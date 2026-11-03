import { type RecordCiteOccurrence, type RecordCiteToken, recordCiteTokens } from "./parser";
import type { RecordCiteInput } from "./resolver";

export interface LinkedRecordCite extends RecordCiteOccurrence {
  /** An `Id.`'s or a `supra`'s record item, by its index in the same list; null when it can't be told. */
  referent?: number | null;
}

/** A paragraph of a Note, as its checks read it: an inline node as U+FFFC. */
export interface NoteParagraph {
  blockId: string;
  text: string;
}

/** Where a checked sentence starts in its Note. */
export interface RecordCitePlace {
  blockId: string;
  from: number;
}

const sameSource = (earlier: string | null, named: string) =>
  earlier !== null && named !== "" && (earlier === named || earlier.startsWith(`${named} `));

const aliasOf = (cite: RecordCiteOccurrence | undefined) =>
  cite?.result.status === "parsed" ? cite.result.sourceAlias : null;

const shortForm = (cite: RecordCiteOccurrence) =>
  cite.result.kind === "id" || cite.result.kind === "supra" ? cite.result.kind : null;

/** Where a deposition's printed page and lines are named: what an `Id.` with nothing before it can only be. */
const atLines = (cite: RecordCiteOccurrence) =>
  cite.result.status === "parsed" &&
  cite.result.location?.kind === "page" &&
  cite.result.location.lines !== undefined;

/**
 * The record cites in reading order, each `Id.` and `supra` linked to the record item it refers
 * back to. Another authority ends an `Id.` chain: an `Id.` after one is that authority's, not a
 * record cite, so it isn't listed. An `Id.` with nothing before it is listed, referring to
 * nothing, only when it names a deposition's page and lines. A `supra` goes back to the latest
 * cite its name names, past other authorities.
 */
export function linkRecordCites(
  tokens: readonly RecordCiteToken[],
): (LinkedRecordCite & { token: number })[] {
  const linked: (LinkedRecordCite & { token: number })[] = [];
  let last: number | "nothing" | "authority" = "nothing";
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "authority") {
      last = "authority";
      continue;
    }
    const { kind: _, ...occurrence } = token;
    const cite = { ...occurrence, token: index };
    const { result } = cite;
    const form = shortForm(cite);
    if (form === "id") {
      if (last === "authority" || (last === "nothing" && !atLines(cite))) continue;
      linked.push({ ...cite, referent: last === "nothing" ? null : last });
    } else if (form === "supra" && result.status === "parsed") {
      const named = result.sourceAlias ?? "";
      const earlier = linked.flatMap((each, index) =>
        each.result.status === "parsed" &&
        each.result.reference === null &&
        sameSource(each.result.sourceAlias, named)
          ? [index]
          : [],
      );
      const sources = new Set(earlier.map((index) => aliasOf(linked[index])));
      linked.push({ ...cite, referent: sources.size === 1 ? (earlier.at(-1) ?? null) : null });
    } else {
      linked.push(cite);
    }
    last = linked.length - 1;
  }
  return linked;
}

/**
 * What each short form's reading rests on, as written, worked out in one pass: the record cite
 * its chain ends at and, for one that names no place of its own, the nearest cite before it that
 * does; empty for one that refers to nothing. Undefined for a direct cite.
 */
export function readThrough(cites: readonly LinkedRecordCite[]): (string[] | undefined)[] {
  const source: (number | null)[] = [];
  const place: (number | null)[] = [];
  return cites.map((cite, index) => {
    if (cite.referent === undefined) {
      source[index] = index;
      place[index] = index;
      return undefined;
    }
    const referent =
      typeof cite.referent === "number" && cite.referent < index ? cite.referent : null;
    const located = cite.result.status === "parsed" && cite.result.location !== null;
    const from = referent === null ? null : (source[referent] ?? null);
    source[index] = from;
    place[index] = located ? index : referent === null ? null : (place[referent] ?? null);
    if (from === null || referent === null) return [];
    const at = located ? null : (place[referent] ?? null);
    const named = cites[from]?.raw ?? "";
    return at !== null && at !== from ? [cites[at]?.raw ?? "", named] : [named];
  });
}

