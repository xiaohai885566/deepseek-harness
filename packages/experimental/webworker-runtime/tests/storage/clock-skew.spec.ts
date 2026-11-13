/**
 * Cross-device merge under clock skew.
 *
 * Both sides of the merge stamp their writes: the deployment's store stamps
 * `updated_at` from the Worker's clock, the browser stamps `savedAt` from the
 * device's. Restore compares those numbers, so a device whose clock runs fast
 * wins every comparison by arithmetic alone — and pushes its stale copy over a
 * change another device had just made. The visible symptom is the one this
 * merge exists to prevent: a key typed on the phone disappears when the laptop
 * next reloads.
 *
 * The store therefore publishes its own clock in the snapshot, and the merge
 * subtracts the measured offset before comparing. These tests pin both halves:
 * a skewed device must lose to a newer stored row, and an unskewed device must
 * still win with its own newer copy.
 */
import { describe, expect, it } from 'vitest'
import { newerPerPath } from '../../src/storage/sinks.ts'
import type { WireEntry } from '../../src/storage/remote.ts'
import type { StoredEntry } from '../../src/storage/indexeddb.ts'

const PATH = '/dsh/home/.credentials.yaml'

/** A row as the deployment stores it: `u` is the Worker's clock. */
function stored(bytes: string, u: number): WireEntry {
  return { p: PATH, d: 0, m: 0o600, b: btoa(bytes), u }
}

/** A row as the browser mirror holds it: `savedAt` is the device's clock. */
function mirrored(bytes: string, savedAt: number): StoredEntry {
  return {
    path: PATH,
    bytes: new TextEncoder().encode(bytes),
    mode: 0o600,
    directory: false,
    savedAt,
  }
}

/** Read the payload this merge would seed, so assertions name the winner. */
function winner(shared: readonly WireEntry[], own: readonly StoredEntry[], offsetMs: number): string {
  const split = newerPerPath(shared, own, offsetMs)
  if (split.sharedPaths.has(PATH)) return 'store'
  if (split.localPaths.has(PATH)) return 'device'
  return 'neither'
}

describe('newerPerPath under clock skew', () => {
  const STORE_CLOCK = 1_800_000_000_000

  it('gives a device running five minutes fast the store copy, not its own', () => {
    // The phone changed the key a minute ago on the store's clock. This device
    // still holds the old value, and its clock reads five minutes ahead, so the
    // raw numbers claim its stale copy is the newer one.
    const shared = [stored('new-key-from-phone', STORE_CLOCK + 60_000)]
    const own = [mirrored('old-key', STORE_CLOCK + 300_000)]
    expect(winner(shared, own, 300_000)).toBe('store')
  })

  it('still lets this device keep a copy it really did write later', () => {
    // Same device, same skew, but its copy is a minute newer *after* correction.
    const shared = [stored('older-value', STORE_CLOCK)]
    const own = [mirrored('just-typed-here', STORE_CLOCK + 120_000 + 300_000)]
    expect(winner(shared, own, 300_000)).toBe('device')
  })

  it('behaves exactly as before when the clocks agree', () => {
    const shared = [stored('store-value', STORE_CLOCK + 1_000)]
    const own = [mirrored('device-value', STORE_CLOCK)]
    expect(winner(shared, own, 0)).toBe('store')
    const sharedOld = [stored('store-value', STORE_CLOCK)]
    const ownNew = [mirrored('device-value', STORE_CLOCK + 1_000)]
    expect(winner(sharedOld, ownNew, 0)).toBe('device')
  })

  it('stamps the seeded store copy in device time', () => {
    // Everything this merge hands the browser store has to speak the clock that
    // store writes with, or the next boot compares two clocks again.
    const shared = [stored('from-store', STORE_CLOCK)]
    const split = newerPerPath(shared, [], 300_000)
    expect(split.shared[0].savedAt).toBe(STORE_CLOCK + 300_000)
  })

  it('lets a device far behind win a row it wrote after the store did', () => {
    // A device four minutes slow: raw arithmetic would hand every row to the
    // store even when the device's copy is genuinely newer.
    const shared = [stored('store-value', STORE_CLOCK)]
    const own = [mirrored('device-value', STORE_CLOCK + 60_000 - 240_000)]
    expect(winner(shared, own, -240_000)).toBe('device')
  })

  it('takes a path only the store holds', () => {
    expect(winner([stored('only-here', STORE_CLOCK)], [], 300_000)).toBe('store')
  })

  it('takes a path only the device holds', () => {
    expect(winner([], [mirrored('only-here', STORE_CLOCK)], 300_000)).toBe('device')
  })
})
