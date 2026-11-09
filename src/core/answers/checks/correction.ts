import { type Figure, type FigureContext, readFigures } from "../../../shared/figures";
import { isPeriod } from "../../../shared/periods";
import { NUMBERS } from "../../../shared/rewriteWords";
import type { Citation, ClaimCorrection } from "../../api";
import { documentFigureContext } from "../calculations";
import type { AnswerDocuments } from "../citations";
import type { ReadCorrection } from "./prompt";

/** Where `text` names a period: "Q2 2025", "第二季度", "2026年4月". */
function periodSpans(text: string): { from: number; to: number }[] {
  const words: { from: number; to: number }[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match.index === undefined) continue;
    words.push({ from: match.index, to: match.index + match[0].length });
  }
  const candidates: { from: number; to: number }[] = [];
  for (const [index, word] of words.entries()) {
    for (const end of words.slice(index, index + 4)) {
      candidates.push({ from: word.from, to: end.to });
    }
  }
  for (let end = 0; end < text.length; end++) {
    if (!/[年季度月]/u.test(text[end] ?? "")) continue;
    for (let start = Math.max(0, end - 24); start < end; start++) {
      candidates.push({ from: start, to: end + 1 });
    }
  }
  return candidates.filter((span) => isPeriod(text.slice(span.from, span.to)));
}

function namedPeriods(text: string): string[] {
  return periodSpans(text)
    .map((span) => text.slice(span.from, span.to).normalize("NFKC").toLocaleLowerCase())
    .sort();
}

function keepsNamedPeriods(from: string, replacement: string): boolean {
  const before = namedPeriods(from);
  if (before.length === 0) return true;
  const after = namedPeriods(replacement);
  return before.length === after.length && before.every((period, index) => period === after[index]);
}

const scriptOf = (text: string): "han" | "latin" | null =>
  /\p{Script=Han}/u.test(text) ? "han" : /\p{Script=Latin}/u.test(text) ? "latin" : null;

/**
 * Whether `wording` is in the language of the words it replaces, or of the nearest words around
 * them when they have none: Claude Haiku 5.5 gave a Chinese sentence's 60日内 "within 30 days",
 * and an English sentence that names 华信公司 "30日内" (#1481). Figures alone fit anywhere.
 */
function inLanguageAt(claim: string, first: number, end: number, wording: string): boolean {
  const written = scriptOf(wording);
  if (written === null) return true;
  const nearest =
    [...claim.slice(0, first)].reverse().find((char) => scriptOf(char) !== null) ??
    [...claim.slice(end)].find((char) => scriptOf(char) !== null) ??
    "";
  return written === (scriptOf(claim.slice(first, end)) ?? scriptOf(nearest));
}

export const sameNumber = (
  a: { value: number; unit: unknown },
  b: { value: number; unit: unknown },
) =>
  Math.abs(a.value - b.value) <= 1e-9 * Math.max(1, Math.abs(a.value), Math.abs(b.value)) &&
  JSON.stringify(a.unit) === JSON.stringify(b.unit);

/**
 * The figures the corrected sentence reads where the old words and any figure they were part of
 * stood, or null when a figure the old words were part of doesn't read whole again: "1.5" of
 * "1.5亿元" written as "120,000,000元" leaves 亿元 behind (#1481).
 */
export function writtenAt(
  claim: string,
  first: number,
  from: string,
  wording: string,
  context: FigureContext,
): Figure[] | null {
  const end = first + from.length;
  const old = readFigures(claim, context).filter((each) => each.start < end && each.end > first);
  const start = Math.min(first, ...old.map((each) => each.start));
  const stop = Math.max(end, ...old.map((each) => each.end)) + wording.length - from.length;
  const corrected = claim.slice(0, first) + wording + claim.slice(end);
  const written = readFigures(corrected, context).filter(
    (each) => each.start < stop && each.end > start,
  );
  const partOfOne = old.some((each) => each.start < first || each.end > end);
  return partOfOne && (written[0]?.start !== start || written.at(-1)?.end !== stop)
    ? null
    : written;
}

const isDigit = (char: string | undefined) => char !== undefined && /\p{Nd}/u.test(char);

/**
 * The written number `start`–`end` is part of, its digits and what joins them taken whole: "10"
 * of "10–12", which the figure reader doesn't read as a range.
 */
