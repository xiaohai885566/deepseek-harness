/**
 * How the two durable mirrors are combined.
 *
 * A browser store and the deployment's store answer different questions. The
 * browser one is fast, offline, and private to the device; the deployment one
 * is what makes a phone and a laptop share a workspace. So both are written to
 * on every mutation, and the boot order decides which is authoritative:
 *
 * 1. Ask the deployment. If it has anything, that is the workspace — it is the
 *    copy every device agreed on.
 * 2. Only if it is empty, absent or unreachable, fall back to the browser's own
 *    store, which is what makes an offline reload work.
 * 3. If the deployment was reachable but empty while the browser had state, the
 *    browser copy is uploaded once. That is the upgrade path for a deployment
 *    that gained a store after the user had already been using it.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/sinks
 */
import { IndexedDbMutationSink, type VfsPersistenceOptions } from './indexeddb.ts'
import type { StoredEntry } from './indexeddb.ts'
import { fromBase64, RemoteVfsSync, type WireEntry } from './remote.ts'
import type { MemoryVfs } from './memory.ts'
import type { VfsMutation, VfsMutationSink } from './types.ts'

/**
 * How far past the device's own clock a `savedAt` may sit before it is read as
 * the residue of a clock that was once wrong rather than a real write.
 *
 * Two samples of the same clock differ by milliseconds, so this is generous:
 * it only has to sit far below the drift worth correcting (minutes) and far
 * above the resolution of the comparison (milliseconds).
 */
const FUTURE_STAMP_SLACK_MS = 60_000

/** Persistence tuning as the host receives it, minus the root it computes itself. */
export interface PersistenceOptions extends Omit<VfsPersistenceOptions, 'root'> {
  /**
   * Cross-device mirror. `false` keeps state on the device that wrote it, which
   * is the right choice for a deployment with no `/__vfs/` route.
   */
  readonly remote?: false | {
    /** Verb prefix; defaults to the Worker's own `/__vfs/`. */
    readonly endpoint?: string
    /** Coalescing window in milliseconds. */
    readonly batchDelayMs?: number
  }
}

/** One sink that reports every mutation to each of its members. */
export class FanOutMutationSink implements VfsMutationSink {
  /**
   * @param sinks - members, in reporting order.
   */
  constructor(private readonly sinks: readonly VfsMutationSink[]) {}

  /** Report one committed mutation to every member. */
  record(mutation: VfsMutation): void {
    for (const sink of this.sinks) sink.record(mutation)
  }

  /** Settle every member. */
  async flush(): Promise<void> {
    await Promise.all(this.sinks.map(sink => sink.flush()))
  }
}

/** What the host keeps for the life of the mounted filesystem. */
export interface PersistencePlan {
  /** Sink to hand the filesystem. */
  readonly sink: VfsMutationSink
  /** Seed the mounted filesystem from the most authoritative copy available. */
  restore(vfs: MemoryVfs): Promise<void>
  /**
   * Re-upload anything the store is missing, for a mirror that dropped an edge.
   * Absent when this deployment has no shared store.
   */
  reconcile?(vfs: MemoryVfs): Promise<number>
}

/**
 * Build the sink pair for one mounted filesystem.
 * @param options - persistence tuning from the page.
 * @param root - virtual root the image is mounted at.
 * @returns the sink to install, and the restore step for boot.
 */
export function persistenceSinks(options: PersistenceOptions, root: string): PersistencePlan {
  const local = new IndexedDbMutationSink({ ...options, root })
  const remoteOptions = options.remote
  const remote = remoteOptions === false || !RemoteVfsSync.supported
    ? undefined
    : new RemoteVfsSync({
      root,
      ...remoteOptions === undefined ? {} : remoteOptions,
    })
  return {
    sink: remote === undefined ? local : new FanOutMutationSink([local, remote]),
    async restore(vfs: MemoryVfs): Promise<void> {
      if (remote === undefined) {
        await local.hydrate(vfs)
        return
      }
      const [shared, own] = await Promise.all([remote.read(), local.snapshot()])
      if (shared === undefined) {
        // Store unreachable: the browser's copy is the only one there is, and
        // whatever it holds will be pushed up by the next mutation.
        await local.hydrate(vfs)
        return
      }
      const newer = newerPerPath(shared, own, remote.clockOffsetMs)
      if (newer.local.length === 0 && newer.shared.length === 0) {
        // The store answered but holds nothing: first boot after it was added.
        // Seeding from the browser keeps the models and sessions the user
        // already had instead of starting over from the image.
        const restored = await local.hydrate(vfs)
        if (restored > 0) {
          const entries = await local.snapshot()
          if (entries.length > 0) void remote.pushAll(entries)
        }
        return
      }
      // Seed only the winning side of each path. Seeding the whole store and
      // then the whole browser copy would leave whichever ran second, which is
      // how a store one batch behind used to erase a just-saved model.
      if (newer.shared.length > 0) {
        await remote.hydrate(vfs, entry => newer.sharedPaths.has(entry.path))
        await local.absorb(newer.shared)
      }
      if (newer.local.length > 0) {
        await local.hydrate(vfs, entry => newer.localPaths.has(entry.path))
        void remote.pushAll(newer.local)
      }
    },
    ...remote === undefined ? {} : { reconcile: (vfs: MemoryVfs) => remote.reconcile(vfs) },
  }
}

