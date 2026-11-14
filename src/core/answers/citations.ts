/**
 * Citations (the v1 design's "Wedge mechanics"). An Answer cites a Passage by
 * writing a marker such as "[^1]" right after a claim, and giving, through the
 * `cite` Tool or structured output, a record for it: the Passage, the
 * Location its quote is at (ADR-0011: one or two pages, slides, sections, or
 * blocks of rows or lines, the Units of src/shared/units.ts), and the quote,
 * copied word for word. The core turns each marker with a record into an
 * inline Citation node; a marker without a record is removed, and a record
 * without a marker dropped. A local model in structured output is asked once
 * more for the quotes the check doesn't find (see ./quoteRetry): a new quote
 * replaces a record's only when the check finds it (`correctQuote`).
 *
 * When the Answer finishes, each Citation is checked once, and the result
 * stored with it: the cited Units must lie within the Passage's Units and be
 * at most two consecutive ones of one sheet or Document (the Location rule),
 * and the quote must be in their text, matched exactly after both are
 * normalised the same way (see `findQuote`: letter case, spacing, hyphenation
 * at line ends, quote marks and "[^36]" for "[36]" don't count, and a quote
 * with an ellipsis is found when each part, of at least 3 words, is there in
 * order; in spreadsheets, number formatting doesn't count either). The Units
 * are read as stored when the Document was processed, a PDF's without
 * running headers, footers and page numbers, so a quote may run across a page
 * break. "Found" means the quote is there, never that it supports the sentence.
 *
 * Each Citation also stores its Location for its label: for blocks of rows or
 * lines, narrowed to those the quote covers ("Revenue, rows 12–14"); for
 * sections, the heading it sits under.
 */
import { markersIn, shownRanges } from "../../shared/answerBlocks";
import { citationNode, type NodeJSON } from "../../shared/blockJson";
import { parseQuotedWords } from "../../shared/citations";
import { formatFullDateTime } from "../../shared/dates";
import { FIGURE_MARKER } from "../../shared/figureMarkers";
import {
  englishPlace,
  joinUnits,
  locationOf,
  numbersIn,
  parseLocation,
  parseRequestedLocation,
  quoteInUnits,
  type RowsOrLines,
  resolveRequested,
  unitLocation,
  withoutArea,
} from "../../shared/locations";
import { citesSource, type NamedSource } from "../../shared/namedSources";
import { cleanQuote } from "../../shared/quotedSpans";
import {
  findQuote,
  lostLigatures,
  type MatchOptions,
  quoteParts,
  type TextRange,
} from "../../shared/quoteMatch";
import { readableQuote, readableQuoteText } from "../../shared/readableQuote";
import { type LinePart, markWords, partsOf, speakerMark, speakerOf } from "../../shared/speakers";
import { foldRadicals, normaliseText } from "../../shared/text";
import { TURN_PAUSE_MS } from "../../shared/transcriptTurns";
import { parseCueTarget, sameRun } from "../../shared/units";
import {
  type AskedQuote,
  type ChangedQuote,
  type Citation,
  type CitationCheck,
  type CitationCheckReason,
  type CitationLocation,
  type CitationRecheck,
  type CitationToRecheck,
  type CitedArea,
  type CitedSelection,
  type DocumentKind,
  MAX_CITED_PAGES,
  type QuoteCell,
  type QuotedWordsCheck,
  type RejectedRecord,
  type SelectedPart,
  type TranscriptSpeakers,
} from "../api";
import type { CitationSource, DocumentDate } from "../documents";
import { BOILERPLATE_PARAMETERS } from "../documents/boilerplate";
import { HEADER_ROWS } from "../documents/formats/grid";
import type { PageText } from "../documents/passages";
import { unsureSpansIn } from "../documents/scan/layout";
import type { WindowedPassage } from "../documents/search";
import { writtenInCjk } from "../documents/textLanguage";
import { asAttribute, fromData, type PromptTag, tagged } from "../promptData";
import { diffSteps, splitWords } from "../proposals/diff";
import { formulaRows } from "../workbooks/formulaCells";
import {
  type ContextCitation,
  type ContextCitations,
  issuedForm,
  replaceWritten,
  writtenIds,
} from "./contextCitations";
import { withCueMarks } from "./cueMarks";
import type {
  AnswerSearchOptions,
  AnswerTools,
  CitationRecordInput,
  CiteOptions,
  ReadDocumentRequest,
  SearchResultForModel,
  UnfoundQuote,
} from "./engine";
import { NOT_CITED_ATTRIBUTE } from "./prompt";
import { quoteCells } from "./quoteCells";
import {
  nearestPlace,
  type QuotedSentence,
  type QuotedWordsPlace,
  quotedWordsVerdict,
  titleRowsOf,
} from "./quotedWords";
import { readDocumentPages } from "./readDocumentPages";
import { withSetAsideMarks } from "./sheetRows";
import { wholeSentences } from "./wholeSentences";

const SEARCHED_ALREADY =
  "You already searched for this, and have its Passages: answer with them, or search for something different.";

const sameSearch = (query: string) =>
  query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const FIX_THESE = "Fix these with another cite call:";

/** What `cite` tells the model once it has taken every record. */
export const WRITE_NOW = " Write the Answer now if you haven't yet; don't repeat it.";

/** Whether what `cite` told the model asks it to fix records, which the Tool loop must not end before. */
export const asksForFixes = (told: string): boolean => told.includes(FIX_THESE);

// The quote check and call help's reader read a quote by one rule (shared/quotedSpans).
export { cleanQuote };

/** Marks where a slide's speaker notes start, inside a Passage given to the model. */
const NOTES_MARK = "[speaker notes]";

/** Marks where a Word comment starts, inside a Passage given to the model, with its author if known (#76). */
const commentMark = (author: string | null) =>
  author ? `[comment by ${author.replace(/[\]\n]+/g, " ")}]` : "[comment]";

/** How a Document's text is matched: whether it lost its f-ligatures (see `lostLigatures`). */
export type Matching = Pick<MatchOptions, "lostLigatures">;

/** How quotes are matched in a Document's text, from all of it (its Units, as stored). */
export const matchingOf = (units: readonly PageText[]): Matching => ({
  lostLigatures: lostLigatures(units.map((unit) => unit.text).join("\n")),
});

/** The Units a Citation names, by number: both null for a whole TXT or Markdown file stored before Units. */
export interface PageRange {
  pageFrom: number | null;
  pageTo: number | null;
}

const asPage = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;

/** What a record cites: its Units, the rows or lines it named, and whether its Location named nothing there. */
interface Cited {
  range: PageRange;
  /** Rows, lines or times the record named more narrowly than its Units: the label's fallback. */
  requested: RowsOrLines | null;
  time?: RowsOrLines;
  /** The record named a Location the Passage doesn't have. */
  unresolved: boolean;
}

/**
 * The Units a record cites, in order. A record names a Location ("slide 4",
 * "Revenue, rows 12–14", "§ 2.1 Sensitivity"), or for a PDF or deck, its
 * pages. One that names none cites the quote's own Unit (or two) among the
 * Passage's, if it is there, else the Passage's own Units: a small model often
 * names no page, and a Passage runs onto a second page (#519) or, with little
 * text on a page, over three or four (#67: 梯度下降法's covers pp. 1–4). Two
 * pages named, as a model copies a Passage's, narrow to the quote's own the same
 * way. `units` are the Passage's.
 */
function citedUnits(
  record: Pick<CitationRecordInput, "pageFrom" | "pageTo" | "location" | "quote">,
  passage: PageRange,
  units: readonly PageText[],
  matching: Matching = {},
): Cited {
  if (passage.pageFrom === null || passage.pageTo === null) {
    return { range: { pageFrom: null, pageTo: null }, requested: null, unresolved: false };
  }
  const own = { pageFrom: passage.pageFrom, pageTo: passage.pageTo };
  const kind = units[0]?.kind ?? "page";
  const requested =
    typeof record.location === "string" ? parseRequestedLocation(record.location) : null;
  if (
    kind === "cues" &&
    typeof record.location === "string" &&
    record.location.trim() &&
    !requested
  ) {
    return { range: own, requested: null, unresolved: true };
  }
  if (requested) {
    const resolved = resolveRequested(requested, units);
    if (!resolved) return { range: own, requested: null, unresolved: true };
    return {
      range: { pageFrom: resolved.from, pageTo: resolved.to },
      requested:
        requested.kind === "rows" || requested.kind === "lines" || requested.kind === "time"
          ? { from: requested.from, to: requested.to }
          : null,
      ...(requested.kind === "time" && { time: requested }),
      unresolved: false,
    };
  }
  const from = asPage(record.pageFrom);
  const to = asPage(record.pageTo);
  if ((kind === "page" || kind === "slide") && (from !== null || to !== null)) {
    const first = (from ?? to) as number;
    const last = (to ?? from) as number;
    const named = { pageFrom: Math.min(first, last), pageTo: Math.max(first, last) };
    // More than two pages named stay so, for the check to reject.
    const narrowed =
      named.pageTo - named.pageFrom + 1 <= MAX_CITED_PAGES
        ? locatedAmong(units, named, record, matching)
        : null;
    return { range: narrowed ?? named, requested: null, unresolved: false };
  }
  const located = locatedAmong(units, own, record, matching);
  return { range: located ?? own, requested: null, unresolved: false };
}

/**
 * A model's quote as these Units hold it: as written, else with the prompt tags its Passage was
 * shown with defused (#2423) taken back. A Document's own "&lt;" is never changed.
 */
export function quoteAsIn(units: readonly PageText[], written: string, matching: Matching): string {
  if (quoteInUnits(units, written, matching)) return written;
  const back = fromData(written);
  return back !== written && quoteInUnits(units, back, matching) ? back : written;
}

/** Where the record's quote is within these pages of the Passage's Units, when they are more than one. */
function locatedAmong(
  units: readonly PageText[],
  pages: { pageFrom: number; pageTo: number },
  record: Pick<CitationRecordInput, "quote">,
  matching: Matching,
): PageRange | null {
  if (pages.pageTo === pages.pageFrom) return null;
  const quote = cleanQuote(typeof record.quote === "string" ? record.quote : "");
  const among = units.filter(
    (unit) => unit.page !== null && unit.page >= pages.pageFrom && unit.page <= pages.pageTo,
  );
  return locateQuote(among, quote, matching);
}

/** The unique place of a quote in one Unit, or two consecutive Units of one run. */
export function locateQuote(
  units: readonly PageText[],
  quote: string,
  matching: Matching = {},
): PageRange | null {
  const ranges = quoteInUnits(units, quote, { ...matching, unique: true });
  if (!ranges) return null;
  const { starts } = joinUnits(units);
  const covered = units.filter((unit, index) => {
    const start = starts[index] ?? 0;
    return ranges.some((range) => range.start < start + unit.text.length && range.end > start);
  });
  const [first, second] = covered;
  if (!first || first.page === null || covered.length > 2) return null;
  if (second && (second.page !== first.page + 1 || !sameRun(first, second))) return null;
  return { pageFrom: first.page, pageTo: second?.page ?? first.page };
}

export function quotePlaceProblem(
  quote: string,
  units: readonly PageText[],
  matching: Matching = {},
  time?: RowsOrLines,
  speakers: TranscriptSpeakers | null = null,
): string | null {
  const find = (unique: boolean) =>
    time
      ? quoteInCues(units, quote, time, { ...matching, unique }, speakers)
      : quoteInUnits(units, quote, { ...matching, unique });
  return find(false) && !find(true)
    ? "the quote occurs more than once in its cited Units; quote enough surrounding words to identify one place."
    : null;
}

/**
 * The quote in the cues of a model's "14:26 Dana": those said then, by the Speaker named as the
 * model read them, the name the User gave (#138) or the label, so a line the User gave to someone
 * else is never found as said by the one the file has. A quote that starts there may run on into
 * the lines the Speaker goes on with in the same turn: a line is a sentence, and a quote can be
 * two. Its place is still the lines cited.
 */
function quoteInCues(
  units: readonly PageText[],
  quote: string,
  time: RowsOrLines & { speaker?: string },
  matching: Matching & { unique?: boolean },
  speakers: TranscriptSpeakers | null = null,
): TextRange[] | null {
  // Cue marks round down, so a named second includes cues that start within it.
  const until = time.to + 1000;
  const then = (span: { startMs: number; endMs: number }) =>
    span.startMs < until && span.endMs > time.from;
  const turn = turnGoingOn(speakers);
  if (!time.speaker) {
    return quoteInCueWindow(
      units,
      quote,
      (cue, label, said) => turn.stretches(cue, label, said, then(cue)),
      matching,
    );
  }
  const asked = markWords(time.speaker);
  // Of a line the User split (#138), only the named Speaker's parts, each run of them that holds
  // a part said then, as a line that isn't split is whole: a quote that runs into another
  // Speaker's part isn't theirs.
  return quoteInCueWindow(
    units,
    quote,
    (cue, label, said) => {
      const parts = turn.partsIn(cue, label, said);
      const theirs = parts.map(
        (part) =>
          label !== null &&
          (asked === markWords(speakerMark(speakers, part.startMs, label)) ||
            asked === markWords(speakerOf(speakers, part.startMs, label))),
      );
      const ranges: CueStretch[] = [];
      const end = (index: number) => parts[index + 1]?.at ?? said.length;
      for (let first = 0; first < parts.length; first++) {
        if (!theirs[first]) {
          turn.stop();
          continue;
        }
        let last = first;
        while (theirs[last + 1]) last++;
        const run = parts.slice(first, last + 1);
        if (run.some(then)) {
          ranges.push({ start: (run[0] as TurnPart).at, end: end(last) });
          turn.cited(run.at(-1) as TurnPart);
        } else {
          for (let at = first; at <= last && turn.goesOn(parts[at] as TurnPart); at++) {
            ranges.push({ start: (parts[at] as TurnPart).at, end: end(at), goesOn: true });
          }
        }
        first = last;
      }
      return ranges;
    },
    matching,
  );
}

/** A part of a cue, by its Speaker as the User's who's who has it now (#138): null for none. */
type TurnPart = Pick<LinePart, "startMs" | "endMs" | "at"> & { speaker: string | null };

/**
 * The turn a quote's cited lines are in, as the Transcript draws turns (../../shared/transcriptTurns),
 * read cue by cue in order: a part goes on with it when its Speaker, as the User's who's who has it
 * now with every reassigned line and split part (#138), is the last part's, within `TURN_PAUSE_MS`
 * of it. Anyone else's part ends the turn.
 */
function turnGoingOn(speakers: TranscriptSpeakers | null) {
  let last: TurnPart | null = null;
  const partsIn = (
    cue: { startMs: number; endMs: number },
    label: string | null,
    said: string,
  ): TurnPart[] =>
    label === null
      ? [{ startMs: cue.startMs, endMs: cue.endMs, at: 0, speaker: null }]
      : partsOf(speakers, { ...cue, text: said, label }).map((part) => ({
          ...part,
          speaker: speakerOf(speakers, part.startMs, label),
        }));
  const goesOn = (part: TurnPart): boolean => {
    const on =
      last !== null && last.speaker === part.speaker && part.startMs - last.endMs < TURN_PAUSE_MS;
    last = on ? part : null;
    return on;
  };
  return {
    partsIn,
    goesOn,
    /** The quote's place takes in `part`: the turn goes on from it. */
    cited(part: TurnPart) {
      last = part;
    },
    stop() {
      last = null;
    },
    /** Of a cue, where to look: all of it when `cited`, else its parts that go on with the turn. */
    stretches(
      cue: { startMs: number; endMs: number },
      label: string | null,
      said: string,
      cited: boolean,
    ): CueStretch[] {
      const parts = partsIn(cue, label, said);
      if (cited) {
        last = parts.at(-1) ?? null;
        return [{ start: 0, end: said.length }];
      }
      const stretches: CueStretch[] = [];
      for (const [index, part] of parts.entries()) {
        if (!goesOn(part)) break;
        stretches.push({ start: part.at, end: parts[index + 1]?.at ?? said.length, goesOn: true });
      }
      return stretches;
    },
  };
}