function numberAround(text: string, start: number, end: number): string {
  const joins = (at: number, beyond: number) =>
    /[–—\-/.,~～]/u.test(text[at] ?? "") && isDigit(text[beyond]);
  let from = start;
  if (isDigit(text[from])) {
    while (from > 0 && (isDigit(text[from - 1]) || joins(from - 1, from - 2))) from--;
  }
  let to = end;
  if (isDigit(text[to - 1])) {
    while (to < text.length && (isDigit(text[to]) || joins(to, to + 1))) to++;
  }
  return text.slice(from, to);
}

/** Where a clause ends: "," or ";" before a space, a sentence's stop, or their Chinese forms. */
const CLAUSE_END = /[,;](?=\s)|\.(?=\s|$)|[，；。！？!?]/gu;

/** A word at a seam: a number, a Latin word, a run of Chinese numerals, or one other character. */
const SEAM_TOKEN =
  /\p{Nd}+(?:[.,]\p{Nd}+)*|\p{Script=Latin}+|[〇零一二两三四五六七八九十百千万亿]+|\S/gu;

const isNumeral = (token: string) => /^[\p{Nd}〇零一二两三四五六七八九十百千万亿]/u.test(token);

/** What stands just before `index`: a word, or "" where a clause starts. */
function wordBefore(text: string, index: number): string {
  const head = text.slice(0, index).trimEnd();
  if (head === "" || /[,;:.，；：。！？!?]$/u.test(head)) return "";
  return (head.match(SEAM_TOKEN)?.at(-1) ?? "").toLocaleLowerCase();
}

/** What stands just after `index`: a word, or "" where a clause ends. */
function wordAfter(text: string, index: number): string {
  const tail = text.slice(index).trimStart();
  if (tail === "" || /^(?:[，；：。！？!?]|[,;:.](?:\s|$))/u.test(tail)) return "";
  return (tail.match(SEAM_TOKEN)?.[0] ?? "").toLocaleLowerCase();
}

/**
 * Whether each end of the wording joins the sentence as the Document's words join their own: it
 * keeps the old words' word at that end (any number for a number), or the sentence goes on from
 * it as the quote does, with the same word or a clause's end. "Westmarch but" before "of London",
 * "monthly rent of $14,250" after "The base rent is" and 的西境公司 after 出租人为 don't (#1481).
 */
function seamsHold(
  claim: string,
  first: number,
  from: string,
  wording: string,
  quote: string,
  at: number,
): boolean {
  const corrected = claim.slice(0, first) + wording + claim.slice(first + from.length);
  const old = from.match(SEAM_TOKEN) ?? [];
  const now = wording.match(SEAM_TOKEN) ?? [];
  const keeps = (a: string | undefined, b: string | undefined) =>
    a !== undefined &&
    b !== undefined &&
    ((isNumeral(a) && isNumeral(b)) || a.toLocaleLowerCase() === b.toLocaleLowerCase());
  const end = at + wording.length;
  return (
    (keeps(old[0], now[0]) || wordBefore(corrected, first) === wordBefore(quote, at)) &&
    (keeps(old.at(-1), now.at(-1)) ||
      wordAfter(corrected, first + wording.length) === wordAfter(quote, end))
  );
}

/** Text as compared for a range: one space for any run of them, and one dash for any dash. */
const spacedAsOne = (text: string) => text.replace(/\s*[–—−‐-]\s*/gu, "-").replace(/\s+/gu, " ");

/**
 * Where `wording` stands in `quote`: its one place, never inside a longer number; -1 when it
 * isn't there or stands in more than one place, so no other stretch of the quote can vouch for it.
 */
function placeIn(quote: string, wording: string): number {
  const places: number[] = [];
  for (let at = quote.indexOf(wording); at >= 0; at = quote.indexOf(wording, at + 1)) {
    const runsOn =
      (isDigit(wording[0]) && isDigit(quote[at - 1])) ||
      (isDigit(wording.at(-1)) && isDigit(quote[at + wording.length]));
    if (!runsOn) places.push(at);
  }
  return places.length === 1 ? (places[0] ?? -1) : -1;
}

/**
 * Whether the clause the corrected words sit in, from its first number to its last with whatever
 * joins them, is what the quote writes around those words where they stand in it. A range is one
 * clause however it is joined, so this fails closed on any connector: "8" over "10" of "10 to 12",
 * 10至12 or 10到12 leaves the User's 12 beside the Document's 8, even where the quote has "8 to
 * 12" in another clause or "18 to 120" (#1481). The numbers of a named period are left to the
 * period rules, which hold wherever the quote names it.
 */
