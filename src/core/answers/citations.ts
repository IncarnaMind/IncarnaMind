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
} from "../../shared/locations";
import { citesSource, type NamedSource } from "../../shared/namedSources";
import {
  findQuote,
  lostLigatures,
  type MatchOptions,
  type TextRange,
} from "../../shared/quoteMatch";
import { readableQuote, readableQuoteText } from "../../shared/readableQuote";
import { foldRadicals, nameKey } from "../../shared/text";
import { sameRun } from "../../shared/units";
import {
  type AskedQuote,
  type ChangedQuote,
  type Citation,
  type CitationCheck,
  type CitationCheckReason,
  type CitationRecheck,
  type CitationToRecheck,
  type CitedSelection,
  type DocumentKind,
  MAX_CITED_PAGES,
  type QuotedWords,
  type RejectedRecord,
  type SelectedPart,
} from "../api";
import type { CitationSource, DocumentDate } from "../documents";
import { BOILERPLATE_PARAMETERS } from "../documents/boilerplate";
import type { PageText } from "../documents/passages";
import type { WindowedPassage } from "../documents/search";
import { writtenInCjk } from "../documents/textLanguage";
import { diffSteps, splitWords } from "../proposals/diff";
import { closestWords } from "./closestWords";
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
import { readDocumentPages } from "./readDocumentPages";

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

/**
 * Where a new Unit starts inside a Passage given to the model ("[p. 4]",
 * "[slide 4]", "[§ 2.1 Sensitivity]", "[Revenue, rows 2–41]", "[lines 51–100]"),
 * where a slide's speaker notes start ("[speaker notes]"), and where a Word
 * comment starts ("[comment by Reviewer]").
 */
const LOCATION_MARK =
  /\[(?:p\.\s*\d+(?:[–-]\d+)?|slides?\s+\d+(?:[–-]\d+)?|(?:[^\]\n]{1,100},\s*)?rows?\s+\d+(?:[–-]\d+)?|lines?\s+\d+(?:[–-]\d+)?|§[^\]\n]{0,200}|speaker notes|comment(?: by [^\]\n]{1,100})?|\d{1,2}:\d{2}(?::\d{2})?(?: [^\]\n]{1,60})?)\]/gi;

/** Marks where a slide's speaker notes start, inside a Passage given to the model. */
const NOTES_MARK = "[speaker notes]";

/** Marks where a Word comment starts, inside a Passage given to the model, with its author if known (#76). */
const commentMark = (author: string | null) =>
  author ? `[comment by ${author.replace(/[\]\n]+/g, " ")}]` : "[comment]";

export const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["«", "»"],
];

/**
 * The quote as the model meant it: without location marks, without the
 * ellipses and quotation marks models put around a quote. Its words are left alone.
 */
