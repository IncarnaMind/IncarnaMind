import { generateText } from "ai";
import type { CheckedVersion, ProviderError, RecordCiteResult } from "../../api";
import type { Language } from "../../language";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import { answerTemperature } from "../engine";
import {
  CONFIRM_INSTRUCTIONS,
  confirmPrompt,
  partInstructions,
  readJudgement,
  readPart,
} from "./prompt";

export interface RecordCiteJudgement {
  outcome: "supported" | "partly" | "not-found";
  covered?: string;
  uncovered?: string;
}

export async function judgeRecordCite(
  model: PreparedChatModel,
  claim: string,
  passage: string,
  signal: AbortSignal,
  language: Language,
): Promise<RecordCiteJudgement | { failed: ProviderError }> {
  const first = await compare(model, claim, passage, CONFIRM_INSTRUCTIONS, signal);
  if ("failed" in first) return first;
  const judged = readJudgement(first.reply);
  if (judged === "same") return { outcome: "supported" };
  if (judged === null)
    return { failed: { kind: "unknown", message: "The check gave no verdict." } };
  const part = await compare(model, claim, passage, partInstructions(language), signal);
  if ("failed" in part) return part;
  const { covered, uncovered } = readPart(part.reply);
  return covered && uncovered
    ? { outcome: "partly", covered, uncovered }
    : { outcome: "not-found" };
}

export async function judgeResolvedRecordCites(
  results: readonly RecordCiteResult[],
  model: PreparedChatModel,
  claim: string,
  signal: AbortSignal,
  language: Language,
): Promise<{ recordCites: RecordCiteResult[] } | { failed: ProviderError }> {
  const recordCites: RecordCiteResult[] = [];
  for (const result of results) {
    if (result.outcome !== "supported") {
      recordCites.push(result);
      continue;
    }
    if (!result.passage) {
      recordCites.push({ ...result, outcome: "not-found" });
      continue;
    }
    const judgement = await judgeRecordCite(model, claim, result.passage, signal, language);
    if ("failed" in judgement) return judgement;
    const judged = { ...result, ...judgement };
    if (judgement.outcome !== "not-found") delete judged.nearby;
    if (judgement.outcome === "not-found" && result.nearby) {
      const nearby = await judgeRecordCite(model, claim, result.nearby.passage, signal, language);
      if ("failed" in nearby) return nearby;
      if (nearby.outcome === "not-found") delete judged.nearby;
    }
    recordCites.push(judged);
  }
  return { recordCites };
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
