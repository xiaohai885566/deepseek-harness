/**
 * Durable filesystem store for the static deployment.
 *
 * The preview runs the whole harness in a browser worker over an in-memory VFS,
 * so without a server the user's model routes, sessions and workspace live in
 * one browser's IndexedDB and nowhere else. This module makes the D1 database
 * behind the same password gate the durable copy: the page mirrors the
 * allowlisted subtrees up as it writes, and seeds them back down at boot.
 *
 * Two verbs, both behind {@link hasSession} in `static-gate.ts`:
 *
 * - `GET /__vfs/snapshot` — every stored entry, directories included, as one
 *   JSON document. Boot reads it once, so a single round trip beats per-path
 *   reads at any realistic file count.
 * - `POST /__vfs/apply` — a batch of mutations in the VFS sink's own shape, so
 *   the client mirrors a change without translating it.
 *
 * Writes are last-writer-wins per path. Two devices editing the same file at
 * the same time therefore converge on whichever flush landed second; the
 * `updated_at` column keeps that diagnosable.
 * @module cloudflare/worker/src/vfs-store
 */

/** D1 bindings and limits this module reads. */
interface VfsEnv {
  /** The durable store. Unset means the deployment keeps browser-local state only. */
  VFS_DB?: D1Database
}

/** Path prefix the store answers on, under the gate's authority. */
export const VFS_PATH = '/__vfs/'

/**
 * Largest single entry mirrored up. D1 caps a row at 2 MB, and a base64 body
 * costs a third more on the wire, so anything near the cap is skipped rather
 * than turned into a permanent write failure.
 */
const MAX_ENTRY_BYTES = 1_500_000

/** One mutation as the VFS sink reports it. */
interface WireMutation {
  /** `write`, `mkdir`, `remove`, or `chmod`. */
  readonly kind: string
  /** Absolute VFS path. */
  readonly path: string
  /** Unix mode; absent on `remove`. */
  readonly mode?: number
  /** Base64 file body for `write`. */
  readonly bytes?: string
}

/** One stored entry as the snapshot reports it. */
interface WireEntry {
  /** Absolute VFS path. */
  readonly p: string
  /** `1` for a directory, `0` for a file. */
  readonly d: 0 | 1
  /** Unix mode. */
  readonly m: number
  /** Base64 body, files only. */
  readonly b?: string
}

