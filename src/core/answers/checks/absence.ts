import {
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from "ai";
import { locationOf } from "../../../shared/locations";
import type {
  CheckedVersion,
  Citation,
  ClaimCheckFailure,
  ClaimCheckResult,
  ClaimReadDocument,
  Document,
  LeftOutDocument,
  ProviderError,
} from "../../api";
import { isRecord } from "../../errors";
import { givesStructuredOutput } from "../../providers/capabilities";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import type { AnswerDocuments, createCitationSession } from "../citations";
import { answerTemperature } from "../engine";
import { replyJson } from "../quoteRetry";
import type { ClaimCheckDependencies, ClaimCheckRequest } from "./claimCheck";
import { readYesNo } from "./prompt";

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

export const CLASSIFY_ABSENCE =
  'Classify whether a sentence says something is absent: a clause, disclosure, figure, approval, event or fact is not present. Answer "yes" only when the sentence asserts that absence itself (for example, "The lease has no break clause" or "公司从未披露这笔贷款"). Otherwise answer "no".';

type AbsenceQuestion = Pick<ClaimCheckRequest, "claim" | "signal"> & {
  model: Pick<PreparedChatModel, "model" | "capabilities">;
};

const answerSchema = jsonSchema<{ answer: string }>({
  type: "object",
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
  required: ["answer"],
  additionalProperties: false,
});

/** The classifier's yes or no; null when its reply gives neither or was cut off. */
async function absenceAnswer(request: AbsenceQuestion): Promise<boolean | null> {
  const call = {
    model: request.model.model,
    instructions: CLASSIFY_ABSENCE,
    prompt: request.claim,
    temperature: answerTemperature(request.model.capabilities.facts.temperature),
    maxOutputTokens: 300,
    maxRetries: 1,
    abortSignal: request.signal,
  };
  try {
    if (givesStructuredOutput(request.model.capabilities) === false) {
      const { text, finishReason } = await generateText(call);
      return finishReason === "length" ? null : readYesNo(text);
    }
    const result = await generateText({
      ...call,
      output: Output.object({ schema: answerSchema, name: "absence" }),
    });
    return result.finishReason === "length" ? null : readYesNo(result.output.answer);
  } catch (error) {
    // Thinking can take every output token and leave no answer at all.
    if (NoOutputGeneratedError.isInstance(error)) return null;
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    if (error.finishReason === "length") return null;
    // JSON in a code fence, or after thinking, is still read; so is a bare yes or no.
    const value = await replyJson(error.text ?? "");
    return readYesNo(
      isRecord(value) && typeof value.answer === "string" ? value.answer : (error.text ?? ""),
    );
  }
}

/**
 * Whether the sentence claims an absence, so Supported needs the whole read. An answer that
 * can't be read as yes or no counts as yes: search alone never backs an absence.
 */
export async function classifyAbsence(request: AbsenceQuestion): Promise<boolean> {
  return (await absenceAnswer(request)) ?? true;
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
