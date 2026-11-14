/**
 * What a check's Run starts from: the gates that keep a walled Document's Citations inside and
 * name a cited Document outside the Search scope, the scope's search, the citation session every
 * look goes through, and the court decisions the sentence cites.
 */
import { type CaseCitation, caseCitations, isOpinionOf } from "../../../shared/caseCitations";
import { aggregateFigureResults } from "../../../shared/figureChecks";
import { findQuote } from "../../../shared/quoteMatch";
import type { Citation, ClaimCheckResult, ClaimJudgment } from "../../api";
import type { CitationSource } from "../../documents";
import type { EvidenceScope, EvidenceSearch } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import { type AnswerDocuments, createCitationSession, documentNamedAmong } from "../citations";
import type { AnswerSearchOptions, AnswerTools, SearchResultForModel } from "../engine";
import type { CheckResults } from "./checkResults";
import type {
  AheadSearch,
  AtomicClaimCheckResult,
  CheckedCitation,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";
import { CHECK_TAGS } from "./prompt";

/**
 * A check reads only what a Document's words say: no date beside its Passages. The one Answers see
 * (#548) is its file's created or modified day, or the latest year its first page mentions, and a
 * check read it as the Document's own date: "dated 2026" was backed by a contract's delivery start,
 * "自 2026 年 11 月起" (#2311).
 */
export const NO_DATE = (): null => null;

/** Passages as every check shows them, and so counts them: with its prompt's tags defused (#2423). */
export const checkSession = (documents: Parameters<typeof createCitationSession>[0]) =>
  createCitationSession(documents, { onRecord: () => undefined, defuses: CHECK_TAGS });

export function citedSources(
  cited: readonly CheckedCitation[],
  scope: EvidenceScope,
  documents: ClaimCheckDependencies["documents"],
): CitationSource[] {
  const found = new Map<string, CitationSource>();
  for (const { passageId } of cited) {
    const source = passageId ? documents.citationSource(passageId) : null;
    if (
      !source ||
      source.documentDeleted ||
      source.notCited ||
      scope.excluded.has(source.documentId) ||
      (scope.documentIds !== null && !scope.documentIds.includes(source.documentId))
    )
      continue;
    found.set(source.passageId, source);
  }
  return [...found.values()];
}

export const asPassage = (source: CitationSource): WindowedPassage => ({
  ...source,
  seq: 0,
  position: 0,
  windowFrom: 0,
  windowTo: 0,
});

/** A whole read's window, searched again: every search of it finds the same Passages. */
const WINDOW_SHOWN: SearchResultForModel = {
  text: "Every search in this check finds the same Passages, and an earlier search returned them all: answer with them.",
  passageCount: 0,
};

/** A check of a sentence whose every Citation is of a Document a wall keeps from it: not checked. */
export function keptInside(
  deps: Pick<ClaimCheckDependencies, "documents" | "walledDocument" | "walledFolderName">,
  request: Pick<ClaimCheckRequest, "cited" | "scope">,
): ClaimCheckResult | null {
  const { scope } = request;
  const outsideCited = (request.cited ?? []).flatMap((citation) => {
    const source = citation.passageId ? deps.documents.citationSource(citation.passageId) : null;
    if (!source || deps.walledDocument(source.documentId) === null) return [];
    const outside =
      scope.documentIds === null ||
      !scope.documentIds.includes(source.documentId) ||
      scope.excluded.has(source.documentId);
    return outside ? [{ citation, source }] : [];
  });
  if (request.cited && request.cited.length > 0 && outsideCited.length === request.cited.length) {
    const [kept] = outsideCited;
    if (!kept) throw new Error("An outside Citation is missing.");
    return {
      verdict: "not-checked",
      reason: "kept-inside",
      detail: deps.walledFolderName(kept.source.documentId) ?? kept.source.documentName,
      versions: [],
      excluded: [],
    };
  }
  return null;
}

/**
 * The Document a sentence cites that its check's Search scope leaves out, the first of its
 * Citations' (#3083), and whether every Citation is outside the scope; null when none is. A
 * Document behind another wall keeps that wall's reason (`keptInside`), and a whole read's window
 * is the pick the User asked to read, not a Search scope.
 */
export function citedOutsideScope(
  deps: Pick<ClaimCheckDependencies, "walledDocument">,
  request: Pick<ClaimCheckRequest, "cited" | "scope" | "window">,
): { name: string; every: boolean } | null {
  const { scope, cited = [] } = request;
  const { documentIds } = scope;
  if (request.window || documentIds === null) return null;
  const outside = ({ documentId }: CheckedCitation): string | null =>
    documentId !== undefined && !documentIds.includes(documentId) && !scope.excluded.has(documentId)
      ? documentId
      : null;
  const named = cited.find((citation) => {
    const documentId = outside(citation);
    return documentId !== null && deps.walledDocument(documentId) === null;
  });
  return named
    ? { name: named.documentName, every: cited.every((citation) => outside(citation) !== null) }
    : null;
}

/**
 * A check's result when a Document the sentence cites is outside its Search scope (#3083):
 * Supported and Contradicted stand on what it read, and Unsupported, which says the Documents
 * don't state it, is Not checked for want of that Document, named by `name`.
 */
export function withoutDocumentLeftOut(
  result: AtomicClaimCheckResult,
  name: string,
): AtomicClaimCheckResult {
  const unjudged = (judgment: ClaimJudgment): ClaimJudgment =>
    judgment.verdict !== "unsupported" || judgment.kept
      ? judgment
      : {
          verdict: "not-checked",
          reason: "outside-scope",
          detail: name,
          versions: judgment.versions,
          excluded: judgment.excluded,
          ...(judgment.recordCites && { recordCites: judgment.recordCites }),
          ...(judgment.readDocuments && { readDocuments: judgment.readDocuments }),
        };
  if (!result.figures) return unjudged(result);
  const figures = result.figures.map((figure) => ({ ...figure, result: unjudged(figure.result) }));
  const remainder = result.remainder && unjudged(result.remainder);
  if (
    remainder === result.remainder &&
    figures.every((each, at) => each.result === result.figures?.[at]?.result)
  )
    return result;
  return {
    ...result,
    ...aggregateFigureResults(figures, remainder),
    figures,
    ...(remainder !== undefined && { remainder }),
  };
}

/**
 * How many Passages a check hands its sentence (#2532). In this order the deciding Passage was
 * within the first four for 85 of the 86 wrong twins of the pressure test it was found for at all,
 * and first for every right sentence.
 */
const HANDED_PASSAGES = 4;

/** The Passages a check hands its sentence: one that states it word for word first, then the search's order. */
export function handOrder<Found extends { rank?: number; text: string }>(
  found: readonly Found[],
  claim: string,
): Found[] {
  const byRank = [...found].sort((a, b) => (a.rank ?? found.length) - (b.rank ?? found.length));
  const stating = byRank.find((passage) => findQuote(passage.text, claim.trim()) !== null);
  return (stating ? [stating, ...byRank.filter((passage) => passage !== stating)] : byRank).slice(
    0,
    HANDED_PASSAGES,
  );
}

/** Said after the Passages a check hands its sentence. */
export const HANDED_NOTE =
  "IncarnaMind searched the sentence's own words for you. If these Passages don't decide it, search again with other words before you give your verdict.";

/** Words without the spaces and stops around them: a sentence's one part is its sentence but for its stop. */
const bareWords = (text: string) => text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");

/**
 * The search of a sentence's own words that its check hands over (#2532): the one made ahead for
 * those words, or one now, in which a Passage that states the words as they are needs no rerank to
 * come first, so none is made.
 */
export const ownSearch = (
  deps: Pick<ClaimCheckDependencies, "evidence">,
  request: Pick<ClaimCheckRequest, "claim" | "scope" | "signal" | "ahead">,
): AheadSearch =>
  request.ahead && bareWords(request.ahead.query) === bareWords(request.claim)
    ? request.ahead
    : {
        query: request.claim,
        found: deps.evidence.search(request.claim, request.scope, request.signal, {
          stated: (text) => findQuote(text, request.claim.trim()) !== null,
        }),
      };

export function setUpRun(
  deps: Pick<ClaimCheckDependencies, "documents" | "evidence" | "fileProperties" | "libraryFacts">,
  request: Pick<
    ClaimCheckRequest,
    "claim" | "originalClaim" | "cited" | "scope" | "window" | "ahead" | "signal"
  >,
  results: Pick<CheckResults, "readVersion" | "leftOut">,
) {
  const { scope } = request;
  let searches = 0;
  const decisions = caseCitations(request.originalClaim ?? request.claim);
  /** What a search found, as the check reads it: its court decisions' web pages left out, each version read. */
  const taken = (
    found: EvidenceSearch | null,
    within: readonly string[] | undefined,
    options: AnswerSearchOptions | undefined,
  ) => {
    // A web search's result never settles a citation of a court decision.
    const matched = (request.window ?? found?.passages ?? []).filter(
      (passage) => decisions.length === 0 || !deps.documents.savedBySearch(passage.documentId),
    );
    const passages = [
      ...matched,
      ...(options?.properties && deps.fileProperties
        ? deps.fileProperties.add(matched, within, options)
        : []),
      ...(options?.library && deps.libraryFacts ? deps.libraryFacts.add() : []),
    ];
    if (!request.window) {
      for (const passage of passages) results.readVersion(passage.documentId, passage.contentHash);
    }
    for (const each of found?.excluded ?? []) results.leftOut(each);
    return passages;
  };
  /** The sentence's own search, as the check hands it over: the first four, in `handOrder`. */
  const ownPassages = async (signal: AbortSignal) => {
    const found = await ownSearch(deps, request).found;
    signal.throwIfAborted();
    return handOrder(taken(found, undefined, undefined), request.claim);
  };
  const scoped: AnswerDocuments = {
    searchableCount: () => deps.documents.searchableCount(scope.documentIds),
    // A search may name one Document, as an Answer's may: the one a Citation quotes, often.
    documentNamed: (name) =>
      documentNamedAmong(
        deps.documents
          .searchableBySize(scope.documentIds)
          .filter((each) => !scope.excluded.has(each.id)),
        name,
      ),
    async search(query, searchSignal, within, options) {
      const found = request.window
        ? null
        : await deps.evidence.search(
            query,
            within ? { ...scope, documentIds: [...within] } : scope,
            searchSignal,
          );
      return taken(found, within, options);
    },
    citationSource: (passageId) => deps.documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      deps.documents.pageTexts(documentId, contentHash, from, to),
    documentDate: NO_DATE,
    passagesBetween: (documentId, from, to) => deps.documents.passagesBetween(documentId, from, to),
  };
  const session = checkSession(scoped);
  // The words a Citation quotes don't say where they stand: a sheet row's year is in its
  // sheet's name and heading row, which the check reads only in the Passage itself (#1459).
  const citedPassages = citedSources(request.cited ?? [], scope, deps.documents);
  for (const passage of citedPassages) results.readVersion(passage.documentId, passage.contentHash);
  const citedShown = citedPassages.length > 0 ? session.show(citedPassages.map(asPassage)) : null;
  /** In a whole read's window: whether a search has returned the window, the searches in turn. */
  let windowShown: Promise<boolean> = Promise.resolve(false);
  return {
    scoped,
    session,
    decisions,
    citedShown,
    shownPassageIds: (): readonly string[] => [
      ...citedPassages.map((passage) => passage.passageId),
      ...session.shownPassages().map((passage) => passage.passageId),
    ],
    searches: () => searches,
    // The Passages a Citation quotes are shown from the scope, so a verdict on them has looked.
    looked: () => searches > 0 || citedShown !== null,
    /** The Passages a search of `query` found, handed to the model as one of the check's searches. */
    handOver(query: string, passages: readonly WindowedPassage[]): SearchResultForModel {
      searches++;
      for (const passage of passages) results.readVersion(passage.documentId, passage.contentHash);
      return session.searchedFor(query, passages);
    },
    ownPassages,
    /** The sentence's own search, handed to the model as the check's first. */
    async handOff(signal: AbortSignal): Promise<SearchResultForModel> {
      const passages = await ownPassages(signal);
      searches++;
      return session.searchedFor(request.claim, passages);
    },
    tools: (
      calculation: Pick<AnswerTools, "calculate" | "calculationFailed"> | null,
    ): AnswerTools => ({
      get documentCount() {
        return session.tools.documentCount;
      },
      documentLanguages: deps.documents.searchableLanguages(scope.documentIds),
      ...(deps.fileProperties && { fileProperties: true }),
      ...(deps.libraryFacts && { libraryFacts: true }),
      // Only the model's searches count: looking up a cited court decision shows it nothing.
      searchDocuments: (query, searchSignal, options) => {
        searches++;
        if (!request.window) {
          const { fileProperties, libraryFacts } = deps;
          return session.tools.searchDocuments(query, searchSignal, options).then((found) => {
            const told =
              options?.properties && fileProperties ? fileProperties.told(found, options) : found;
            return options?.library && libraryFacts ? libraryFacts.told(told) : told;
          });
        }
        // Claude Haiku 5.5 searched a window two or three times, at once or in turn, and each
        // search returned the whole window again: its verdict request carried it two or three
        // times (#1554).
        const found = windowShown.then((shown) =>
          shown ? WINDOW_SHOWN : session.tools.searchDocuments(query, searchSignal, options),
        );
        windowShown = found.then(
          (result) => result === WINDOW_SHOWN || result.passageCount > 0,
          () => false,
        );
        return found;
      },
      cite: (records, options) => session.tools.cite(records, options),
      hasRecord: (marker) => session.tools.hasRecord?.(marker) ?? false,
      unfoundQuotes: () => session.tools.unfoundQuotes?.() ?? [],
      correctQuote: (marker, quote) => session.tools.correctQuote?.(marker, quote) ?? false,
      ...calculation,
    }),
  };
}

interface Opinions {
  documentIds: ReadonlySet<string>;
  missing: boolean;
}

function startOf(documents: AnswerDocuments, documentId: string, contentHash: string): string {
  const [first] = documents.pageTexts(documentId, contentHash, 1, 1);
  return first?.text ?? documents.pageTexts(documentId, contentHash, null, null)[0]?.text ?? "";
}

async function opinionsOf(
  decisions: readonly CaseCitation[],
  documents: AnswerDocuments,
  signal: AbortSignal,
): Promise<Opinions> {
  const documentIds = new Set<string>();
  let missing = false;
  for (const decision of decisions) {
    const query = [decision.name, decision.cite].filter(Boolean).join(" ");
    const found = await documents.search(query, signal);
    const candidates = new Map(found.map((each) => [each.documentId, each]));
    const opinions = [...candidates.values()].filter((each) =>
      isOpinionOf(
        {
          name: each.documentName,
          start: startOf(documents, each.documentId, each.contentHash),
        },
        decision,
      ),
    );
    if (opinions.length === 0) missing = true;
    for (const each of opinions) documentIds.add(each.documentId);
  }
  return { documentIds, missing };
}

/** The court decisions the sentence cites, and whether a Document holds each one's opinion. */
export async function courtDecisions(
  decisions: readonly CaseCitation[],
  documents: AnswerDocuments,
  signal: AbortSignal,
) {
  const opinions = await opinionsOf(decisions, documents, signal);
  return {
    missing: opinions.missing,
    citedCase: (evidence: Citation | null) => ({
      citedCaseUnchecked: opinions.missing,
      citedCaseFound:
        !opinions.missing &&
        evidence !== null &&
        opinions.documentIds.has(evidence.documentId ?? ""),
    }),
  };
}

export type CourtDecisions = Awaited<ReturnType<typeof courtDecisions>>;
