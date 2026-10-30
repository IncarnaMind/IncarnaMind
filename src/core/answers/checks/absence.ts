import { generateText } from "ai";
import { locationOf } from "../../../shared/locations";
import type {
  CheckedVersion,
  Citation,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimJudgment,
  ClaimReadDocument,
  Document,
  LeftOutDocument,
  ProviderError,
} from "../../api";
import { isRecord } from "../../errors";
import { classifyProviderError } from "../../providers/providerErrors";
import type { AnswerDocuments, createCitationSession } from "../citations";
import { answerTemperature, parseRecords } from "../engine";
import { replyJson } from "../quoteRetry";
import type { ClaimCheckDependencies, ClaimCheckRequest } from "./claimCheck";
import { absenceFigureResults } from "./figureChecks";
import { readsAsRefusal } from "./prompt";

interface AbsenceContext {
  request: ClaimCheckRequest;
  documents: ClaimCheckDependencies["documents"];
  session: ReturnType<typeof createCitationSession>;
  versions: Map<string, string>;
  facts(): { versions: CheckedVersion[]; excluded: LeftOutDocument[] };
  citedCase(evidence: Citation | null): {
    citedCaseUnchecked: boolean;
    citedCaseFound: boolean;
  };
  /** Whether the scope fits a whole read (`fitsWholeRead`), worked out once for the check. */
  fits: boolean;
  notChecked(reason: ClaimCheckFailure, detail?: string | null): ClaimCheckResult;
  failedCheck(error: ProviderError): ClaimCheckResult;
}

interface WholeReading {
  documentId: string;
  passages: Parameters<ReturnType<typeof createCitationSession>["show"]>[0];
  units: ReturnType<AnswerDocuments["pageTexts"]>;
}

type ScopeRecords = Pick<
  ClaimCheckDependencies["documents"],
  "searchableBySize" | "unitCounts"
> &
  Partial<Pick<ClaimCheckDependencies["documents"], "getMany" | "names">>;

/** The scope's Documents are all whole and current: none failed, missing or partly read. */
function recordsComplete(
  documentIds: readonly string[] | null,
  documents: ScopeRecords,
  units: ReadonlyMap<string, number>,
): boolean {
  if (!documents.getMany || !documents.names) return true;
  const ids = documentIds ?? documents.names().map((each) => each.id);
  const records = documents.getMany(ids);
  if (records.length !== ids.length) return false;
  return records.every((document: Document) => {
    if (
      document.fileStatus !== "available" ||
      document.status === "failed" ||
      document.status === "no-text" ||
      document.status === "extracting" ||
      document.status === "queued" ||
      document.failure !== null ||
      document.unreadParts !== null ||
      document.unreadPartsUnknown
    )
      return false;
    return document.pageCount === null || units.get(document.id) === document.pageCount;
  });
}

/**
 * Whether a check's whole scope (`documentIds`, null for every Document) fits a whole read, from
 * the stored Unit counts and Document records: no page text is loaded, so a scope far too long
 * costs nothing to turn away.
 */
export function fitsWholeRead(
  documentIds: readonly string[] | null,
  documents: ScopeRecords,
): boolean {
  const ids = documents.searchableBySize(documentIds).map((each) => each.id);
  const units = documents.unitCounts(ids);
  const total = ids.reduce((sum, id) => sum + (units.get(id) ?? 0), 0);
  return total > 0 && total <= 40 && recordsComplete(documentIds, documents, units);
}

/** The scope read for the whole read: every Passage and Unit; null when a Unit couldn't be read. */
function wholeScope(
  request: ClaimCheckRequest,
  documents: ClaimCheckDependencies["documents"],
): WholeReading[] | null {
  const reading: WholeReading[] = [];
  for (const document of documents.searchableBySize(request.scope.documentIds)) {
    const passages = documents.passagesBetween?.(document.id, 0, Number.MAX_SAFE_INTEGER) ?? [];
    const contentHash = passages[0]?.contentHash;
    if (!contentHash) continue;
    const units = documents.pageTexts(document.id, contentHash, null, null);
    reading.push({ documentId: document.id, passages, units });
  }
  const unreadUnit = reading.some(({ units }) =>
    units.some(
      (unit) =>
        unit.label?.scan?.unread === true ||
        unit.label?.figures?.some((figure) => figure.unread === true),
    ),
  );
  return reading.length === 0 || unreadUnit ? null : reading;
}