function quoteInStoredCues(
  units: readonly PageText[],
  quote: string,
  time: RowsOrLines,
  matching: Matching & { unique?: boolean },
  speakers: TranscriptSpeakers | null,
  accepted?: (ranges: readonly TextRange[]) => boolean,
): TextRange[] | null {
  // A stored speaker names the first cue, not every cue in its interval. The quote may run on
  // into the lines its Speaker goes on with, as when it was cited (quoteInCues).
  const turn = turnGoingOn(speakers);
  return quoteInCueWindow(
    units,
    quote,
    (cue, label, said) =>
      turn.stretches(cue, label, said, cue.startMs >= time.from && cue.endMs <= time.to),
    matching,
    accepted,
  );
}

/** Of a cue's words, a stretch to look in; `goesOn`: only as the rest of a quote cited before it. */
type CueStretch = TextRange & { goesOn?: boolean };

/**
 * The quote in the stretches of cues `selected` picks: of each cue's words (`said`), the ranges
 * it gives, those next to each other read as one. A quote must start in a stretch that isn't one
 * that `goesOn`, and its ranges end with that stretch's cited words, the place a Citation keeps.
 */
function quoteInCueWindow(
  units: readonly PageText[],
  quote: string,
  selected: (
    cue: { startMs: number; endMs: number },
    speaker: string | null,
    said: string,
  ) => readonly CueStretch[],
  matching: Matching & { unique?: boolean },
  accepted?: (ranges: readonly TextRange[]) => boolean,
): TextRange[] | null {
  const { text, starts } = joinUnits(units);
  const spans: (TextRange & { cited: TextRange[] })[] = [];
  const joined = (before: TextRange | undefined, start: number) =>
    before !== undefined && text.slice(before.end, start).trim() === "";
  units.forEach((unit, index) => {
    if (unit.kind !== "cues") return;
    for (const [at, anchor] of (unit.anchors ?? []).entries()) {
      const cue = parseCueTarget(anchor.target);
      if (!cue) continue;
      const said = unit.text.slice(anchor.start, anchor.end);
      for (const range of selected(cue, unit.label?.speakers?.[at] ?? null, said)) {
        const start = (starts[index] ?? 0) + anchor.start + range.start;
        const end = (starts[index] ?? 0) + anchor.start + range.end;
        const previous = spans.at(-1);
        if (previous && joined(previous, start)) previous.end = end;
        else spans.push({ start, end, cited: [] });
        const span = spans.at(-1) as (typeof spans)[number];
        if (range.goesOn) continue;
        const cited = span.cited.at(-1);
        if (cited && joined(cited, start)) cited.end = end;
        else span.cited.push({ start, end });
      }
    }
  });
  let found: TextRange[] | null = null;
  for (const span of spans) {
    const part = text.slice(span.start, span.end);
    const absolute = (ranges: readonly TextRange[]) =>
      ranges.map((range) => ({ start: span.start + range.start, end: span.start + range.end }));
    const whole = span.cited[0];
    const goesOn = !(
      span.cited.length === 1 &&
      whole?.start === span.start &&
      whole.end === span.end
    );
    // Of a quote that runs on past its cited words, the part in them.
    const cited = (ranges: readonly TextRange[]): TextRange[] | null => {
      const head = ranges[0];
      const within =
        head && span.cited.find((each) => each.start <= head.start && head.start < each.end);
      if (!within) return null;
      return ranges
        .filter((range) => range.start < within.end)
        .map((range) => ({ start: range.start, end: Math.min(range.end, within.end) }));
    };
    const keep = (ranges: readonly TextRange[]) => {
      const kept = goesOn ? cited(ranges) : ranges;
      return kept !== null && (!accepted || accepted(kept));
    };
    const options = {
      ...matching,
      ...((accepted || goesOn) && {
        acceptMatch: (ranges: readonly TextRange[]) => keep(absolute(ranges)),
      }),
    };
    const ranges = findQuote(part, quote, { ...options, unique: false });
    if (!ranges) continue;
    if (matching.unique && (found || !findQuote(part, quote, { ...options, unique: true }))) {
      return null;
    }
    found = goesOn ? cited(absolute(ranges)) : absolute(ranges);
    if (!matching.unique) return found;
  }
  return found;
}

/**
 * The Location rule: the cited Units must lie within the cited Passage's
 * Units, and be one Unit or two consecutive ones of one run. Returns why they
 * break it, or null.
 */
function pageRangeProblem(
  range: PageRange,
  passage: PageRange,
  unresolved = false,
): CitationCheckReason | null {
  if (unresolved) return "pages-outside-passage";
  if (range.pageFrom === null || range.pageTo === null) return null;
  if (passage.pageFrom === null || passage.pageTo === null) return null;
  if (range.pageFrom < passage.pageFrom || range.pageTo > passage.pageTo) {
    return "pages-outside-passage";
  }
  if (range.pageTo - range.pageFrom + 1 > MAX_CITED_PAGES) return "too-many-pages";
  return null;
}

export interface CheckResult {
  check: Exclude<CitationCheck, "checking">;
  checkReason: CitationCheckReason | null;
  /** The unsure words of a scanned page the quote covers, in order (#535); absent when it covers none. */
  unsure?: string[];
}

/**
 * The words of `units` a text recognizer wasn't sure of, or that a number's
 * shape says it misread (#535), that `ranges` (in their joined text) cover, in
 * order: a quote of one isn't on the page for certain, so it asks the User to
 * look. The rule is applied here too, so a page read before it is covered.
 */
export function unsureWordsCovered(
  units: readonly PageText[],
  ranges: readonly TextRange[],
): string[] {
  if (ranges.length === 0) return [];
  const { starts } = joinUnits(units);
  const words: string[] = [];
  units.forEach((unit, index) => {
    const offset = starts[index] ?? 0;
    for (const [from, to] of unsureSpansIn(unit)) {
      if (!ranges.some((range) => offset + from < range.end && offset + to > range.start)) continue;
      const word = unit.text.slice(from, to);
      if (word !== "") words.push(word);
    }
  });
  return words;
}

/**
 * The Citation check. `pages` is the stored text of the cited Units (for a
 * whole TXT or Markdown file stored before Units, its one text), as
 * `AnswerDocuments.pageTexts` gives it. `lostLigatures`: the Document's text
 * lost its f-ligatures (see `matchingOf`).
 */
export function checkCitation(input: {
  quote: string;
  range: PageRange;
  passage: PageRange;
  documentDeleted: boolean;
  pages: readonly PageText[];
  /** The record named a Location the Passage doesn't have. */
  unresolved?: boolean;
  lostLigatures?: boolean;
}): CheckResult {
  if (input.documentDeleted) return { check: "cant-check", checkReason: "document-removed" };
  const problem = pageRangeProblem(input.range, input.passage, input.unresolved);
  if (problem) return { check: "not-found", checkReason: problem };
  const [first, second] = input.pages;
  if (first && second && !sameRun(first, second)) {
    return { check: "not-found", checkReason: "too-many-pages" };
  }
  if (input.pages.every((page) => page.text.trim() === "")) {
    return { check: "cant-check", checkReason: "no-text" };
  }
  const found = quoteInUnits(input.pages, input.quote, {
    lostLigatures: input.lostLigatures ?? false,
  });
  if (!found) return { check: "not-found", checkReason: "quote-not-on-pages" };
  const unsure = unsureWordsCovered(input.pages, found);
  return unsure.length > 0 ? { check: "cant-check", checkReason: "unsure-word", unsure } : FOUND;
}

/** A recorded call, as its Transcript's Passages name it: its Note's current name, and its start (ISO 8601). */
export interface TranscriptCall {
  note: string;
  startedAt: string;
}

/** What the core needs from Documents for an Answer: search, and what Citations point to. */
export interface AnswerDocuments {
  /** How many live Documents have Passages to search. */
  searchableCount(): number;
  /** The document-search Tool; `within`: only these Documents, not the Answer's. */
  search(
    query: string,
    signal?: AbortSignal,
    within?: readonly string[],
    options?: AnswerSearchOptions,
  ): Promise<WindowedPassage[]>;
  /** A Passage and its Document, deleted or not; null if unknown. */
  citationSource(passageId: string): CitationSource | null;
  /** The stored text of one version of a live Document's Units (see `pageTexts` in ../documents). */
  pageTexts(
    documentId: string,
    contentHash: string,
    from: number | null,
    to: number | null,
  ): PageText[];
  /** A live Document's date, shown with its Passages (see `documentDate` in ../documents); null if none is known. */
  documentDate(documentId: string): DocumentDate | null;
  /** Who's who in a Transcript (#138), so its lines read by the names the User gave; null for none. */
  speakers?(documentId: string): TranscriptSpeakers | null;
  /** The call a Transcript records (#3005); null for any other Document. */
  callOf?(documentId: string): TranscriptCall | null;
  /** The id of the Document to search named `name`, as the instructions list it; null for none. */
  documentNamed?(name: string): string | null;
  /** The User's highlights and notes that hold the words (#327), as lines for the model; "" for none. */
  annotationText?(query: string, within?: readonly string[]): string;
  /** One live Passage by id, when reading around it is offered. */
  passage?(passageId: string): WindowedPassage | null;
  /** Live Passages at positions `from` to `to`, when Document reads are offered. */
  passagesBetween?(documentId: string, from: number, to: number): WindowedPassage[];
  /** Live Passages covering pages `from` to `to`, or intersecting them when `overlapping`. */
  passagesCovering?(
    documentId: string,
    from: number | null,
    to: number | null,
    overlapping?: boolean,
  ): WindowedPassage[];
}

/**
 * The Document among `documents` a model named for a search: by its name as listed, else one
 * whose name holds the name given or is held in it. Null for none.
 */
export function documentNamedAmong(
  documents: readonly { id: string; name: string }[],
  name: string,
): string | null {
  const key = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const wanted = key(name.replace(/\s*\(“[^”]*”\)\s*$/, ""));
  return (
    documents.find((each) => key(each.name) === wanted)?.id ??
    documents.find((each) => key(each.name).includes(wanted) || wanted.includes(key(each.name)))
      ?.id ??
    null
  );
}

/** What re-checking a Citation against the current version needs from Documents. */
export interface RecheckDocuments {
  /** The current version of a live Document; null if it was deleted. */
  currentVersion(documentId: string): string | null;
  /**
   * The day the version's snapshot was taken, when it is the User's own note (#335):
   * `contentHash` is the version quoted, null for the Document's own.
   */
  yourNoteAt?(documentId: string, contentHash: string | null): string | null;
  pageTexts: AnswerDocuments["pageTexts"];
  /** A live Document's name as the app shows it, which words in quotation marks may give (#2504). */
  documentName(documentId: string): string | null;
  /** Who's who in a Transcript (#138): who speaks each line now; null for none. */
  speakersOf?(documentId: string): TranscriptSpeakers | null;
  /** The live Passages of the current version covering these Units, in reading order. */
  passagesCovering(
    documentId: string,
    from: number | null,
    to: number | null,
  ): { id: string; text: string }[];
}

const removedFrom = (range: PageRange): CitationRecheck => ({
  check: "cant-check",
  checkReason: "document-removed",
  contentHash: null,
  passageId: null,
  ...range,
  location: null,
});

const FOUND: CheckResult = { check: "found", checkReason: null };
const NOT_ON_PAGES: CheckResult = { check: "not-found", checkReason: "quote-not-on-pages" };

/** Whether a check puts the quote on its page: found, or a scan's word that asks for a look (#535). */
const located = (result: CheckResult) =>
  result.check === "found" ||
  (result.check === "cant-check" && result.checkReason === "unsure-word");

function versionOf(documents: RecheckDocuments, documentId: string, contentHash: string) {
  const units = documents.pageTexts(documentId, contentHash, null, null);
  const matching = matchingOf(units);
  const passageFor = (range: PageRange, quote: string): string | null => {
    const covering = documents.passagesCovering(documentId, range.pageFrom, range.pageTo);
    return (
      covering.find((passage) => quote !== "" && findQuote(passage.text, quote, matching))?.id ??
      covering[0]?.id ??
      null
    );
  };
  const inRange = (range: PageRange) =>
    units.filter(
      (unit) =>
        range.pageFrom === null ||
        range.pageTo === null ||
        (unit.page !== null && unit.page >= range.pageFrom && unit.page <= range.pageTo),
    );
  const result = (
    check: CheckResult,
    range: PageRange,
    quote: string,
    found?: readonly TextRange[],
    location?: CitationLocation | null,
  ): CitationRecheck => {
    const covered = inRange(range);
    // A scan's unsure word was still found: its place is where the quote is (#535).
    const held = check.check === "found" || check.checkReason === "unsure-word";
    const yourNoteAt = documents.yourNoteAt?.(documentId, contentHash) ?? null;
    return {
      ...check,
      contentHash,
      passageId: passageFor(range, quote),
      ...(yourNoteAt && { yourNoteAt }),
      ...range,
      location:
        !held && location?.kind === "time"
          ? location
          : (range.pageFrom === null || range.pageTo === null) && location?.kind !== "time"
            ? null
            : locationOf(covered, held ? (found ?? quoteInUnits(covered, quote, matching)) : null),
    };
  };
  return { units, matching, inRange, result };
}

type Rechecked = Pick<
  CitationToRecheck,
  "documentId" | "quote" | "pageFrom" | "pageTo" | "location"
>;

/**
 * The quote at a Transcript Citation's own time, said by its speaker when `speakerToo`. The
 * current version can lose a speaker's label only to the speaker pass naming them (#138): then its
 * time alone holds, and the location returned, rebuilt from the cue found, shows the new name.
 */
function quoteForRecheck(
  units: readonly PageText[],
  quote: string,
  matching: Matching,
  location: CitationLocation | null | undefined,
  speakerToo: boolean,
  speakers: TranscriptSpeakers | null,
): TextRange[] | null {
  if (!location || !units.some((unit) => unit.kind === "cues")) {
    return quoteInUnits(units, quote, matching);
  }
  if (location.kind !== "time") return null;
  return quoteInStoredCues(
    units,
    quote,
    location,
    { ...matching, unique: true },
    speakers,
    (ranges) => {
      const at = locationOf(units, ranges);
      return (
        at?.kind === "time" &&
        at.from === location.from &&
        at.to === location.to &&
        (!speakerToo || !location.speaker || at.speaker === location.speaker)
      );
    },
  );
}

/**
 * A Citation's cited place in one version of its Document, as the check of quoted words reads it
 * (#2712): its time alone, in a Transcript, as its stored Location gives it.
 */
function quotedWordsPlaceIn(
  documents: RecheckDocuments,
  documentId: string,
  contentHash: string,
  range: PageRange,
  location: CitationLocation | null | undefined,
): QuotedWordsPlace {
  const all = documents.pageTexts(documentId, contentHash, null, null);
  const matching = matchingOf(all);
  const units = documents.pageTexts(documentId, contentHash, range.pageFrom, range.pageTo);
  return {
    units,
    matching,
    find: (words) =>
      location?.kind === "time"
        ? quoteInStoredCues(
            units,
            words,
            location,
            matching,
            documents.speakersOf?.(documentId) ?? null,
          )
        : quoteInUnits(units, words, matching),
    documentName: documents.documentName(documentId),
    throughNextUnit: () =>
      range.pageFrom !== null && range.pageFrom === range.pageTo
        ? documents.pageTexts(documentId, contentHash, range.pageFrom, range.pageTo + 1)
        : null,
    titleRows: (sheet) => titleRowsOf(all, sheet),
    cantCheck: false,
  };
}