function clauseHeld(
  corrected: string,
  first: number,
  end: number,
  quote: string,
  at: number,
): boolean {
  const ends = [...corrected.matchAll(CLAUSE_END)].map((match) => match.index);
  const start = Math.max(0, ...ends.filter((at) => at < first).map((at) => at + 1));
  const stop = Math.min(corrected.length, ...ends.filter((at) => at >= end));
  const clause = corrected.slice(start, stop);
  const periods = periodSpans(clause);
  const numbers = [...clause.matchAll(NUMBERS)].filter(
    (match) =>
      !periods.some((span) => span.from <= match.index && span.to >= match.index + match[0].length),
  );
  const [head] = numbers;
  const last = numbers.at(-1);
  if (!head || !last) return true;
  const before = spacedAsOne(corrected.slice(Math.min(first, start + head.index), first));
  const after = spacedAsOne(
    corrected.slice(end, Math.max(end, start + last.index + last[0].length)),
  );
  const quoteBefore = spacedAsOne(quote.slice(0, at));
  const quoteAfter = spacedAsOne(quote.slice(at + end - first));
  return (
    quoteBefore.endsWith(before) &&
    quoteAfter.startsWith(after) &&
    !(isDigit(before[0]) && isDigit(quoteBefore[quoteBefore.length - before.length - 1])) &&
    !(isDigit(after.at(-1)) && isDigit(quoteAfter[after.length]))
  );
}

/**
 * Whether the corrected sentence reads, where the old words stood, the very numbers the quote
 * reads in the same words, with their scale and sign, written as the quote writes them: "1.5" of
 * "$1.5m" written as "1,200,000" reads $1,200,000m, "4,620.00" is not the quote's "(4,620.00)",
 * "$1.2m" over "$1.5" of "$1.5m" reads $1.2mm, and "8" over "10" of "10–12" reads 8–12 (#1481).
 */
function readsAsQuote(
  claim: string,
  first: number,
  from: string,
  wording: string,
  quote: string,
  context: FigureContext,
): boolean {
  const written = writtenAt(claim, first, from, wording, context);
  const at = placeIn(quote, wording);
  if (written === null || at < 0) return false;
  const corrected = claim.slice(0, first) + wording + claim.slice(first + from.length);
  const end = first + wording.length;
  if (
    numberAround(corrected, first, end) !== numberAround(quote, at, at + wording.length) ||
    !clauseHeld(corrected, first, end, quote, at)
  )
    return false;
  const quoted = readFigures(quote, documentFigureContext([{ text: quote }])).filter(
    (each) => each.start < at + wording.length && each.end > at,
  );
  return (
    written.length === quoted.length &&
    written.every((each, index) => {
      const same = quoted[index];
      return same !== undefined && sameNumber(each, same) && quote.includes(each.chars);
    })
  );
}

/**
 * The Document's words as far as `quote` holds them, to the end of a clause: Claude Haiku 5.5 went
 * on past its quote with ", less any amounts properly deducted" (#1481). Null when it holds none.
 */
function heldBy(quote: string, wording: string): string | null {
  if (quote.includes(wording)) return wording;
  // An English comma ends a clause only before a space: 1,200 is one number.
  const ends = [...wording.matchAll(/\s*(?:[,;](?=\s)|[，；])/gu)]
    .map((match) => match.index)
    .reverse();
  for (const end of ends) {
    const clause = wording.slice(0, end);
    if (clause !== "" && quote.includes(clause)) return clause;
  }
  return null;
}

/** The one figure `words` are, or null when they are more or less than a figure. */
function figureOnly(words: string, context: FigureContext): Figure | null {
  const read = readFigures(words, context);
  return read.length === 1 && read[0]?.chars === words.trim() ? read[0] : null;
}

/** Whether `quote` names every period `sentence` does: a Document's value for another is no correction. */
function namesPeriodsOf(sentence: string, quote: string): boolean {
  const named = new Set(namedPeriods(quote));
  return namedPeriods(sentence).every((period) => named.has(period));
}

/** An overlap at least this long, or one character that isn't a letter or digit ("$", " "). */
const overlaps = (words: string) => words.length >= 2 || /^[^\p{L}\p{N}]$/u.test(words);

/**
 * The Document's words as they fit between `before` and `after`: without the words either side
 * already has. Asked for 60日内, Claude Haiku 5.5 gave 货款应在开票后45日内支付 (#1481).
 */