export async function checkAbsence({
  request,
  documents,
  session,
  versions,
  facts,
  citedCase,
  fits,
  notChecked,
  failedCheck,
}: AbsenceContext): Promise<ClaimCheckResult | null> {
  const { model, signal } = request;
  // A readable part is not the whole scope: anything failed, missing or unread stops Supported.
  const reading = fits ? wholeScope(request, documents) : null;
  if (!reading) return notChecked("absence-read-limit");

  const readDocuments: ClaimReadDocument[] = [];
  for (const { documentId, passages, units } of reading) {
    const contentHash = passages[0]?.contentHash;
    if (!contentHash) continue;
    versions.set(documentId, contentHash);
    readDocuments.push({
      documentId,
      documentName: passages[0]?.documentName ?? "",
      contentHash,
      locations: units.flatMap((unit) => {
        const location = locationOf([unit], null);
        return location ? [location] : [];
      }),
    });
  }
  const whole = reading.map(({ passages }) => session.show(passages)).join("\n\n");
  let reply: string;
  try {
    const { text } = await generateText({
      model: model.model,
      instructions: WHOLE_READ,
      prompt: `<sentence>\n${request.claim}\n</sentence>\n\n${whole}`,
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: 400,
      maxRetries: 1,
      abortSignal: signal,
    });
    reply = text;
  } catch (error) {
    return failedCheck(classifyProviderError(error));
  }
  const value = await replyJson(reply);
  if (!isRecord(value)) return notChecked(readsAsRefusal(reply) ? "refused" : "malformed");
  // The read decides the part, so only what it read backs it: the pages read whole, and the quote
  // that contains the absent thing when it is there. A quote the check's search cited on the way
  // backs nothing here, and a card or Citation that showed it would show an unrelated line.
  const { versions: read, excluded } = facts();
  const judgment = (verdict: "supported" | "contradicted", evidence: Citation | null) => ({
    verdict,
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    readDocuments,
    ...citedCase(evidence),
    versions: read,
    excluded,
  });
  let absence: ClaimJudgment;
  if (value.absence === "holds") absence = judgment("supported", null);
  else if (value.absence === "contained") {
    const citations = parseRecords(value.citations ?? []).filter((each) => each.marker === 1);
    if (citations.length === 0) return notChecked("no-evidence");
    if (!session.tools.cite(citations).startsWith("Recorded")) return notChecked("no-evidence");
    session.check();
    const evidence = session.finalCitation(1);
    if (evidence?.check !== "found") return notChecked("no-evidence");
    absence = judgment("contradicted", evidence);
  } else return notChecked("malformed");
  const figures = request.figures ?? [];
  if (figures.length === 0) return absence;
  const absent = typeof value.absent === "string" ? value.absent : null;
  return absenceFigureResults(request.claim, figures, absence, absent);
}

/**
 * The whole read judges only the absence. Anything else a sentence says is a part of its own,
 * checked as any part is with its own Citation (#2174): a read that also judged the rest backed
 * it with a quote of its own choosing, once an unrelated one (#1443).
 */
export const WHOLE_READ = [
  "Read the whole Documents and decide only whether they contain what the sentence says is absent.",
  'Reply with one JSON object: {"absent":"the sentence\'s own words for what it says is absent","absence":"holds"} when the whole text does not contain it; {"absent":"…","absence":"contained","citations":[{"marker":1,"passage":"P1","quote":"the exact words that contain it"}]} when it does.',
  "Copy the quote exactly from one Passage, as one unbroken stretch. A Passage outside the whole text is never evidence.",
].join("\n");
