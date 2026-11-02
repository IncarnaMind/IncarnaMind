/**
 * Citing from the User's own writing: what writing suggestions (#282) use,
 * and what Cite… in the note (#281) and the checks of the User's sentences
 * (#96) are to share. Two steps, each as Answers do them:
 *
 * - `findPassages`: the Passages a piece of the User's text is about, from
 *   the Documents of a Search scope, found by the document-search Tool
 *   (keyword search, then the reranker; ADR-0009), best first, each with its
 *   Location and the words of the text it holds.
 * - `citeQuote`: a Citation of a quote from one of those Passages, checked at
 *   once by the Citation check (see ./citations): cited at the quote's own
 *   Unit, or two, within the Passage, so its Location is as narrow as the
 *   quote. "Found" means the quote is word for word at that Location, never
 *   that it supports the User's sentence.
 */
import { locationOf, quoteInUnits } from "../../shared/locations";
import type { Citation, CitationLocation, DocumentKind } from "../api";
import type { CitationSource } from "../documents";
import { keywordTerms, keywordText } from "../documents/keywords";
import type { PageText } from "../documents/passages";
import type { WindowedPassage } from "../documents/search";
import { checkCitation, cleanQuote, locateQuote, matchingOf, type PageRange } from "./citations";

/** What citing needs from Documents: Answers' search, and what Citations point to. */
export interface CitingDocuments {
  /** The document-search Tool over these Documents (null: every Document), as Answers search. */
  search(
    query: string,
    documentIds: readonly string[] | null,
    signal?: AbortSignal,
  ): Promise<WindowedPassage[]>;
  /** A Passage and its Document, deleted or not; null if unknown. */
  citationSource(passageId: string): CitationSource | null;
  /** The stored text of one version of a Document's Units, from `from` to `to` (both null: all). */
  pageTexts(
    documentId: string,
    contentHash: string,
    from: number | null,
    to: number | null,
  ): PageText[];
}

/** A Passage found for the User's text. */
export interface FoundPassage {
  passageId: string;
  documentId: string;
  documentName: string;
  documentKind: DocumentKind;
  /** The Units it covers; null for a whole TXT or Markdown file stored before Units. */
  pageFrom: number | null;
  pageTo: number | null;
  /** Where it is, for its label ("p. 11", "§ History", "rows 40–44"); null as for `pageFrom`. */
  location: CitationLocation | null;
  text: string;
  /** Its Document is the User's own workings: shown to the User, never cited without their say. */
  notCited: boolean;
  /**
   * How relevant the reranker found it, when search reranked it (see
   * `WindowedPassage.relevance`), or null.
   */
  relevance: number | null;
  /**
   * The words of the text searched for (as keyword search reads them, without
   * stopwords) that the Passage holds, each once, in the text's order: how
   * closely it matches, and what a list of results shows in bold.
   */
  matches: string[];
}

export interface Citing {
  /** The Passages `text` is about, of these Documents (null: every Document), best first. */
  findPassages(
    text: string,
    documentIds: readonly string[] | null,
    signal?: AbortSignal,
  ): Promise<FoundPassage[]>;
  /**
   * A Citation of `quote` in the Passage, checked now (`check` is never
   * "checking"); null for a Passage that doesn't exist.
   */
  citeQuote(passageId: string, quote: string): Citation | null;
  /**
   * A Citation of `quote` in the Passage's Unit `page` at `at`, its character range in that Unit,
   * checked: a Transcript cue's own time. Null for a Passage or Unit that doesn't exist, or whose
   * text doesn't hold the range.
   */
  citeUnit(
    passageId: string,
    quote: string,
    page: number,
    at: { start: number; end: number },
  ): Citation | null;
  /** Where a Passage is, as a Citation of all of it would say; null as for `FoundPassage.location`. */
  locate(
    passage: Pick<
      WindowedPassage,
      "documentId" | "documentKind" | "contentHash" | "pageFrom" | "pageTo"
    >,
  ): CitationLocation | null;
}

/** How many Document versions' matching rules (see `matchingOf`) are kept, the latest used. */
const MATCHINGS_KEPT = 16;

const HAN = /\p{Script=Han}/u;

/**
 * The terms of a search (`keywordTerms`) that a text holds, each once, in
 * order: as words; a Chinese term as characters, wherever they are, since
 * the same characters split into other words in another sentence ("绿地多的"
 * gives 绿|地|多, "城市绿地" 城市|绿地).
 */
export function matchingTerms(terms: readonly string[], text: string): string[] {
  const words = keywordText(text);
  const spaced = ` ${words} `;
  const characters = words.replaceAll(" ", "");
  return terms.filter((term) =>
    HAN.test(term) ? characters.includes(term.replaceAll(" ", "")) : spaced.includes(` ${term} `),
  );
}