function onlyIndex(text: string, words: string): number | null {
  const first = text.indexOf(words);
  return first >= 0 && text.indexOf(words, first + 1) < 0 ? first : null;
}

/** The most paragraphs' cites kept between readings: a Note's, many times over. */
const KEPT_PARAGRAPHS = 4096;
const tokensByText = new Map<string, RecordCiteToken[]>();

/**
 * A text's tokens, read once: the editor works every check out again at each keystroke (#1709),
 * when only the paragraph typed in has new text.
 */
function tokensOf(text: string): RecordCiteToken[] {
  const known = tokensByText.get(text);
  if (known) return known;
  const tokens = recordCiteTokens(text);
  if (tokensByText.size >= KEPT_PARAGRAPHS) tokensByText.clear();
  tokensByText.set(text, tokens);
  return tokens;
}

/** A Note's record cites: each paragraph's read once, linked in one pass. */
interface LinkedNote {
  paragraphs: readonly NoteParagraph[];
  byBlock: ReadonlyMap<string, number>;
  linked: readonly (LinkedRecordCite & { token: number })[];
  /** For each paragraph, where its cites start in `linked`; one more for the end. */
  starts: readonly number[];
  through: readonly (string[] | undefined)[];
}

const linkedNotes = new WeakMap<readonly NoteParagraph[], LinkedNote>();

function linkedNoteOf(paragraphs: readonly NoteParagraph[]): LinkedNote {
  const known = linkedNotes.get(paragraphs);
  if (known) return known;
  const tokens: RecordCiteToken[] = [];
  const tokenParagraph: number[] = [];
  const byBlock = new Map<string, number>();
  for (const [index, paragraph] of paragraphs.entries()) {
    if (!byBlock.has(paragraph.blockId)) byBlock.set(paragraph.blockId, index);
    for (const token of tokensOf(paragraph.text)) {
      tokens.push(token);
      tokenParagraph.push(index);
    }
  }
  const linked = linkRecordCites(tokens);
  const starts: number[] = [];
  let at = 0;
  for (let index = 0; index <= paragraphs.length; index++) {
    while (at < linked.length && (tokenParagraph[linked[at]?.token ?? 0] ?? 0) < index) at++;
    starts.push(at);
  }
  const note = { paragraphs, byBlock, linked, starts, through: readThrough(linked) };
  linkedNotes.set(paragraphs, note);
  return note;
}

