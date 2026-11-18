/**
 * What a check's Run starts from: the gates that keep a walled Document's Citations inside and
 * name a cited Document outside the Search scope, the scope's search, the citation session every
 * look goes through, and the court decisions the sentence cites.
 */
import { type CaseCitation, caseCitations, isOpinionOf } from "../../../shared/caseCitations";
import { LIBRARY_FACTS } from "../../../shared/libraryFacts";
import type { AnalysisRuntime } from "../../adapters";
import { analysisTool } from "../../analysis/tool";
import type {
  AnswerAnalysis,
  CheckWorking,
  Citation,
  ClaimCheckResult,
  LibraryListName,
} from "../../api";
import type { CitationSource } from "../../documents";
import type { EvidenceScope } from "../../documents/evidence";
import type { WindowedPassage } from "../../documents/search";
import { isLibraryList, type LibraryLists, libraryVersion } from "../../library/lists";
import { answerLanguage, createCalculationSession, givenList } from "../calculations";
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

/**
 * The Library's lists a sentence's check may count (#2525): none in a check an outside agent
 * started, whose verdicts would tell the agent the names and counts of what it may not read.
 */
export const listsFor = (
  deps: Pick<ClaimCheckDependencies, "libraryLists">,
  request: Pick<ClaimCheckRequest, "outside">,
): ClaimCheckDependencies["libraryLists"] => (request.outside ? undefined : deps.libraryLists);

/** What a run read of the Library's own lists: what its working keeps, and what its verdict rests on. */
export interface LibraryRead {
  read: NonNullable<CheckWorking["library"]>;
  citation: Citation;
}

/**
 * The Library's lists a run counted, as a check's card shows them: the row names the Library and
 * how many Documents the Note's check saw, which is no Document's text. Its version is of all its
 * lists, so a change to the Library puts the sentence back to needs re-check.
 */
function libraryRead(lists: LibraryLists, names: readonly LibraryListName[]): LibraryRead {
  const read = names.map((list) => ({ list, count: lists[list].rows.length }));
  const first = read[0]?.list ?? "documents";
  const count = lists[first].rows.length;
  const version = libraryVersion(lists);
  return {
    read: { source: lists.source, lists: read },
    citation: {
      passageId: version,
      documentId: LIBRARY_FACTS,
      documentName: LIBRARY_FACTS,
      contentHash: version,
      pageFrom: null,
      pageTo: null,
      location: { kind: "library", source: lists.source, fact: { kind: first, count } },
      quote: `${first}: ${count}`,
      check: "found",
      checkReason: null,
    },
  };
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
  deps: Pick<ClaimCheckDependencies, "documents" | "evidence" | "callMark" | "libraryLists">,
  request: Pick<
    ClaimCheckRequest,
    "claim" | "cited" | "scope" | "about" | "callIn" | "mindId" | "outside"
  >,
  results: Pick<CheckResults, "readVersion" | "leftOut">,
  /** The model is offered `calculate`, the calculator Answers use (ADR-0021). */
  calculates = false,
  /** Given, the model is offered the Analysis Tool, to work a figure out over a data file's rows. */
  runtime?: AnalysisRuntime,
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
  // A tool in the model's hands: it works a figure out from numbers quoted from the Passages and
  // tells the model the result. What that means for the sentence is the model's to say.
  const calculator = calculates
    ? createCalculationSession({
        documents: scoped,
        quotes: session.quotes,
        language: answerLanguage(request.claim),
      })
    : null;
  // What the model reads of a data file is the Passages a search shows it; the code reads the
  // whole sheet those Passages are of, on this computer. What the result means is the model's to say.
  const workings: AnswerAnalysis[] = [];
  let figures = 0;
  // The Library's lists are read once, when a run first asks for one: every run of this check
  // counts the same rows.
  let lists: LibraryLists | null = null;
  const libraryLists = listsFor(deps, request);
  const listsRead = new Map<AnswerAnalysis, LibraryRead>();
  const analysis = runtime
    ? analysisTool({
        runtime,
        passage(id) {
          const named = id.trim().toLowerCase();
          const shown = session.shownPassages().find((each) => each.id.toLowerCase() === named);
          const source = shown ? scoped.citationSource(shown.passageId) : null;
          return source && !source.documentDeleted
            ? { source, units: scoped.pageTexts(source.documentId, source.contentHash, null, null) }
            : null;
        },
        number: () => ({
          problem: "a check's Analysis reads rows only: write a number a Passage gives in the code",
        }),
        figure: () => ++figures,
        language: answerLanguage(request.claim),
        now: () => new Date(),
        ran: (_call, run) => workings.push(run),
        ...(libraryLists && {
          library(list) {
            lists ??= libraryLists(request.mindId ?? null);
            return isLibraryList(list) ? (lists?.[list] ?? null) : null;
          },
          readLibrary(run, read) {
            const names = [...new Set(read)].filter(isLibraryList);
            if (!lists || names.length === 0) return;
            const found = libraryRead(lists, names);
            results.readVersion(found.citation.documentId, found.citation.contentHash);
            listsRead.set(run, found);
          },
        }),
      })
    : null;
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
    ...(calculator && {
      calculate: (given, options) => calculator.calculate(givenList(given), options),
    }),
    ...(analysis && { analysis }),
  };
  return {
    scoped,
    session,
    decisions,
    citedShown,
    searches: () => searches,
    // The Passages a Citation quotes are shown from the scope, so a verdict on them has looked;
    // so has one whose code counted the Library's own lists.
    looked: () => searches > 0 || citedShown !== null || listsRead.size > 0,
    /** The Analyses the model ran, in order: a failed one too. */
    workings: (): readonly AnswerAnalysis[] => workings,
    /** The Library's lists a run read; none for a run over a data file's rows alone. */
    libraryRead: (run: AnswerAnalysis): LibraryRead | undefined => listsRead.get(run),
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
