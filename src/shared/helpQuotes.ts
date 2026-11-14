/**
 * What call help's panel draws under a line that carries a Citation's number (#2847): each
 * Citation's quote, word for word, in quotation marks with its number, and a ✓ only where the app
 * found the quote word for word in its Passage, never beside a sentence the model wrote. The first
 * two Citations the line cites, in its order, get a line each; a third and later keep their numbers
 * at the end of the second; one quote cited twice is one line. A line's room is kept from the moment
 * its number shows, so nothing shown moves when its quote lands. The panel, its tests and the
 * evaluation's replay all draw a reply from here.
 */
import type {
  AnswerStatus,
  CitationCheck,
  CitationCheckReason,
  CitationLocation,
  QuoteCell,
} from "../core/api";
import { onlyMoment, type ReplyPiece } from "./helpReplyRead";
import { CJK, normaliseText } from "./text";

/** The trial's fact-line limit (#2847): a quote past it is cut at a clause. */
export const QUOTE_WORDS = 20;
/** The same limit for a quote written in Chinese, Japanese or Korean, in characters. */
export const QUOTE_CHARACTERS = 40;

/** What a quote line reads of a Citation. */
export interface QuotedCitation {
  marker: number;
  documentId: string;
  passageId: string;
  /** Where it points; a call's time, for a quote of a Transcript. */
  location: CitationLocation | null;
  /** The Units of its Passage it cites, as its Document numbers them; none where a record lacks them. */
  pageFrom?: number | null;
  pageTo?: number | null;
  quote: string;
  check: CitationCheck;
  checkReason: CitationCheckReason | null;
  /** Its found quote's table cells, as the cite found them; none for a reply kept before them. */
  cells?: readonly QuoteCell[];
}

/**
 * A quote line's state: its number shows and its quote hasn't come yet (`waiting`, its room kept);
 * its quote found word for word in its Passage (`found`, ✓); or a quote that isn't in the place it
 * cites, can't be checked there, or that nothing stored proves found (`not-checked`), which the line
 * says in the Citation card's words, with no ✓.
 */
export type QuoteState = "waiting" | "found" | "not-found" | "cant-check" | "not-checked";

export interface QuoteLine {
  /**
   * The Citations it stands for, in the order cited: more than one where a found quote holds
   * another found quote of the same place.
   */
  markers: number[];
  /** The one of them whose quote, time and card words the line draws: the quote holding the rest. */
  drawn: number;
  /** A third and later Citation's markers, at the end of the second line. */
  more: number[];
  state: QuoteState;
  /** The quote as drawn, cut at a clause past the limit; null where it isn't drawn. */
  quote: string | null;
  /** The quote was cut, and ends "…". */
  cut: boolean;
  /**
   * A found quote that is cells of a table, drawn cell by cell in place of `quote`, each whole
   * after its column's name where the table gives one; null for any other.
   */
  cells: readonly QuoteCell[] | null;
}

/**
 * A Citation's quote line state, `found` only where what is stored proves the quote was found. A
 * sentence's own judgement (supported, unsupported, contradicted) is only ever made on a found
 * quote, and words the reply put in quotation marks that the cited place doesn't hold leave its
 * quote found. A Citation still waiting for its sentence's judgement ("checking", or "not checked"
 * once a later start gave up on it) proves its quote found only on a reply that ended, since only a
 * found quote waits: one left being written, which a quit stops, may never have had its quote
 * checked, so it says "not checked" until Check again settles it. A check this build doesn't know
 * proves nothing. Before its record comes the room waits; a reply stopped or failed closes it.
 */
export function quoteState(
  citation: Pick<QuotedCitation, "check" | "checkReason"> | undefined,
  status: AnswerStatus,
): QuoteState | null {
  if (!citation) return status === "streaming" ? "waiting" : null;
  switch (citation.check) {
    case "found":
    case "unsupported":
    case "contradicted":
      return "found";
    case "not-found":
      return citation.checkReason === "quoted-words-not-on-pages" ? "found" : "not-found";
    case "cant-check":
      return "cant-check";
    case "checking":
      if (status === "streaming") return "waiting";
      return status === "done" ? "found" : "not-checked";
    case "not-checked":
      // Another call's quote is never checked for a press (#3005), so it proves nothing found.
      return status === "done" && citation.checkReason !== "other-call" ? "found" : "not-checked";
  }
  return "cant-check";
}

