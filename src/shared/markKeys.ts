import type * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  COMMENT_MARK,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../core/api";

/**
 * Where a mark with an identity of its own is kept in the Note's Yjs text (#2996): a sentence's
 * check, a comment, or an assistant's change is under a format key of its own, the mark's name,
 * `--` and eight characters of its id. Kept under the mark's name alone, two such marks side by
 * side shared the marker that ends one and starts the next, and two copies writing it at once could
 * leave the second with the first's value. Notes saved before are read as they are and converted
 * when the core opens them.
 */
export const KEYED_MARKS = [
  CLAIM_CHECK_MARK,
  COMMENT_MARK,
  PROPOSAL_INSERT_MARK,
  PROPOSAL_DELETE_MARK,
] as const;
export type KeyedMark = (typeof KEYED_MARKS)[number];

/** A mark's format key for the thing with this id: y-tiptap's form for a mark keyed by more than its name. */
export function markKeyOf(name: KeyedMark, id: unknown): string {
  if (typeof id !== "string" || id === "") return name;
  let hash = 0x811c9dc5;
  for (let at = 0; at < id.length; at++) {
    hash ^= id.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${name}--${hash.toString(16).padStart(8, "0")}`;
}

export const checkKeyOf = (id: unknown): string => markKeyOf(CLAIM_CHECK_MARK, id);

/** Whether a format key holds this mark, under its own key or, as Notes saved before kept it, its name. */
const isMarkKey = (name: KeyedMark, key: string): boolean =>
  key === name ||
  (key.startsWith(`${name}--`) && /^[a-zA-Z0-9+/=]{8}$/.test(key.slice(name.length + 2)));

export const isCheckKey = (key: string): boolean => isMarkKey(CLAIM_CHECK_MARK, key);

/** A mark as one format key of a run holds it. */
interface KeyedValue {
  key: string;
  attrs: unknown;
}

const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

/**
 * Which of the checks on the same words counts (#2996), the one rule for the core's reader and the
 * editor's: a kept check, then the later `checkedAt`, then the first key. Two checks meet on words
 * only when two copies of the Note gave one sentence a check at the same moment.
 */
function whichCheckCounts(checks: readonly KeyedValue[]): number {
  let best = 0;
  checks.forEach((check, at) => {
    const other = checks[best];
    if (at === best || !other) return;
    const kept = fieldOf(check.attrs, "kept") === true;
    const otherKept = fieldOf(other.attrs, "kept") === true;
    if (kept !== otherKept) {
      if (kept) best = at;
      return;
    }
    const when = String(fieldOf(check.attrs, "checkedAt") ?? "");
    const otherWhen = String(fieldOf(other.attrs, "checkedAt") ?? "");
    if (when !== otherWhen) {
      if (when > otherWhen) best = at;
      return;
    }
    if (check.key < other.key) best = at;
  });
  return best;
}

/** Which of two comments, or two assistant changes, on the same words is read: the first key. */
function whichByKey(values: readonly KeyedValue[]): number {
  let best = 0;
  values.forEach((value, at) => {
    if (value.key < (values[best]?.key ?? "")) best = at;
  });
  return best;
}

const RULES: Record<KeyedMark, (values: readonly KeyedValue[]) => number> = {
  [CLAIM_CHECK_MARK]: whichCheckCounts,
  [COMMENT_MARK]: whichByKey,
  [PROPOSAL_INSERT_MARK]: whichByKey,
  [PROPOSAL_DELETE_MARK]: whichByKey,
};

/** The value of a mark that counts among a run's formats, or null when the run has none. */
export function countingMarkOf(
  name: KeyedMark,
  attributes: Record<string, unknown> | undefined,
): KeyedValue | null {
  const values = Object.entries(attributes ?? {})
    .filter(([key, attrs]) => isMarkKey(name, key) && attrs != null)
    .map(([key, attrs]) => ({ key, attrs }));
  return values[RULES[name](values)] ?? null;
}

export const countingCheckOf = (attributes: Record<string, unknown> | undefined) =>
  countingMarkOf(CLAIM_CHECK_MARK, attributes);

/** The value of a mark a run holds, under whichever of its keys counts; undefined for none. */
export const markValueOf = (
  name: KeyedMark,
  attributes: Record<string, unknown> | undefined,
): unknown => countingMarkOf(name, attributes)?.attrs;

export const hasMarkIn = (name: KeyedMark, attributes: Record<string, unknown> | undefined) =>
  countingMarkOf(name, attributes) !== null;

/**
 * The formats that put `value` on a stretch of `text` as the mark `name`: under its own key, and no
 * other of that mark's keys the text holds.
 */
export function keyedFormats(
  text: Y.XmlText,
  name: KeyedMark,
  value: { id?: unknown },
): Record<string, unknown> {
  const own = markKeyOf(name, value.id);
  const formats: Record<string, unknown> = { [own]: value };
  for (const run of text.toDelta() as { attributes?: Record<string, unknown> }[])
    for (const key of Object.keys(run.attributes ?? {}))
      if (key !== own && isMarkKey(name, key)) formats[key] = null;
  return formats;
}

/**
 * What the editor's Yjs sync is told of a keyed mark (patches/y-tiptap/marks.mjs): the key each
 * value is kept under, and which value it reads when two meet on the same words.
 */
export const ySyncOf = (name: KeyedMark) => ({
  yKey: (attrs: Record<string, unknown>) => markKeyOf(name, attrs.id),
  yPick: RULES[name],
});

/** The keyed mark a format key holds, if any. */
export const keyedMarkOf = (key: string): KeyedMark | null =>
  KEYED_MARKS.find((name) => isMarkKey(name, key)) ?? null;
