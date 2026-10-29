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

// A name that says it is a record item's ("Smith Decl., supra"), unlike a decision's ("Smith, supra").
const RECORD_NAME = /\b(?:dep|decl|ex|compl|dkt|aff|tr)\b/;

const sameSource = (earlier: string | null, named: string) =>
  earlier !== null && named !== "" && (earlier === named || earlier.startsWith(`${named} `));

const aliasOf = (cite: RecordCiteOccurrence) =>
  cite.result.status === "parsed" ? cite.result.sourceAlias : null;

/**
 * The record cites in reading order, each `Id.` and `supra` linked to the record item it refers
 * back to. An `Id.` after a court decision's citation is the decision's, and one with nothing
 * before it refers to no record item: neither is a record cite, so neither is listed. Nor is a
 * `supra` whose name no earlier record cite has, unless that name is plainly a record item's.
 */
export function linkRecordCites<T extends RecordCiteToken>(
  tokens: readonly T[],
): (LinkedRecordCite & Omit<Extract<T, { kind: "cite" }>, "kind">)[] {
  const linked: (LinkedRecordCite & Omit<Extract<T, { kind: "cite" }>, "kind">)[] = [];
  let last: number | null = null;
  for (const token of tokens) {
    if (token.kind === "case") {
      last = null;
      continue;
    }
    const { kind: _, ...cite } = token as Extract<T, { kind: "cite" }>;
    const { result } = cite;
    if (result.status === "parsed" && result.kind === "id") {
      if (last === null) continue;
      linked.push({ ...cite, referent: last });
    } else if (result.status === "parsed" && result.kind === "supra") {
      const named = result.sourceAlias ?? "";
      const earlier = linked.flatMap((each, index) =>
        each.result.status === "parsed" &&
        each.result.reference === null &&
        sameSource(each.result.sourceAlias, named)
          ? [index]
          : [],
      );
      if (earlier.length === 0 && !RECORD_NAME.test(named)) continue;
      const sources = new Set(earlier.map((index) => aliasOf(linked[index] as LinkedRecordCite)));
      linked.push({ ...cite, referent: sources.size === 1 ? (earlier.at(-1) ?? null) : null });
    } else {
      linked.push(cite);
    }
    last = linked.length - 1;
  }
  return linked;
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
    if (token.kind === "case") {
      first = false;
      continue;
    }
    const { result } = token;
    if (result.status === "parsed" && result.kind === "supra") return true;
    if (result.status === "parsed" && result.kind === "id") {
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
  const own = recordCiteTokens(claim).map((token) => ({ ...token, own: true }));
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
        ].map((token) => ({ ...token, own: false }))
      : [];
  const linked = linkRecordCites([...before, ...own]);
  const needed = new Set<number>();
  const need = (index: number) => {
    if (needed.has(index)) return;
    needed.add(index);
    const referent = linked[index]?.referent;
    if (typeof referent === "number") need(referent);
  };
  linked.forEach((cite, index) => {
    if (cite.own) need(index);
  });
  const kept = [...needed].sort((a, b) => a - b);
  const renumbered = new Map(kept.map((index, at) => [index, at]));
  const cites = kept.map((index): LinkedRecordCite => {
    const { own: _, referent, ...cite } = linked[index] as (typeof linked)[number];
    return referent === undefined
      ? cite
      : { ...cite, referent: referent === null ? null : (renumbered.get(referent) ?? null) };
  });
  return { cites, own: kept.filter((index) => linked[index]?.own).length };
}

/** A linked cite as the resolver reads it. */
export const resolverInput = (cite: LinkedRecordCite): RecordCiteInput => ({
  ...cite.result,
  from: cite.from,
  to: cite.to,
  ...(cite.referent !== undefined && { referent: cite.referent }),
});
