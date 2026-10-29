/**
 * Which sentences make claims, for Verify (#97) and Check this Mind (#737):
 * the model is shown them numbered, in batches, and decides each. The
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
  findClaimsPrompt,
  readClaimDecisions,
} from "./claims";

export type ClaimsFound =
  | {
      kind: "found";
      /** The indexes, in `texts`, of the sentences that make claims. */
      claims: ReadonlySet<number>;
      /** The indexes of those no reply decided, asked about twice (#1682): neither claims nor left out. */
      undecided: ReadonlySet<number>;
    }
  | { kind: "failed"; error: ProviderError }
  | { kind: "cancelled" };

type Asked =
  | { kind: "read"; decisions: Map<number, boolean> }
  | { kind: "unread" }
  | Exclude<ClaimsFound, { kind: "found" }>;

/** Names the claims among `texts`: someone else's document's, or the User's own draft's, which leaves out their opinions. */
export async function claimsAmong(
  prepared: PreparedChatModel,
  texts: readonly string[],
  whose: "someone-else" | "own",
  signal: AbortSignal,
): Promise<ClaimsFound> {
  const ask = async (
    batch: readonly { number: number; text: string }[],
    tries: number,
  ): Promise<Asked> => {
    for (let tried = 0; tried < tries; tried++) {
      try {
        const { text } = await generateText({
          model: prepared.model,
          instructions: whose === "own" ? FIND_OWN_CLAIMS_INSTRUCTIONS : FIND_CLAIMS_INSTRUCTIONS,
          prompt: findClaimsPrompt(batch),
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
          maxOutputTokens: 4_000,
          maxRetries: 1,
          abortSignal: signal,
        });
        const decisions = readClaimDecisions(
          text,
          batch.map((each) => each.number),
        );
        if (decisions) return { kind: "read", decisions };
      } catch (error) {
        if (signal.aborted) return { kind: "cancelled" };
        return { kind: "failed", error: classifyProviderError(error) };
      }
    }
    return { kind: "unread" };
  };

  const claims = new Set<number>();
  const undecided = new Set<number>();
  for (let start = 0; start < texts.length; start += CLAIM_BATCH) {
    const batch = texts
      .slice(start, start + CLAIM_BATCH)
      .map((text, index) => ({ number: start + index + 1, text }));
    // A reply that can't be read is asked for once more.
    const first = await ask(batch, 2);
    if (first.kind === "unread") {
      return {
        kind: "failed",
        error: { kind: "no-answer", message: "The model's reply named no sentences." },
      };
    }
    if (first.kind !== "read") return first;
    const { decisions } = first;
    // A sentence the reply says nothing of was never decided, so it isn't one that makes no claim.
    const unanswered = batch.filter((each) => !decisions.has(each.number));
    if (unanswered.length > 0) {
      const again = await ask(unanswered, 1);
      if (again.kind === "cancelled" || again.kind === "failed") return again;
      if (again.kind === "read") {
        for (const { number } of unanswered) {
          const decision = again.decisions.get(number);
          if (decision !== undefined) decisions.set(number, decision);
        }
      }
    }
    for (const { number } of batch) {
      const decision = decisions.get(number);
      if (decision === undefined) undecided.add(number - 1);
      else if (decision) claims.add(number - 1);
    }
  }
  return signal.aborted ? { kind: "cancelled" } : { kind: "found", claims, undecided };
}
