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
  FigureCheckResult,
  LeftOutDocument,
  ProviderError,
} from "../../api";
import { isRecord } from "../../errors";
import { classifyProviderError } from "../../providers/providerErrors";
import type { AnswerDocuments, createCitationSession } from "../citations";
import { answerTemperature, parseRecords } from "../engine";
import { replyJson } from "../quoteRetry";
import type { ClaimCheckDependencies, ClaimCheckRequest } from "./claimCheck";
import { wholeReadResults } from "./figureChecks";
import { FIGURES_SHAPE, figuresSection } from "./prompt";

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
  /** Each requested figure's row from a Figures line, read as the check reads its own reply's. */
  figureRows(reply: string): Promise<FigureCheckResult[]>;
  notChecked(reason: ClaimCheckFailure, detail?: string | null): ClaimCheckResult;
  failedCheck(error: ProviderError): ClaimCheckResult;
}

interface WholeReading {
  documentId: string;
  passages: Parameters<ReturnType<typeof createCitationSession>["show"]>[0];
  units: ReturnType<AnswerDocuments["pageTexts"]>;
}

function scopeComplete(
  request: ClaimCheckRequest,
  documents: ClaimCheckDependencies["documents"],
  reading: readonly WholeReading[],
): boolean {
  const unreadUnit = reading.some(({ units }) =>
    units.some(
      (unit) =>
        unit.label?.scan?.unread === true ||
        unit.label?.figures?.some((figure) => figure.unread === true),
    ),
  );
  if (unreadUnit) return false;
  if (!documents.getMany || !documents.names) return true;
  const ids = request.scope.documentIds ?? documents.names().map((each) => each.id);
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
    if (document.pageCount === null) return true;
    const units = reading.find((each) => each.documentId === document.id)?.units ?? [];
    return new Set(units.map((unit) => unit.page)).size === document.pageCount;
  });
}

export async function checkAbsence({
  request,
  documents,
  session,
  versions,
  facts,
  citedCase,
  figureRows,
  notChecked,
  failedCheck,
}: AbsenceContext): Promise<ClaimCheckResult | null> {
  const { model, signal } = request;
  const reading: WholeReading[] = [];
  let pageCount = 0;
  for (const document of documents.searchableBySize(request.scope.documentIds)) {
    const passages = documents.passagesBetween?.(document.id, 0, Number.MAX_SAFE_INTEGER) ?? [];
    const contentHash = passages[0]?.contentHash;
    if (!contentHash) continue;
    const units = documents.pageTexts(document.id, contentHash, null, null);
    reading.push({ documentId: document.id, passages, units });
    pageCount += units.length;
  }
  if (reading.length === 0) return notChecked("absence-read-limit");
  if (pageCount > 40) return notChecked("absence-read-limit");
  // A readable part is not the whole scope: anything failed, missing or unread stops Supported.
  if (!scopeComplete(request, documents, reading)) return notChecked("absence-read-limit");

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
  const figures = request.figures ?? [];
  let reply: string;
  try {
    const { text } = await generateText({
      model: model.model,
      instructions: wholeReadInstructions(figures.length > 0),
      prompt: [
        `<sentence>\n${request.claim}\n</sentence>`,
        ...(figures.length > 0 ? [figuresSection(figures)] : []),
        whole,
      ].join("\n\n"),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: 400 + 150 * figures.length,
      maxRetries: 1,
      abortSignal: signal,
    });
    reply = text;
  } catch (error) {
    return failedCheck(classifyProviderError(error));
  }
  const [judged, ...figureLines] = reply.split(/\r?\n(?=\s*Figures:)/i);
  const value = await replyJson(judged ?? "");
  if (!isRecord(value)) return notChecked("malformed");
  const citations = parseRecords(value.citations ?? []);
  if (citations.length > 0) {
    const recorded = session.tools.cite(citations);
    if (!recorded.startsWith("Recorded")) return notChecked("no-evidence");
    session.check();
  }
  const found = (marker: number) => {
    const citation = citations.some((each) => each.marker === marker)
      ? session.finalCitation(marker)
      : null;
    return citation?.check === "found" ? citation : null;
  };
  const judgment = (
    verdict: "supported" | "contradicted" | "unsupported",
    evidence: Citation | null,
  ): ClaimJudgment =>
    verdict === "unsupported"
      ? {
          verdict,
          evidence: null,
          says: null,
          unsupported: { reason: null, covered: null, uncovered: null },
          calculation: null,
          readDocuments,
          ...citedCase(null),
          ...facts(),
        }
      : {
          verdict,
          evidence,
          says: null,
          unsupported: null,
          calculation: null,
          readDocuments,
          ...citedCase(evidence),
          ...facts(),
        };
  let absence: ClaimJudgment;
  if (value.absence === "holds") absence = judgment("supported", null);
  else if (value.absence === "contained") {
    const evidence = found(1);
    if (!evidence) return notChecked("no-evidence");
    absence = judgment("contradicted", evidence);
  } else return notChecked("malformed");
  const rest = restOfSentence(value.rest, found(2), judgment);
  if (rest === undefined) return notChecked("malformed");
  const sentence = [absence, ...(rest ? [rest] : [])];
  const worst =
    sentence.find((part) => part.verdict === "contradicted") ??
    sentence.find((part) => part.verdict === "unsupported") ??
    rest ??
    absence;
  if (figures.length === 0) return worst;
  const rows = await figureRows(figureLines.join("\n"));
  const absent = typeof value.absent === "string" ? value.absent : null;
  return wholeReadResults(request.claim, figures, rows, { absence, sentence: worst }, absent);
}

