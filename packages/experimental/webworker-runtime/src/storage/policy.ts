/**
 * Which VFS paths a durable mirror is allowed to keep.
 *
 * Both mirrors — the browser's IndexedDB write-behind and the deployment's D1
 * store — must agree, because they are the same promise to the user: "what you
 * wrote is still there after a reload, on this device and on the next one". A
 * policy mismatch would make a file durable on one device and not another, and
 * a restore that disagrees with the writer is worse than no restore.
 *
 * What is mirrored is an allowlist of files the *user* owns, not a subtree.
 * `home/` also holds bootstrap state that the image owns and that a new build
 * must be free to replace — the platform patch `home/cordis.patch.yml` and the
 * profile manifest `home/profiles/<name>/package.json` — and restoring a stale
 * copy of either leaves a profile whose patch layer and bundle list disagree
 * with the code the deployment just shipped. Mirrored: the user patch layer
 * (`home/profiles/<name>/cordis.patch.yml`, where settings and model routes
 * live), the session logs under `home/sessions`, the durable KV root
 * `home/storages` that holds the workspace registry, and `workspace/`.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/policy
 */
import { IMAGE_HOME_DIRECTORY } from '../image-layout.ts'
import { join, SEP } from '../module-system/posix-path.ts'

/** Decide whether one path belongs to the user rather than to the build. */
export type PersistPolicy = (path: string) => boolean

/**
 * Which paths the boot-time sweep re-reads: the small structured state whose
 * loss shows up as "my settings are gone".
 *
 * Narrower than {@link PersistPolicy} on purpose. `workspace/` and
 * `home/sessions/` are large, append-only, and already carried by the mutation
 * stream; re-reading all of them on every boot would cost more than the one
 * dropped mutation it might recover. The KV root and the profile patch are a
 * handful of small files, and they are exactly what a reload reads back to decide
 * whether the user still has their models and their workspace. The sweep's
 * orphan cleanup must use this same scope, or it would delete every stored
 * session log for merely being outside it.
 */
export type ReconcileScope = (path: string) => boolean

/**
 * The credential store's filename, under the home directory.
 *
 * `@deepseek-ai/dsh-credentials-local` exports this constant, but that package is
 * a host-side dependency this one does not carry, and the value is a fixed part
 * of the on-disk layout rather than something that varies by deployment: the
 * local provider resolves `$DSH_HOME/.credentials.yaml`. Duplicating it here keeps
 * the dependency graph as it is.
 */
const CREDENTIALS_FILENAME = '.credentials.yaml'

/**
 * The basename every atomic write leaves behind before it renames into place.
 *
 * `storage-json` writes `.${uuid}.tmp`, `writeFileAtomic` writes
 * `<name>.${hex}.tmp`, and the session log writes `<name>.${hex}.tmp`. Nothing a
 * user owns ends in `.tmp`, so a path matching this is never durable state: it is
 * either a write in flight or the debris of one that was interrupted. Excluded
 * from the mirror, from restore, and deleted by the boot sweep wherever it is
 * found — including inside `sessions/`, which the sweep otherwise leaves alone.
 */
export const ATOMIC_TEMP = /(?:^|\/)[^/]*\.tmp$/

/** Escape one literal path so it can stand inside a regular expression. */
function literal(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The two path sets both mirrors agree on.
 * @param root - virtual root the image is mounted at.
 * @returns the allowlist, the sweep scope, and the KV's own root.
 */
function rules(root: string): { persists: PersistPolicy; scope: ReconcileScope } {
  const storages = join(root, IMAGE_HOME_DIRECTORY, 'storages')
  // The credential store. `llm-pi-ai` drops a route from the model picker when
  // its `apiKeyEnv` does not resolve (`listModels` returns an empty array for
  // `MISSING_CREDENTIAL`), so a key that lives only in browser memory reads back
  // after a reload as "no models" while the provider itself is still configured.
  const credentials = join(root, IMAGE_HOME_DIRECTORY, CREDENTIALS_FILENAME)
  const prefixes = [
    join(root, 'workspace'),
    join(root, IMAGE_HOME_DIRECTORY, 'sessions'),
    // Durable KV: the workspace registry lives here, so a reload would
    // otherwise forget every workspace the user created.
    storages,
    // Without this, every stored API key is gone on the next boot and the
    // model picker silently empties.
    credentials,
  ]
  // Every atomic write in this codebase commits by rename: storage-json writes
  // `.${uuid}.tmp`, `writeFileAtomic` writes `<name>.${hex}.tmp`, and the session
  // log writes `<name>.${hex}.tmp`. The `.tmp` half is never the user's data —
  // mirroring it only leaves a half-written copy in the store, and a store
  // holding that temp file but not the renamed target is exactly the state that
  // reads back as "my workspace is gone". A tab closed mid-write leaves the
  // sibling behind in the filesystem too, so this skips any segment, at any
  // depth: nothing the user owns is named `*.tmp`.
  const atomicTemp = ATOMIC_TEMP
  const userPatch = new RegExp(`^${literal(join(root, IMAGE_HOME_DIRECTORY, 'profiles'))}/[^/]+/cordis\\.patch\\.yml$`)
  return {
    persists: (path: string): boolean => {
      if (atomicTemp.test(path)) return false
      if (userPatch.test(path)) return true
      return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}${SEP}`))
    },
    scope: (path: string): boolean => {
      if (userPatch.test(path)) return true
      if (path === credentials) return true
      return path === storages || path.startsWith(`${storages}${SEP}`)
    },
  }
}

/**
 * Build the allowlist for a filesystem mounted at `root`.
 * @param root - Virtual root the image is mounted at.
 * @returns Predicate over absolute VFS paths.
 */
export function createPersistPolicy(root: string): PersistPolicy {
  return rules(root).persists
}

/**
 * Build the boot sweep's scope for a filesystem mounted at `root`.
 * @param root - Virtual root the image is mounted at.
 * @returns Predicate over absolute VFS paths.
 */
export function createReconcileScope(root: string): ReconcileScope {
  return rules(root).scope
}
