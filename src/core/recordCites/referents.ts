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

/** The cites a sentence's `Id.` or `supra` refers back through, nearest first, as written. */
export function referredThrough(cites: readonly LinkedRecordCite[], index: number): string[] {
  const through: string[] = [];
  const seen = new Set<number>();
  for (
    let referent = cites[index]?.referent;
    typeof referent === "number" && !seen.has(referent);
    referent = cites[referent]?.referent
  ) {
    seen.add(referent);
    through.push(cites[referent]?.raw ?? "");
  }
  return through;
}

function onlyIndex(text: string, words: string): number | null {
  const first = text.indexOf(words);
  return first >= 0 && text.indexOf(words, first + 1) < 0 ? first : null;
}

/** Where the sentence is in the Note: at its place, else where its words are, once. */
function positionIn(
  note: readonly NoteParagraph[],
  claim: string,
  place: RecordCitePlace | undefined,
): { paragraph: number; from: number } | null {
  const own = place ? note.findIndex((paragraph) => paragraph.blockId === place.blockId) : -1;
  const paragraph = note[own];
  if (place && paragraph) {
    if (paragraph.text.startsWith(claim, place.from)) return { paragraph: own, from: place.from };
    const from = onlyIndex(paragraph.text, claim);
    if (from !== null) return { paragraph: own, from };
  }
  const found = note.flatMap((each, index) => {
    const from = each.text.indexOf(claim);
    if (from < 0) return [];
    return each.text.indexOf(claim, from + 1) < 0 ? [{ paragraph: index, from }] : [null, null];
  });
  return found.length === 1 ? (found[0] ?? null) : null;
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
  const own = recordCiteTokens(claim);
  if (!own.some((token) => token.kind === "cite")) return { cites: [], own: 0 };
  const note = noteNow && refersBack(own) ? noteNow() : undefined;
  const position = note ? positionIn(note, claim, place) : null;
  const before =
    note && position
      ? [
          ...note
            .slice(0, position.paragraph)
            .flatMap((paragraph) => recordCiteTokens(paragraph.text)),
          ...recordCiteTokens(note[position.paragraph]?.text.slice(0, position.from) ?? ""),
        ]
      : [];
  const linked = linkRecordCites([...before, ...own]);
  const isOwn = (cite: { token: number } | undefined) =>
    cite !== undefined && cite.token >= before.length;
  const needed = new Set<number>();
  const need = (index: number) => {
    if (needed.has(index)) return;
    needed.add(index);
    const referent = linked[index]?.referent;
    if (typeof referent === "number") need(referent);
  };
  linked.forEach((cite, index) => {
    if (isOwn(cite)) need(index);
  });
  const kept = [...needed].sort((a, b) => a - b);
  const renumbered = new Map(kept.map((index, at) => [index, at]));
  const cites = kept.flatMap((index): LinkedRecordCite[] => {
    const found = linked[index];
    if (!found) return [];
    const { token: _, referent, ...cite } = found;
    return [
      referent === undefined
        ? cite
        : { ...cite, referent: referent === null ? null : (renumbered.get(referent) ?? null) },
    ];
  });
  return { cites, own: kept.filter((index) => isOwn(linked[index])).length };
}

/** A Note as a sentence's `Id.` and `supra` read it: its paragraphs, read only when needed, and where the sentence starts. */
export interface RecordCiteNote {
  paragraphs(): readonly NoteParagraph[];
  place?: RecordCitePlace;
}

/** What each of a sentence's own `Id.` and `supra` refers back through in its Note now, in order. */
export function shortFormsThrough(claim: string, note: RecordCiteNote): string[][] {
  const { cites, own } = sentenceRecordCites(claim, note.place, () => note.paragraphs());
  const first = cites.length - own;
  return cites.flatMap((cite, index) =>
    index >= first && cite.referent !== undefined ? [referredThrough(cites, index)] : [],
  );
}

/** A linked cite as the resolver reads it. */
export const resolverInput = (cite: LinkedRecordCite): RecordCiteInput => ({
  ...cite.result,
  from: cite.from,
  to: cite.to,
  ...(cite.referent !== undefined && { referent: cite.referent }),
});
