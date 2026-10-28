import { generateText } from "ai";
import { comparableSentence } from "../../../shared/sentences";
import type { CheckedVersion, ClaimCheckFailure, ProviderError, RecordCiteResult } from "../../api";
import type { Language } from "../../language";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import type { ResolvableRecordCiteResult } from "../../recordCites/resolver";
import { answerTemperature } from "../engine";
import {
  confirmPrompt,
  partInstructions,
  RECORD_CITE_INSTRUCTIONS,
  readJudgement,
  readPart,
} from "./prompt";

export interface RecordCiteJudgement {
  outcome: "supported" | "partly" | "unsupported";
  covered?: string;
  uncovered?: string;
}

export function recordClaimFacts(
  claim: string,
  results: readonly Pick<RecordCiteResult, "from" | "to">[],
): string {
  const ranges = results
    .flatMap(({ from, to }) =>
      typeof from === "number" && typeof to === "number" ? [{ from, to }] : [],
    )
    .sort((left, right) => right.from - left.from);
  let text = claim;
  for (const range of ranges) text = `${text.slice(0, range.from)}${text.slice(range.to)}`;
  return text
    .replace(/\s+/g, " ")
    .replace(/\([\s;]*\)/g, "")
    .trim();
}

export async function judgeRecordCite(
  model: PreparedChatModel,
  claim: string,
  passage: string,
  signal: AbortSignal,
  language: Language,
): Promise<RecordCiteJudgement | { failed: ProviderError }> {
  const first = await compare(model, claim, passage, RECORD_CITE_INSTRUCTIONS, signal);
  if ("failed" in first) return first;
  const judged = readJudgement(first.reply);
  if (judged === "same") return { outcome: "supported" };
  if (judged === "neither") return { outcome: "unsupported" };
  if (judged === null) {
    return {
      failed: {
        kind: "unknown",
        message: "The check gave no verdict.",
        wording: { key: "claim.reason.malformed" },
      },
    };
  }
  const part = await compare(model, claim, passage, partInstructions(language), signal);
  if ("failed" in part) return part;
  const { covered, uncovered } = readPart(part.reply);
  return covered && uncovered
    ? { outcome: "partly", covered, uncovered }
    : { outcome: "unsupported" };
}

const failureOf = (error: ProviderError): { reason: ClaimCheckFailure; detail: string | null } => {
  switch (error.kind) {
    case "unknown":
      return { reason: "malformed", detail: null };
    case "rate-limit":
    case "cost-cap":
    case "plan-limit":
    case "out-of-credit":
    case "consent-revoked":
    case "local-mode":
      return { reason: error.kind, detail: null };
    case "no-answer":
      return { reason: "empty", detail: null };
    default:
      return { reason: "failed", detail: error.message };
  }
};

const withoutCandidates = (result: ResolvableRecordCiteResult): RecordCiteResult => {
  const { nearbyCandidates: _, ...rest } = result;
  const publicResult: RecordCiteResult = {
    ...rest,
    outcome: rest.outcome === "found" ? "not-found" : rest.outcome,
  };
  return publicResult;
};

export async function judgeResolvedRecordCites(
  results: readonly ResolvableRecordCiteResult[],
  model: PreparedChatModel,
  claim: string,
  signal: AbortSignal,
  language: Language,
  allResults: readonly ResolvableRecordCiteResult[] = results,
): Promise<{ recordCites: RecordCiteResult[]; failure?: ProviderError }> {
  const recordCites: RecordCiteResult[] = [];
  let failure: ProviderError | undefined;
  const facts = comparableSentence(recordClaimFacts(claim, allResults));
  for (const result of results) {
    if (result.outcome !== "found") {
      recordCites.push(withoutCandidates(result));
      continue;
    }
    if (!result.passage) {
      recordCites.push(withoutCandidates({ ...result, outcome: "not-found" }));
      continue;
    }
    const judgement = await judgeRecordCite(model, facts, result.passage, signal, language);
    if ("failed" in judgement) {
      failure ??= judgement.failed;
      recordCites.push(
        withoutCandidates({
          ...result,
          outcome: "not-checked",
          nearby: undefined,
          ...failureOf(judgement.failed),
        }),
      );
      continue;
    }
    if (judgement.outcome !== "unsupported") {
      recordCites.push(withoutCandidates({ ...result, ...judgement, nearby: undefined }));
      continue;
    }

    const candidates = result.nearbyCandidates ?? (result.nearby ? [result.nearby] : []);
    let nearby: RecordCiteResult["nearby"];
    for (const candidate of candidates) {
      const alternative = await judgeRecordCite(model, facts, candidate.passage, signal, language);
      if ("failed" in alternative) continue;
      if (alternative.outcome !== "unsupported") {
        nearby = candidate;
        break;
      }
    }
    recordCites.push(withoutCandidates({ ...result, ...judgement, nearby }));
  }
  return { recordCites, ...(failure ? { failure } : {}) };
}

export function recordCiteVersions(results: readonly RecordCiteResult[]): CheckedVersion[] {
  const versions = new Map<string, CheckedVersion>();
  for (const result of results) {
    if (!result.documentId || !result.contentHash) continue;
    versions.set(result.documentId, {
      documentId: result.documentId,
      contentHash: result.contentHash,
    });
  }
  return [...versions.values()];
}

async function compare(
  model: PreparedChatModel,
  claim: string,
  passage: string,
  instructions: string,
  signal: AbortSignal,
): Promise<{ reply: string } | { failed: ProviderError }> {
  try {
    const { text } = await generateText({
      model: model.model,
      instructions,
      prompt: confirmPrompt({ claim, quote: passage, passage }),
      temperature: answerTemperature(model.capabilities.facts.temperature),
      maxOutputTokens: 300,
      maxRetries: 1,
      abortSignal: signal,
    });
    return { reply: text };
  } catch (error) {
    return { failed: classifyProviderError(error) };
  }
}