/** A line of the reply as written, its Citations as markers. */
export const lineText = (pieces: readonly ReplyPiece[]): string =>
  pieces
    .map((piece) =>
      piece.kind === "text"
        ? piece.text
        : piece.kind === "citation"
          ? `[^${piece.marker}]`
          : `[=${piece.marker}]`,
    )
    .join("");

/**
 * A reading's line that is a moment of the call, by what it holds (#2847): `plain`, a time, one
 * quotation and exactly one Citation marker (once its list mark, its marker and the time at its
 * start are taken off, one pair of quotation marks around words is left), which keeps its own words
 * and takes a ✓ when the app finds them in the cited place; or `several`, the same with more than one
 * marker, wherever they sit, which the app draws from its Citations. Null for any other line: two
 * moments on one line, words beside the quotation (a speaker, a gloss), or no Citation.
 */
export type Moment =
  | { kind: "plain"; marker: number; words: string }
  | { kind: "several"; markers: number[] };

export function momentOf(pieces: readonly ReplyPiece[]): Moment | null {
  const markers = markersOf([pieces]);
  const [marker] = markers;
  if (marker === undefined) return null;
  const all = pieces.flatMap((piece) => (piece.kind === "citation" ? [piece] : []));
  if (all.length === 1) {
    const text = lineText(pieces);
    if (!onlyMoment(text)) return null;
    const plain = lineText(pieces.filter((piece) => piece.kind !== "citation"));
    return { kind: "plain", marker, words: quotedWordsOf(plain) };
  }
  const plain = lineText(pieces.filter((piece) => piece.kind !== "citation"));
  return onlyMoment(plain) ? { kind: "several", markers } : null;
}

/** The time a moment line begins with, as the model wrote it. */
const MOMENT_TIME = /^\d{1,2}:\d{2}(?::\d{2})?/;

/** What is between a moment's quotation marks. */
const quotedWordsOf = (line: string): string =>
  line.trim().replace(MOMENT_TIME, "").trim().slice(1, -1).trim();

/**
 * A plain moment's words as its line shows them: the model's, except the time, which is its cited
 * place's own once its Citation has come (`time`), since the model may round or mistake it.
 */
export const momentWords = (line: string, time: string | null): string => {
  const words = line.trim();
  return time ? words.replace(MOMENT_TIME, time) : words;
};

/**
 * Words as the quote check compares them: case, spaces, quotation marks and dashes aside, and the
 * marks a sentence ends with.
 */
export const comparedWords = (text: string): string =>
  normaliseText(text.replace(LINE_MARKS, ""))
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』«»„‹›\-‐‑–—―]/gu, "")
    .replace(/[.,;:!?。，；：！？、…]+$/u, "");

/** Whether a plain moment's quoted words are among the words the app found in its cited place. */
export const momentFound = (
  words: string,
  citation: { quotedWordsFound?: readonly string[] },
): boolean =>
  (citation.quotedWordsFound ?? []).some(
    (stated) => comparedWords(stated) === comparedWords(words),
  );

/**
 * A reading's line that may be a moment while it is still written: a time or an opening quotation
 * mark first, the start of a time so far, or nothing yet. Until it is finished its place is a room,
 * since which kind it is can't be told yet.
 */