/** Row shape of the entries table. */
interface EntryRow {
  readonly path: string
  readonly directory: number
  readonly mode: number
  readonly bytes: ArrayBuffer | null
  readonly updated_at: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Base64-encode bytes without blowing the argument limit of `String.fromCharCode`. */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.byteLength; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

/** Decode a base64 body back to bytes. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/** Read the store's revision counter, treating a fresh database as revision 0. */
async function readRevision(database: D1Database): Promise<number> {
  const row = await database.prepare('SELECT value FROM vfs_meta WHERE key = ?1').bind('revision').first<{ value: string }>()
  return row === null ? 0 : Number.parseInt(row.value, 10) || 0
}

/**
 * Every stored entry, plus the revision the snapshot reflects.
 *
 * The client compares revisions only for diagnostics; it seeds unconditionally,
 * because a boot with no snapshot is indistinguishable from a boot whose
 * snapshot the network dropped.
 * @param database - the D1 database.
 * @returns the snapshot document.
 */
async function readSnapshot(database: D1Database): Promise<{ revision: number; entries: WireEntry[] }> {
  const [rows, revision] = await Promise.all([
    database.prepare('SELECT path, directory, mode, bytes, updated_at FROM vfs_entries ORDER BY path')
      .all<EntryRow>(),
    readRevision(database),
  ])
  const entries: WireEntry[] = (rows.results ?? []).map((row) => {
    const base: WireEntry = { p: row.path, d: row.directory === 1 ? 1 : 0, m: row.mode }
    if (row.directory === 1 || row.bytes === null) return base
    return { ...base, b: toBase64(new Uint8Array(row.bytes)) }
  })
  return { revision, entries }
}

/** Turn one wire mutation into the statements that apply it. */
function statementsFor(database: D1Database, mutation: WireMutation, now: number): D1PreparedStatement | undefined {
  if (mutation.kind === 'remove') {
    // A subtree delete is one statement: the sink reports the directory it
    // removed, and every stored descendant goes with it.
    return database.prepare('DELETE FROM vfs_entries WHERE path = ?1 OR path LIKE ?2')
      .bind(mutation.path, `${mutation.path}/%`)
  }
  const directory = mutation.kind === 'mkdir' ? 1 : 0
  const mode = mutation.mode ?? (directory === 1 ? 0o755 : 0o644)
  if (mutation.kind === 'chmod') {
    return database.prepare('UPDATE vfs_entries SET mode = ?2, updated_at = ?3 WHERE path = ?1')
      .bind(mutation.path, mode, now)
  }
  if (mutation.kind !== 'write' && mutation.kind !== 'mkdir') return undefined
  if (directory === 0 && mutation.bytes === undefined) return undefined
  const bytes = directory === 1 || mutation.bytes === undefined ? null : fromBase64(mutation.bytes)
  if (bytes !== null && bytes.byteLength > MAX_ENTRY_BYTES) return undefined
  return database.prepare(
    'INSERT INTO vfs_entries (path, directory, mode, bytes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) '
    + 'ON CONFLICT(path) DO UPDATE SET directory = ?2, mode = ?3, bytes = ?4, updated_at = ?5',
  ).bind(mutation.path, directory, mode, bytes, now)
}

/**
 * Apply one batch of mutations and bump the revision.
 * @param database - the D1 database.
 * @param mutations - the batch, in the order the VFS applied it.
 * @returns the new revision, and the mutations that were skipped.
 */
async function applyMutations(
  database: D1Database,
  mutations: readonly WireMutation[],
): Promise<{ revision: number; skipped: string[] }> {
  const now = Date.now()
  const skipped: string[] = []
  const statements: D1PreparedStatement[] = []
  for (const mutation of mutations) {
    const statement = statementsFor(database, mutation, now)
    if (statement === undefined) {
      if (mutation.kind !== 'chmod') skipped.push(mutation.path)
      continue
    }
    statements.push(statement)
  }
  if (statements.length > 0) await database.batch(statements)
  const revision = (await readRevision(database)) + 1
  await database.prepare(
    'INSERT INTO vfs_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  ).bind('revision', String(revision)).run()
  return { revision, skipped }
}

/**
 * Answer one `/__vfs/` request.
 *
 * Authentication already happened: the gate only reaches this function for a
 * request carrying a valid session cookie.
 * @param request - the gated request.
 * @param url - its URL, whose path selects the verb.
 * @param env - the D1 binding.
 * @returns the snapshot, the new revision, or a refusal naming what was wrong.
 */
export async function handleVfs(request: Request, url: URL, env: VfsEnv): Promise<Response> {
  const database = env.VFS_DB
  if (database === undefined) {
    return json({ error: 'this deployment has no VFS_DB binding, so cross-device sync is off' }, 503)
  }
  const verb = url.pathname.slice(VFS_PATH.length)
  if (verb === 'snapshot' && request.method === 'GET') {
    return json(await readSnapshot(database))
  }
  if (verb === 'apply' && request.method === 'POST') {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json({ error: 'apply body is not JSON' }, 400)
    }
    const mutations = (body as { mutations?: unknown } | null)?.mutations
    if (!Array.isArray(mutations)) return json({ error: 'apply body needs a mutations array' }, 400)
    const wellFormed: WireMutation[] = []
    for (const candidate of mutations as readonly Partial<WireMutation>[]) {
      if (typeof candidate?.kind !== 'string' || typeof candidate.path !== 'string') continue
      wellFormed.push({
        kind: candidate.kind,
        path: candidate.path,
        ...candidate.mode === undefined ? {} : { mode: candidate.mode },
        ...candidate.bytes === undefined ? {} : { bytes: candidate.bytes },
      })
    }
    return json(await applyMutations(database, wellFormed))
  }
  return json({ error: `no VFS verb for ${request.method} ${url.pathname}` }, 404)
}