/**
 * A found check made not found again when the words the Answer quoted (#483), which the
 * Citation's check didn't find before, still aren't at its cited place of that version by the
 * one rule an Answer's are checked by (#2612, #2712). A recheck sees one Citation of the
 * sentence, so it never takes the words for a translation: only the Answer, which sees them all,
 * can, and then it stores none.
 */
function withQuotedWords(
  documents: RecheckDocuments,
  documentId: string,
  contentHash: string,
  range: PageRange,
  location: CitationLocation | null | undefined,
  asked: QuotedWordsCheck | null | undefined,
  check: CheckResult,
): CheckResult {
  if (check.check !== "found" || !asked || !("answer" in asked)) return check;
  const words = asked.answer.map((piece) => piece.text).join("");
  const place = quotedWordsPlaceIn(documents, documentId, contentHash, range, location);
  const verdict = quotedWordsVerdict(words, [place], []).kind;
  return verdict === "not-found" || verdict === "translation"
    ? { check: "not-found", checkReason: "quoted-words-not-on-pages" }
    : check;
}

/**
 * Checks a Citation again against its Document's current version (see
 * `CoreApi.recheckCitation`): at its cited Units, without relocating it.
 * The Passage given is one of the current version that holds the
 * Units, preferably one whose text holds the quote too. Given the version it
 * quotes, once the Document has a newer one: its check in that version too,
 * and its words as they changed when the current one doesn't hold them.
 */
export function recheckCitation(
  documents: RecheckDocuments,
  input: Rechecked & Pick<CitationToRecheck, "contentHash" | "quotedWords">,
): CitationRecheck {
  const quoteOnly = recheckInCurrent(documents, input);
  const now =
    quoteOnly.contentHash === null
      ? quoteOnly
      : {
          ...quoteOnly,
          ...withQuotedWords(
            documents,
            input.documentId,
            quoteOnly.contentHash,
            quoteOnly,
            input.location,
            input.quotedWords,
            quoteOnly,
          ),
        };
  const quoted = input.contentHash ?? "";
  if (quoted === "" || now.contentHash === null || now.contentHash === quoted) return now;
  const inQuoted = checkInVersion(documents, input, quoted);
  return {
    ...now,
    inQuotedVersion:
      inQuoted &&
      withQuotedWords(
        documents,
        input.documentId,
        quoted,
        input,
        input.location,
        input.quotedWords,
        inQuoted,
      ),
    changed:
      quoteOnly.check === "not-found"
        ? changedQuote(documents, input, quoted, now.contentHash)
        : null,
  };
}

function checkInVersion(
  documents: RecheckDocuments,
  input: Rechecked,
  contentHash: string,
): CheckResult | null {
  const version = versionOf(documents, input.documentId, contentHash);
  // That version's text is no longer kept: the check made when it was cited stands.
  if (version.units.length === 0) return null;
  const range = { pageFrom: input.pageFrom, pageTo: input.pageTo };
  const quote = cleanQuote(input.quote);
  const pages = version.inRange(range);
  const result = checkCitation({
    quote,
    range,
    passage: range,
    documentDeleted: false,
    pages,
    lostLigatures: version.matching.lostLigatures ?? false,
  });
  return result.check === "found" &&
    !quoteForRecheck(
      pages,
      quote,
      version.matching,
      input.location,
      true,
      documents.speakersOf?.(input.documentId) ?? null,
    )
    ? NOT_ON_PAGES
    : result;
}

const holdsWord = (token: string) => /[\p{L}\p{N}]/u.test(token);
const wordCount = (text: string) => splitWords(text).filter(holdsWord).length;

/** At least this share of a quote's words stays at its place for the words there now to be its words, changed. */
const LEAST_KEPT = 0.5;

function changedQuote(
  documents: RecheckDocuments,
  input: Rechecked,
  version: string,
  current: string,
): ChangedQuote | null {
  const before = versionOf(documents, input.documentId, version);
  const cited = before.inRange(input);
  const found = quoteForRecheck(
    cited,
    cleanQuote(input.quote),
    before.matching,
    input.location,
    true,
    documents.speakersOf?.(input.documentId) ?? null,
  );
  const start = found?.[0]?.start;
  const end = found?.at(-1)?.end;
  if (start === undefined || end === undefined) return null;
  const { pageFrom, pageTo } = input;
  // A Unit either side, in both versions: a page added before the quote moves its words on one.
  const near = (units: readonly PageText[]) =>
    units.filter(
      (unit) =>
        pageFrom === null ||
        pageTo === null ||
        (unit.page !== null && unit.page >= pageFrom - 1 && unit.page <= pageTo + 1),
    );
  const around = near(before.units);
  const old = joinUnits(around);
  const offset = old.starts[cited[0] ? around.indexOf(cited[0]) : 0] ?? 0;
  const after = joinUnits(near(versionOf(documents, input.documentId, current).units));
  const parts = changedParts(old.text, after.text, offset + start, offset + end);
  if (!parts.some((part) => part.kind !== "same")) return null;
  const kept = parts.filter((part) => part.kind === "same").map((part) => part.text);
  const quoted = old.text.slice(offset + start, offset + end);
  if (wordCount(kept.join("")) < wordCount(quoted) * LEAST_KEPT) return null;
  const words = parts
    .filter((part) => part.kind !== "removed")
    .map((part) => part.text)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const now = words === "" ? null : recheckInCurrent(documents, { ...input, quote: words });
  return now?.check === "found" ? { parts, now: { ...now, quote: words } } : null;
}

type Segment = { same: string } | { removed: string; added: string };

