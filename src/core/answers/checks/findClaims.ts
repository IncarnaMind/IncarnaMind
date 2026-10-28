/**
 * Which sentences make claims, for Verify (#97) and Check this Mind (#737):
 * the model is shown them numbered, in batches, and names those that do. The
 * sentences stay exactly as they are, so each claim is a sentence of the Mind.
 */
import { generateText } from "ai";
import type { ProviderError } from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import { answerTemperature } from "../engine";
import {
  CLAIM_BATCH,
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  FIND_UNCITED_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
  readClaimNumbers,
} from "./claims";

export type ClaimsFound =
  /** The indexes, in `texts`, of the sentences that make claims. */
  | { kind: "found"; claims: ReadonlySet<number> }
  | { kind: "failed"; error: ProviderError }
  | { kind: "cancelled" };

/** Names the claims among `texts`: someone else's document's, or the User's own draft's, which leaves out their opinions. */
export async function claimsAmong(
  prepared: PreparedChatModel,
  texts: readonly string[],
  whose: "someone-else" | "own" | "uncited",
  signal: AbortSignal,
): Promise<ClaimsFound> {
  const claims = new Set<number>();
  for (let start = 0; start < texts.length; start += CLAIM_BATCH) {
    const batch = texts
      .slice(start, start + CLAIM_BATCH)
      .map((text, index) => ({ number: start + index + 1, text }));
    let numbers: number[] | null = null;
    // A reply that names nothing readable is asked for once more.
    for (let tries = 0; tries < 2 && numbers === null; tries++) {
      try {
        const { text } = await generateText({
          model: prepared.model,
          instructions:
            whose === "own"
              ? FIND_OWN_CLAIMS_INSTRUCTIONS
              : whose === "uncited"
                ? FIND_UNCITED_CLAIMS_INSTRUCTIONS
                : FIND_CLAIMS_INSTRUCTIONS,
          prompt: findClaimsPrompt(batch),
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
          maxOutputTokens: 4_000,
          maxRetries: 1,
          abortSignal: signal,
        });
        numbers = readClaimNumbers(text);
      } catch (error) {
        if (signal.aborted) return { kind: "cancelled" };
        return { kind: "failed", error: classifyProviderError(error) };
      }
    }
    if (numbers === null) {
      return {
        kind: "failed",
        error: { kind: "no-answer", message: "The model's reply named no sentences." },
      };
    }
    for (const number of numbers) {
      if (number > start && number <= start + batch.length) claims.add(number - 1);
    }
  }
  return signal.aborted ? { kind: "cancelled" } : { kind: "found", claims };
}