export function createCiting(documents: CitingDocuments): Citing {
  const matchings = new Map<string, ReturnType<typeof matchingOf>>();
  /** How quotes are matched in a Document version's text: worked out once from all of it. */
  const matchingFor = (source: Pick<CitationSource, "documentId" | "contentHash">) => {
    const key = `${source.documentId}\n${source.contentHash}`;
    let matching = matchings.get(key);
    if (matching) {
      matchings.delete(key);
    } else {
      matching = matchingOf(documents.pageTexts(source.documentId, source.contentHash, null, null));
    }
    matchings.set(key, matching);
    const oldest = matchings.keys().next().value;
    if (matchings.size > MATCHINGS_KEPT && oldest !== undefined) matchings.delete(oldest);
    return matching;
  };

  /** The stored text of these Units of the Passage's version: every Unit when the range is null. */
  const unitsOf = (source: CitationSource, range: PageRange) =>
    documents.pageTexts(source.documentId, source.contentHash, range.pageFrom, range.pageTo);

  const citationOf = (
    source: CitationSource,
    own: PageRange,
    range: PageRange,
    quote: string,
    matching: ReturnType<typeof matchingOf>,
  ): Citation => {
    const pages = unitsOf(source, range);
    const result = checkCitation({
      quote,
      range,
      passage: own,
      documentDeleted: source.documentDeleted,
      pages,
      ...matching,
    });
    const hasUnits = own.pageFrom !== null && own.pageTo !== null;
    // A scan's unsure word was still found: its place is where the quote is (#535).
    const held = result.check === "found" || result.checkReason === "unsure-word";
    const location: CitationLocation | null = !hasUnits
      ? null
      : pages.length > 0
        ? locationOf(pages, held ? quoteInUnits(pages, quote, matching) : null)
        : source.documentKind === "pdf" && range.pageFrom !== null && range.pageTo !== null
          ? { kind: "page", from: range.pageFrom, to: range.pageTo }
          : null;
    return citationObject(source, range, quote, result, location);
  };

  const citationObject = (
    source: CitationSource,
    range: PageRange,
    quote: string,
    result: ReturnType<typeof checkCitation>,
    location: CitationLocation | null,
  ): Citation => ({
    passageId: source.passageId,
    documentId: source.documentId,
    documentName: source.documentName,
    contentHash: source.contentHash,
    pageFrom: range.pageFrom,
    pageTo: range.pageTo,
    location,
    quote,
    ...result,
  });

  /** Where a Passage is, as a Citation of all of it would say. */
  const passageLocation: Citing["locate"] = (passage) => {
    if (passage.pageFrom === null || passage.pageTo === null) return null;
    const units = documents.pageTexts(
      passage.documentId,
      passage.contentHash,
      passage.pageFrom,
      passage.pageTo,
    );
    if (units.length > 0) return locationOf(units, null);
    return passage.documentKind === "pdf"
      ? { kind: "page", from: passage.pageFrom, to: passage.pageTo }
      : null;
  };

  return {
    async findPassages(text, documentIds, signal) {
      const found = await documents.search(text, documentIds, signal);
      const terms = keywordTerms(text);
      const best = (passage: WindowedPassage) => passage.rank ?? Number.POSITIVE_INFINITY;
      return [...found]
        .sort((a, b) => best(a) - best(b))
        .map((passage) => ({
          passageId: passage.passageId,
          documentId: passage.documentId,
          documentName: passage.documentName,
          documentKind: passage.documentKind,
          pageFrom: passage.pageFrom,
          pageTo: passage.pageTo,
          location: passageLocation(passage),
          text: passage.text,
          notCited: documents.citationSource(passage.passageId)?.notCited ?? false,
          relevance: passage.relevance ?? null,
          matches: matchingTerms(terms, passage.text),
        }));
    },

    citeQuote(passageId, given) {
      const source = documents.citationSource(passageId);
      if (!source) return null;
      const quote = cleanQuote(given);
      const own: PageRange = { pageFrom: source.pageFrom, pageTo: source.pageTo };
      const hasUnits = own.pageFrom !== null && own.pageTo !== null;
      const matching = matchingFor(source);
      const range =
        (hasUnits && quote !== "" && locateQuote(unitsOf(source, own), quote, matching)) || own;
      return citationOf(source, own, range, quote, matching);
    },

    citeUnit(passageId, given, page, at) {
      const source = documents.citationSource(passageId);
      if (!source) return null;
      const own: PageRange = { pageFrom: source.pageFrom, pageTo: source.pageTo };
      if (own.pageFrom === null || own.pageTo === null) return null;
      if (page < own.pageFrom || page > own.pageTo) return null;
      const quote = cleanQuote(given);
      const matching = matchingFor(source);
      const pages = documents.pageTexts(source.documentId, source.contentHash, page, page);
      const unit = pages[0];
      if (!unit || at.start < 0 || at.end < at.start || at.end > unit.text.length) return null;
      const holds =
        quoteInUnits([{ ...unit, text: unit.text.slice(at.start, at.end) }], quote, {
          lostLigatures: matching.lostLigatures ?? false,
        }) !== null;
      const result = checkCitation({
        quote,
        range: { pageFrom: page, pageTo: page },
        passage: own,
        documentDeleted: source.documentDeleted,
        pages,
        ...matching,
      });
      const checked = holds
        ? result
        : { check: "not-found" as const, checkReason: "quote-not-on-pages" as const };
      const location = checked.check === "found" ? locationOf(pages, [at]) : null;
      return citationObject(source, { pageFrom: page, pageTo: page }, quote, checked, location);
    },

    locate: passageLocation,
  };
}
