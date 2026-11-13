/**
 * Section-level merge for the credential document.
 *
 * The credential store is one file with two halves that are written by two
 * unrelated parties: `records:` is machine-written by the harness itself (the
 * browser-session grant), and `refs:` is written only when a human saves a key
 * on the Models page. The filesystem sees one path, so the cross-device merge
 * decides the whole file by one timestamp — and the halves lose each other's
 * writes.
 *
 * The losing direction is the one users hit: a device that booted before the key
 * was saved holds a mirror of that file with `records` and no `refs`, and every
 * boot rewrites `records` (the session secret rotates), which restamps the whole
 * file. Its copy is then genuinely the newer one, it wins, and the `refs:` block
 * another device just wrote disappears. `llm-pi-ai` then reports
 * `MISSING_CREDENTIAL` for the route and the model picker empties.
 *
 * A per-path timestamp cannot fix that, because the file is not one fact. This
 * merges it as what it is: the outer document's other keys, and `refs:` /
 * `records:`, are resolved independently, and a `refs` key deleted on one side
 * stays deleted rather than resurrecting from the other side's older copy.
 *
 * Deliberately tolerant: an unparsable document on either side falls back to
 * "this side wins whole", which is the old behaviour. A merge that guessed here
 * could resurrect a key the user deliberately removed.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/credentials-merge
 */
import { parse, stringify } from 'yaml'

/** The section whose entries are a user's saved secrets, keyed by reference name. */
const REFS = 'refs'

/** The section whose entries are machine-written records, keyed by credential name. */
const RECORDS = 'records'

/** Keys the document format puts beside the two sections. */
const VERSION = 'version'

/** One side's view of a credential document, flattened to comparable parts. */
interface ParsedDocument {
  /** Top-level scalars other than the two sections. */
  readonly scalars: Record<string, unknown>
  /** `refs:` entries. */
  readonly refs: Record<string, string>
  /** `records:` entries, kept as raw nodes: records are replaced wholesale, never edited. */
  readonly records: Record<string, unknown>
}

/**
 * Read a credential document into its parts.
 * @param text - document text, or undefined when that side has no copy.
 * @returns the parts, or undefined when the text is absent or not a mapping.
 */
function parseDocument(text: string | undefined): ParsedDocument | undefined {
  if (text === undefined || text.trim() === '') return undefined
  let root: unknown
  try {
    root = parse(text)
  } catch {
    return undefined
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return undefined
  const scalars: Record<string, unknown> = {}
  const refs: Record<string, string> = {}
  const records: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (key === REFS) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      for (const [ref, entry] of Object.entries(value as Record<string, unknown>)) {
        // A reference is a name over a secret string; anything else is not one,
        // and copying it forward would spread a shape no writer produces.
        if (typeof entry === 'string' && entry !== '') refs[ref] = entry
      }
      continue
    }
    if (key === RECORDS) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      for (const [name, entry] of Object.entries(value as Record<string, unknown>)) records[name] = entry
      continue
    }
    scalars[key] = value
  }
  return { scalars, refs, records }
}

/**
 * Render merged parts back to document text.
 * @param parts - the merged document.
 * @returns YAML text ending in a newline.
 */
function renderDocument(parts: ParsedDocument): string {
  const root: Record<string, unknown> = {}
  // `version` first: the store's own reader rejects a document that does not
  // declare the layout it expects, and it is the one scalar that is not advisory.
  if (parts.scalars[VERSION] !== undefined) root[VERSION] = parts.scalars[VERSION]
  for (const [key, value] of Object.entries(parts.scalars)) {
    if (key !== VERSION) root[key] = value
  }
  if (Object.keys(parts.records).length > 0) root[RECORDS] = parts.records
  if (Object.keys(parts.refs).length > 0) root[REFS] = parts.refs
  const text = stringify(root, { lineWidth: 0 })
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Merge two copies of the credential document, section by section.
 *
 * `records:` is machine-written and comes from `winner`: the browser-session
 * secret rotates on every boot, and reviving the losing one makes the harness
 * reject its own record on the next start.
 *
 * `refs:` is a **union**. That is a deliberate asymmetry, because the section
 * cannot distinguish the two ways a key goes missing from one side:
 *
 * - A device that booted before the key was saved has no `refs:` at all. Taking
 *   that side whole drops the key, and the model picker empties — the failure
 *   this merge exists to stop.
 * - A device stripped of a *different* provider's key would likewise drop it
 *   under a winner-takes-section rule, which is the same failure at a smaller
 *   scale rather than a different one.
 * - A key the user really deleted is absent from the newer side, and a stale
 *   device can revive it once.
 *
 * Of those, only the last is recoverable in the product: a resurrected key shows
 * up on the Models page and can be deleted again, while a silently dropped key
 * looks exactly like "the harness lost my model" and costs a round of debugging.
 * So the union wins, and the cost is that a deletion made on one device may need
 * repeating on another that had not caught up yet.
 * @param winner - the document belonging to the side the merge chose.
 * @param loser - the other side's document.
 * @returns merged document text, or undefined when neither side parses (the
 * caller then keeps the winner byte for byte).
 */
export function mergeCredentialDocuments(winner: string, loser: string | undefined): string | undefined {
  const winning = parseDocument(winner)
  if (winning === undefined) return undefined
  const losing = parseDocument(loser)
  if (losing === undefined) return undefined
  const refs: Record<string, string> = { ...losing.refs, ...winning.refs }
  const records: Record<string, unknown> = hasSection(winner, RECORDS)
    ? { ...winning.records }
    : { ...losing.records, ...winning.records }
  const scalars: Record<string, unknown> = { ...losing.scalars, ...winning.scalars }
  return renderDocument({ scalars, refs, records })
}

/**
 * Whether a document carries a section at all, even an empty one.
 * @param text - document text.
 * @param section - section name.
 * @returns true when the parsed root has that key.
 */
function hasSection(text: string, section: string): boolean {
  let root: unknown
  try {
    root = parse(text)
  } catch {
    return false
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return false
  return Object.hasOwn(root as Record<string, unknown>, section)
}
