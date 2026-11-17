/**
 * What a check's Run starts from: the gates that keep a walled Document's Citations inside and
 * name a cited Document outside the Search scope, the scope's search, the citation session every
 * look goes through, and the court decisions the sentence cites.
 */
import { type CaseCitation, caseCitations, isOpinionOf } from "../../../shared/caseCitations";
import type { Citation, ClaimCheckResult } from "../../api";
import type { CitationSource } from "../../documents";
import type { EvidenceScope } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import { type AnswerDocuments, createCitationSession, documentNamedAmong } from "../citations";
import type { AnswerTools } from "../engine";
import type { CheckResults } from "./checkResults";
import type { CheckedCitation, ClaimCheckDependencies, ClaimCheckRequest } from "./claimCheck";
import { CHECK_TAGS } from "./prompt";

/**
 * A check reads only what a Document's words say: no date beside its Passages. The one Answers see
 * (#548) is its file's created or modified day, or the latest year its first page mentions, and a
 * check read it as the Document's own date: "dated 2026" was backed by a contract's delivery start,
 * "自 2026 年 11 月起" (#2311).
 */
export const NO_DATE = (): null => null;

/** Passages as every check shows them, and so counts them: with its prompt's tags defused (#2423). */
export const checkSession = (
  documents: Parameters<typeof createCitationSession>[0],
  thisCall?: (documentId: string) => boolean | undefined,
) =>
  createCitationSession(documents, {
    onRecord: () => undefined,
    defuses: CHECK_TAGS,
    ...(thisCall && { thisCall }),
  });

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
 * Document behind another wall keeps that wall's reason (`keptInside`).
 */
export function citedOutsideScope(
  deps: Pick<ClaimCheckDependencies, "walledDocument">,
  request: Pick<ClaimCheckRequest, "cited" | "scope">,
): { name: string; every: boolean } | null {
  const { scope, cited = [] } = request;
  const { documentIds } = scope;
  if (documentIds === null) return null;
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
export function withoutDocumentLeftOut(result: ClaimCheckResult, name: string): ClaimCheckResult {
  return result.verdict !== "unsupported" || result.kept
    ? result
    : {
        verdict: "not-checked",
        reason: "outside-scope",
        detail: name,
        versions: result.versions,
        excluded: result.excluded,
        ...(result.recordCites && { recordCites: result.recordCites }),
      };
}

export function setUpRun(
  deps: Pick<ClaimCheckDependencies, "documents" | "evidence" | "callMark">,
  request: Pick<ClaimCheckRequest, "claim" | "cited" | "scope" | "about" | "callIn">,
  results: Pick<CheckResults, "readVersion" | "leftOut">,
) {
  const { scope } = request;
  let searches = 0;
  const decisions = caseCitations(request.claim);
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
    async search(query, searchSignal, within) {
      const found = await deps.evidence.search(
        query,
        within ? { ...scope, documentIds: [...within] } : scope,
        searchSignal,
        request.about,
      );
      // A web search's result never settles a citation of a court decision.
      const passages = found.passages.filter(
        (passage) => decisions.length === 0 || !deps.documents.savedBySearch(passage.documentId),
      );
      for (const passage of passages) results.readVersion(passage.documentId, passage.contentHash);
      for (const each of found.excluded) results.leftOut(each);
      return passages;
    },
    citationSource: (passageId) => deps.documents.citationSource(passageId),
    pageTexts: (documentId, contentHash, from, to) =>
      deps.documents.pageTexts(documentId, contentHash, from, to),
    documentDate: NO_DATE,
    passagesBetween: (documentId, from, to) => deps.documents.passagesBetween(documentId, from, to),
    // A Transcript's Passage is marked as this call's or an earlier one's, for an Answer asked in a call.
    callOf: (documentId) => {
      const call = deps.callMark?.(request.callIn ?? null, documentId);
      return call ? { note: call.note, startedAt: call.startedAt } : null;
    },
  };
  const session = checkSession(scoped, (documentId) =>
    request.callIn === undefined
      ? undefined
      : deps.callMark?.(request.callIn, documentId)?.thisCall,
  );
  // The words a Citation quotes don't say where they stand: a sheet row's year is in its
  // sheet's name and heading row, which the check reads only in the Passage itself (#1459).
  const citedPassages = citedSources(request.cited ?? [], scope, deps.documents);
  for (const passage of citedPassages) results.readVersion(passage.documentId, passage.contentHash);
  const citedShown = citedPassages.length > 0 ? session.show(citedPassages.map(asPassage)) : null;
  const tools: AnswerTools = {
    get documentCount() {
      return session.tools.documentCount;
    },
    documentLanguages: deps.documents.searchableLanguages(scope.documentIds),
    // Only the model's searches count: looking up a cited court decision shows it nothing.
    searchDocuments: (query, searchSignal, options) => {
      searches++;
      return session.tools.searchDocuments(query, searchSignal, options);
    },
    cite: (records, options) => session.tools.cite(records, options),
    hasRecord: (marker) => session.tools.hasRecord?.(marker) ?? false,
    unfoundQuotes: () => session.tools.unfoundQuotes?.() ?? [],
    correctQuote: (marker, quote) => session.tools.correctQuote?.(marker, quote) ?? false,
  };
  return {
    scoped,
    session,
    decisions,
    citedShown,
    searches: () => searches,
    // The Passages a Citation quotes are shown from the scope, so a verdict on them has looked.
    looked: () => searches > 0 || citedShown !== null,
    tools,
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
