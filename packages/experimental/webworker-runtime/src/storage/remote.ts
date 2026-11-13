/**
 * Durable cross-device mirror for the browser filesystem.
 *
 * The IndexedDB sink keeps a reload from throwing the user's work away, but it
 * keeps it in *one browser*: a laptop and a phone end up with two unrelated
 * workspaces. This sink is the same write-behind contract aimed at the
 * deployment itself — `/__vfs/apply` for changes, `/__vfs/snapshot` for the
 * boot seed — so every device that knows the password reads and writes one
 * filesystem. The Worker serving those two verbs sits behind the same password
 * gate as the assets, so the store is not an open door.
 *
 * Writes are last-writer-wins per path. Two devices editing the same file at
 * once converge on whichever flush landed second, which is the honest behaviour
 * for a mirror that has no merge rules to offer.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/remote
 */
import { IMAGE_HOME_DIRECTORY } from '../image-layout.ts'
import { join } from '../module-system/posix-path.ts'
import { createPersistPolicy, createReconcileScope, type PersistPolicy, type ReconcileScope } from './policy.ts'
import type { MemoryVfs } from './memory.ts'
import type { StoredEntry } from './indexeddb.ts'
import type { VfsMutation, VfsMutationSink } from './types.ts'

/** Default verb prefix, matching the Worker's route. */
const DEFAULT_ENDPOINT = '/__vfs/'

/** Coalescing window for autonomous sends; `flush()` bypasses it. */
const DEFAULT_BATCH_DELAY_MS = 500

/** Largest single file mirrored. The Worker refuses anything near D1's row cap. */
const DEFAULT_MAX_FILE_BYTES = 1_500_000

/** Entries per upload when handing a browser's existing state to the store. */
const PUSH_CHUNK = 200

/**
 * Consecutive failed sends after which the queue is assumed to be the problem
 * rather than the network, and gets flushed instead of retried forever.
 *
 * There is deliberately no "stop mirroring" threshold: the store is the only
 * copy a second device can see, and the failure that used to trip a permanent
 * stop is a transient one — a batch D1 rejects once and accepts on the next
 * attempt. Giving up turned a second of packet loss into "every model you add
 * from now on is local-only", which is exactly what the user then reports as
 * "my settings disappeared after a reload".
 */
const POISON_AFTER = 5

/**
 * Retry delays, in order; the last one repeats.
 *
 * Front-loaded on purpose: the failure this has to absorb is a single batch D1
 * rejects and then accepts, so the second attempt must come within a few hundred
 * milliseconds. The user is often one reload away from judging whether their
 * settings were saved at all.
 */
const RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000]

/** One mutation in the Worker's wire shape. */
interface WireMutation {
  readonly kind: string
  readonly path: string
  readonly mode?: number
  readonly bytes?: string
}

/** One stored entry in the Worker's wire shape. */
export interface WireEntry {
  readonly p: string
  readonly d: 0 | 1
  readonly m: number
  readonly b?: string
  readonly u?: number
}

/** Tuning for {@link RemoteVfsSync}. */
export interface RemoteSyncOptions {
  /** Virtual root the filesystem is mounted at. */
  root: string
  /** Verb prefix; a deployment behind a path prefix overrides it. */
  endpoint?: string
  /** Transport override, for tests. */
  fetch?: typeof fetch
  /** Coalescing window in milliseconds. */
  batchDelayMs?: number
  /** Largest single file mirrored. */
  maxFileBytes?: number
}

/** Base64-encode bytes without exhausting the argument limit of `String.fromCharCode`. */
/** Compare two byte arrays. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let at = 0; at < left.byteLength; at += 1) if (left[at] !== right[at]) return false
  return true
}

function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.byteLength; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

/**
 * Decode a base64 body back to bytes.
 * @param text - base64 body from the store.
 * @returns the bytes it encodes.
 */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/** Translate one committed VFS mutation into the wire shape, or nothing to send. */
function toWire(mutation: VfsMutation, maxFileBytes: number): WireMutation | undefined {
  switch (mutation.kind) {
    case 'write':
      if (mutation.bytes.byteLength > maxFileBytes) return undefined
      return { kind: 'write', path: mutation.path, mode: mutation.mode, bytes: toBase64(mutation.bytes) }
    case 'mkdir':
      return { kind: 'mkdir', path: mutation.path, mode: mutation.mode }
    case 'remove':
      return { kind: 'remove', path: mutation.path }
    case 'chmod':
      return { kind: 'chmod', path: mutation.path, mode: mutation.mode }
  }
}

