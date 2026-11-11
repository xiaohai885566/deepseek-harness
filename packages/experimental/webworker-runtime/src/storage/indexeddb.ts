/**
 * IndexedDB write-behind for the browser filesystem.
 *
 * The preview's VFS is mounted from a build-time image and lives in memory, so
 * without a sink a reload throws away everything the app wrote: the model routes
 * a user just added, their settings, their session logs.
 *
 * What is mirrored is the shared allowlist in `./policy.ts` — the files the
 * user owns, never the build's own bootstrap state.
 *
 * Failures never reach the caller of a write: the in-memory mutation has already
 * committed by the time the sink sees it, so the contract is to report once and
 * stop mirroring rather than reject.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/indexeddb
 */
import { SEP } from '../module-system/posix-path.ts'
import { createPersistPolicy, type PersistPolicy } from './policy.ts'
import type { MemoryVfs } from './memory.ts'
import type { VfsMutation, VfsMutationSink } from './types.ts'

/** Database every deployment of this runtime shares within one origin. */
const DEFAULT_DATABASE = 'dsh-web-vfs'

/** Object store holding one record per file or directory. */
const STORE = 'entries'

/** Schema version; bump only when a stored record's shape changes. */
const SCHEMA_VERSION = 1

/** Largest single file mirrored. Session logs are far below it; a stray build artifact is not. */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024

/** Largest total mirrored before the sink stops accepting new content. */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

/** One stored entry: a file's bytes, or a directory's existence. */
export interface StoredEntry {
  /** Absolute path inside the mounted root, the store's key. */
  path: string
  /** File contents; absent for a directory. */
  bytes?: Uint8Array
  /** Permission bits, so a restored file keeps what the app set. */
  mode: number
  /** Marks a directory, including one with no files in it. */
  directory: boolean
}

/** Tuning for {@link IndexedDbMutationSink}. */
export interface VfsPersistenceOptions {
  /** Virtual root the filesystem is mounted at. */
  root: string
  /** Database name, when a deployment wants its own. */
  database?: string
  /** Largest single file mirrored. */
  maxFileBytes?: number
  /** Largest total mirrored. */
  maxTotalBytes?: number
}

/** What a queued mutation will do to the store. */
type PendingWrite = { entry: StoredEntry } | { remove: string }

/**
 * Promisify one request.
 * @param request - IndexedDB request.
 * @returns Its result once it settles.
 */
function resolveRequest<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => { resolve(request.result) }
    request.onerror = (): void => { reject(request.error ?? new Error('indexedDB request failed')) }
  })
}

/**
 * Promisify a transaction's completion, which is where a write actually lands.
 * @param transaction - IndexedDB transaction.
 * @returns A promise that resolves after `complete` and rejects on abort or error.
 */
function resolveTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = (): void => { resolve() }
    transaction.onabort = (): void => { reject(transaction.error ?? new Error('indexedDB transaction aborted')) }
    transaction.onerror = (): void => { reject(transaction.error ?? new Error('indexedDB transaction failed')) }
  })
}

/**
 * Durable mirror of the user-owned subtrees, backed by IndexedDB.
 *
 * Construct one before mounting the image, hand it to the filesystem as its
 * sink, and call {@link hydrate} once the image and its overlays are in place.
 */
export class IndexedDbMutationSink implements VfsMutationSink {
  private readonly root: string
  private readonly database: string
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  /** The allowlist both mirrors share. */
  private readonly persists: PersistPolicy
  private queue: PendingWrite[] = []
  private draining: Promise<void> | undefined
  private databasePromise: Promise<IDBDatabase> | undefined
  private totalBytes = 0
  private stopped = false
  private reportedFailure = false

  /**
   * @param options - root, database name and size caps.
   */
  constructor(options: VfsPersistenceOptions) {
    this.root = options.root
    this.database = options.database ?? DEFAULT_DATABASE
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    this.persists = createPersistPolicy(this.root)
  }

  /** Whether this realm can persist at all. */
  static get supported(): boolean {
    return typeof indexedDB !== 'undefined'
  }

  /**
   * Mirror one committed mutation, if it lands in a user-owned subtree.
   * @param mutation - Post-commit state from the filesystem.
   */
  record(mutation: VfsMutation): void {
    if (this.stopped || !IndexedDbMutationSink.supported) return
    if (mutation.kind === 'chmod') return
    if (!this.persists(mutation.path)) return
    if (mutation.kind === 'remove') {
      this.queue.push({ remove: mutation.path })
      this.schedule()
      return
    }
    if (mutation.kind === 'mkdir') {
      this.queue.push({ entry: { path: mutation.path, mode: mutation.mode, directory: true } })
      this.schedule()
      return
    }
    if (mutation.bytes.byteLength > this.maxFileBytes) return
    if (this.totalBytes + mutation.bytes.byteLength > this.maxTotalBytes) {
      this.reportFailure(new Error(`vfs persistence: ${String(this.maxTotalBytes)} byte cap reached; stopping the mirror`))
      return
    }
    this.totalBytes += mutation.bytes.byteLength
    // Copied: the filesystem keeps its own view of a buffer it may reuse.
    this.queue.push({
      entry: { path: mutation.path, bytes: mutation.bytes.slice(), mode: mutation.mode, directory: false },
    })
    this.schedule()
  }

  /**
   * Settle everything recorded so far.
   * @returns A promise that resolves once the queue has landed.
   */
  async flush(): Promise<void> {
    await this.drain()
  }

