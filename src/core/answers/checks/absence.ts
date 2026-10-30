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
import type {
  AtomicClaimCheckResult,
  ClaimCheckDependencies,
  ClaimCheckRequest,
} from "./claimCheck";
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
  /** The two looks an ordinary Contradicted gets, at the quote the read says contains the thing. */
  confirm(evidence: Citation): Promise<Confirmation>;
}

export type Confirmation =
  | { kind: "unrelated" | "doubt" | "confirmed" | "malformed" | "stopped" }
  | { failed: ProviderError };

/** The most a whole read's judgement writes. */
export const ABSENCE_OUTPUT_TOKENS = 400;

/** What a whole read's judgement is asked about: the sentence, then the text it reads. */
export const absencePrompt = (claim: string, whole: string): string =>
  `<sentence>\n${claim}\n</sentence>\n\n${whole}`;

interface WholeReading {
  documentId: string;
  passages: Parameters<ReturnType<typeof createCitationSession>["show"]>[0];
  units: ReturnType<AnswerDocuments["pageTexts"]>;
}

type ScopeRecords = Pick<
  ClaimCheckDependencies["documents"],
  "searchableBySize" | "unitCounts" | "getMany" | "names"
>;

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

/**
 * One window of a pick read whole (#1554), by Document: its Passages and the Units they are on;
 * null when a Unit couldn't be read.
 */
function windowScope(
  window: NonNullable<ClaimCheckRequest["window"]>,
  documents: ClaimCheckDependencies["documents"],
): WholeReading[] | null {
  const byDocument = new Map<string, (typeof window)[number][]>();
  for (const passage of window) {
    byDocument.set(passage.documentId, [...(byDocument.get(passage.documentId) ?? []), passage]);
  }
  const reading = [...byDocument].map(([documentId, passages]): WholeReading => {
    const pages = passages.flatMap(({ pageFrom, pageTo }) =>
      pageFrom === null ? [] : [pageFrom, pageTo ?? pageFrom],
    );
    const units = documents.pageTexts(
      documentId,
      passages[0]?.contentHash ?? "",
      pages.length > 0 ? Math.min(...pages) : null,
      pages.length > 0 ? Math.max(...pages) : null,
    );
    return { documentId, passages, units };
  });
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
  confirm,
}: AbsenceContext): Promise<AtomicClaimCheckResult | null> {
  const { model, signal, window } = request;
  // A readable part is not the whole scope: anything failed, missing or unread stops Supported.
  // A pick read whole is judged one window at a time: the absence holds only when every window
  // holds it, which its read decides (./wholeRead).
  const reading = window
    ? windowScope(window, documents)
    : fits
      ? wholeScope(request, documents)
      : null;
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
      prompt: absencePrompt(request.claim, whole),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: ABSENCE_OUTPUT_TOKENS,
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
  const judgment = (
    verdict: "supported" | "contradicted" | "unsupported",
    evidence: Citation | null,
  ) => ({
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
  let holds = value.absence === "holds";
  if (holds) absence = judgment("supported", null);
  else if (value.absence === "contained") {
    const citations = parseRecords(value.citations ?? []).filter((each) => each.marker === 1);
    if (citations.length === 0) return notChecked("no-evidence");
    if (!session.tools.cite(citations).startsWith("Recorded")) return notChecked("no-evidence");
    session.check();
    const evidence = session.finalCitation(1);
    if (evidence?.check !== "found") return notChecked("no-evidence");
    // Saying the thing is there contradicts the sentence, so it gets an ordinary Contradicted's
    // two looks: a quote about something else leaves the absence holding, as on a garden clause
    // given for "no parking" (#1554).
    const confirmation = await confirm(evidence);
    if ("failed" in confirmation) return failedCheck(confirmation.failed);
    if (confirmation.kind === "stopped") return notChecked("stopped");
    if (confirmation.kind === "malformed") return notChecked("malformed");
    holds = confirmation.kind === "unrelated";
    absence =
      confirmation.kind === "confirmed"
        ? judgment("contradicted", evidence)
        : judgment(holds ? "supported" : "unsupported", null);
  } else return notChecked("malformed");
  const figures = request.figures ?? [];
  const absent = typeof value.absent === "string" ? value.absent : null;
  const result =
    figures.length === 0 ? absence : absenceFigureResults(request.claim, figures, absence, absent);
  if (!window) return result;
  return {
    ...result,
    readPassages: window.map((passage) => passage.passageId),
    ...(holds && { absenceHeld: true }),
  };
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
