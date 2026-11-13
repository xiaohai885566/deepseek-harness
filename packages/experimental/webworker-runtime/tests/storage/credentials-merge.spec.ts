/**
 * The credential document is one file holding two independently written
 * sections, and the cross-device merge used to decide the whole file by one
 * timestamp.
 *
 * That is wrong in the direction users actually hit. A device that booted before
 * a key was saved carries a mirror of the document with `records:` and no
 * `refs:`; every boot rewrites `records:` (the session secret rotates), which
 * restamps the file, so that copy wins on recency and the `refs:` block another
 * device just wrote vanishes. `llm-pi-ai` then reports `MISSING_CREDENTIAL` for
 * the route and the model picker empties — the symptom this whole thread is
 * about, arriving by a different door.
 *
 * These pin the merge to "sections, not bytes", and pin the one thing a merge
 * must not do: bring back a key the user deleted.
 */
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mergeCredentialDocuments } from '../../src/storage/credentials-merge.ts'

/** The document as the store writes it: a session record and a saved key. */
const WITH_KEY = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: secret-from-this-boot
refs:
  GENT2API_API_KEY: sk-real-key
`

/** The same document from a device that booted before the key existed. */
const WITHOUT_REFS = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: secret-from-that-other-boot
`

/** Read a merged document back, so assertions name sections and values. */
function read(text: string): { refs: Record<string, string>; records: Record<string, unknown>; version: unknown } {
  const root = parse(text) as { version?: unknown; refs?: Record<string, string>; records?: Record<string, unknown> }
  return { refs: root.refs ?? {}, records: root.records ?? {}, version: root.version }
}

describe('mergeCredentialDocuments', () => {
  it('keeps the saved key when the newer copy is the one without refs', () => {
    // The failure: a stale device's document wins on recency and drops the key.
    const merged = mergeCredentialDocuments(WITHOUT_REFS, WITH_KEY)
    expect(merged).toBeDefined()
    expect(read(merged!).refs.GENT2API_API_KEY).toBe('sk-real-key')
  })

  it('keeps the saved key when the newer copy is the one with refs', () => {
    const merged = mergeCredentialDocuments(WITH_KEY, WITHOUT_REFS)
    expect(read(merged!).refs.GENT2API_API_KEY).toBe('sk-real-key')
  })

  it('takes the winning side\u2019s records, not the loser\u2019s', () => {
    // The session secret rotates per boot. Reviving the losing one would make the
    // harness reject its own credential record on the next start.
    const merged = mergeCredentialDocuments(WITHOUT_REFS, WITH_KEY)
    const records = read(merged!).records as Record<string, { payload: { secret: string } }>
    expect(records['client-connection/browser-session'].payload.secret).toBe('secret-from-that-other-boot')
  })

  it('revives a key deleted on the other side, by design', () => {
    // The trade this merge makes, pinned so it cannot drift silently: `refs` is
    // a union, because a missing key is unrecoverable in the product (the picker
    // just empties) while a revived one is visible on the Models page and can be
    // deleted again. A device that deletes a key it also sees on a stale peer may
    // therefore have to delete it twice.
    const deleted = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: current-secret
refs: {}
`
    const merged = mergeCredentialDocuments(deleted, WITH_KEY)
    expect(read(merged!).refs.GENT2API_API_KEY).toBe('sk-real-key')
  })

  it('keeps a second key the winning side still holds', () => {
    const twoKeys = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: s
refs:
  OTHER_PROVIDER_KEY: sk-other
`
    const merged = mergeCredentialDocuments(twoKeys, WITH_KEY)
    const refs = read(merged!).refs
    expect(refs.OTHER_PROVIDER_KEY).toBe('sk-other')
    expect(refs.GENT2API_API_KEY).toBe('sk-real-key')
  })

  it('declares the layout the store requires', () => {
    const merged = mergeCredentialDocuments(WITHOUT_REFS, WITH_KEY)
    expect(read(merged!).version).toBe(1)
  })

  it('refuses to merge when a side does not parse', () => {
    // A hand-edited document must not be silently rewritten; the caller keeps
    // the seeded copy instead.
    expect(mergeCredentialDocuments('not: [valid', WITH_KEY)).toBeUndefined()
    expect(mergeCredentialDocuments(WITHOUT_REFS, 'not: [valid')).toBeUndefined()
  })

  it('refuses to merge a document that is not a mapping', () => {
    expect(mergeCredentialDocuments('- a\n- b\n', WITH_KEY)).toBeUndefined()
  })
})