  /**
   * Seed stored entries over a freshly mounted image.
   *
   * Directories first, shallowest first, so every file's parent exists; then the
   * files themselves. A stored entry whose directory no longer exists in the
   * image is still restored: user data outlives the build that created it.
   * @param vfs - The mounted filesystem to seed.
   * @returns How many files were restored, so a caller can tell an empty store
   * from an unreachable one.
   */
  async hydrate(vfs: MemoryVfs): Promise<number> {
    if (!IndexedDbMutationSink.supported) return 0
    let entries: StoredEntry[]
    try {
      const database = await this.open()
      entries = await resolveRequest(
        database.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<StoredEntry[]>,
      )
    } catch (error) {
      this.reportFailure(error)
      return 0
    }
    if (entries.length === 0) return 0
    // Prune what an earlier policy stored and this one refuses: a stale platform
    // patch or profile manifest is exactly what breaks the next boot, and it is
    // already in the database of anyone who ran the wider version.
    const stale = entries.filter(entry => !this.persists(entry.path))
    if (stale.length > 0) {
      entries = entries.filter(entry => this.persists(entry.path))
      void this.forget(stale.map(entry => entry.path))
    }
    if (entries.length === 0) return 0
    const depth = (path: string): number => path.split(SEP).length
    const directories = entries.filter(entry => entry.directory).sort((left, right) => depth(left.path) - depth(right.path))
    const files = entries.filter(entry => !entry.directory)
    for (const directory of directories) {
      try {
        vfs.seedDirectory(directory.path, { mode: directory.mode })
      } catch { /* A directory the image already owns, or a mode it refuses. */ }
    }
    let restored = 0
    for (const file of files) {
      if (file.bytes === undefined) continue
      try {
        vfs.seed(file.path, file.bytes, { mode: file.mode })
        this.totalBytes += file.bytes.byteLength
        restored += 1
      } catch { /* Seeding is best effort; the image's own copy stays in place. */ }
    }
    if (restored > 0) {
      console.info(`webworker vfs: restored ${String(restored)} file(s) from IndexedDB`)
    }
    return restored
  }

  /**
   * Every mirrored entry, for handing a browser's existing state to another
   * mirror.
   *
   * The first boot against a deployment that just gained a D1 store finds the
   * store empty and this one full: uploading what is here is what makes the
   * upgrade keep the models and sessions the user already had instead of
   * silently starting from the image again.
   * @returns The stored entries, or none when the browser has no store.
   */
  async snapshot(): Promise<StoredEntry[]> {
    if (!IndexedDbMutationSink.supported) return []
    try {
      const database = await this.open()
      const entries = await resolveRequest(
        database.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<StoredEntry[]>,
      )
      return entries.filter(entry => this.persists(entry.path))
    } catch (error) {
      this.reportFailure(error)
      return []
    }
  }

  /**
   * Write entries that came from the deployment's store straight into this one.
   *
   * Used after a boot seeded from the shared copy: without it the browser's own
   * store would keep whatever it held before, and the next offline boot would
   * restore an older workspace over the one the user just worked in.
   * @param entries - entries the shared store supplied.
   */
  async absorb(entries: readonly StoredEntry[]): Promise<void> {
    if (this.stopped || !IndexedDbMutationSink.supported) return
    const kept = entries.filter(entry => this.persists(entry.path))
    if (kept.length === 0) return
    try {
      const database = await this.open()
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      for (const entry of kept) {
        if (entry.directory) {
          store.put({ path: entry.path, mode: entry.mode, directory: true })
          continue
        }
        if (entry.bytes === undefined || entry.bytes.byteLength > this.maxFileBytes) continue
        if (this.totalBytes + entry.bytes.byteLength > this.maxTotalBytes) continue
        this.totalBytes += entry.bytes.byteLength
        store.put({ path: entry.path, bytes: entry.bytes, mode: entry.mode, directory: false })
      }
      await resolveTransaction(transaction)
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /**
   * Delete stored entries by path, best effort.
   * @param paths - Keys to drop.
   */
  private async forget(paths: readonly string[]): Promise<void> {
    try {
      const database = await this.open()
      const store = database.transaction(STORE, 'readwrite').objectStore(STORE)
      for (const path of paths) store.delete(path)
      await resolveTransaction(store.transaction)
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /**
   * Whether a path is inside one of the mirrored subtrees.
   * @param path - Absolute path the filesystem reported.
   * @returns true when the path belongs to the user.
   */

  /** Queue one drain on the next microtask, coalescing a burst into one transaction. */
  private schedule(): void {
    if (this.draining !== undefined) return
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .finally(() => { this.draining = undefined })
  }

  /** Write the queue out in one transaction. */
  private async drain(): Promise<void> {
    if (this.stopped || this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    try {
      const database = await this.open()
      const store = database.transaction(STORE, 'readwrite').objectStore(STORE)
      const transaction = store.transaction
      for (const pending of batch) {
        if ('remove' in pending) {
          store.delete(pending.remove)
          // A removed directory takes its subtree with it.
          store.delete(IDBKeyRange.bound(`${pending.remove}${SEP}`, `${pending.remove}${SEP}\uffff`))
          continue
        }
        store.put(pending.entry)
      }
      await resolveTransaction(transaction)
    } catch (error) {
      this.reportFailure(error)
    }
  }

  /** Open the database once per instance. */
  private open(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.database, SCHEMA_VERSION)
      request.onupgradeneeded = (): void => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'path' })
      }
      request.onsuccess = (): void => { resolve(request.result) }
      request.onerror = (): void => { reject(request.error ?? new Error('indexedDB open failed')) }
    })
    return this.databasePromise
  }

  /**
   * Report the first persistence failure and stop mirroring.
   * @param error - What went wrong.
   */
  private reportFailure(error: unknown): void {
    this.stopped = true
    this.queue = []
    if (this.reportedFailure) return
    this.reportedFailure = true
    console.warn('webworker vfs: IndexedDB persistence stopped:', error)
  }
}