function changedParts(
  oldText: string,
  newText: string,
  start: number,
  end: number,
): ChangedQuote["parts"] {
  const a = splitWords(oldText);
  const b = splitWords(newText);
  const steps = diffSteps(a, b);
  const segments: Segment[] = [];
  const keep = (text: string) => {
    const last = segments.at(-1);
    if (last && "same" in last) last.same += text;
    else if (text !== "") segments.push({ same: text });
  };
  const inQuote = (token: string, at: number) =>
    token.slice(Math.max(0, start - at), Math.max(0, Math.min(token.length, end - at)));
  let x = 0;
  let i = 0;
  let j = 0;
  for (let step = 0; step < steps.length; ) {
    if (steps[step] === "equal") {
      const token = a[i++] ?? "";
      j++;
      keep(inQuote(token, x));
      x += token.length;
      step++;
      continue;
    }
    const from = x;
    let removed = "";
    let added = "";
    for (; step < steps.length && steps[step] !== "equal"; step++) {
      if (steps[step] === "insert") {
        added += b[j++] ?? "";
        continue;
      }
      const token = a[i++] ?? "";
      removed += inQuote(token, x);
      x += token.length;
    }
    // Words put in where nothing was taken out belong to the quote only inside it.
    const touches = from === x ? start < from && from < end : from < end && x > start;
    if (touches) segments.push({ removed, added });
  }
  // Changes with only spaces and marks kept between them read as one: "sixty (60)" became
  // "forty-five (45)", not "sixty" became "forty-five" and "60" became "45".
  const joined: Segment[] = [];
  for (const [index, segment] of segments.entries()) {
    const before = joined.at(-1);
    const next = segments[index + 1];
    const between = "same" in segment && next && "removed" in next && !holdsWord(segment.same);
    const change = "same" in segment ? { removed: segment.same, added: segment.same } : segment;
    if (before && "removed" in before && (between || "removed" in segment)) {
      joined[joined.length - 1] = {
        removed: before.removed + change.removed,
        added: before.added + change.added,
      };
    } else joined.push(segment);
  }
  // A bracket or quotation mark against a change goes with it: "(60)", not "(60" and ")".
  for (const [index, segment] of joined.entries()) {
    const before = joined[index - 1];
    const after = joined[index + 1];
    if (!("removed" in segment)) continue;
    const lead =
      before && "same" in before ? (/[\p{Ps}\p{Pi}"]+$/u.exec(before.same)?.[0] ?? "") : "";
    const tail = after && "same" in after ? (/^[\p{Pe}\p{Pf}"]+/u.exec(after.same)?.[0] ?? "") : "";
    if (before && "same" in before)
      before.same = before.same.slice(0, before.same.length - lead.length);
    if (after && "same" in after) after.same = after.same.slice(tail.length);
    segment.removed = lead + segment.removed + tail;
    segment.added = lead + segment.added + tail;
  }
  const first = joined[0];
  const last = joined.at(-1);
  if (first && "same" in first) first.same = first.same.trimStart();
  if (last && "same" in last) last.same = last.same.trimEnd();
  return joined.flatMap((segment): ChangedQuote["parts"] =>
    "same" in segment
      ? segment.same === ""
        ? []
        : [{ kind: "same", text: segment.same }]
      : [
          ...(segment.removed ? [{ kind: "removed" as const, text: segment.removed }] : []),
          ...(segment.added ? [{ kind: "added" as const, text: segment.added }] : []),
        ],
  );
}

function recheckInCurrent(
  documents: RecheckDocuments,
  input: Rechecked & { contentHash?: string | null },
): CitationRecheck {
  const cited = { pageFrom: input.pageFrom, pageTo: input.pageTo };
  const contentHash = documents.currentVersion(input.documentId);
  if (contentHash === null) return removedFrom(cited);
  const quote = cleanQuote(input.quote);
  const version = versionOf(documents, input.documentId, contentHash);
  const { units, matching, inRange } = version;
  const location =
    input.location?.kind === "time" && units.some((unit) => unit.kind === "cues")
      ? input.location
      : undefined;
  const result = (check: CheckResult, range: PageRange, found?: readonly TextRange[]) =>
    version.result(check, range, quote, found, location);
  if (units.every((unit) => unit.text.trim() === "")) {
    return result({ check: "cant-check", checkReason: "no-text" }, cited);
  }
  const range = inRange(cited);
  const [first, second] = range;
  const whole = cited.pageFrom === null || cited.pageTo === null;
  if (
    range.length > 0 &&
    (whole || (range.length <= MAX_CITED_PAGES && (!first || !second || sameRun(first, second)))) &&
    quote !== ""
  ) {
    const speaker = input.location?.kind === "time" ? input.location.speaker : undefined;
    const renamed =
      speaker !== undefined &&
      !!input.contentHash &&
      input.contentHash !== contentHash &&
      !units.some((unit) => unit.kind === "cues" && unit.label?.speakers?.includes(speaker));
    const found = quoteForRecheck(
      range,
      quote,
      matching,
      input.location,
      !renamed,
      documents.speakersOf?.(input.documentId) ?? null,
    );
    if (found) {
      const unsure = unsureWordsCovered(range, found);
      return result(
        unsure.length > 0 ? { check: "cant-check", checkReason: "unsure-word", unsure } : FOUND,
        cited,
        found,
      );
    }
  }
  return result({ check: "not-found", checkReason: "quote-not-on-pages" }, cited);
}

/** About this many characters of a version are matched between yields: some 15 ms of the matcher. */
const LOOK_WINDOW = 30_000;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Windows over a version's text (its Units joined, see `joinUnits`), each about `LOOK_WINDOW` long
 * and cut after a line break where one is near, each starting at least `overlap` characters before
 * the one before ends: any stretch of the text shorter than `overlap` is whole in one of them, over
 * Units of any length. A cut inside a line is only for a line longer than a window.
 */
export function* windowsOf(text: string, overlap: number): Generator<TextRange> {
  const size = Math.max(LOOK_WINDOW, overlap * 2);
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n", end - 1) + 1;
      if (cut > start + overlap) end = cut;
    }
    yield { start, end };
    if (end === text.length) return;
    const next = text.lastIndexOf("\n", end - overlap - 1) + 1;
    start = next > start ? next : end - overlap;
  }
}

/**
 * Where the whole quote stands in a version, matched by the check's own `findQuote` a window at a
 * time with a turn of the event loop between (#3041), so a long Document never holds the app up.
 * At one place a Citation could cite, one Unit or two that run on: its Location. In more than one
 * place, or across more Units than a Citation cites: no Location. A quote with an ellipsis whose
 * parts each still stand, though no window holds them together: no Location. Nowhere: null. The
 * readings `findQuote` tries are tried in its order, a later one only when no window had the quote
 * in the one before.
 */
export async function quoteElsewhere(
  documents: RecheckDocuments,
  input: Rechecked,
  contentHash: string,
): Promise<CitationRecheck["elsewhere"]> {
  const { units, matching, inRange } = versionOf(documents, input.documentId, contentHash);
  const quote = cleanQuote(input.quote);
  if (quote === "") return null;
  const { text, starts } = joinUnits(units);
  const numbers = numbersIn(units);
  const readings = (numbers === "if-needed" ? [false, true] : [numbers === true]).flatMap(
    (each) => [
      { numbers: each, lostLigatures: false },
      ...(matching.lostLigatures ? [{ numbers: each, lostLigatures: true }] : []),
    ],
  );
  // As `placesOf` has it: room for the quote and the spacing matching passes over.
  const overlap = quote.length * 2 + 200;
  const standsIn = async (wanted: string) => {
    for (const reading of readings) {
      for (const { start, end } of windowsOf(text, overlap)) {
        await nextTurn();
        if (findQuote(text.slice(start, end), wanted, reading)) return true;
      }
    }
    return false;
  };
  const places: TextRange[][] = [];
  for (const reading of readings) {
    for (const { start, end } of windowsOf(text, overlap)) {
      await nextTurn();
      const window = text.slice(start, end);
      const found = findQuote(window, quote, reading);
      if (!found) continue;
      if (!findQuote(window, quote, { ...reading, unique: true })) return { location: null };
      const at = found.map((range) => ({ start: range.start + start, end: range.end + start }));
      if (!places.some((place) => place[0]?.start === at[0]?.start)) places.push(at);
      if (places.length > 1) return { location: null };
    }
    if (places.length > 0) break;
  }
  const [place] = places;
  if (!place) {
    // Its parts can stand further apart than a window: each is looked for on its own.
    const parts = quoteParts(quote);
    if (parts.length === 0) return null;
    for (const part of parts) if (!(await standsIn(part))) return null;
    return { location: null };
  }
  const covered = units.filter((unit, index) => {
    const at = starts[index] ?? 0;
    return place.some((range) => range.start < at + unit.text.length && range.end > at);
  });
  const [first, second] = covered;
  if (!first || first.page === null || covered.length > 2) return { location: null };
  if (second && (second.page !== first.page + 1 || !sameRun(first, second))) {
    return { location: null };
  }
  const cited = inRange({ pageFrom: first.page, pageTo: second?.page ?? first.page });
  return { location: locationOf(cited, quoteInUnits(cited, quote, matching)) };
}

/**
 * `quoteElsewhere` for a core: one look for each Citation at a time (#3041), so a card and the
 * viewer asking while it runs share it. Nothing is kept once it ends.
 */
export function sharedQuoteLooks(documents: RecheckDocuments) {
  const running = new Map<string, Promise<CitationRecheck["elsewhere"]>>();
  return (input: Rechecked, contentHash: string): Promise<CitationRecheck["elsewhere"]> => {
    const key = JSON.stringify([
      input.documentId,
      contentHash,
      input.quote,
      input.pageFrom,
      input.pageTo,
      input.location ?? null,
    ]);
    const known = running.get(key);
    if (known) return known;
    const look = quoteElsewhere(documents, input, contentHash).finally(() => running.delete(key));
    running.set(key, look);
    return look;
  };
}

// Processing peels running headers and footers off a PDF's stored pages (../documents/boilerplate):
// a selection that took them in at a page's edge is checked without them, "" if it was nothing else.
function withoutRunningLines(part: SelectedPart, unit: PageText, matching: Matching): string {
  const lines = part.text.split("\n").filter((line) => line.trim() !== "");
  const { edgeLines } = BOILERPLATE_PARAMETERS;
  const top = part.linesBefore === undefined ? 0 : Math.max(0, edgeLines - part.linesBefore);
  const foot = part.linesAfter === undefined ? 0 : Math.max(0, edgeLines - part.linesAfter);
  const pageStart = unit.text.length - unit.text.trimStart().length;
  const pageEnd = unit.text.trimEnd().length;
  // The fewest lines left out first; what is left out was at the page's very edge.
  for (let cut = 0; cut <= top + foot; cut++) {
    for (let fromTop = Math.min(cut, top); fromTop >= 0 && cut - fromTop <= foot; fromTop--) {
      const fromFoot = cut - fromTop;
      const kept = lines.slice(fromTop, lines.length - fromFoot);
      if (kept.length === 0) return "";
      const found = quoteInUnits([unit], kept.join("\n"), matching);
      if (!found) continue;
      if (fromTop > 0 && (found[0]?.start ?? 0) > pageStart) continue;
      if (fromFoot > 0 && (found.at(-1)?.end ?? 0) < pageEnd) continue;
      return kept.join("\n");
    }
  }
  return part.text;
}

// Looked for a window at a time, so a Document's length costs once over, not once for each place.
const PLACES_WINDOW = 20_000;
// More places than this are too many to tell apart: they aren't cited.
const MOST_PLACES = 50;

function placesOf(text: string, quote: string, options: MatchOptions): TextRange[][] {
  const places: TextRange[][] = [];
  const overlap = quote.length * 2 + 200;
  for (let from = 0; from < text.length && places.length <= MOST_PLACES; ) {
    const found = findQuote(text.slice(from, from + PLACES_WINDOW + overlap), quote, options);
    const first = found?.[0];
    // A place that starts in the overlap is found again from the next window.
    if (!found || !first || first.start >= PLACES_WINDOW) {
      from += PLACES_WINDOW;
      continue;
    }
    places.push(found.map((range) => ({ start: range.start + from, end: range.end + from })));
    from += first.start + 1;
  }
  return places;
}

const CONTEXT_LENGTHS = [60, 24, 8, 0];

// The far end may cut a word: it is left out, or a word the page writes whole would never match.
function contextOf(text: string, length: number, side: "before" | "after"): string {
  if (length === 0) return "";
  if (side === "before") {
    const tail = text.slice(-length);
    return tail.length < text.length ? tail.replace(/^\S+(?=\s)/u, "") : tail;
  }
  const head = text.slice(0, length);
  return head.length < text.length ? head.replace(/(?<=\s)\S+$/u, "") : head;
}

function placesIn(
  units: readonly PageText[],
  text: string,
  around: Pick<SelectedPart, "before" | "after">,
  matching: Matching,
): TextRange[][] {
  const joined = joinUnits(units).text;
  const options = { ...matching, numbers: numbersIn(units) };
  for (const length of CONTEXT_LENGTHS) {
    const before = contextOf(around.before ?? "", length, "before");
    const after = contextOf(around.after ?? "", length, "after");
    if (length > 0 && before === "" && after === "") continue;
    const spans = placesOf(joined, `${before}${text}${after}`, options);
    if (spans.length === 0) continue;
    return spans.flatMap((span) => {
      const start = span[0]?.start ?? 0;
      const end = span.at(-1)?.end ?? 0;
      const inSpan = joined.slice(start, end);
      // Matching passes over spacing, so the words before end where they are found, not at their length.
      const from =
        before.trim() === "" ? 0 : (findQuote(inSpan, before, options)?.at(-1)?.end ?? 0);
      const place = placesOf(inSpan, text, options).find((each) => (each[0]?.start ?? -1) >= from);
      return place
        ? [place.map((range) => ({ start: range.start + start, end: range.end + start }))]
        : [];
    });
  }
  return [];
}

/**
 * Cites what the User selected in a Document's viewer (see
 * `CoreApi.citeSelection`): parts on known Units are checked in those Units
 * alone, which become the Citation's, so it points where the User selected,
 * not at the same words elsewhere; refused, it keeps them. Where the words are
 * in several places, the words around them tell which, also from the Units
 * next to the selection's, and they are cited only when every place left gives
 * one Location (else "in-several-places"); on no known Unit, where the
 * Document has them in one place. The quote is read as words
 * (`readableQuote`), its radical look-alikes the ideographs they stand for,
 * and is found only as `recheckCitation` finds it. Given an `area` (#118), the
 * Location keeps the region; with no words in it, the region is a picture,
 * which can't be checked.
 */
export function citeSelection(
  documents: RecheckDocuments,
  input: {
    documentId: string;
    parts: readonly SelectedPart[];
    area?: CitedArea;
    unit?: number | null;
    around?: { before?: string; after?: string };
  },
): CitedSelection {
  const cited = citeSelectionAt(documents, input);
  if (!input.area) return cited;
  if (cited.quote.trim() === "") {
    return pictureCitation(
      documents,
      input.documentId,
      input.unit ?? input.parts[0]?.unit ?? null,
      input.area,
      input.around,
    );
  }
  const location =
    cited.location ?? placeIn(documents, input.documentId, cited.contentHash, input.unit ?? null);
  return location ? { ...cited, location: { ...location, area: input.area } } : cited;
}

/** The Unit whose text holds the words just before or after a region, where the view names no Unit. */
function unitAround(
  units: readonly PageText[],
  around: { before?: string; after?: string } | undefined,
  matching: Matching,
): PageText | undefined {
  if (!around) return undefined;
  const before = (around.before ?? "").trim();
  const after = (around.after ?? "").trim();
  const probes = [
    before.slice(-60).replace(/^\S+\s/, ""),
    before.slice(-30).replace(/^\S+\s/, ""),
    after.slice(0, 60).replace(/\s\S+$/, ""),
    after.slice(0, 30),
  ].filter((probe) => probe.trim() !== "");
  for (const probe of probes) {
    const on = units.filter((unit) => quoteInUnits([unit], probe, matching));
    // Words the User wrote once may be a page's running line repeated on every page: no single Unit is theirs.
    if (on.length === 1) return on[0];
  }
  return undefined;
}

/** The picture an area with no text is: its Citation points at the region and says it can't be checked. */
function pictureCitation(
  documents: RecheckDocuments,
  documentId: string,
  unit: number | null,
  area: CitedArea,
  around?: { before?: string; after?: string },
): CitedSelection {
  const contentHash = documents.currentVersion(documentId);
  if (contentHash === null) return { ...removedFrom({ pageFrom: unit, pageTo: unit }), quote: "" };
  const units = documents.pageTexts(documentId, contentHash, null, null);
  // No Unit named and no words around it: no place is guessed, so the figure names none.
  const on =
    unit !== null
      ? units.find((each) => each.page === unit)
      : unitAround(units, around, matchingOf(units));
  const location = on ? locationOf([on], null) : null;
  return {
    check: "cant-check",
    checkReason: "picture",
    contentHash,
    passageId: null,
    pageFrom: on?.page ?? null,
    pageTo: on?.page ?? null,
    location: location ? { ...location, area } : null,
    quote: "",
  };
}

/** The Location of a Unit on its own, for an area whose words weren't found: the region still names its place. */
function placeIn(
  documents: RecheckDocuments,
  documentId: string,
  contentHash: string | null,
  unit: number | null,
): CitationLocation | null {
  if (contentHash === null) return null;
  const units = documents.pageTexts(documentId, contentHash, null, null);
  // A view that names no Unit (Word, Markdown, a web page) must not have its area guessed onto the first.
  const on = unit === null ? undefined : units.find((each) => each.page === unit);
  return on ? locationOf([on], null) : null;
}

function citeSelectionAt(
  documents: RecheckDocuments,
  input: { documentId: string; parts: readonly SelectedPart[] },
): CitedSelection {
  const raw = input.parts.map((part) => part.text).join("\n");
  const all = foldRadicals(readableQuoteText(raw));
  const nowhere: PageRange = { pageFrom: null, pageTo: null };
  const known = input.parts.flatMap((part) => (part.unit === null ? [] : [part.unit]));
  const selected: PageRange =
    known.length > 0 ? { pageFrom: Math.min(...known), pageTo: Math.max(...known) } : nowhere;
  const contentHash = documents.currentVersion(input.documentId);
  if (contentHash === null) return { ...removedFrom(selected), quote: all };
  const version = versionOf(documents, input.documentId, contentHash);
  const { units, matching, inRange } = version;
  const refused = (check: CheckResult, range: PageRange, quote = all): CitedSelection => ({
    ...version.result(check, range, quote),
    ...(range.pageFrom === null && { location: null }),
    quote,
  });
  const around = { before: input.parts[0]?.before, after: input.parts.at(-1)?.after };
  const citeAt = (
    among: readonly PageText[],
    places: readonly TextRange[][],
    otherwise: PageRange,
    text: string,
  ): CitedSelection => {
    const { starts } = joinUnits(among);
    const cited = places.map((place) => {
      const start = place[0]?.start ?? 0;
      const end = place.at(-1)?.end ?? 0;
      const first = among.findIndex(
        (unit, index) => (starts[index] ?? 0) + unit.text.length > start,
      );
      const last = among.findLastIndex((_, index) => (starts[index] ?? 0) < end);
      const covered = among.slice(first, last + 1);
      const offset = starts[first] ?? 0;
      const found = place.map((range) => ({
        start: range.start - offset,
        end: range.end - offset,
      }));
      return { covered, found, location: JSON.stringify(locationOf(covered, found)) };
    });
    const [one] = cited;
    const unread = foldRadicals(readableQuoteText(text));
    if (!one) return refused(NOT_ON_PAGES, otherwise, unread);
    if (places.length > MOST_PLACES || cited.some((each) => each.location !== one.location)) {
      return refused({ check: "not-found", checkReason: "in-several-places" }, otherwise, unread);
    }
    const whole = one.covered[0]?.kind === "text";
    const pageFrom = whole ? null : (one.covered[0]?.page ?? null);
    const pageTo = whole ? null : (one.covered.at(-1)?.page ?? null);
    const range = { pageFrom, pageTo };
    if (pageFrom !== null && pageTo !== null && pageTo - pageFrom + 1 > MAX_CITED_PAGES) {
      return refused({ check: "not-found", checkReason: "too-many-pages" }, otherwise, unread);
    }
    const quote = foldRadicals(readableQuote(joinUnits(one.covered).text, one.found));
    // A Citation's quote is checked again as it is stored, cleaned as a model's is.
    const ranges = quoteInUnits(one.covered, cleanQuote(quote), matching);
    if (!ranges) {
      return refused(NOT_ON_PAGES, otherwise, quote);
    }
    const unsure = unsureWordsCovered(one.covered, ranges);
    return {
      ...version.result(
        unsure.length > 0 ? { check: "cant-check", checkReason: "unsure-word", unsure } : FOUND,
        range,
        quote,
        one.found,
      ),
      quote,
    };
  };
  const citeIn = (range: PageRange, text: string): CitedSelection => {
    const covered = inRange(range);
    const [head] = covered;
    if (!head) return refused(NOT_ON_PAGES, range, foldRadicals(readableQuoteText(text)));
    // The words around a selection at a Unit's edge are in the Unit next to it: they are matched
    // there too, and only places in the selection's own Units are kept.
    const at = units.indexOf(head);
    const from = Math.max(0, at - 1);
    const wider = units.slice(from, at + covered.length + 1);
    const start = joinUnits(wider).starts[at - from] ?? 0;
    const end = start + joinUnits(covered).text.length;
    const places = placesIn(wider, text, around, matching).flatMap((place) =>
      (place[0]?.start ?? -1) >= start && (place.at(-1)?.end ?? end + 1) <= end
        ? [place.map((range) => ({ start: range.start - start, end: range.end - start }))]
        : [],
    );
    return citeAt(covered, places, range, text);
  };
  if (units.every((unit) => unit.text.trim() === "")) {
    return refused({ check: "cant-check", checkReason: "no-text" }, selected);
  }
  // A whole TXT or Markdown file stored before Units is checked as one text.
  if (units.length === 1 && units[0]?.kind === "text") return citeIn(nowhere, raw);
  if (known.length === 0) {
    return citeAt(units, placesIn(units, raw, around, matching), nowhere, raw);
  }
  if (known.length < input.parts.length) return refused(NOT_ON_PAGES, selected);
  // A page at each end may hold nothing but a running header or footer: more can't be cited.
  if (selected.pageTo !== null && selected.pageFrom !== null) {
    if (selected.pageTo - selected.pageFrom + 1 > MAX_CITED_PAGES + 2) {
      return refused({ check: "not-found", checkReason: "too-many-pages" }, selected);
    }
  }
  const kept = input.parts.flatMap((part) => {
    const unit = units.find((each) => each.page === part.unit);
    const text = unit ? withoutRunningLines(part, unit, matching) : part.text;
    return text.trim() === "" ? [] : [{ unit: part.unit as number, text }];
  });
  const first = kept[0];
  const last = kept.at(-1);
  if (!first || !last) return refused(NOT_ON_PAGES, selected);
  const pages = kept.map((part) => part.unit);
  const range = { pageFrom: Math.min(...pages), pageTo: Math.max(...pages) };
  const text = kept.map((part) => part.text).join("\n");
  const covered = inRange(range);
  const [start, end] = [covered[0], covered.at(-1)];
  if (
    range.pageTo - range.pageFrom + 1 > MAX_CITED_PAGES ||
    (start && end && !sameRun(start, end))
  ) {
    const quote = foldRadicals(readableQuoteText(text));
    return refused({ check: "not-found", checkReason: "too-many-pages" }, range, quote);
  }
  return citeIn(range, text);
}

/**
 * Checks words the User selected to ask about (`AskedQuote`) against their Document's current
 * version: found only at their Location on their Units, as `citeSelection` cited them, never
 * moved to the same words elsewhere. Found, its quote is the Document's own words at that place,
 * read as `citeSelection` reads them; else it is "". The words given are only looked for: what
 * they hold that the matching passes over (location marks, say) never comes back.
 */
export function recheckWhereSelected(
  documents: RecheckDocuments,
  input: Pick<AskedQuote, "documentId" | "quote" | "pageFrom" | "pageTo" | "location">,
): CitedSelection {
  const cited = { pageFrom: input.pageFrom, pageTo: input.pageTo };
  const contentHash = documents.currentVersion(input.documentId);
  if (contentHash === null) return { ...removedFrom(cited), quote: "" };
  const quote = cleanQuote(input.quote);
  const version = versionOf(documents, input.documentId, contentHash);
  const covered = version.inRange(cited);
  const wanted = JSON.stringify(withoutArea(parseLocation(input.location)));
  const options = { ...version.matching, numbers: numbersIn(covered) };
  const place =
    quote === "" || covered.length === 0 || covered.length > MAX_CITED_PAGES
      ? undefined
      : placesOf(joinUnits(covered).text, quote, options).find(
          (found) =>
            JSON.stringify(withoutArea(parseLocation(locationOf(covered, found)))) === wanted,
        );
  const own = place ? foldRadicals(readableQuote(joinUnits(covered).text, place)) : "";
  const found = place ? quoteInUnits(covered, cleanQuote(own), version.matching) : null;
  if (!place || !found) {
    return { ...version.result(NOT_ON_PAGES, cited, quote), quote: "" };
  }
  const unsure = unsureWordsCovered(covered, found);
  return {
    ...version.result(
      unsure.length > 0 ? { check: "cant-check", checkReason: "unsure-word", unsure } : FOUND,
      cited,
      own,
      place,
    ),
    quote: own,
  };
}

/**
 * A Citation that a change of its sentence keeps (Edit with AI, #93), checked
 * again: its new attributes when its quote is found in the Document's current
 * version and it said otherwise (not found yet, or found in an older
 * version), else null. A quote the current version doesn't hold leaves the
 * Citation as it was: its check stands for the version it quotes, whose text
 * is kept. So does the User's choice to keep citing the old version
 * (`keptOver`, ADR-0017's amendment).
 */
export function recheckKept(
  documents: RecheckDocuments,
  attributes: Record<string, unknown>,
): Record<string, unknown> | null {
  const { documentId, quote, keptOver } = attributes;
  if (typeof documentId !== "string" || documentId === "") return null;
  if (typeof keptOver === "string" && keptOver !== "") return null;
  const page = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
  // The quote being found says nothing of the words the Answer put in quotation marks (#483).
  const { quotedWords, ...kept } = attributes;
  const now = recheckCitation(documents, {
    documentId,
    quote: typeof quote === "string" ? quote : "",
    pageFrom: page(attributes.pageFrom),
    pageTo: page(attributes.pageTo) ?? page(attributes.pageFrom),
    quotedWords: parseQuotedWords(quotedWords),
    location: parseLocation(attributes.location),
  });
  if (now.check !== "found") return null;
  if (attributes.check === "found" && attributes.contentHash === now.contentHash) return null;
  return {
    ...kept,
    check: now.check,
    checkReason: now.checkReason,
    contentHash: now.contentHash,
    passageId: now.passageId ?? attributes.passageId ?? null,
    pageFrom: now.pageFrom,
    pageTo: now.pageTo,
    location: now.location,
  };
}

const pagesLabel = ({ pageFrom, pageTo }: PageRange) =>
  pageFrom === null
    ? ""
    : pageTo !== null && pageTo !== pageFrom
      ? `${pageFrom}-${pageTo}`
      : `${pageFrom}`;

/** The English label of a Unit, as its mark in a Passage shows it. */
function unitMark(unit: PageText): string | null {
  if (unit.kind === "cues") return null; // each cue is marked with its time instead (./cueMarks)
  const place = englishPlace(unitLocation(unit));
  return place ? `[${place}]` : null;
}

/** The start of a stretch of text, long enough to find it again where it was laid out. */
const headOf = (text: string) => text.trim().slice(0, 200);

/**
 * The marks inside a Unit, after a paragraph break: where a slide's speaker
 * notes start ("[speaker notes]"), and where each Word comment read into a
 * section starts ("[comment by Reviewer]"), each with the start of what it marks.
 */
function innerMarks(unit: PageText): { head: string; mark: string }[] {
  const marks: { head: string; mark: string }[] = [];
  for (const anchor of unit.anchors ?? []) {
    const head = headOf(unit.text.slice(anchor.start, anchor.end));
    if (unit.kind === "slide" && anchor.target === "notes") {
      marks.push({ head, mark: NOTES_MARK });
    } else if (unit.kind === "section" && anchor.target.startsWith("comment")) {
      const comment = unit.label?.comments?.find((each) => each.target === anchor.target);
      marks.push({ head, mark: commentMark(comment?.author ?? null) });
    }
  }
  return marks;
}

/**
 * The Passage's text with marks where each of its later Units starts ("[p. 4]",
 * "[slide 4]", "[§ 2.1 Sensitivity]", "[Revenue, rows 2–41]"), and where a
 * slide's speaker notes or a Word comment start ("[speaker notes]",
 * "[comment by Reviewer]"), so the model can tell where a quote is, and what
 * it is. Found by matching the start of each Unit's stored text after a
 * paragraph break, which is how Units were laid out when the Passages were
 * built (and how a slide's notes follow its text, and a section's comments
 * its own). `units` are the Passage's, in order.
 */
function withUnitMarks(text: string, units: readonly PageText[]): string {
  const marks: { head: string; mark: string; unit: boolean }[] = [];
  units.forEach((unit, index) => {
    const mark = unitMark(unit);
    if (index > 0 && mark && unit.text.trim()) {
      marks.push({ head: headOf(unit.text), mark, unit: true });
    }
    for (const inner of innerMarks(unit)) marks.push({ ...inner, unit: false });
  });
  let marked = "";
  let from = 0;
  for (const { head, mark, unit } of marks) {
    if (!head) continue;
    if (from === 0 && marked === "" && text.startsWith(head) && !unit) {
      marked = `${mark} `;
      continue;
    }
    for (let at = text.indexOf("\n\n", from); at >= 0; at = text.indexOf("\n\n", at + 1)) {
      const rest = text.slice(at + 2);
      const length = Math.min(rest.length, head.length);
      if (length > 0 && rest.slice(0, length) === head.slice(0, length)) {
        marked += `${text.slice(from, at)}\n\n${mark} `;
        from = at + 2;
        break;
      }
    }
  }
  return marked + text.slice(from);
}

/**
 * `text` with each word a scan's recognizer was unsure of, or a number's
 * shape says it misread (#535), wrapped in ⟦ ⟧, so the model can see which
 * figures not to trust. The marks are never stored: `shownTexts` keeps the
 * text without them.
 */
function withUnsureMarks(text: string, units: readonly PageText[]): string {
  const marks: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  for (const unit of units) {
    for (const anchor of unit.anchors ?? []) {
      const line = foldRadicals(unit.text.slice(anchor.start, anchor.end));
      if (line === "") continue;
      const inOrder = text.indexOf(line, cursor);
      const at = inOrder >= 0 ? inOrder : text.indexOf(line);
      if (at < 0) continue;
      cursor = at + line.length;
      for (const [wordFrom, wordTo] of unsureSpansIn(unit)) {
        const from = Math.max(wordFrom, anchor.start);
        const to = Math.min(wordTo, anchor.end);
        if (from >= to) continue;
        const key = `${at + (from - anchor.start)}:${at + (to - anchor.start)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        marks.push({ start: at + (from - anchor.start), end: at + (to - anchor.start) });
      }
    }
  }
  let marked = text;
  for (const { start, end } of marks.sort((a, b) => b.start - a.start)) {
    marked = `${marked.slice(0, start)}⟦${marked.slice(start, end)}⟧${marked.slice(end)}`;
  }
  return marked;
}

const attribute = (value: string) => asAttribute(value, ["passage"]);

/** A Passage as the model sees it: its short id, Document and its date, where it is, and its text. */
interface ShownPassage {
  id: string;
  documentName: string;
  /** Its Document's date, when known: what tells the newer of two Documents that disagree (#548). */
  date: DocumentDate | null;
  range: PageRange;
  /** For every kind but PDF: the label of the Units it covers, e.g. "slides 3–4". */
  location: string | null;
  text: string;
  notCited: boolean;
  /** A workbook's rows whose figures its formulas work out, which the text doesn't show (#2372). */
  formulas: string | null;
  /** The call a Transcript Passage is from, when the Answer is asked during one (#3005). */
  call: (TranscriptCall & { thisCall: boolean }) | null;
}

/**
 * A call Transcript's attributes: this call's, or an earlier one's by its Note, each with its start
 * in words, so two Transcripts named for the same day are told apart (#3005).
 */
function callAttributes(call: ShownPassage["call"]): string {
  if (!call) return "";
  const started = ` started="${attribute(formatFullDateTime(call.startedAt, "en"))}"`;
  return call.thisCall
    ? ` call="this"${started}`
    : ` call="earlier" note="${attribute(call.note)}"${started}`;
}

/** Passages as the model sees them, each with its short id, Document, its date, and pages or Location. */
function formatPassages(passages: readonly ShownPassage[], also: readonly PromptTag[]): string {
  return passages
    .map(({ id, documentName, date, range, location, text, notCited, formulas, call }) => {
      const pages = pagesLabel(range);
      const where = location
        ? ` location="${attribute(location)}"`
        : pages
          ? ` pages="${pages}"`
          : "";
      const dated = date
        ? ` ${date.of === "document" ? "date" : date.of}="${attribute(date.date)}"`
        : "";
      const never = notCited ? NOT_CITED_ATTRIBUTE : "";
      const worked = formulas ? ` formulas="${attribute(formulas)}"` : "";
      return tagged(
        "passage",
        text,
        ` id="${id}" document="${attribute(documentName)}"${dated}${where}${callAttributes(call)}${worked}${never}`,
        also,
      );
    })
    .join("\n\n");
}

/** A record the core accepted, with what it points to. */
interface Accepted {
  marker: number;
  handle: string;
  source: CitationSource;
  /** Where the model said its quote is, as it said it: a corrected quote is taken with it (`correctQuote`). */
  given: Pick<CitationRecordInput, "location" | "pageFrom" | "pageTo">;
  range: PageRange;
  requested: RowsOrLines | null;
  time?: RowsOrLines;
  unresolved: boolean;
  quote: string;
  /**
   * The words its Citation shows, when they aren't `quote`: a found quote's whole sentences
   * (./wholeSentences, #2739). The check, a figure's inputs and the model's feedback read `quote`.
   */
  shown?: string;
  /** Where it points, for its label, worked out once when the record is taken. */
  location: Citation["location"];
  result: CheckResult | null;
  /**
   * Its quote's check as it was recorded, which call help shows while the reply is still written
   * (#2847). `result`, the end's, differs from it only where the Answer's own quoted words aren't in
   * the cited place, or the Document was deleted meanwhile.
   */
  atCite?: CheckResult;
  /**
   * The Answer's quoted words that its sentence's Citations don't have, when they made `result`
   * not found (#483), or the page they run on to past the one it cites (#2504).
   */
  quotedWords?: QuotedWordsCheck;
  /** The words of the Answer's quotation marks this record's Units state (#2602). */
  quotedWordsFound?: string[];
  /** Its found quote's table cells, as the cite found them (`quoteCells`), for call help (#2847). */
  cells?: QuoteCell[];
  /** A Citation of the Question context, kept as it is (#1800): there is nothing of it to fix. */
  kept?: true;
  /**
   * Who's who in the Transcript it cites as its model had just read it, when it was taken
   * (#2839): the same Passage shown again after the speaker pass is marked anew.
   */
  speakers?: TranscriptSpeakers | null;
}

/** A record as `take` read it: accepted, with its Passage's Units; or why not. */
type Taken =
  | { ok: true; record: Accepted; source: CitationSource; passageUnits: PageText[] }
  | { ok: false; rejected: RejectedRecord; problem: string };

/** A quote that isn't for a marker: where an input of a calculated figure reads its number (./calculations). */
export type QuoteInput = Omit<CitationRecordInput, "marker">;

/** A quote the core took, as a Citation of the Answer's: what a calculated figure's input reads. */
export interface Quoted {
  /** The Passage's id, as the model was given it: "P3". */
  passage: string;
  /** The Passage's own text, as it was built: where a quote of it was taken from. */
  passageText: string;
  /** How the check matches the quote in its Units. */
  matching: Matching;
  /** Its Citation, "checking". */
  citation: Citation;
  /** The stored text of the Units it cites, of the version it quotes. */
  units: PageText[];
  /** The Citation check, with the Document as it is now. */
  check(): CheckResult;
}

const toCitation = (record: Accepted, result: CheckResult | null, asShown = true): Citation => ({
  passageId: record.source.passageId,
  documentId: record.source.documentId,
  documentName: record.source.documentName,
  contentHash: record.source.contentHash,
  pageFrom: record.range.pageFrom,
  pageTo: record.range.pageTo,
  location: record.location,
  // A Citation that ends not found shows the words that weren't, not a sentence around them.
  ...(asShown && record.shown && (!result || result.check === "found")
    ? { quote: record.shown, given: record.quote }
    : { quote: record.quote }),
  ...(record.source.yourNoteAt && { yourNoteAt: record.source.yourNoteAt }),
  check: result?.check ?? "checking",
  checkReason: result?.checkReason ?? null,
  ...(result?.unsure && result.unsure.length > 0 && { unsure: result.unsure }),
  ...(record.quotedWords && { quotedWords: record.quotedWords }),
  ...(record.quotedWordsFound && { quotedWordsFound: record.quotedWordsFound }),
  ...(record.cells && { cells: record.cells }),
});

export interface CitationSessionEvents {
  /** The model gave a valid record for a marker (again: it replaces the earlier one). */
  onRecord(marker: number, citation: Citation): void;
  /** Whether a workbook's Passage names the rows its formulas work out: when the model can trace them (#2372). */
  marksFormulas?(): boolean;
  /**
   * The tags of the prompt the Passages are shown in besides `passage`, which their text may not
   * open or close: the Answer's own (#2473) or a check's (#2423). A quote copied from them still
   * matches (`quoteAsIn`).
   */
  defuses?: readonly PromptTag[];
  /**
   * Whether a found quote shows as the whole sentence that holds it, and `cite` tells the model
   * once when two records give one quote (#2739): an Answer's, unless the evaluation compares the
   * quotes as given. A check's own evidence keeps its quote.
   */
  quotesStateClaims?(): boolean;
  /**
   * Whether a found quote that is cells of a table keeps them, read once as it is cited: call
   * help's, whose quote line draws them (#2847).
   */
  tableCells?(): boolean;
  /**
   * Whether a Document is the Transcript of the call the Answer is asked during (#3005); undefined
   * when it is asked during none, so no Passage is marked with its call.
   */
  thisCall?(documentId: string): boolean | undefined;
}

/**
 * One Answer's Citations: the Passages it was given (each with a short id such
 * as "P3", which is what the model cites), the records it gave, and the Tools
 * the Answer engine offers the model. `opening`, when the Question is asked
 * beside the working copy of a Document (#1036): that Document's opening
 * Passages, which a search that finds nothing gives instead, once. `ids`: the Citations the
 * Question context shows, which a record names by id to keep one as it is.
 */
export function createCitationSession(
  documents: Omit<AnswerDocuments, "search" | "searchableCount"> &
    Partial<Pick<AnswerDocuments, "search" | "searchableCount">>,
  events: CitationSessionEvents,
  opening?: { documentId: string; name: string; passages(): WindowedPassage[] },
  ids?: ContextCitations,
) {
  const handles = new Map<string, string>();
  const handleOf = new Map<string, string>();
  /** Each Passage's text as the model was given it, by its short id. */
  const shownTexts = new Map<string, string>();
  /** Who's who each Transcript Passage was marked with, by its handle, as `shownTexts` keeps its text. */
  const shownSpeakers = new Map<string, TranscriptSpeakers | null>();
  const records = new Map<number, Accepted>();
  /** Markers whose last record from a `cite` call was refused or came back with a problem to fix. */
  const toFix = new Set<number>();
  /** Quotes `cite` has told the model two records share, by Document: each told once, as advice. */
  const toldSameQuote = new Set<string>();
  /** Records naming no Passage the model was given, or no marker: as given, and why. */
  const rejected: RejectedRecord[] = [];
  const searched = new Set<string>();
  let reads = 0;
  const passageDocuments: string[] = [];
  /** What the model was given of each Passage, in the order it was, with its Document and its kind. */
  const read: {
    documentId: string;
    documentName: string;
    text: string;
    kind: DocumentKind;
  }[] = [];
  const searchedDocuments: string[] = [];
  const remember = (list: string[], id: string) => {
    if (!list.includes(id)) list.push(id);
  };
  let openingGiven = false;
  /** Markers in the final text, in order of first appearance, and those that had no record. */
  const finalMarkers: number[] = [];
  let removedMarkers = 0;
  /** Markers whose Citations went into a Mind rather than the Answer's text (#202). */
  const placedElsewhere = new Set<number>();
  /** The Question context's Citations the model wrote as ids in text, not as records (`citeWrittenIds`), each once. */
  const idsAsText = new Set<string>();

  const handleFor = (passageId: string) => {
    let handle = handleOf.get(passageId);
    if (!handle) {
      handle = `P${handleOf.size + 1}`;
      handleOf.set(passageId, handle);
      handles.set(handle.toLowerCase(), passageId);
    }
    return handle;
  };

  /** The Passage a record names: by its short id or its full id, if the model was given it. */
  const resolve = (name: string): { handle: string; passageId: string } | null => {
    const key = name
      .trim()
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    const byHandle = handles.get(key);
    if (byHandle) return { handle: handleOf.get(byHandle) as string, passageId: byHandle };
    for (const [passageId, handle] of handleOf) {
      if (passageId.toLowerCase() === key) return { handle, passageId };
    }
    return null;
  };

  /** How quotes are matched in each Document version's text (see `matchingOf`), worked out once. */
  const matchings = new Map<string, Matching>();
  const matchingFor = (source: Pick<CitationSource, "documentId" | "contentHash">): Matching => {
    const key = `${source.documentId}\n${source.contentHash}`;
    let matching = matchings.get(key);
    if (!matching) {
      matching = matchingOf(documents.pageTexts(source.documentId, source.contentHash, null, null));
      matchings.set(key, matching);
    }
    return matching;
  };

  /** Who's who in the Transcript a Passage is from, as it was last shown to the model, else as it is. */
  const lastShown = (
    handle: string,
    source: Pick<CitationSource, "documentId" | "documentKind">,
  ) => {
    if (source.documentKind !== "transcript") return null;
    const shown = shownSpeakers.get(handle);
    return shown !== undefined ? shown : (documents.speakers?.(source.documentId) ?? null);
  };

  /**
   * Who's who in a Transcript a record cites (#138): the names its model read in the Passage it
   * names, kept with the record. The speaker pass may change who's who while a reply is out, or
   * before the Passage is shown again (#2839); a Citation stores its line's own label, so it
   * shows who's who as it is now.
   */
  const speakersFor = (record: Pick<Accepted, "handle" | "source" | "speakers">) =>
    record.speakers !== undefined ? record.speakers : lastShown(record.handle, record.source);

  /** The stored text of the Units a record cites, of the version its Passage was built from. */
  const citedText = (record: Pick<Accepted, "source" | "range">) =>
    documents.pageTexts(
      record.source.documentId,
      record.source.contentHash,
      record.range.pageFrom,
      record.range.pageTo,
    );

  /** The text of a sheet's title rows (`titleRowsOf`), by Document version and sheet, read once. */
  const titles = new Map<string, string>();
  function titleRows(record: Pick<Accepted, "source">, sheet: string | null): string {
    const key = `${record.source.documentId}\n${record.source.contentHash}\n${sheet ?? ""}`;
    const known = titles.get(key);
    if (known !== undefined) return known;
    const text = titleRowsOf(
      documents.pageTexts(record.source.documentId, record.source.contentHash, null, null),
      sheet,
    );
    titles.set(key, text);
    return text;
  }

  /**
   * The Units a sheet's header row may be in, by Document version and sheet, read once: the Units
   * of its first rows, which `headerRow` looks among. Not every Unit whose first line repeats the
   * header: on a long sheet that is every Unit, and each cite would read the whole sheet (#2847).
   */
  const heads = new Map<string, PageText[]>();
  function headUnits(record: Pick<Accepted, "source">, sheet: string | null): PageText[] {
    const key = `${record.source.documentId}\n${record.source.contentHash}\n${sheet ?? ""}`;
    const known = heads.get(key);
    if (known) return known;
    const units = documents
      .pageTexts(record.source.documentId, record.source.contentHash, null, null)
      .filter(
        (unit) =>
          unit.kind === "rows" &&
          (unit.label?.sheet ?? null) === sheet &&
          (unit.label?.rows ?? [])
            .slice(unit.label?.header ? 1 : 0)
            .some((row) => row <= HEADER_ROWS),
      );
    heads.set(key, units);
    return units;
  }

  /** A found quote's table cells (`quoteCells`), from the Units it cites and its sheet's header. */
  const cellsOf = (record: Accepted): QuoteCell[] | null => {
    const cited = citedText(record);
    const sheets = new Set(
      cited.filter((unit) => unit.kind === "rows").map((unit) => unit.label?.sheet ?? null),
    );
    const above = [...sheets].flatMap((sheet) =>
      headUnits(record, sheet).filter((unit) => !cited.some((each) => each.page === unit.page)),
    );
    return quoteCells(record.shown ?? record.quote, [...above, ...cited]);
  };

  /**
   * What a record's cite found, kept as it lands: its quote's check and, for call help, its found
   * quote's table cells, which nothing reads again.
   */
  const keepAtCite = (record: Accepted, result: CheckResult) => {
    record.atCite = result;
    if (result.check !== "found" || !events.tableCells?.()) return;
    const cells = cellsOf(record);
    if (cells) record.cells = cells;
  };

  /**
   * The check, with the Document as it is now: it may have been deleted since
   * the record. The text read is that of the version the Passage was built
   * from, which the Citation records: the Document may have a newer one by now.
   */
  const check = (record: Accepted) => {
    const now = documents.citationSource(record.source.passageId);
    const pages = citedText(record);
    const result = checkCitation({
      quote: record.quote,
      range: record.range,
      passage: record.source,
      documentDeleted: !now || now.documentDeleted,
      pages,
      unresolved: record.unresolved,
      ...matchingFor(record.source),
    });
    return result.check === "found" &&
      record.time &&
      !quoteInCues(
        pages,
        record.quote,
        record.time,
        matchingFor(record.source),
        speakersFor(record),
      )
      ? NOT_ON_PAGES
      : result;
  };

  /** A record's cited place, as the check of quoted words reads it (#2712). */
  const placeOf = (record: Accepted): QuotedWordsPlace & { record: Accepted } => {
    const units = citedText(record);
    const matching = matchingFor(record.source);
    const { pageFrom, pageTo } = record.range;
    return {
      record,
      units,
      matching,
      find: (words) =>
        record.time
          ? quoteInCues(units, words, record.time, matching, speakersFor(record))
          : quoteInUnits(units, words, matching),
      documentName: record.source.documentName,
      throughNextUnit: () =>
        pageFrom !== null && pageFrom === pageTo
          ? documents.pageTexts(
              record.source.documentId,
              record.source.contentHash,
              pageFrom,
              pageTo + 1,
            )
          : null,
      titleRows: (sheet) => titleRows(record, sheet),
      cantCheck: record.result?.check === "cant-check",
    };
  };

  /**
   * The check of quoted words (#483) for each sentence, by `quotedWordsVerdict`, written onto the
   * records `entry` gives for its markers: the records, or copies of them. Returns the words that
   * are a translation.
   */
  const applyQuotedWords = (
    quoted: readonly QuotedSentence[],
    entry: (marker: number) => Accepted | undefined,
  ): string[] => {
    const translated: string[] = [];
    /** Keeps `words` with the record whose Units state them, for the check of its figures (#2602). */
    const states = (record: Accepted, words: string) => {
      record.quotedWordsFound ??= [];
      if (!record.quotedWordsFound.includes(words)) record.quotedWordsFound.push(words);
    };
    const names = [...records.values()].map(({ source }) => source.documentName);
    for (const { words, markers } of quoted) {
      const cited = [...new Set(markers)].flatMap((marker) => {
        const record = entry(marker);
        return record ? [placeOf(record)] : [];
      });
      const verdict = quotedWordsVerdict(words, cited, names);
      if (verdict.kind === "stated" || verdict.kind === "title") {
        for (const { record } of verdict.by) states(record, words);
      } else if (verdict.kind === "name") {
        // The Citation says so and keeps its own quote's check, never found or not found by it.
        for (const { record } of verdict.by) record.quotedWords ??= { name: words };
      } else if (verdict.kind === "run-on") {
        const runsOnTo = locationOf([verdict.next], null);
        if (runsOnTo) verdict.by.record.quotedWords ??= { runsOnTo };
        states(verdict.by.record, words);
      } else if (verdict.kind === "translation") {
        translated.push(words);
      } else if (verdict.kind === "not-found") {
        const nearest = nearestPlace(words, cited);
        if (nearest?.place.record.result?.check !== "found") continue;
        nearest.place.record.result = {
          check: "not-found",
          checkReason: "quoted-words-not-on-pages",
        };
        nearest.place.record.quotedWords = nearest.shown();
      }
    }
    return translated;
  };

  /** Where a record points, for its label: narrowed to its quote when the quote is there. */
  const locationFor = (record: Omit<Accepted, "location">): Citation["location"] => {
    if (record.range.pageFrom === null) return null;
    const units = citedText(record);
    if (units.length === 0) {
      return record.source.documentKind === "pdf" && record.range.pageTo !== null
        ? { kind: "page", from: record.range.pageFrom, to: record.range.pageTo }
        : null;
    }
    const usable = record.unresolved || units.length > MAX_CITED_PAGES ? null : units;
    return locationOf(
      units,
      usable
        ? record.time
          ? quoteInCues(
              usable,
              record.quote,
              record.time,
              matchingFor(record.source),
              speakersFor(record),
            )
          : quoteInUnits(usable, record.quote, matchingFor(record.source))
        : null,
      record.requested,
    );
  };

  /**
   * A Passage as structured output may name it, read as its id: by its number
   * alone ("1", "[1]", "Passage 1"), or its id with more ("P1 (p. 9)", "P1, P2").
   */
  const loosely = (name: string): string => {
    const alone = /^\s*\[?\s*(?:passage\s*)?(\d{1,4})\s*\]?\s*$/i.exec(name);
    if (alone) return `P${alone[1]}`;
    const id = /(?<![\p{L}\p{N}])P\s?(\d{1,4})(?!\p{N})/iu.exec(name);
    return id ? `P${id[1]}` : name;
  };

  /** The first Passage the model was given whose pages hold the quote word for word, or null. */
  const passageWithQuote = (quote: string): { handle: string; passageId: string } | null => {
    if (!quote) return null;
    for (const [passageId, handle] of handleOf) {
      const source = documents.citationSource(passageId);
      if (!source || source.documentDeleted || source.notCited) continue;
      const units = documents.pageTexts(
        source.documentId,
        source.contentHash,
        source.pageFrom,
        source.pageTo,
      );
      if (quoteInUnits(units, quote, matchingFor(source))) return { handle, passageId };
    }
    return null;
  };

  /** Reads a record: the Passage it names, the Units it cites and its quote; or why it can't be taken. */
  function take(
    input: CitationRecordInput,
    options: CiteOptions,
    read?: TranscriptSpeakers | null,
  ): Taken {
    const marker = input.marker;
    const given = String(input.passage ?? "").slice(0, 200);
    if (!Number.isInteger(marker) || marker < 1) {
      return {
        ok: false,
        rejected: {
          marker: Number.isFinite(marker) ? marker : null,
          passage: given,
          reason: "marker",
        },
        problem: `A record needs a marker number (1, 2, …) that is in the Answer as [^n].`,
      };
    }
    const taken = takeQuote(input, marker, options, true, read);
    if (taken.ok && !taken.record.kept) {
      const problem =
        quotePlaceProblem(
          taken.record.quote,
          citedText(taken.record),
          matchingFor(taken.source),
          taken.record.time,
          speakersFor(taken.record),
        ) ??
        (!taken.record.time && check(taken.record).check === "not-found"
          ? quotePlaceProblem(taken.record.quote, taken.passageUnits, matchingFor(taken.source))
          : null);
      if (problem) {
        return {
          ok: false,
          rejected: { marker, passage: given, reason: "quote-context" },
          problem: `[^${marker}]: ${problem}`,
        };
      }
    }
    return taken.ok
      ? taken
      : {
          ok: false,
          rejected: { marker, passage: given, reason: "passage" },
          problem: `[^${marker}]: ${taken.problem}`,
        };
  }

  /** `take`, for a quote with or without a marker (0 for none). A calculated figure's direct input keeps its supplied Location (#1979). */
  function takeQuote(
    input: QuoteInput,
    marker: number,
    options: CiteOptions,
    relocate = true,
    /** Who's who as its model read the Passage, where an earlier record of it says. */
    read?: TranscriptSpeakers | null,
  ): Extract<Taken, { ok: true }> | { ok: false; problem: string } {
    const named = typeof input.passage === "string" ? input.passage : "";
    const kept = ids?.get(named);
    if (kept) return takeKept(issuedForm(named), kept, marker);
    const written = cleanQuote(typeof input.quote === "string" ? input.quote : "");
    // Structured output can't be told it named no Passage (see `CiteOptions`): its id read loosely,
    // else the Passage it was given that holds its quote.
    const known = <Found extends { passageId: string }>(each: Found | null): Found | null =>
      each && documents.citationSource(each.passageId) ? each : null;
    const found =
      known(resolve(named)) ??
      (options.structured
        ? (known(resolve(loosely(named))) ??
          passageWithQuote(written) ??
          passageWithQuote(fromData(written)))
        : null);
    const source = found && documents.citationSource(found.passageId);
    if (!found || !source) {
      return {
        ok: false,
        problem: `there is no Passage "${String(input.passage)}" in your search results; use a Passage's id, such as P1.`,
      };
    }
    if (source.notCited) {
      return {
        ok: false,
        problem: `${found.handle} is from the User's own working file, which is read but never cited; cite a Passage from another Document, or leave the claim without a marker.`,
      };
    }
    const passageUnits = documents.pageTexts(
      source.documentId,
      source.contentHash,
      source.pageFrom,
      source.pageTo,
    );
    const quote = quoteAsIn(passageUnits, written, matchingFor(source));
    const { range, requested, time, unresolved } = citedUnits(
      { ...input, quote },
      source,
      passageUnits,
      matchingFor(source),
    );
    const taken = {
      marker,
      handle: found.handle,
      source,
      given: { location: input.location, pageFrom: input.pageFrom, pageTo: input.pageTo },
      range,
      requested,
      time,
      unresolved,
      quote,
      result: null,
      speakers: read !== undefined ? read : lastShown(found.handle, source),
    };
    let record: Accepted = { ...taken, location: locationFor(taken) };
    // A quote that isn't where it names is cited where it uniquely occurs in its Passage,
    // never outside it, and the check still reads it there.
    const selectedTime =
      source.documentKind === "transcript" &&
      typeof input.location === "string" &&
      input.location.trim();
    if (relocate && !selectedTime && quote && check(record).check === "not-found") {
      const placedAt = locateQuote(passageUnits, quote, matchingFor(source));
      if (placedAt) {
        const placed = { ...taken, range: placedAt, requested: null, unresolved: false };
        record = { ...placed, location: locationFor(placed) };
      }
    }
    if (marker > 0 && events.quotesStateClaims?.() && check(record).check === "found") {
      const shown = wholeSentences(citedText(record), quote, matchingFor(source));
      // Words around the quote may hold a scan's word that may be misread: the check reads them too.
      // The Location stays the quote's: a page's is its Units', and a sentence ends at any other
      // Unit's line break, so the shown one never leaves the quote's line, paragraph, figure or
      // comment.
      if (shown !== quote && check({ ...record, quote: shown }).check === "found") {
        record = { ...record, shown };
      }
    }
    return { ok: true, record, source, passageUnits };
  }

  /**
   * A Citation of the Question context, as it is: its Passage, the version it quotes (ADR-0010),
   * its Units, Location and quote. The check reads that version, so a Document changed or
   * deleted since says so, as the Citation did where it was read.
   */
  function takeKept(
    id: string,
    kept: ContextCitation,
    marker: number,
  ): Extract<Taken, { ok: true }> | { ok: false; problem: string } {
    const passage = kept.passageId === null ? null : documents.citationSource(kept.passageId);
    if (!passage) {
      return {
        ok: false,
        problem: `${id} can't be kept: what it cites is no longer in the User's Documents. Keep its claim without a marker, and say its source is no longer available.`,
      };
    }
    if (passage.notCited) {
      return {
        ok: false,
        problem: `${id} is from the User's own working file, which is read but never cited; leave its claim without a marker.`,
      };
    }
    const source: CitationSource = {
      ...passage,
      documentName: kept.documentName ?? passage.documentName,
      contentHash: kept.contentHash ?? passage.contentHash,
    };
    const passageUnits = documents.pageTexts(
      source.documentId,
      source.contentHash,
      source.pageFrom,
      source.pageTo,
    );
    const record: Accepted = {
      marker,
      handle: id,
      source,
      given: { location: null, pageFrom: kept.pageFrom, pageTo: kept.pageTo },
      range: { pageFrom: kept.pageFrom, pageTo: kept.pageTo },
      requested: null,
      unresolved: false,
      quote: kept.quote,
      location: kept.location,
      result: null,
      kept: true,
    };
    return { ok: true, record, source, passageUnits };
  }

  /** Takes records; returns what to tell the model about them. */
  function cite(inputs: readonly CitationRecordInput[], options: CiteOptions = {}): string {
    const recorded: number[] = [];
    const problems: string[] = [];
    const advice: string[] = [];
    for (const input of inputs) {
      const taken = take(input, options);
      if (!taken.ok) {
        rejected.push(taken.rejected);
        problems.push(taken.problem);
        if (!options.structured && taken.rejected.marker !== null) toFix.add(taken.rejected.marker);
        continue;
      }
      const { record, source, passageUnits } = taken;
      const { marker } = record;
      keepAtCite(record, check(record));
      records.set(marker, record);
      recorded.push(marker);
      events.onRecord(marker, toCitation(record, null));
      // Tell the model now what the check will find, so it can fix the record.
      const problem = record.kept ? null : recordProblem(record, source, passageUnits);
      if (problem) {
        problems.push(`[^${marker}]: ${problem}`);
        if (!options.structured) toFix.add(marker);
      } else toFix.delete(marker);
      const same = problem ? null : sameQuoteAs(record);
      const told =
        same === null ? null : `${record.source.documentId}\n${normaliseText(record.quote)}`;
      if (told !== null && !toldSameQuote.has(told)) {
        toldSameQuote.add(told);
        advice.push(
          ` [^${marker}] gives the quote of [^${same}]. If its claim is another, record it again with the words that state that claim; if it is the same claim, write [^${same}] for it.`,
        );
      }
    }
    const done = recorded.length
      ? `Recorded ${recorded.map((marker) => `[^${marker}]`).join(", ")}.`
      : "Nothing was recorded.";
    // Advice, not a fix: asked as one, the gate's Answers were judged right less often and kept
    // their shared quotes (#2739); and an Answer written beside `cite` stays complete.
    const fix = problems.length ? ` ${FIX_THESE}\n- ${problems.join("\n- ")}` : WRITE_NOW;
    return `${done}${advice.join("")}${fix}`;
  }

  /**
   * Another marker whose record gives the same words of the same Document, or null: citing first,
   * a model gave the quote of one claim to the next sentence's claim too (#2739).
   */
  function sameQuoteAs(record: Accepted): number | null {
    if (!events.quotesStateClaims?.() || record.kept || !record.quote) return null;
    const words = normaliseText(record.quote);
    for (const other of records.values()) {
      if (
        other.marker !== record.marker &&
        !other.kept &&
        other.source.documentId === record.source.documentId &&
        normaliseText(other.quote) === words
      ) {
        return other.marker;
      }
    }
    return null;
  }

  /** What the check will find wrong with a record, for the model to fix; null when nothing. */
  function recordProblem(
    record: Accepted,
    source: CitationSource,
    passageUnits: readonly PageText[],
  ): string | null {
    const { handle } = record;
    const where = passageUnits.length > 0 ? passageLocation(passageUnits) : null;
    const cueAdvice =
      source.documentKind === "transcript"
        ? `copy the exact cue timestamp from ${handle} (for example "0:11" or "0:11 Dana") and its word-for-word quote; do not omit or broaden the requested time/speaker to match words elsewhere.`
        : null;
    if (pageRangeProblem(record.range, source, record.unresolved)) {
      if (cueAdvice) {
        return `give a cue timestamp in ${handle}; a speaker name alone is not a timestamp; ${cueAdvice}`;
      }
      return where
        ? `give a location inside ${handle} (${where}), naming one place, or two in a row.`
        : `cite one page, or two consecutive pages, within ${handle}'s pages (${pagesLabel(source)}).`;
    }
    if (!record.quote) return `the quote is empty; copy a short quote from ${handle}.`;
    if ((record.atCite ?? check(record)).check !== "not-found") return null;
    if (cueAdvice && record.time) {
      return `the quote was not found at the requested time/speaker "${record.given.location}" in ${handle}; ${cueAdvice}`;
    }
    if (
      writtenInCjk(record.quote) !== writtenInCjk(passageUnits.map((unit) => unit.text).join("\n"))
    ) {
      return `the quote is a translation: copy it from ${handle} in the Passage's own language, word for word, never translated.`;
    }
    return where
      ? `the quote isn't word for word at ${cutLocation(record) ?? where} in ${handle}; copy it exactly, and check where it is.`
      : `the quote isn't word for word${record.range.pageFrom === null ? "" : ` on p. ${pagesLabel(record.range)}`} in ${handle}; copy it exactly, and check its page.`;
  }

  /** A record as a calculated figure's input reads it. */
  const quotedOf = (record: Accepted): Quoted => ({
    passage: record.handle,
    passageText: record.source.text,
    matching: matchingFor(record.source),
    // A figure reads its number from the words the model gave, not the sentence shown around them.
    citation: toCitation(record, null, false),
    units: citedText(record),
    check: () => check(record),
  });

  /** The English label of a record's cited Units, as a whole: "slide 4", "§ 2.1 Sensitivity". */
  const cutLocation = (record: Accepted): string | null => {
    if (record.range.pageFrom === null) return null;
    return englishPlace(locationOf(citedText(record), null, record.requested));
  };

  /** The English label of a Passage's Units, as its `location` attribute shows them. */
  const passageLocation = (units: readonly PageText[]): string | null => {
    if ((units[0]?.kind ?? "page") === "page") return null;
    return englishPlace(locationOf(units, null));
  };

  /** Searches, and gives the model what it found: each Passage under the id it cites it by. */
  async function search(
    query: string,
    signal: AbortSignal | undefined,
    within?: readonly string[],
    options?: AnswerSearchOptions,
  ): Promise<SearchResultForModel> {
    const found = await find(query, signal, within, options);
    if (found.length === 0) {
      // The miss is the search's, as `coverageOf` says of results that cover only some pages (#1443).
      return {
        text: "No Passages in the User's Documents match this search.",
        passageCount: 0,
        coverage: () =>
          "A miss in these results is not evidence that the Documents lack the answer.",
      };
    }
    return {
      text: show(found),
      passageCount: found.length,
      passageIds: found.map((passage) => passage.passageId),
      ranks: found.map((passage, index) => passage.rank ?? index),
      coverage: coverageOf(found),
      // Someone else wrote a saved web page: reading it makes the Run third-party (#78).
      ...(found.some((passage) => passage.documentKind === "web") && {
        thirdParty: ["web-page"] as const,
      }),
    };
  }

  function find(...args: Parameters<AnswerDocuments["search"]>) {
    if (!documents.search)
      throw new Error("Document search is unavailable in this Citation session.");
    return documents.search(...args);
  }

  /**
   * The Passages as the model reads them, each under the id it cites it by.
   * `measuring`: only to count what showing them would send, so nothing is recorded as shown.
   */
  function show(found: readonly WindowedPassage[], measuring = false): string {
    if (!measuring) for (const passage of found) remember(passageDocuments, passage.documentId);
    let unseen = 0;
    const dates = new Map<string, DocumentDate | null>();
    const dateOf = (documentId: string) => {
      if (!dates.has(documentId)) dates.set(documentId, documents.documentDate(documentId));
      return dates.get(documentId) ?? null;
    };
    const calls = new Map<string, ShownPassage["call"]>();
    const callOf = (documentId: string) => {
      if (!calls.has(documentId)) {
        const thisCall = events.thisCall?.(documentId);
        const call = thisCall === undefined ? null : documents.callOf?.(documentId);
        calls.set(documentId, call ? { ...call, thisCall: thisCall === true } : null);
      }
      return calls.get(documentId) ?? null;
    };
    const formatted = found.map((passage): ShownPassage => {
      const range = { pageFrom: passage.pageFrom, pageTo: passage.pageTo };
      const units =
        passage.pageFrom !== null && passage.pageTo !== null
          ? documents.pageTexts(
              passage.documentId,
              passage.contentHash,
              passage.pageFrom,
              passage.pageTo,
            )
          : [];
      const severalSections =
        units.every((unit) => unit.kind === "section") &&
        new Set(units.map((unit) => JSON.stringify([unit.label?.path ?? [], unitLocation(unit)])))
          .size > 1;
      const firstMark = severalSections && units[0] ? unitMark(units[0]) : null;
      const marked =
        units.length > 1 || units.some((unit) => innerMarks(unit).length > 0)
          ? withUnitMarks(passage.text, units)
          : passage.text;
      const id = measuring
        ? (handleOf.get(passage.passageId) ?? `P${handleOf.size + ++unseen}`)
        : handleFor(passage.passageId);
      // A browser-made PDF's "⼤" for "大": every other reader of the text folds it (ADR-0009).
      const speakers = units.some((unit) => unit.kind === "cues")
        ? (documents.speakers?.(passage.documentId) ?? null)
        : null;
      const plain = foldRadicals(
        withCueMarks(
          withSetAsideMarks(firstMark ? `${firstMark} ${marked}` : marked, passage.text, units),
          units,
          speakers,
        ),
      );
      const text = withUnsureMarks(plain, units);
      const notCited = documents.citationSource(passage.passageId)?.notCited ?? false;
      // What later requests offer for citing is what was shown here: never a Passage no record may name.
      if (!notCited && !measuring) {
        shownTexts.set(id, plain);
        shownSpeakers.set(id, speakers);
      }
      if (!measuring) {
        read.push({
          documentId: passage.documentId,
          documentName: passage.documentName,
          text: plain,
          kind: passage.documentKind,
        });
      }
      return {
        id,
        documentName: passage.documentName,
        date: dateOf(passage.documentId),
        range,
        location: severalSections ? null : passageLocation(units),
        text,
        notCited,
        formulas: events.marksFormulas?.() ? formulaRows(units) : null,
        call: callOf(passage.documentId),
      };
    });
    return formatPassages(formatted, events.defuses ?? []);
  }

  function coverageOf(found: readonly WindowedPassage[]) {
    return (fitted: string): string | null => {
      const documentsCovered = new Map<
        string,
        { name: string; contentHash: string; pages: Set<number> }
      >();
      for (const passage of found) {
        if (passage.pageFrom === null || passage.pageTo === null) continue;
        if (!fitted.includes(`<passage id="${handleFor(passage.passageId)}"`)) continue;
        const covered = documentsCovered.get(passage.documentId) ?? {
          name: passage.documentName,
          contentHash: passage.contentHash,
          pages: new Set<number>(),
        };
        for (let page = passage.pageFrom; page <= passage.pageTo; page++) covered.pages.add(page);
        documentsCovered.set(passage.documentId, covered);
      }
      const notes: string[] = [];
      for (const [documentId, covered] of documentsCovered) {
        const total = documents.pageTexts(documentId, covered.contentHash, null, null).length;
        if (total === 0 || covered.pages.size >= total) continue;
        const pages = [...covered.pages].sort((a, b) => a - b);
        const ranges: string[] = [];
        let start = pages[0] as number;
        let end = start;
        for (const page of [...pages.slice(1), Number.POSITIVE_INFINITY]) {
          if (page === end + 1) {
            end = page;
            continue;
          }
          ranges.push(start === end ? `${start}` : `${start}–${end}`);
          start = page;
          end = page;
        }
        notes.push(`pages ${ranges.join(", ")} of ${total} of “${covered.name}”`);
      }
      return notes.length > 0
        ? `These results cover ${notes.join("; ")}. A miss in these results is not evidence that the other pages lack the answer.`
        : null;
    };
  }

  const tools: AnswerTools = {
    get documentCount() {
      if (!documents.searchableCount)
        throw new Error("Document count is unavailable in this Citation session.");
      return documents.searchableCount();
    },

    async searchDocuments(
      query: string,
      signal?: AbortSignal,
      options?: AnswerSearchOptions,
    ): Promise<SearchResultForModel> {
      if (!documents.search)
        throw new Error("Document search is unavailable in this Citation session.");
      // The same words over another Document, or for the file properties or the Library's facts
      // too, are a new search.
      const same = `${options?.properties ? "properties:" : ""}${options?.library ? "library:" : ""}${sameSearch(
        options?.document ? `${options.document}\n${query}` : query,
      )}`;
      if (searched.has(same)) return { text: SEARCHED_ALREADY, passageCount: 0 };
      searched.add(same);
      let within: string[] | undefined;
      if (options?.document) {
        const id = documents.documentNamed?.(options.document) ?? null;
        if (!id) {
          return {
            text: `No Document to search is called “${options.document}”: name one as the instructions list it, or leave document out.`,
            passageCount: 0,
          };
        }
        remember(searchedDocuments, id);
        within = [id];
      }
      const found = await search(query, signal, within, options);
      // The User's own highlights and notes on these words (#327): what they marked is what they meant.
      const marked = documents.annotationText?.(query, within) ?? "";
      if (marked !== "") {
        return {
          ...found,
          text: found.text === "" ? marked : `${found.text}\n\n${marked}`,
        };
      }
      if (found.passageCount > 0 || !opening || openingGiven) return found;
      if (within && !within.includes(opening.documentId)) return found;
      const passages = opening.passages();
      if (passages.length === 0) return found;
      openingGiven = true;
      return {
        text: `No Passages match these words. The opening of “${opening.name}”, which the Note is the working copy of, instead:\n${show(passages)}`,
        passageCount: passages.length,
        passageIds: passages.map((passage) => passage.passageId),
        ...(passages.some((passage) => passage.documentKind === "web") && {
          thirdParty: ["web-page"] as const,
        }),
      };
    },

    ...(documents.documentNamed && documents.passagesCovering && documents.passagesBetween
      ? {
          async readDocument(request: ReadDocumentRequest): Promise<SearchResultForModel> {
            if (reads >= 3) {
              return {
                text: "This Answer has reached its 3-read limit. Answer from the Passages already read.",
                passageCount: 0,
              };
            }
            const documentId = documents.documentNamed?.(request.document);
            if (!documentId) {
              return {
                text: `No Document to read is called “${request.document}”: name one in the Question's Search scope, as the instructions list it.`,
                passageCount: 0,
              };
            }
            const around = (value: number | undefined, fallback: number) =>
              value === undefined || !Number.isFinite(value)
                ? fallback
                : Math.max(0, Math.min(3, Math.floor(value)));
            const before = around(request.before, 0);
            const after = around(request.after, 2);
            let found: WindowedPassage[] = [];
            let limited = false;
            if (request.passage !== undefined) {
              const resolved = resolve(request.passage);
              const anchor = resolved ? documents.passage?.(resolved.passageId) : null;
              if (!anchor || anchor.documentId !== documentId) {
                return {
                  text: `No Passage already shown in “${request.document}” has the id “${request.passage}”.`,
                  passageCount: 0,
                };
              }
              found =
                documents.passagesBetween?.(
                  documentId,
                  Math.max(0, anchor.position - before),
                  anchor.position + after,
                ) ?? [];
            } else if (request.pages !== undefined) {
              const pages = readDocumentPages(request.pages);
              if (!pages) {
                return {
                  text: `Pages must be one page or a range, such as "16" or "15-17".`,
                  passageCount: 0,
                };
              }
              limited = pages.limited;
              found = documents.passagesCovering?.(documentId, pages.from, pages.to, true) ?? [];
            } else {
              found = documents.passagesBetween?.(documentId, 0, after) ?? [];
            }
            reads++;
            if (found.length === 0) {
              return {
                text: `No Passages were found for “${request.document}” at the requested place.`,
                passageCount: 0,
              };
            }
            return {
              text: `${limited ? "Only the first 3 requested pages are shown.\n" : ""}${show(found)}`,
              passageCount: found.length,
              passageIds: found.map((passage) => passage.passageId),
              ranks: found.map((_, index) => index),
              coverage: coverageOf(found),
              ...(found.some((passage) => passage.documentKind === "web") && {
                thirdParty: ["web-page"] as const,
              }),
            };
          },
        }
      : {}),

    cite,

    hasRecord: (marker) => records.has(marker),

    recordedQuotes: () =>
      [...records.values()].map((record) => ({
        passageId: record.source.passageId,
        quote: record.quote,
      })),

    owed(text, figured) {
      const unrecorded = markersIn(text).filter((marker) => !records.has(marker));
      const figures = [...text.matchAll(FIGURE_MARKER)].map((match) => Number(match[1]));
      return {
        citations: [...new Set([...toFix, ...unrecorded])].sort((a, b) => a - b),
        figures: figured ? [...new Set(figures)].filter((marker) => !figured(marker)) : [],
      };
    },

    shownPassages: () =>
      [...handleOf.values()].flatMap((id) => {
        const text = shownTexts.get(id);
        return text === undefined ? [] : [{ id, text }];
      }),

    quoteFound(passage: string, quote: string): boolean {
      const taken = takeQuote({ passage, quote }, 0, { structured: true });
      return taken.ok && !!taken.record.quote && located(check(taken.record));
    },

    unfoundQuotes(): UnfoundQuote[] {
      return [...records.values()]
        .filter((record) => !record.kept && check(record).check === "not-found")
        .sort((a, b) => a.marker - b.marker)
        .map((record) => ({
          marker: record.marker,
          passage: record.handle,
          quote: record.quote,
          text:
            shownTexts.get(record.handle) ??
            documents
              .pageTexts(
                record.source.documentId,
                record.source.contentHash,
                record.source.pageFrom,
                record.source.pageTo,
              )
              .map((unit) => unit.text)
              .join("\n\n"),
        }));
    },

    correctQuote(marker: number, quote: string): boolean {
      const earlier = records.get(marker);
      if (!earlier || earlier.kept) return false;
      const taken = take(
        { marker, passage: earlier.handle, ...earlier.given, quote },
        { structured: true },
        earlier.speakers,
      );
      if (!taken.ok || !taken.record.quote) return false;
      const result = check(taken.record);
      if (!located(result)) return false;
      keepAtCite(taken.record, result);
      records.set(marker, taken.record);
      toFix.delete(marker);
      events.onRecord(marker, toCitation(taken.record, null));
      return true;
    },
  };

  /**
   * A marker's Citation while the Answer streams: its record's, or null before one is given. It reads
   * "checking", or with `atCite` its quote's check as recorded (call help's, #2847), with what the
   * finished lines' quoted words found so far (`quotedWordsSoFar`).
   */
  const streamingCitation = (
    marker: number,
    atCite = false,
    quoted?: { stated: string[]; notFound: boolean },
  ): Citation | null => {
    const record = records.get(marker);
    if (!record) return null;
    if (!atCite) return toCitation(record, null);
    const result: CheckResult | null = quoted?.notFound
      ? { check: "not-found", checkReason: "quoted-words-not-on-pages" }
      : (record.atCite ?? null);
    const citation = toCitation(record, result);
    return quoted && quoted.stated.length > 0
      ? { ...citation, quotedWordsFound: [...(citation.quotedWordsFound ?? []), ...quoted.stated] }
      : citation;
  };

  /**
   * A marker's Citation once the Answer has finished (after `check`), or null:
   * a marker with no record is removed. Call it (or `finalNode`) for each marker
   * in the final text, in order: it counts them for `summary`.
   */
  const finalCitation = (marker: number): Citation | null => {
    const record = records.get(marker);
    if (!finalMarkers.includes(marker)) {
      finalMarkers.push(marker);
      if (!record) removedMarkers++;
    }
    return record ? toCitation(record, record.result) : null;
  };

  /** The Documents the Answer's final Citations name, in the order they first appear. */
  const citedDocuments = () => {
    const ids: string[] = [];
    for (const marker of new Set(finalMarkers)) {
      const record = records.get(marker);
      if (record && !ids.includes(record.source.documentId)) ids.push(record.source.documentId);
    }
    return ids;
  };

  /** Quotes for calculated figures' inputs (./calculations). */
  const quotes = {
    /** An input keeps its recorded Location: moving it could substitute another revision (#1979). */
    recorded(marker: number): Quoted | null {
      const record = records.get(marker);
      if (!record) return null;
      return quotedOf(record);
    },

    /** A quote outside the markers, read as a record is; or what the check would find wrong with it. */
    quote(input: QuoteInput, options: CiteOptions = {}): Quoted | { problem: string } {
      const taken = takeQuote(input, 0, options, false);
      if (!taken.ok) return { problem: taken.problem };
      const problem = recordProblem(taken.record, taken.source, taken.passageUnits);
      return problem ? { problem } : quotedOf(taken.record);
    },

    /**
     * A line another Passage of the same Document holds, given the Unit it is in, which the model
     * wasn't shown: the Passage that holds it, kept as its own Citation (#2365).
     */
    quoteIn(
      document: { documentId: string; contentHash: string },
      unit: PageText,
      quote: string,
    ): Quoted | { problem: string } {
      const clean = cleanQuote(quote);
      const covering =
        unit.page === null
          ? []
          : (documents.passagesCovering?.(document.documentId, unit.page, unit.page) ?? []);
      for (const passage of covering) {
        const source = documents.citationSource(passage.passageId);
        if (!source || source.documentDeleted || source.notCited) continue;
        if (source.contentHash !== document.contentHash) continue;
        const units = documents.pageTexts(
          source.documentId,
          source.contentHash,
          source.pageFrom,
          source.pageTo,
        );
        if (!quoteInUnits(units, clean, matchingFor(source))) continue;
        const taken = {
          marker: 0,
          handle: passageLocation(units) ?? source.passageId,
          source,
          given: { location: null, pageFrom: unit.page, pageTo: unit.page },
          range: { pageFrom: unit.page, pageTo: unit.page },
          requested: null,
          unresolved: false,
          quote: clean,
          result: null,
        };
        return quotedOf({ ...taken, location: locationFor(taken) });
      }
      return { problem: `no Passage of the Document holds the line "${clean}"` };
    },

    /** A Passage's text, as the model was given it, by its id ("P3"); "" for one it wasn't. */
    passageText: (passage: string): string => shownTexts.get(passage) ?? "",
  };

  return {
    tools,

    /** What the model was given of each Passage so far, in order, with its Document's id, name and kind. */
    passagesRead: (): readonly {
      documentId: string;
      documentName: string;
      text: string;
      kind: DocumentKind;
    }[] => read,

    /** The Documents its final Citations name, those its Passages came from, and those it searched by name. */
    documentsRead: () => ({
      cited: citedDocuments(),
      passages: [...passageDocuments],
      searched: [...searchedDocuments],
    }),

    /**
     * Searches one Document, whatever the Answer's Search scope: a web page
     * web search just saved (#128). Its Passages can be cited as a search's
     * are, and it doesn't count as one of the Answer's searches.
     */
    searchDocument: (documentId: string, query: string, signal?: AbortSignal) =>
      search(query, signal, [documentId]),

    /**
     * Gives the model Passages without a search: a meeting's live transcript (#144), a short
     * Document's whole text (#1036). They can be cited as a search's are, and don't count as
     * one of the Answer's searches.
     */
    show: (found: readonly WindowedPassage[]) => show(found),

    /** What `show` would send for these Passages, recording nothing. */
    measure: (found: readonly WindowedPassage[]) => show(found, true),

    /** Searches the Answer's Search scope as its search Tool does, for Passages to `show`. */
    find: (query: string, signal?: AbortSignal, options?: AnswerSearchOptions) =>
      find(query, signal, undefined, options),

    quotes,

    /** The Passages the model was given, by the id it cites them by, as it read them. */
    shownPassages: (): { id: string; passageId: string; text: string }[] =>
      [...handleOf].flatMap(([passageId, id]) => {
        const text = shownTexts.get(id);
        return text === undefined ? [] : [{ id, passageId, text }];
      }),

    streamingCitation,

    /** A marker's node while the Answer streams: its record's details, if given yet, "checking". */
    streamingNode(marker: number): NodeJSON {
      return citationNode(streamingCitation(marker));
    },

    /** Checks every record, once, when the Answer finishes. */
    check(): void {
      for (const record of records.values()) record.result ??= check(record);
    },

    /**
     * Checks the words an Answer put in quotation marks (#483), after `check`, by the one rule
     * (`quotedWordsVerdict` in ./quotedWords). One found keeps its words with the Citations whose
     * Units state them, which its sentence's figures are counted against (#2602); one that runs on
     * to the next page names that page (#2504); a Document's name says so. One not found makes the
     * Citation whose Units are nearest it "not found", with the Answer's words and the Document's
     * nearest for its card. Returns the translations, to lose their quotation marks.
     */
    checkQuotedWords(quoted: readonly QuotedSentence[]): string[] {
      return applyQuotedWords(quoted, (marker) => records.get(marker));
    },

    /**
     * The same check of quoted words, run while call help's reply is still written on the lines it
     * has finished (#2847), against each Citation's quote check as recorded, changing no record: by
     * marker, the words its place states, and whether it is the one the words weren't found nearest,
     * which the end will make not found.
     */
    quotedWordsSoFar(
      quoted: readonly QuotedSentence[],
    ): Map<number, { stated: string[]; notFound: boolean }> {
      const found = new Map<number, { stated: string[]; notFound: boolean }>();
      const of = (marker: number) => {
        const known = found.get(marker) ?? { stated: [], notFound: false };
        found.set(marker, known);
        return known;
      };
      const names = [...records.values()].map(({ source }) => source.documentName);
      for (const { words, markers } of quoted) {
        const cited = [...new Set(markers)].flatMap((marker) => {
          const record = records.get(marker);
          return record?.atCite
            ? [{ ...placeOf(record), cantCheck: record.atCite.check === "cant-check" }]
            : [];
        });
        if (cited.length === 0) continue;
        const verdict = quotedWordsVerdict(words, cited, names);
        if (verdict.kind === "stated" || verdict.kind === "title") {
          for (const { record } of verdict.by) of(record.marker).stated.push(words);
        } else if (verdict.kind === "run-on") {
          of(verdict.by.record.marker).stated.push(words);
        } else if (verdict.kind === "not-found") {
          const nearest = nearestPlace(words, cited);
          if (nearest?.place.record.atCite?.check === "found") {
            of(nearest.place.record.marker).notFound = true;
          }
        }
      }
      return found;
    },

    finalCitation,

    /**
     * The nodes of the markers in text the Answer writes into a Mind (#202): each record checked
     * now, and the words the text puts in quotation marks checked as an Answer's are (#2712), on
     * copies of the records, so the Answer's own Citations keep their checks. With the words to
     * lose their quotation marks; a node is null to remove a marker with no record.
     */
    checkedNodes(quoted: readonly QuotedSentence[]): {
      translated: string[];
      node(marker: number): NodeJSON | null;
    } {
      const copies = new Map<number, Accepted>();
      const copyOf = (marker: number): Accepted | undefined => {
        const record = records.get(marker);
        if (!record) return undefined;
        record.result ??= check(record);
        let copy = copies.get(marker);
        if (!copy) {
          copy = {
            ...record,
            ...(record.quotedWordsFound && { quotedWordsFound: [...record.quotedWordsFound] }),
          };
          copies.set(marker, copy);
        }
        return copy;
      };
      const translated = applyQuotedWords(quoted, copyOf);
      return {
        translated,
        node(marker) {
          const copy = copyOf(marker);
          if (!copy) return null;
          placedElsewhere.add(marker);
          return citationNode(toCitation(copy, copy.result));
        },
      };
    },

    /**
     * `markdown` with each id of the Question context's Citations written as text (`writtenIds`,
     * "[Tides, p. 3 · C2]") made a marker of that Citation, kept as `cite` keeps one; one the
     * Answer can't keep is taken out, `notKept` said in its place. An id never shows (#1800).
     */
    citeWrittenIds(markdown: string, notKept: string): string {
      const written = writtenIds(markdown, (id) => ids !== undefined && ids.get(id) !== null);
      if (written.length === 0) return markdown;
      // A write into a Mind is read again as its input grows: a Citation counts once, however often it's read.
      for (const each of written) for (const id of each.ids) idsAsText.add(id);
      let next = Math.max(0, ...records.keys(), ...markersIn(markdown)) + 1;
      const markerOf = (id: string): number | null => {
        for (const record of records.values()) if (record.handle === id) return record.marker;
        const kept = ids?.get(id);
        const taken = kept ? takeKept(id, kept, next) : null;
        if (!taken?.ok) return null;
        records.set(next, taken.record);
        events.onRecord(next, toCitation(taken.record, null));
        return next++;
      };
      return replaceWritten(markdown, written, (each) => {
        const markers = each.ids.map(markerOf);
        const shown = markers.flatMap((marker) => (marker === null ? [] : [`[^${marker}]`]));
        // No space before full-width words: "（未能保留来源）" (docs/agents/zh-CN.md, rule 2).
        const said = /^[\x20-\x7e]/.test(notKept) ? ` ${notKept}` : notKept;
        return `${shown.join("")}${markers.includes(null) ? said : ""}`;
      });
    },

    /** The marker of a Citation recorded for a source written as its name in brackets; null for none. */
    markerFor(source: NamedSource): number | null {
      for (const record of records.values()) {
        if (citesSource(toCitation(record, record.result), source)) return record.marker;
      }
      return null;
    },

    /** A marker's node once the Answer has finished: `finalCitation`'s, or null to remove the marker. */
    finalNode(marker: number): NodeJSON | null {
      const citation = finalCitation(marker);
      return citation ? citationNode(citation) : null;
    },

    /** The Answer's Citations and the counts the evaluation reads, after the final nodes. */
    summary(): {
      citations: Citation[];
      droppedMarkers: number;
      droppedRecords: number;
      rejectedRecords: RejectedRecord[];
      idsAsText: number;
    } {
      const citations = finalMarkers.flatMap((marker) => {
        const record = records.get(marker);
        return record ? [toCitation(record, record.result)] : [];
      });
      const unused = [...records.keys()].filter(
        (marker) => !finalMarkers.includes(marker) && !placedElsewhere.has(marker),
      ).length;
      return {
        citations,
        droppedMarkers: removedMarkers,
        droppedRecords: unused + rejected.length,
        rejectedRecords: rejected,
        idsAsText: idsAsText.size,
      };
    },
  };
}

/**
 * Lines that are footnote definitions ("[^1]: …"): some models list their
 * sources this way at the end. The records are what counts, so these go.
 */
export function withoutFootnoteDefinitions(markdown: string): string {
  return markdown.replace(/^ {0,3}\[\^\d{1,4}\]:.*(?:\n|$)/gm, "");
}

/** Whether the marker at `at` starts a footnote definition line ("[^2]: …"), as `withoutFootnoteDefinitions` reads one. */
const definesFootnote = (markdown: string, at: number, end: number) =>
  markdown.charAt(end) === ":" && /(?:^|\n) {0,3}$/.test(markdown.slice(0, at));

export function withoutDeadMarkers(markdown: string, backed: (marker: number) => boolean): string {
  // A marker before a colon mid-line ("width d[^2]:") is a marker, not a definition (#2769).
  const found = [...markdown.matchAll(/([ \t]*)\[\^(\d{1,4})\]/g)]
    .map((each) => ({
      from: each.index,
      space: (each[1] ?? "").length,
      end: each.index + each[0].length,
      marker: Number(each[2]),
    }))
    .filter((each) => !definesFootnote(markdown, each.from + each.space, each.end));
  const shown = shownRanges(
    markdown,
    found.map((each) => ({ start: each.from + each.space, end: each.end })),
  );
  let text = "";
  let at = 0;
  found.forEach((each, index) => {
    if (!shown[index] || backed(each.marker)) return;
    const keepsSpace = /^\p{L}/u.test(markdown.charAt(each.end));
    text += markdown.slice(at, keepsSpace ? each.from + each.space : each.from);
    at = each.end;
  });
  return text + markdown.slice(at);
}