function inPlace(before: string, after: string, wording: string): string {
  // Whatever its case: Claude Haiku 5.5 gave "The term is 10 to 12 months." the wording "the term
  // is 8 to 10 months" (#1481).
  const lower = (text: string) => text.toLocaleLowerCase();
  let start = 0;
  for (let length = Math.min(before.length, wording.length); length > 0; length--) {
    const words = wording.slice(0, length);
    if (lower(before).endsWith(lower(words)) && overlaps(words)) {
      start = length;
      break;
    }
  }
  let end = wording.length;
  for (let length = Math.min(after.length, wording.length - start); length > 0; length--) {
    const words = wording.slice(wording.length - length);
    if (lower(after).startsWith(lower(words)) && overlaps(words)) {
      end = wording.length - length;
      break;
    }
  }
  return wording.slice(start, end);
}

/**
 * A confirmed contradiction's correction of `claim`, a part of `sentence` or all of it: old words
 * that occur once in it, never all the sentence's words, each choice's wording in its own found
 * quote, keeping the sentence's named periods.
 */
export function correctionFor(
  sentence: string,
  claim: string,
  read: ReadCorrection | undefined,
  finalCitation: (marker: number) => Citation | null,
  documentDate: AnswerDocuments["documentDate"],
  context: FigureContext,
): { correction: ClaimCorrection; evidence: Citation } | null {
  if (!read || read.from === "" || read.choices.length < 1 || read.choices.length > 2) return null;
  const first = claim.indexOf(read.from);
  if (first < 0 || first !== claim.lastIndexOf(read.from)) return null;
  // Old words that are all of the sentence would rewrite it, not correct its contradicted part:
  // Claude Haiku 5.5 named a whole Chinese sentence so (#1481).
  const kept = claim.slice(0, first) + claim.slice(first + read.from.length);
  if (sentence === claim && !/[\p{L}\p{N}]/u.test(kept)) return null;
  const markers = new Set<number>();
  const wordings = new Set<string>();
  const choices: ({ wording: string; marker: number } & { evidence: Citation })[] = [];
  const figure = figureOnly(read.from, context);
  const end = first + read.from.length;
  for (const stated of read.choices) {
    const inPlaceOf = (words: string) =>
      inPlace(claim.slice(0, first), claim.slice(first + read.from.length), words);
    const citation = finalCitation(stated.marker);
    const placed = inPlaceOf(stated.wording);
    const held = citation?.check === "found" ? heldBy(citation.quote, placed) : null;
    if (!citation || held === null) return null;
    // Cut to a clause, the words may end with what follows the old ones: 30日内无息退还.
    const fitted = held === placed ? placed : inPlaceOf(held);
    // A figure takes the Document's figure of its own kind, not the words around it.
    const figures = figure && !figureOnly(fitted, context) ? readFigures(fitted, context) : [];
    const same = figures.filter((each) => each.unit.kind === figure?.unit.kind);
    const choice = { ...stated, wording: same.length === 1 && same[0] ? same[0].chars : fitted };
    // Another Document's words in another language are left out, as a choice no one could take.
    if (!inLanguageAt(claim, first, end, choice.wording)) continue;
    const place = placeIn(citation.quote, choice.wording);
    if (place < 0 || !seamsHold(claim, first, read.from, choice.wording, citation.quote, place))
      return null;
    if (
      markers.has(choice.marker) ||
      choice.wording === "" ||
      choice.wording === read.from ||
      !keepsNamedPeriods(read.from, choice.wording) ||
      !keepsNamedPeriods(
        claim,
        claim.slice(0, first) + choice.wording + claim.slice(first + read.from.length),
      ) ||
      wordings.has(choice.wording) ||
      !namesPeriodsOf(claim, citation.quote) ||
      !readsAsQuote(claim, first, read.from, choice.wording, citation.quote, context)
    )
      return null;
    markers.add(choice.marker);
    wordings.add(choice.wording);
    choices.push({ ...choice, evidence: citation });
  }
  const sorted = choices.sort(
    (a, b) =>
      (documentDate(b.evidence.documentId)?.date ?? "").localeCompare(
        documentDate(a.evidence.documentId)?.date ?? "",
      ) || a.marker - b.marker,
  );
  const [newest] = sorted;
  if (!newest) return null;
  return {
    correction: {
      from: read.from,
      choices: sorted.map(({ wording, evidence }) => ({ wording, evidence })),
    },
    evidence: newest.evidence,
  };
}