/** Translate one stored entry into the wire shape of an upsert. */
function entryToWire(entry: StoredEntry, maxFileBytes: number): WireMutation | undefined {
  if (entry.directory) return { kind: 'mkdir', path: entry.path, mode: entry.mode }
  if (entry.bytes === undefined || entry.bytes.byteLength > maxFileBytes) return undefined
  return { kind: 'write', path: entry.path, mode: entry.mode, bytes: toBase64(entry.bytes) }
}

/** Durable mirror backed by the deployment's D1 store. */
export class RemoteVfsSync implements VfsMutationSink {
  /** Whether this realm can reach the store at all. */
  static get supported(): boolean {
    return typeof fetch === 'function'
  }

  private readonly root: string
  private readonly endpoint: string
  private readonly transport: typeof fetch
  private readonly batchDelayMs: number
  private readonly maxFileBytes: number
  private readonly persists: PersistPolicy
  private readonly scope: ReconcileScope
  private queue: WireMutation[] = []
  private sending: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private warned = false
  private reportedSize = false

  /**
   * @param options - root, endpoint, transport and caps.
   */
  constructor(options: RemoteSyncOptions) {
    this.root = options.root
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.transport = options.fetch ?? ((input, init) => fetch(input, init))
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.persists = createPersistPolicy(options.root)
    this.scope = createReconcileScope(options.root)
  }

  /** Queue one committed mutation. */
  record(mutation: VfsMutation): void {
    if (!this.persists(mutation.path)) return
    const wire = toWire(mutation, this.maxFileBytes)
    if (wire === undefined) {
      if (mutation.kind === 'write' && !this.reportedSize) {
        this.reportedSize = true
        console.warn(`webworker vfs: ${mutation.path} exceeds the ${String(this.maxFileBytes)}-byte sync cap and stays on this device`)
      }
      return
    }
    this.queue.push(wire)
    this.schedule()
  }

  /** Send everything queued so far. */
  async flush(): Promise<void> {
    this.cancelTimer()
    await this.drain()
  }

  /**
   * Seed a freshly mounted filesystem from the store.
   * @param vfs - the mounted filesystem.
   * @param accept - Restrict seeding to the entries this returns true for, so a
   * restore can seed only the paths where the store holds the newer write.
   * @returns the entries the store held, so the caller can tell an empty store
   * from an unreachable one and can refresh the browser's offline copy from the
   * same bytes. Empty means "nothing to seed": absent, unreachable, or empty.
   */
  async hydrate(vfs: MemoryVfs, accept?: (entry: StoredEntry) => boolean): Promise<StoredEntry[]> {
    const entries = await this.read()
    if (entries === undefined) return []
    const kept = entries.filter(entry => this.persists(entry.p)
      && (accept === undefined || accept({
        path: entry.p,
        mode: entry.m,
        directory: entry.d === 1,
        ...entry.u === undefined ? {} : { savedAt: entry.u },
      })))
    if (kept.length === 0) return []
    const depth = (path: string): number => path.split('/').length
    const directories = kept.filter(entry => entry.d === 1).sort((left, right) => depth(left.p) - depth(right.p))
    for (const directory of directories) {
      try {
        vfs.seedDirectory(directory.p, { mode: directory.m })
      } catch { /* A directory the image already owns, or a mode it refuses. */ }
    }
    const seeded: StoredEntry[] = []
    let restored = 0
    for (const entry of kept) {
      if (entry.d === 1) {
        seeded.push({
          path: entry.p,
          mode: entry.m,
          directory: true,
          ...entry.u === undefined ? {} : { savedAt: entry.u },
        })
        continue
      }
      if (entry.b === undefined) continue
      const bytes = fromBase64(entry.b)
      try {
        vfs.seed(entry.p, bytes, { mode: entry.m })
        seeded.push({
          path: entry.p,
          bytes,
          mode: entry.m,
          directory: false,
          ...entry.u === undefined ? {} : { savedAt: entry.u },
        })
        restored += 1
      } catch { /* Seeding is best effort; the image's own copy stays in place. */ }
    }
    if (restored > 0) console.info(`webworker vfs: restored ${String(restored)} file(s) from the deployment`)
    return seeded
  }

