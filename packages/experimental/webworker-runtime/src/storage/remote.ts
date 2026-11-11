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
import { createPersistPolicy, type PersistPolicy } from './policy.ts'
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

/** Consecutive failed sends after which mirroring stops for this session. */
const GIVE_UP_AFTER = 5

/** Retry delays, in order; the last one repeats. */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 30_000]

/** One mutation in the Worker's wire shape. */
interface WireMutation {
  readonly kind: string
  readonly path: string
  readonly mode?: number
  readonly bytes?: string
}

/** One stored entry in the Worker's wire shape. */
interface WireEntry {
  readonly p: string
  readonly d: 0 | 1
  readonly m: number
  readonly b?: string
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

  private readonly endpoint: string
  private readonly transport: typeof fetch
  private readonly batchDelayMs: number
  private readonly maxFileBytes: number
  private readonly persists: PersistPolicy
  private queue: WireMutation[] = []
  private sending: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private failures = 0
  private stopped = false
  private warned = false
  private reportedSize = false

  /**
   * @param options - root, endpoint, transport and caps.
   */
  constructor(options: RemoteSyncOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.transport = options.fetch ?? ((input, init) => fetch(input, init))
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.persists = createPersistPolicy(options.root)
  }

  /** Queue one committed mutation. */
  record(mutation: VfsMutation): void {
    if (this.stopped || !this.persists(mutation.path)) return
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
   * @returns the entries the store held, so the caller can tell an empty store
   * from an unreachable one and can refresh the browser's offline copy from the
   * same bytes. Empty means "nothing to seed": absent, unreachable, or empty.
   */
  async hydrate(vfs: MemoryVfs): Promise<StoredEntry[]> {
    let entries: readonly WireEntry[]
    try {
      const response = await this.transport(this.url('snapshot'), { credentials: 'same-origin' })
      if (!response.ok) return []
      const body = await response.json() as { entries?: readonly WireEntry[] }
      entries = body.entries ?? []
    } catch (error) {
      console.warn('webworker vfs: cross-device snapshot unavailable:', error instanceof Error ? error.message : error)
      return []
    }
    const kept = entries.filter(entry => this.persists(entry.p))
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
        seeded.push({ path: entry.p, mode: entry.m, directory: true })
        continue
      }
      if (entry.b === undefined) continue
      const bytes = fromBase64(entry.b)
      try {
        vfs.seed(entry.p, bytes, { mode: entry.m })
        seeded.push({ path: entry.p, bytes, mode: entry.m, directory: false })
        restored += 1
      } catch { /* Seeding is best effort; the image's own copy stays in place. */ }
    }
    if (restored > 0) console.info(`webworker vfs: restored ${String(restored)} file(s) from the deployment`)
    return seeded
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
    if (this.queue.length === 0 || this.stopped) return
    const batch = this.queue
    this.queue = []
    this.sending = this.send(batch)
    try {
      await this.sending
    } finally {
      this.sending = undefined
    }
  }

  private async send(batch: readonly WireMutation[]): Promise<void> {
    try {
      const response = await this.transport(this.url('apply'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mutations: batch }),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`${String(response.status)} ${detail.slice(0, 200)}`)
      }
      this.failures = 0
    } catch (error) {
      this.failures += 1
      const message = error instanceof Error ? error.message : String(error)
      if (this.failures >= GIVE_UP_AFTER) {
        this.stopped = true
        if (!this.warned) {
          this.warned = true
          console.warn(`webworker vfs: cross-device sync stopped after ${String(this.failures)} failed sends (${message}); this device keeps writing locally`)
        }
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
}