/** Which side of each path restore should believe. */
interface NewerSplit {
  /** Entries the deployment's store holds newer than the browser's copy. */
  readonly shared: StoredEntry[]
  /** Entries the browser holds newer than the deployment's copy. */
  readonly local: StoredEntry[]
  /** Paths of {@link shared}, for the store's own seeding filter. */
  readonly sharedPaths: Set<string>
  /** Paths of {@link local}, for the browser's seeding filter. */
  readonly localPaths: Set<string>
}

/**
 * Decide, per path, whether the deployment's copy or the browser's is current.
 *
 * A path only one side has is unambiguously that side's. A path both have is
 * decided by the write time: the deployment stamps `updated_at` on every row,
 * and the browser stamps on every write, so the later one is the write the user
 * is looking at. Timestamps are compared only after checking both are present;
 * an entry written before `savedAt` existed counts as current on the device it
 * is on, because that is the copy whose author is sitting in front of it.
 *
 * The two stamps come from **different clocks**. The deployment's is the
 * Worker's `Date.now()`; the browser's is the device's. Comparing them raw means
 * a phone whose clock runs five minutes fast outranks every row and pushes its
 * stale copy over a key another device just changed — the exact failure
 * {@link StoredEntry.savedAt} was added to prevent, reintroduced through the
 * clock. `offsetMs` is the device-minus-store difference the snapshot reports;
 * subtracting it puts both stamps on the store's clock before the comparison,
 * and adding it back keeps the local mirror uniformly in device time so the next
 * boot compares like with like.
 * @param shared - entries read from the deployment's store.
 * @param own - entries read from the browser's store.
 * @param offsetMs - device clock minus store clock, in milliseconds.
 * @param nowMs - the device's clock at merge time, for spotting stale stamps.
 * @returns the split restore seeds from.
 */
export function newerPerPath(
  shared: readonly WireEntry[],
  own: readonly StoredEntry[],
  offsetMs = 0,
  nowMs = Date.now(),
): NewerSplit {
  const sharedByPath = new Map<string, WireEntry>()
  for (const entry of shared) sharedByPath.set(entry.p, entry)
  const ownByPath = new Map<string, StoredEntry>()
  for (const entry of own) ownByPath.set(entry.path, entry)
  const result: NewerSplit = { shared: [], local: [], sharedPaths: new Set(), localPaths: new Set() }
  for (const entry of shared) {
    const mine = ownByPath.get(entry.p)
    const sendShared = (): void => {
      const path = entry.p
      result.sharedPaths.add(path)
      const base: StoredEntry = {
        path,
        mode: entry.m,
        directory: entry.d === 1,
        // Rewritten into device time: everything this function seeds into the
        // browser store has to speak the clock that store stamps with.
        ...entry.u === undefined ? {} : { savedAt: entry.u + offsetMs },
      }
      if (entry.d === 1 || entry.b === undefined) {
        result.shared.push(base)
        return
      }
      result.shared.push({ ...base, bytes: fromBase64(entry.b) })
    }
    if (mine === undefined) {
      sendShared()
      continue
    }
    const theirs = entry.u ?? 0
    const ours = mine.savedAt
    // A stamp the device could not have written: `savedAt` is `Date.now()` at
    // write time, so it can never exceed the device's own clock now. One that
    // does was written while the clock ran fast and has since been corrected —
    // the correction is exactly what makes it outrank everything, so it cannot
    // be trusted. Slack absorbs the ordinary jitter of a clock that is merely
    // being sampled twice.
    const stale = ours !== undefined && ours > nowMs + FUTURE_STAMP_SLACK_MS
    if (ours === undefined || stale || theirs > ours - offsetMs) sendShared()
    else {
      result.localPaths.add(mine.path)
      result.local.push(mine)
    }
  }
  for (const entry of own) {
    if (sharedByPath.has(entry.path)) continue
    result.localPaths.add(entry.path)
    result.local.push(entry)
  }
  return result
}
