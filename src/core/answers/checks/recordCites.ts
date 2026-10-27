import { generateText } from "ai";
import type { ProviderError } from "../../api";
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
  raw: string,
  passage: string,
  signal: AbortSignal,
  language: Language,
): Promise<RecordCiteJudgement | { failed: ProviderError }> {
  const first = await compare(model, claim, raw, passage, CONFIRM_INSTRUCTIONS, signal);
  if ("failed" in first) return first;
  const judged = readJudgement(first.reply);
  if (judged === "same") return { outcome: "supported" };
  if (judged === null)
    return { failed: { kind: "malformed", message: "The check gave no verdict." } };
  const part = await compare(model, claim, raw, passage, partInstructions(language), signal);
  if ("failed" in part) return part;
  const { covered, uncovered } = readPart(part.reply);
  return covered && uncovered
    ? { outcome: "partly", covered, uncovered }
    : { outcome: "not-found" };
}

async function compare(
  model: PreparedChatModel,
  claim: string,
  raw: string,
  passage: string,
  instructions: string,
  signal: AbortSignal,
): Promise<{ reply: string } | { failed: ProviderError }> {
  try {
    const { text } = await generateText({
      model: model.model,
      instructions,
      prompt: confirmPrompt({ claim, quote: raw, passage }),
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
