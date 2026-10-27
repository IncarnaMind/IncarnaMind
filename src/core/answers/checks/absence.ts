import { generateText } from "ai";
import { locationOf } from "../../../shared/locations";
import type {
  CheckedVersion,
  Citation,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimReadDocument,
  LeftOutDocument,
  ProviderError,
} from "../../api";
import { classifyProviderError } from "../../providers/providerErrors";
import type { AnswerDocuments, createCitationSession } from "../citations";
import { answerTemperature } from "../engine";
import { replyJson } from "../quoteRetry";
import type { ClaimCheckDependencies, ClaimCheckRequest } from "./claimCheck";

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
  notChecked(reason: ClaimCheckFailure, detail?: string | null): ClaimCheckResult;
  failedCheck(error: ProviderError): ClaimCheckResult;
}

const CLASSIFY =
  'Classify whether a sentence says something is absent: a clause, disclosure, figure, approval, event or fact is not present. Reply "yes" only when the sentence asserts that absence itself (for example, "The lease has no break clause" or "公司从未披露这笔贷款"). Otherwise reply "no".';

export async function classifyAbsence(request: ClaimCheckRequest): Promise<boolean> {
  const { text } = await generateText({
    model: request.model.model,
    instructions: CLASSIFY,
    prompt: request.claim,
    temperature: answerTemperature(request.model.capabilities.facts.temperature),
    maxOutputTokens: 12,
    maxRetries: 1,
    abortSignal: request.signal,
  });
  return text.trim().toLocaleLowerCase() === "yes";
}

export async function checkAbsence({
  request,
  documents,
  session,
  versions,
  facts,
  citedCase,
  notChecked,
  failedCheck,
}: AbsenceContext): Promise<ClaimCheckResult | null> {
  const { model, signal } = request;
  const reading: {
    documentId: string;
    passages: Parameters<typeof session.show>[0];
    units: ReturnType<AnswerDocuments["pageTexts"]>;
  }[] = [];
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
      instructions:
        'Read the whole Documents and decide whether the sentence\'s absence holds. Reply with one JSON object: {"verdict":"supported"} only when the whole text does not contain the thing the sentence says is absent; otherwise {"verdict":"contradicted","passage":"P1","quote":"the exact words that contain it"}. A Passage outside the whole text is never evidence.',
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
  if (typeof value !== "object" || value === null) return notChecked("malformed");
  const verdict = "verdict" in value ? value.verdict : null;
  if (verdict === "supported") {
    return {
      verdict: "supported",
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      readDocuments,
      ...citedCase(null),
      ...facts(),
    };
  }
  if (verdict !== "contradicted") return notChecked("malformed");
  const passage = "passage" in value && typeof value.passage === "string" ? value.passage : "";
  const quote = "quote" in value && typeof value.quote === "string" ? value.quote : "";
  const recorded = session.tools.cite([{ marker: 1, passage, quote }]);
  if (!recorded.startsWith("Recorded [^1]")) return notChecked("no-evidence");
  session.check();
  const evidence = session.finalCitation(1);
  if (evidence?.check !== "found") return notChecked("no-evidence");
  return {
    verdict: "contradicted",
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    readDocuments,
    ...citedCase(evidence),
    ...facts(),
  };
}