  /**
   * Read the store's entries without seeding anything.
   * @returns the stored entries with their write times, or undefined when the
   * store is unreachable — the caller needs that difference to decide whether
   * "nothing here" means empty or offline.
   */
  async read(): Promise<readonly WireEntry[] | undefined> {
    try {
      const response = await this.transport(this.url('snapshot'), { credentials: 'same-origin' })
      if (!response.ok) return undefined
      const body = await response.json() as { entries?: readonly WireEntry[] }
      return body.entries ?? []
    } catch (error) {
      console.warn('webworker vfs: cross-device snapshot unavailable:', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  /**
   * Sweep the mirrored subtrees and upload whatever differs from what the store
   * already holds.
   *
   * Edge-triggered mirroring has one failure mode that matters: a single dropped
   * mutation is invisible forever. The filesystem reports a commit as a stream,
   * and if the stream loses the `write <target>` half of a rename — which is what
   * a half-mirrored KV unit looks like: the `<uuid>.tmp` sibling arrives and the
   * renamed file never does — nothing later re-reports it, so the store keeps a
   * temp file and the user reloads into a workspace that no longer exists.
   *
   * This is the level-triggered half: read the tree, compare against the store,
   * push what is missing or newer. It is cheap enough to run on boot and on
   * `visibilitychange`, and it makes the mirror self-healing rather than
   * "correct as long as nothing was ever dropped".
   * @param vfs - the mounted filesystem to read.
   * @returns how many paths were pushed.
   */
  async reconcile(vfs: MemoryVfs): Promise<number> {
    const stored = await this.read()
    if (stored === undefined) return 0
    const known = new Map<string, WireEntry>()
    for (const entry of stored) known.set(entry.p, entry)
    const pending: WireMutation[] = []
    for (const path of this.walk(vfs)) {
      const bytes = this.readBytes(vfs, path)
      if (bytes === undefined) continue
      if (bytes === null) {
        const entry = known.get(path)
        if (entry?.d === 1) continue
        pending.push({ kind: 'mkdir', path, mode: 0o755 })
        continue
      }
      const entry = known.get(path)
      if (entry !== undefined && entry.d === 0 && entry.b !== undefined) {
        // The store already holds exactly these bytes: nothing to push. Only
        // content matters here, because a rewrite with identical content is not
        // a state change the other device needs to see.
        if (sameBytes(fromBase64(entry.b), bytes)) continue
      }
      pending.push({ kind: 'write', path, mode: 0o644, bytes: toBase64(bytes) })
    }
    // The other direction: a row the filesystem does not have is a leftover of a
    // write that was half-mirrored (the temp sibling of a rename that never
    // landed). Leaving it would make the next boot seed a file the app has
    // already deleted, so it goes.
    const present = new Set(this.walk(vfs))
    for (const entry of stored) {
      // `scope` decides which stored rows this sweep may judge; presence comes
      // from the persists-filtered walk, so a `.tmp` row has no live file and is
      // removed here just like any other leftover.
      if (!this.scope(entry.p)) continue
      if (present.has(entry.p)) continue
      pending.push({ kind: 'remove', path: entry.p })
    }
    if (pending.length === 0) return 0
    for (let at = 0; at < pending.length; at += PUSH_CHUNK) {
      try {
        await this.post(pending.slice(at, at + PUSH_CHUNK))
      } catch (error) {
        console.warn('webworker vfs: reconcile upload failed:', error instanceof Error ? error.message : error)
        return 0
      }
    }
    return pending.length
  }

  /**
   * The paths the sweep reads: the structured state whose loss is visible as
   * "my settings are gone", never the bulk.
   *
   * Deliberately narrower than {@link PersistPolicy}. `workspace/` and
   * `home/sessions/` are large and append-only, they are written on every turn,
   * and the edge-triggered stream carries them; re-reading all of them on every
   * boot to compare bytes would cost more than the one dropped mutation it might
   * recover. The KV root and the profile patch are a handful of small files, and
   * they are precisely the state a reload reads back to decide whether the user
   * still has their models and their workspace.
   * @param vfs - the mounted filesystem.
   * @returns absolute paths.
   */
  private walk(vfs: MemoryVfs): string[] {
    const found: string[] = []
    const directory = (path: string): void => {
      // Read set and presence set are the same: what the user owns. A `.tmp`
      // sibling is in neither, so it is never uploaded and its stored row reads
      // as an orphan below.
      if (!this.persists(path)) return
      if (!vfs.existsSync(path)) return
      found.push(path)
      let names: string[]
      try {
        names = vfs.readdirSync(path)
      } catch {
        return
      }
      for (const name of names) directory(join(path, name))
    }
    directory(join(this.root, IMAGE_HOME_DIRECTORY, 'storages'))
    const profiles = join(this.root, IMAGE_HOME_DIRECTORY, 'profiles')
    if (vfs.existsSync(profiles)) {
      let names: string[]
      try {
        names = vfs.readdirSync(profiles)
      } catch {
        names = []
      }
      for (const name of names) {
        const patch = join(profiles, name, 'cordis.patch.yml')
        if (vfs.existsSync(patch) && this.persists(patch)) found.push(patch)
      }
    }
    return found
  }

  /**
   * Read one path as bytes, or as a directory marker.
   * @param vfs - the mounted filesystem.
   * @param path - absolute path.
   * @returns the bytes, `null` for a directory, or undefined when unreadable.
   */
  private readBytes(vfs: MemoryVfs, path: string): Uint8Array | null | undefined {
    try {
      const stat = vfs.statSync(path)
      if (stat.isDirectory()) return null
      const body = vfs.readFileSync(path)
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
      if (bytes.byteLength > this.maxFileBytes) return undefined
      return bytes
    } catch {
      return undefined
    }
  }

  /**
   * Upload a whole browser store, in chunks the Worker accepts.
   *
   * Used once, when the deployment gains a store that is still empty while the
   * browser already holds state: without it, upgrading would start from the
   * image and the user would rebuild every model and workspace by hand.
   * @param entries - entries read from the browser store.
   */
  async pushAll(entries: readonly StoredEntry[]): Promise<void> {
    const wire = entries
      .map(entry => entryToWire(entry, this.maxFileBytes))
      .filter((mutation): mutation is WireMutation => mutation !== undefined)
    for (let at = 0; at < wire.length; at += PUSH_CHUNK) {
      const chunk = wire.slice(at, at + PUSH_CHUNK)
      try {
        await this.send(chunk)
      } catch (error) {
        console.warn('webworker vfs: uploading the browser copy failed:', error instanceof Error ? error.message : error)
        return
      }
    }
    if (wire.length > 0) console.info(`webworker vfs: uploaded ${String(wire.length)} entr(y/ies) to the deployment`)
  }

  private url(verb: string): string {
    const base = typeof location === 'undefined' ? 'http://localhost/' : location.href
    return new URL(`${this.endpoint}${verb}`, base).href
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, this.batchDelayMs)
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private async drain(): Promise<void> {
    // One send at a time: the store applies a batch in order, so overlapping
    // sends would race two revisions of the same path.
    while (this.sending !== undefined) await this.sending
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    this.sending = this.send(batch)
    try {
      await this.sending
    } finally {
      this.sending = undefined
    }
  }

  /**
   * Send one batch once.
   * @param batch - mutations to post.
   * @returns nothing; a rejection means the store refused or was unreachable.
   */
  private async post(batch: readonly WireMutation[]): Promise<void> {
    const body = JSON.stringify({ mutations: batch })
    // A reload tears the worker down and aborts whatever it was sending. The
    // batch in flight is usually the one that just saved the user's edit, so it
    // gets `keepalive` and survives the unload. Browsers cap keepalive bodies at
    // 64 KiB, so a large batch (a session log) is sent normally: the browser
    // store still holds it, and the next boot merges it back in from there.
    const keepalive = body.length <= 60_000
    const response = await this.transport(this.url('apply'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
      ...keepalive ? { keepalive: true } : {},
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${String(response.status)} ${detail.slice(0, 200)}`)
    }
  }

  /** Send one batch, re-queueing it and scheduling the next attempt on failure. */
  private async send(batch: readonly WireMutation[]): Promise<void> {
    try {
      await this.post(batch)
      this.failures = 0
      return
    } catch (error) {
      this.failures += 1
      const message = error instanceof Error ? error.message : String(error)
      if (!this.warned) {
        this.warned = true
        console.warn(`webworker vfs: cross-device sync is retrying after a failed send (${message})`)
      }
      // A poison batch must not become a permanent stall: after enough
      // consecutive failures, retry the mutations one at a time so the healthy
      // ones land and only the rejected path is dropped.
      if (this.failures >= POISON_AFTER && batch.length > 1) {
        // Already backed off five times; splitting now is the only thing left to
        // try, so doing it immediately costs nothing the delay would have saved.
        this.queue = [...batch, ...this.queue]
        this.cancelTimer()
        void this.drainIndividually()
        return
      }
      // Put the batch back in front of anything recorded meanwhile: order is
      // the only conflict resolution this mirror has.
      this.queue = [...batch, ...this.queue]
      const delay = RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)]
      this.cancelTimer()
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.drain()
      }, delay)
    }
  }

  /**
   * Retry queued mutations one at a time, dropping only the ones that fail.
   *
   * This is the escape hatch for a batch the store rejects every time: without
   * it, one unaccepted path would hold every later mutation behind it and the
   * store would silently freeze at that revision.
   */
  private async drainIndividually(): Promise<void> {
    while (this.sending !== undefined) await this.sending
    const batch = this.queue
    this.queue = []
    let failures = 0
    for (const mutation of batch) {
      try {
        await this.post([mutation])
        this.failures = 0
      } catch (error) {
        failures += 1
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`webworker vfs: dropping a path the store keeps refusing (${mutation.path}): ${message}`)
      }
    }
    if (failures === 0) return
    this.failures = Math.max(this.failures, failures)
  }
}
