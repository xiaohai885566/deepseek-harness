/**
 * The boot sweep's two obligations, asserted against a real {@link MemoryVfs}
 * rather than a stub: it must re-upload a mirrored file the store is missing,
 * and it must not delete a stored row for a path the filesystem still holds.
 *
 * The credential store is the case that matters. It is named in `scope`, so a
 * sweep that cannot *see* it (because `walk` visits the KV root and the profile
 * patches by name) reads every stored credential row as an orphan and deletes
 * it on every boot. The visible symptom is not a credentials error: it is a
 * model picker that empties after every reload, however often the key is typed
 * in again, because `llm-pi-ai` drops a route whose `apiKeyEnv` no longer
 * resolves.
 */
import { describe, expect, it } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { RemoteVfsSync } from '../../src/storage/remote.ts'
import { createCredentialsPath } from '../../src/storage/policy.ts'

const ROOT = '/dsh'
const CREDENTIALS = createCredentialsPath(ROOT)

interface Call {
  readonly mutations: readonly { kind: string, path: string, mode?: number, bytes?: string }[]
}

/**
 * A store that answers `GET` from `entries` and records every `POST`.
 * @param entries - what the store claims to hold.
 * @returns the sync under test and the mutations it posted.
 */
function store(entries: readonly object[]): { sync: RemoteVfsSync, calls: Call[] } {
  const calls: Call[] = []
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ revision: 1, entries }), { status: 200 })
    }
    calls.push(JSON.parse(String(init?.body)) as Call)
    return new Response(JSON.stringify({ revision: 2, skipped: [] }), { status: 200 })
  }) as typeof fetch
  return { sync: new RemoteVfsSync({ root: ROOT, fetch: transport }), calls }
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

const credentialEntry = {
  p: CREDENTIALS,
  d: 0,
  m: 0o600,
  b: b64('version: 1\nrecords:\nrefs:\n  GENT2API_API_KEY: stored\n'),
}

describe('reconcile and the credential store', () => {
  it('keeps a stored credential row the filesystem still holds', async () => {
    const vfs = new MemoryVfs()
    // The restore seeded the file from this very store, so the bytes agree and
    // the sweep has nothing to push — but the row must not be *removed* either.
    const tenant = 'version: 1\nrecords:\nrefs:\n  GENT2API_API_KEY: stored\n'
    vfs.seed(CREDENTIALS, tenant, { mode: 0o600 })
    const { sync, calls } = store([credentialEntry])
    await sync.reconcile(vfs)
    const removed = calls.flatMap(call => call.mutations).filter(m => m.kind === 'remove')
    expect(removed).toEqual([])
  })

  it('re-uploads a credential file the store has lost, with owner-only mode', async () => {
    const vfs = new MemoryVfs()
    vfs.seed(CREDENTIALS, 'version: 1\nrecords:\nrefs:\n  GENT2API_API_KEY: fresh\n', { mode: 0o600 })
    const { sync, calls } = store([])
    await sync.reconcile(vfs)
    const writes = calls.flatMap(call => call.mutations).filter(m => m.kind === 'write')
    const mine = writes.find(m => m.path === CREDENTIALS)
    expect(mine).toBeDefined()
    // `credentials-local` aborts the plugin — and therefore the whole boot —
    // unless the file is owner-only, so the sweep must not widen it to 0644.
    expect(mine?.mode).toBe(0o600)
  })

  it('still removes a credential row the filesystem really has lost', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('/dsh/home/storages/keep.json', '{}', { mode: 0o644 })
    const { sync, calls } = store([credentialEntry])
    await sync.reconcile(vfs)
    const removed = calls.flatMap(call => call.mutations).filter(m => m.kind === 'remove')
    expect(removed.map(m => m.path)).toEqual([CREDENTIALS])
  })
})