export function cleanQuote(raw: string): string {
  // The marks of a scan's unsure words (#535) are the Passage's, never the quote's.
  let quote = raw.replace(/[⟦⟧]/gu, "").replace(LOCATION_MARK, " ").trim();
  for (;;) {
    const before = quote;
    quote = quote
      .replace(/^(?:\.{3}|…)\s*/u, "")
      .replace(/\s*(?:\.{3}|…)$/u, "")
      .trim();
    for (const [open, close] of QUOTE_PAIRS) {
      if (quote.length > 1 && quote.startsWith(open) && quote.endsWith(close)) {
        quote = quote.slice(open.length, -close.length).trim();
      }
    }
    if (quote === before) return quote;
  }
}

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
  /** Rows or lines the record named more narrowly than its Units: the label's fallback. */
  requested: RowsOrLines | null;
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
  if (requested) {
    const resolved = resolveRequested(requested, units);
    if (!resolved) return { range: own, requested: null, unresolved: true };
    return {
      range: { pageFrom: resolved.from, pageTo: resolved.to },
      requested:
        requested.kind === "rows" || requested.kind === "lines"
          ? { from: requested.from, to: requested.to }
          : null,
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
): string | null {
  return quoteInUnits(units, quote, matching) &&
    !quoteInUnits(units, quote, { ...matching, unique: true })
    ? "the quote occurs more than once in its cited Units; quote enough surrounding words to identify one place."
    : null;
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
 * The words of `units` a text recognizer wasn't sure of that `ranges` (in
 * their joined text) cover, in order: a quote of one isn't on the page for
 * certain, so it asks the User to look (#535).
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
    for (const [from, to] of unit.label?.scan?.unsure ?? []) {
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
  /** The id of the Document to search named `name`, as the instructions list it; null for none. */
  documentNamed?(name: string): string | null;
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
  pageTexts: AnswerDocuments["pageTexts"];
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
  ): CitationRecheck => {
    const covered = inRange(range);
    return {
      ...check,
      contentHash,
      passageId: passageFor(range, quote),
      ...range,
      location:
        range.pageFrom === null || range.pageTo === null
          ? null
          : locationOf(
              covered,
              check.check === "found" ? (found ?? quoteInUnits(covered, quote, matching)) : null,
            ),
    };
  };
  return { units, matching, inRange, result };
}

type Rechecked = Pick<CitationToRecheck, "documentId" | "quote" | "pageFrom" | "pageTo">;

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
  input: Rechecked & { contentHash?: string | null },
): CitationRecheck {
  const now = recheckInCurrent(documents, input);
  const quoted = input.contentHash ?? "";
  if (quoted === "" || now.contentHash === null || now.contentHash === quoted) return now;
  return {
    ...now,
    inQuotedVersion: checkInVersion(documents, input, quoted),
    changed:
      now.check === "not-found" ? changedQuote(documents, input, quoted, now.contentHash) : null,
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
  return checkCitation({
    quote: cleanQuote(input.quote),
    range,
    passage: range,
    documentDeleted: false,
    pages: version.inRange(range),
    lostLigatures: version.matching.lostLigatures ?? false,
  });
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
  const found = quoteInUnits(cited, cleanQuote(input.quote), before.matching);
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

function recheckInCurrent(documents: RecheckDocuments, input: Rechecked): CitationRecheck {
  const cited = { pageFrom: input.pageFrom, pageTo: input.pageTo };
  const contentHash = documents.currentVersion(input.documentId);
  if (contentHash === null) return removedFrom(cited);
  const quote = cleanQuote(input.quote);
  const version = versionOf(documents, input.documentId, contentHash);
  const { units, matching, inRange } = version;
  const result = (check: CheckResult, range: PageRange) => version.result(check, range, quote);
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
    const found = quoteInUnits(range, quote, matching);
    if (found) {
      const unsure = unsureWordsCovered(range, found);
      return result(
        unsure.length > 0 ? { check: "cant-check", checkReason: "unsure-word", unsure } : FOUND,
        cited,
      );
    }
  }
  return result({ check: "not-found", checkReason: "quote-not-on-pages" }, cited);
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
 * and is found only as `recheckCitation` finds it.
 */
export function citeSelection(
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
  const wanted = JSON.stringify(parseLocation(input.location));
  const options = { ...version.matching, numbers: numbersIn(covered) };
  const place =
    quote === "" || covered.length === 0 || covered.length > MAX_CITED_PAGES
      ? undefined
      : placesOf(joinUnits(covered).text, quote, options).find(
          (found) => JSON.stringify(parseLocation(locationOf(covered, found))) === wanted,
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
  const now = recheckCitation(documents, {
    documentId,
    quote: typeof quote === "string" ? quote : "",
    pageFrom: page(attributes.pageFrom),
    pageTo: page(attributes.pageTo) ?? page(attributes.pageFrom),
  });
  if (now.check !== "found") return null;
  if (attributes.check === "found" && attributes.contentHash === now.contentHash) return null;
  // The quote being found says nothing of the words the Answer put in quotation marks (#483).
  const { quotedWords, ...kept } = attributes;
  const asked = parseQuotedWords(quotedWords);
  if (asked && now.contentHash !== null) {
    const words = asked.answer.map((piece) => piece.text).join("");
    const units = documents.pageTexts(documentId, now.contentHash, null, null);
    const cited = documents.pageTexts(documentId, now.contentHash, now.pageFrom, now.pageTo);
    if (!quoteInUnits(cited, words, matchingOf(units))) return null;
  }
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
 * `text` with each word a scan's recognizer was unsure of wrapped in ⟦ ⟧
 * (#535), so the model can see which figures not to trust. The marks are
 * never stored: `shownTexts` keeps the text without them.
 */
function withUnsureMarks(text: string, units: readonly PageText[]): string {
  const marks: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const unit of units) {
    for (const anchor of unit.anchors ?? []) {
      const line = foldRadicals(unit.text.slice(anchor.start, anchor.end));
      if (line === "") continue;
      const inOrder = text.indexOf(line, cursor);
      const at = inOrder >= 0 ? inOrder : text.indexOf(line);
      if (at < 0) continue;
      cursor = at + line.length;
      for (const [wordFrom, wordTo] of unit.label?.scan?.unsure ?? []) {
        const from = Math.max(wordFrom, anchor.start);
        const to = Math.min(wordTo, anchor.end);
        if (from >= to) continue;
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

const attribute = (value: string) => value.replace(/"/g, "'").replace(/\s+/g, " ");

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
}

/** Passages as the model sees them, each with its short id, Document, its date, and pages or Location. */
function formatPassages(passages: readonly ShownPassage[]): string {
  return passages
    .map(({ id, documentName, date, range, location, text, notCited }) => {
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
      return `<passage id="${id}" document="${attribute(documentName)}"${dated}${where}${never}>\n${text}\n</passage>`;
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
  unresolved: boolean;
  quote: string;
  /** Where it points, for its label, worked out once when the record is taken. */
  location: Citation["location"];
  result: CheckResult | null;
  /** The Answer's quoted words that its sentence's Citations don't have, when they made `result` not found (#483). */
  quotedWords?: QuotedWords;
  /** A Citation of the Question context, kept as it is (#1800): there is nothing of it to fix. */
  kept?: true;
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

const toCitation = (record: Accepted, result: CheckResult | null): Citation => ({
  passageId: record.source.passageId,
  documentId: record.source.documentId,
  documentName: record.source.documentName,
  contentHash: record.source.contentHash,
  pageFrom: record.range.pageFrom,
  pageTo: record.range.pageTo,
  location: record.location,
  quote: record.quote,
  check: result?.check ?? "checking",
  checkReason: result?.checkReason ?? null,
  ...(result?.unsure && result.unsure.length > 0 && { unsure: result.unsure }),
  ...(record.quotedWords && { quotedWords: record.quotedWords }),
});

export interface CitationSessionEvents {
  /** The model gave a valid record for a marker (again: it replaces the earlier one). */
  onRecord(marker: number, citation: Citation): void;
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
  const records = new Map<number, Accepted>();
  /** Markers whose last record from a `cite` call was refused or came back with a problem to fix. */
  const toFix = new Set<number>();
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

  /** The stored text of the Units a record cites, of the version its Passage was built from. */
  const citedText = (record: Pick<Accepted, "source" | "range">) =>
    documents.pageTexts(
      record.source.documentId,
      record.source.contentHash,
      record.range.pageFrom,
      record.range.pageTo,
    );

  /**
   * The text of a sheet's title rows, above its header, by Document version
   * and sheet: the rows that name the table a Citation's rows are in, which an
   * Answer may quote as the table's title while citing one of its rows (#2358).
   * A sheet read in one block keeps its title rows in the cited Unit itself.
   */
  const titles = new Map<string, string>();
  function titleRows(record: Pick<Accepted, "source">, sheet: string | null): string {
    const key = `${record.source.documentId}\n${record.source.contentHash}\n${sheet ?? ""}`;
    const known = titles.get(key);
    if (known !== undefined) return known;
    const units = documents
      .pageTexts(record.source.documentId, record.source.contentHash, null, null)
      .filter((unit) => unit.kind === "rows" && (unit.label?.sheet ?? null) === sheet);
    const header = units.find((unit) => unit.label?.header)?.label?.rows?.[0] ?? null;
    const first = units.reduce<PageText | null>(
      (earliest, unit) =>
        !earliest || (unit.label?.from ?? 0) < (earliest.label?.from ?? 0) ? unit : earliest,
      null,
    );
    const rows = first?.label?.rows ?? [];
    const text =
      header === null || !first
        ? ""
        : first.text
            .split("\n")
            .filter((_, at) => {
              const row = rows[at] ?? 0;
              return row > 0 && row < header;
            })
            .join("\n");
    titles.set(key, text);
    return text;
  }

  /**
   * The check, with the Document as it is now: it may have been deleted since
   * the record. The text read is that of the version the Passage was built
   * from, which the Citation records: the Document may have a newer one by now.
   */
  const check = (record: Accepted) => {
    const now = documents.citationSource(record.source.passageId);
    return checkCitation({
      quote: record.quote,
      range: record.range,
      passage: record.source,
      documentDeleted: !now || now.documentDeleted,
      pages: citedText(record),
      unresolved: record.unresolved,
      ...matchingFor(record.source),
    });
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
      usable ? quoteInUnits(usable, record.quote, matchingFor(record.source)) : null,
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
  function take(input: CitationRecordInput, options: CiteOptions): Taken {
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
    const taken = takeQuote(input, marker, options);
    if (taken.ok && !taken.record.kept) {
      const problem =
        quotePlaceProblem(taken.record.quote, citedText(taken.record), matchingFor(taken.source)) ??
        (check(taken.record).check === "not-found"
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
  ): Extract<Taken, { ok: true }> | { ok: false; problem: string } {
    const named = typeof input.passage === "string" ? input.passage : "";
    const kept = ids?.get(named);
    if (kept) return takeKept(issuedForm(named), kept, marker);
    const quote = cleanQuote(typeof input.quote === "string" ? input.quote : "");
    // Structured output can't be told it named no Passage (see `CiteOptions`): its id read loosely,
    // else the Passage it was given that holds its quote.
    const known = <Found extends { passageId: string }>(each: Found | null): Found | null =>
      each && documents.citationSource(each.passageId) ? each : null;
    const found =
      known(resolve(named)) ??
      (options.structured ? (known(resolve(loosely(named))) ?? passageWithQuote(quote)) : null);
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
    const { range, requested, unresolved } = citedUnits(
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
      unresolved,
      quote,
      result: null,
    };
    let record: Accepted = { ...taken, location: locationFor(taken) };
    // A quote that isn't where it names is cited where it uniquely occurs in its Passage,
    // never outside it, and the check still reads it there.
    if (relocate && quote && check(record).check === "not-found") {
      const placedAt = locateQuote(passageUnits, quote, matchingFor(source));
      if (placedAt) {
        const placed = { ...taken, range: placedAt, requested: null, unresolved: false };
        record = { ...placed, location: locationFor(placed) };
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
      records.set(marker, record);
      recorded.push(marker);
      events.onRecord(marker, toCitation(record, null));
      // Tell the model now what the check will find, so it can fix the record.
      const problem = record.kept ? null : recordProblem(record, source, passageUnits);
      if (problem) {
        problems.push(`[^${marker}]: ${problem}`);
        if (!options.structured) toFix.add(marker);
      } else toFix.delete(marker);
    }
    const done = recorded.length
      ? `Recorded ${recorded.map((marker) => `[^${marker}]`).join(", ")}.`
      : "Nothing was recorded.";
    const fix = problems.length ? ` ${FIX_THESE}\n- ${problems.join("\n- ")}` : WRITE_NOW;
    return `${done}${fix}`;
  }

  /** What the check will find wrong with a record, for the model to fix; null when nothing. */
  function recordProblem(
    record: Accepted,
    source: CitationSource,
    passageUnits: readonly PageText[],
  ): string | null {
    const { handle } = record;
    const where = passageUnits.length > 0 ? passageLocation(passageUnits) : null;
    if (pageRangeProblem(record.range, source, record.unresolved)) {
      return where
        ? `give a location inside ${handle} (${where}), naming one place, or two in a row.`
        : `cite one page, or two consecutive pages, within ${handle}'s pages (${pagesLabel(source)}).`;
    }
    if (!record.quote) return `the quote is empty; copy a short quote from ${handle}.`;
    if (check(record).check !== "not-found") return null;
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
    citation: toCitation(record, null),
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
      const plain = foldRadicals(
        withCueMarks(firstMark ? `${firstMark} ${marked}` : marked, units),
      );
      const text = withUnsureMarks(plain, units);
      const notCited = documents.citationSource(passage.passageId)?.notCited ?? false;
      // What later requests offer for citing is what was shown here: never a Passage no record may name.
      if (!notCited && !measuring) shownTexts.set(id, plain);
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
      };
    });
    return formatPassages(formatted);
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
      // The same words over another Document are a new search.
      const same = sameSearch(options?.document ? `${options.document}\n${query}` : query);
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
      return taken.ok && !!taken.record.quote && check(taken.record).check === "found";
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
      );
      if (!taken.ok || !taken.record.quote || check(taken.record).check !== "found") return false;
      records.set(marker, taken.record);
      toFix.delete(marker);
      events.onRecord(marker, toCitation(taken.record, null));
      return true;
    },
  };

  /** A marker's Citation while the Answer streams, "checking": its record's, or null before one is given. */
  const streamingCitation = (marker: number): Citation | null => {
    const record = records.get(marker);
    return record ? toCitation(record, null) : null;
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
     * Checks the words an Answer put in quotation marks (#483), after `check`:
     * each span (see ./quotedWords) is looked for with the Citation check's own
     * matching in the Units its Citation cites, and, in a sheet, in its title
     * rows: the rows above the header, which name the table the Citation's
     * rows are in, as a Document's name is not a quote (#2358). One found
     * changes nothing. One not found makes the Citation whose Units are nearest
     * it "not found", with the Answer's words and the Document's nearest for
     * its card. Where a Citation of the sentence couldn't be checked, no span
     * of it is. Words in another language than every page cited are a
     * translation: they aren't checked, and are returned to lose their
     * quotation marks.
     */
    checkQuotedWords(quoted: readonly { words: string; markers: readonly number[] }[]): string[] {
      /** Whether the words are the title rows of the sheet a record's rows are in (#2358). */
      const titled = (
        record: Accepted,
        units: readonly PageText[],
        words: string,
        matching: Matching,
      ) => {
        const rows = units.find((unit) => unit.kind === "rows");
        if (!rows) return false;
        const text = titleRows(record, rows.label?.sheet ?? null);
        return text !== "" && findQuote(text, words, { ...matching, numbers: true }) !== null;
      };
      const translated: string[] = [];
      // A Document's name in quotation marks, as an Answer gives a title, is a name, not a quote.
      const names = new Set(
        [...records.values()].map(({ source }) => nameKey(source.documentName)),
      );
      for (const { words, markers } of quoted) {
        if (names.has(nameKey(words))) continue;
        const cited = [...new Set(markers)].flatMap((marker) => {
          const record = records.get(marker);
          return record
            ? [
                {
                  record,
                  units: citedText(record),
                  matching: matchingFor(record.source),
                },
              ]
            : [];
        });
        if (cited.some(({ record }) => record.result?.check === "cant-check")) continue;
        if (cited.some(({ units, matching }) => quoteInUnits(units, words, matching))) continue;
        if (cited.some(({ record, units, matching }) => titled(record, units, words, matching)))
          continue;
        const inCjk = writtenInCjk(words);
        if (
          cited.length > 0 &&
          cited.every(
            ({ units }) => writtenInCjk(units.map((unit) => unit.text).join("\n")) !== inCjk,
          )
        ) {
          translated.push(words);
          continue;
        }
        let nearest: { record: Accepted; closest: ReturnType<typeof closestWords> } | undefined;
        for (const { record, units, matching } of cited) {
          const closest = closestWords(units, words, matching);
          if (!nearest || closest.near > nearest.closest.near) nearest = { record, closest };
        }
        if (!nearest || nearest.record.quotedWords || nearest.record.result?.check !== "found") {
          continue;
        }
        nearest.record.result = { check: "not-found", checkReason: "quoted-words-not-on-pages" };
        nearest.record.quotedWords = nearest.closest.shown;
      }
      return translated;
    },

    finalCitation,

    /**
     * A marker's node in text the Answer writes into a Mind (#202): its
     * record, checked now, or null to remove a marker with none.
     */
    checkedNode(marker: number): NodeJSON | null {
      const record = records.get(marker);
      if (!record) return null;
      placedElsewhere.add(marker);
      record.result ??= check(record);
      return citationNode(toCitation(record, record.result));
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

export function withoutDeadMarkers(markdown: string, backed: (marker: number) => boolean): string {
  const found = [...markdown.matchAll(/([ \t]*)\[\^(\d{1,4})\](?!:)/g)].map((each) => ({
    from: each.index,
    space: (each[1] ?? "").length,
    end: each.index + each[0].length,
    marker: Number(each[2]),
  }));
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