/** Where the sentence is in the Note: at its place, else where its words are, once. */
function positionIn(
  note: LinkedNote,
  claim: string,
  place: RecordCitePlace | undefined,
): { paragraph: number; from: number } | null {
  const own = place ? note.byBlock.get(place.blockId) : undefined;
  const text = own === undefined ? undefined : note.paragraphs[own]?.text;
  if (place && own !== undefined && text !== undefined) {
    if (text.startsWith(claim, place.from)) return { paragraph: own, from: place.from };
    const from = onlyIndex(text, claim);
    if (from !== null) return { paragraph: own, from };
  }
  const found = note.paragraphs.flatMap((each, index) => {
    const from = each.text.indexOf(claim);
    if (from < 0) return [];
    return each.text.indexOf(claim, from + 1) < 0 ? [{ paragraph: index, from }] : [null, null];
  });
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** The indices in `note.linked` of the cites of the sentence at `position`, `length` long. */
function citesAt(
  note: LinkedNote,
  position: { paragraph: number; from: number },
  length: number,
): number[] {
  const own: number[] = [];
  const end = note.starts[position.paragraph + 1] ?? note.linked.length;
  for (let index = note.starts[position.paragraph] ?? end; index < end; index++) {
    const cite = note.linked[index];
    if (cite && cite.from >= position.from && cite.to <= position.from + length) own.push(index);
  }
  return own;
}

/** Whether a sentence's own `Id.` or `supra` may refer to something before the sentence. */
function refersBack(tokens: readonly RecordCiteToken[]): boolean {
  let first = true;
  for (const token of tokens) {
    if (token.kind === "authority") {
      first = false;
      continue;
    }
    const form = shortForm(token);
    if (form === "supra") return true;
    if (form === "id") {
      if (first) return true;
      continue;
    }
    first = false;
  }
  return false;
}

export interface SentenceRecordCites {
  /** The sentence's own cites and, before them, the earlier record items they refer to. */
  cites: LinkedRecordCite[];
  /** How many of `cites`, at the end, are the sentence's own, its offsets in `claim`. */
  own: number;
}

/** A sentence's cites as its Note reads them, or null when the Note needn't or can't be read. */
function inNote(
  claim: string,
  own: readonly RecordCiteToken[],
  place: RecordCitePlace | undefined,
  noteNow: (() => readonly NoteParagraph[]) | undefined,
): { note: LinkedNote; own: number[]; from: number } | null {
  if (!noteNow || !refersBack(own)) return null;
  const note = linkedNoteOf(noteNow());
  const position = positionIn(note, claim, place);
  return position
    ? { note, own: citesAt(note, position, claim.length), from: position.from }
    : null;
}

const withoutToken = ({ token: _, ...cite }: LinkedRecordCite & { token: number }) => cite;

/**
 * A sentence's record cites, with what its `Id.` and `supra` refer to worked out from the Note
 * as it reads now (#1709): nothing about an earlier check is kept, so checks in any order, in
 * the background or at once, read the same.
 */
export function sentenceRecordCites(
  claim: string,
  place?: RecordCitePlace,
  noteNow?: () => readonly NoteParagraph[],
): SentenceRecordCites {
  const own = tokensOf(claim);
  if (!own.some((token) => token.kind === "cite")) return { cites: [], own: 0 };
  const read = inNote(claim, own, place, noteNow);
  if (!read) {
    const linked = linkRecordCites(own).map(withoutToken);
    return { cites: linked, own: linked.length };
  }
  const { note, from } = read;
  const needed = new Set<number>();
  for (const index of read.own) {
    for (
      let at: number | null | undefined = index;
      typeof at === "number" && !needed.has(at);
      at = note.linked[at]?.referent
    ) {
      needed.add(at);
    }
  }
  const kept = [...needed].sort((a, b) => a - b);
  const renumbered = new Map(kept.map((index, at) => [index, at]));
  const ownSet = new Set(read.own);
  const cites = kept.flatMap((index): LinkedRecordCite[] => {
    const found = note.linked[index];
    if (!found) return [];
    const { referent, ...cite } = withoutToken(found);
    const placed = ownSet.has(index)
      ? { ...cite, from: cite.from - from, to: cite.to - from }
      : cite;
    return [
      referent === undefined
        ? placed
        : { ...placed, referent: referent === null ? null : (renumbered.get(referent) ?? null) },
    ];
  });
  return { cites, own: read.own.length };
}

/** A Note as a sentence's `Id.` and `supra` read it: its paragraphs, read only when needed, and where the sentence starts. */
export interface RecordCiteNote {
  paragraphs(): readonly NoteParagraph[];
  place?: RecordCitePlace;
}

/**
 * What each of a sentence's own `Id.` and `supra` reads through in its Note now (`readThrough`),
 * in order. Each paragraph's cites are read once for the whole Note, however many sentences ask.
 */
export function shortFormsThrough(claim: string, note: RecordCiteNote): string[][] {
  const own = tokensOf(claim);
  if (!own.some((token) => token.kind === "cite")) return [];
  const read = inNote(claim, own, note.place, () => note.paragraphs());
  if (!read) {
    const linked = linkRecordCites(own);
    const through = readThrough(linked);
    return linked.flatMap((cite, index) =>
      cite.referent === undefined ? [] : [through[index] ?? []],
    );
  }
  return read.own.flatMap((index) =>
    read.note.linked[index]?.referent === undefined ? [] : [read.note.through[index] ?? []],
  );
}

/** A linked cite as the resolver reads it. */
export const resolverInput = (cite: LinkedRecordCite): RecordCiteInput => ({
  ...cite.result,
  from: cite.from,
  to: cite.to,
  ...(cite.referent !== undefined && { referent: cite.referent }),
});
