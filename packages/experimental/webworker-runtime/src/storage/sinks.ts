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
import { RemoteVfsSync } from './remote.ts'
import type { MemoryVfs } from './memory.ts'
import type { VfsMutation, VfsMutationSink } from './types.ts'

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
      if (remote !== undefined) {
        const shared = await remote.hydrate(vfs)
        if (shared.length > 0) {
          // Keep the offline copy in step with the shared one, so a later boot
          // without a network restores this workspace rather than an older one.
          await local.absorb(shared)
          return
        }
      }
      const restored = await local.hydrate(vfs)
      if (remote !== undefined && restored > 0) {
        const entries = await local.snapshot()
        if (entries.length > 0) void remote.pushAll(entries)
      }
    },
  }
}
