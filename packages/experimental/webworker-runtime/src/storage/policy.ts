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
 * Build the allowlist for a filesystem mounted at `root`.
 * @param root - Virtual root the image is mounted at.
 * @returns Predicate over absolute VFS paths.
 */
export function createPersistPolicy(root: string): PersistPolicy {
  const prefixes = [
    join(root, 'workspace'),
    join(root, IMAGE_HOME_DIRECTORY, 'sessions'),
    // Durable KV: the workspace registry lives here, so a reload would
    // otherwise forget every workspace the user created.
    join(root, IMAGE_HOME_DIRECTORY, 'storages'),
  ]
  const escaped = join(root, IMAGE_HOME_DIRECTORY, 'profiles').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const userPatch = new RegExp(`^${escaped}/[^/]+/cordis\\.patch\\.yml$`)
  return (path: string): boolean => {
    if (userPatch.test(path)) return true
    return prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}${SEP}`))
  }
}