/**
 * What the read says of the sentence beyond its absence: null when it says nothing more,
 * undefined when the reply gives no answer that can be read. Supported only on a found
 * Citation (`evidence`): the absence holding backs nothing else. Parts of a sentence (#2174)
 * will check this rest on their own.
 */
function restOfSentence(
  rest: unknown,
  evidence: Citation | null,
  judgment: (
    verdict: "supported" | "contradicted" | "unsupported",
    evidence: Citation | null,
  ) => ClaimJudgment,
): ClaimJudgment | null | undefined {
  if (rest === "none") return null;
  if (rest === "supported" || rest === "contradicted")
    return evidence ? judgment(rest, evidence) : judgment("unsupported", null);
  if (rest === "unsupported") return judgment("unsupported", null);
  return undefined;
}

/**
 * The whole read judges the whole sentence, not only its absence: a read that asked only whether
 * the absent thing is there approved whatever else the sentence said (#1443). The absence and the
 * rest of the sentence are answered apart, each with its own evidence, so neither borrows the
 * other's.
 */
export function wholeReadInstructions(figures: boolean): string {
  return [
    "Read the whole Documents and judge the sentence against them in two parts: what it says is absent, and the rest of what it says.",
    'Reply with one JSON object on one line: {"absent":"the sentence\'s own words for what it says is absent","absence":"holds","rest":"none","citations":[{"marker":1,"passage":"P1","quote":"the exact words"}]}.',
    '- absence: "holds" when the whole text does not contain what the sentence says is absent; "contained" when it does, and citation 1 quotes the words that contain it.',
    '- rest: "none" when the sentence says nothing besides its absence; otherwise "supported" when the text states it, or "contradicted" when it gives another value, with citation 2 quoting those words; else "unsupported".',
    "Copy each quote exactly from one Passage, as one unbroken stretch. A Passage outside the whole text is never evidence.",
    ...(figures
      ? [
          `Then one last line: Figures: and one JSON object shaped ${FIGURES_SHAPE}, giving every requested id once. A figure inside what the sentence says is absent takes the absence's verdict (supported when it holds), with source null. Any other figure names its citation (2 or later) and the number as its quote writes it; calculation is null; remainder is null.`,
        ]
      : []),
  ].join("\n");
}