export const momentBegun = (pieces: readonly ReplyPiece[]): boolean =>
  /^\s*(?:\d{1,2}:\d{2}|\d{1,2}(?::\d?)?\s*$|[“"「『«]|$)/u.test(lineText(pieces));

/** The Citation markers a line of the reply carries, each once, in its order. */
export const markersOf = (pieces: readonly (readonly ReplyPiece[])[]): number[] => [
  ...new Set(pieces.flat().flatMap((piece) => (piece.kind === "citation" ? [piece.marker] : []))),
];

/**
 * Whether a found quote lies wholly inside another found quote of the same place, so its number
 * joins that quote's line (#2847): the same Passage of the same Document, the same Units of it,
 * its words inside the other's as the quote check compares them, and on a call its time within the
 * other's. The same words in another Document or another Unit, or said again later in the call,
 * aren't inside; nor is a quote that only overlaps another, since no line draws words no one
 * Citation gave.
 */
function inside(inner: QuotedCitation, outer: QuotedCitation): boolean {
  if (inner.documentId !== outer.documentId || inner.passageId !== outer.passageId) return false;
  if (!unitsWithin(inner, outer) || !placedWithin(inner.location, outer.location)) return false;
  return comparedWords(outer.quote).includes(comparedWords(inner.quote));
}

/**
 * Whether a quote's Units lie within another's. Two parts of a long section, or two sections whose
 * headings read alike, give the same place, so only the Units tell them apart. A record without its
 * Units (a replay of saved records) is told by its place alone.
 */
function unitsWithin(inner: QuotedCitation, outer: QuotedCitation): boolean {
  const { pageFrom: from, pageTo: to } = inner;
  const { pageFrom: outerFrom, pageTo: outerTo } = outer;
  if (from == null || to == null || outerFrom == null || outerTo == null) {
    return (from ?? null) === (outerFrom ?? null) && (to ?? null) === (outerTo ?? null);
  }
  return from >= outerFrom && to <= outerTo;
}

/** A range `inner` inside `outer`; with only one of them given, it can't be shown to be. */
function rangeWithin(
  inner: { from: number; to: number } | undefined,
  outer: { from: number; to: number } | undefined,
): boolean {
  if (inner === undefined || outer === undefined) return inner === outer;
  return inner.from >= outer.from && inner.to <= outer.to;
}

/**
 * Whether a Citation's place lies within another's: the same kind of place, a sheet's rows on the
 * same sheet, its pages, slides, rows, lines or call's time inside the other's. A section's is the
 * same section and part of it (before its heading, its speaker notes, a comment, a picture, or the
 * body), its paragraphs inside the other's where both give them; where only one does, it isn't
 * shown to lie within. Two Citations with no place of their own share their Passage's.
 */
function placedWithin(a: CitationLocation | null, b: CitationLocation | null): boolean {
  if (a === null || b === null) return a === b;
  switch (a.kind) {
    case "page":
    case "slide":
    case "lines":
    case "time":
      return b.kind === a.kind && a.from >= b.from && a.to <= b.to;
    case "rows":
      return b.kind === "rows" && a.sheet === b.sheet && a.from >= b.from && a.to <= b.to;
    case "section":
      return (
        b.kind === "section" &&
        a.heading === b.heading &&
        (a.start ?? false) === (b.start ?? false) &&
        (a.notes ?? false) === (b.notes ?? false) &&
        (a.comment === undefined) === (b.comment === undefined) &&
        a.comment?.author === b.comment?.author &&
        a.figure === b.figure &&
        rangeWithin(a.paragraphs, b.paragraphs)
      );
    default:
      return JSON.stringify(a) === JSON.stringify(b);
  }
}

/** The Citations a quote line draws, before they are counted into two lines. */
interface Group {
  markers: number[];
  citation: QuotedCitation | undefined;
  found: boolean;
}

/**
 * Joins each found quote wholly inside another found quote into that quote's line, its number in
 * cited order, until none is left: a quote that grows a line to hold one also takes in any other it
 * now holds, so no line shows words another line already shows. Only found quotes take one another
 * in, so a joined line's ✓ stands for every number on it. The line keeps the place of the first.
 */
function joinInside(groups: Group[], order: readonly number[]): void {
  const at = (marker: number) => order.indexOf(marker);
  for (let joined = true; joined; ) {
    joined = false;
    for (const [first, kept] of groups.entries()) {
      const own = kept.found ? kept.citation : undefined;
      if (!own) continue;
      const taken = groups.findIndex(
        ({ found, citation }, index) =>
          index > first &&
          found &&
          citation !== undefined &&
          (inside(citation, own) || inside(own, citation)),
      );
      const other = groups[taken];
      if (!other?.citation) continue;
      if (!inside(other.citation, own)) kept.citation = other.citation;
      kept.markers = [...kept.markers, ...other.markers].sort((a, b) => at(a) - at(b));
      groups.splice(taken, 1);
      joined = true;
      break;
    }
  }
}

/**
 * The quote lines under a line that cites `markers`, in the order cited. A marker `numbered` doesn't
 * show takes none.
 */
export function quoteLines(
  markers: readonly number[],
  citationOf: (marker: number) => QuotedCitation | undefined,
  status: AnswerStatus,
  numbered: (marker: number) => boolean = () => true,
): QuoteLine[] {
  const groups: Group[] = [];
  for (const marker of markers) {
    if (!numbered(marker)) continue;
    const citation = citationOf(marker);
    const state = quoteState(citation, status);
    if (state === null) continue;
    groups.push({
      markers: [marker],
      citation: state === "waiting" ? undefined : citation,
      found: state === "found" && citation !== undefined,
    });
  }
  joinInside(groups, markers);
  const lines = groups.slice(0, 2).map(({ markers: cited, citation }): QuoteLine => {
    const state = quoteState(citation, status) ?? "waiting";
    const fitted = state === "found" && citation ? fittedQuote(citation.quote) : null;
    return {
      markers: cited,
      drawn: citation?.marker ?? cited[0] ?? 0,
      more: [],
      state,
      quote: fitted?.text ?? null,
      cut: fitted?.cut ?? false,
      cells: state === "found" ? (citation?.cells ?? null) : null,
    };
  });
  const second = lines[1];
  if (second) second.more = groups.slice(2).flatMap((group) => group.markers);
  return lines;
}

const CJK_CHARACTER = new RegExp(`[${CJK}]`, "u");

/**
 * A table quote's cells as its line reads them (#2847): each value whole, in quotation marks, after
 * its column's name where the table gives one, apart by " · ". A Chinese name takes no space.
 */
export const cellsText = (cells: readonly QuoteCell[]): string =>
  cells
    .map(({ name, value }) =>
      name === null ? `“${value}”` : `${name}${CJK_CHARACTER.test(name) ? "" : " "}“${value}”`,
    )
    .join(" · ");
/** A character that counts toward a quote's length in Chinese: any but a space or a mark. */
const COUNTED = /[\p{L}\p{N}]/u;
/** Where a clause may end: after these, unless the mark sits inside a number ("42,000", "3.5"). */
const CLAUSE_END = /[,，;；:：、。.!！?？—–]/u;
const DIGIT = /\p{N}/u;

/** A quote's length against the limit: its words, or for a quote in Chinese its characters. */
function lengthOf(text: string, cjk: boolean): number {
  if (!cjk) return text.split(/\s+/).filter(Boolean).length;
  return [...text].filter((character) => COUNTED.test(character)).length;
}

/** Whether a mark at `at` sits inside a number, between two of its digits. */
const insideNumber = (text: string, at: number): boolean =>
  DIGIT.test(text[at - 1] ?? "") && DIGIT.test(text[at + 1] ?? "");

/** A Markdown line's own marks before its words: a list's, a heading's, a quotation's. */
const LINE_MARKS = /^(?:[-*+•]\s+|\d{1,3}[.)]\s+|#{1,6}\s+|>\s*)+/u;

/**
 * A quote as its line draws it: the Document's words without the Markdown marks its line begins
 * with, whole within the trial's fact-line limit; past it, cut at the last clause that ends within
 * it, with "…". A mark inside a number ends no clause, so the cut never lands in one. With no clause
 * to end at, it is cut at the last word within the limit, or for Chinese the last character that
 * isn't part of a number.
 */
export function fittedQuote(quote: string): { text: string; cut: boolean } {
  const text = quote.trim().replace(LINE_MARKS, "");
  const cjk = CJK_CHARACTER.test(text);
  const limit = cjk ? QUOTE_CHARACTERS : QUOTE_WORDS;
  if (lengthOf(text, cjk) <= limit) return { text, cut: false };
  let best = -1;
  for (let at = 0; at < text.length; at++) {
    if (!CLAUSE_END.test(text[at] ?? "") || insideNumber(text, at)) continue;
    const kept = text.slice(0, at).trimEnd();
    if (kept && lengthOf(kept, cjk) <= limit) best = at;
  }
  if (best > 0) return { text: `${text.slice(0, best).trimEnd()}…`, cut: true };
  if (!cjk) {
    const words = text.split(/\s+/).filter(Boolean).slice(0, limit);
    return { text: `${words.join(" ")}…`, cut: true };
  }
  let counted = 0;
  let end = 0;
  for (const [at, character] of [...text].entries()) {
    if (COUNTED.test(character)) counted++;
    if (counted > limit) break;
    end = at + 1;
  }
  const characters = [...text];
  const ofNumber = (at: number) =>
    DIGIT.test(characters[at] ?? "") ||
    (/[.,，]/u.test(characters[at] ?? "") &&
      DIGIT.test(characters[at - 1] ?? "") &&
      DIGIT.test(characters[at + 1] ?? ""));
  while (end > 0 && ofNumber(end - 1) && ofNumber(end)) end--;
  return { text: `${characters.slice(0, end).join("").trimEnd()}…`, cut: true };
}
