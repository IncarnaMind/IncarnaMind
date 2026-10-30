/**
 * Which sentences make claims, for Verify (#97) and Check this Mind (#737):
 * the model is shown them numbered, in batches, and decides each. The
 * sentences stay exactly as they are, so each claim is a sentence of the Mind.
 */
import { generateText } from "ai";
import type { ClaimPartPlan, ProviderError } from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { classifyProviderError } from "../../providers/providerErrors";
import { slots } from "../../runs/stop";
import { answerTemperature } from "../engine";
import {
  CLAIM_BATCH,
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
  readClaimParts,
} from "./claims";
import { claimsAtOnce } from "./runChecks";

export type ClaimsFound =
  | {
      kind: "found";
      /** The indexes, in `texts`, of the sentences that make claims. */
      claims: ReadonlySet<number>;
      parts: ReadonlyMap<number, readonly ClaimPartPlan[]>;
      /** The indexes of those no reply decided, asked about twice (#1682): neither claims nor left out. */
      undecided: ReadonlySet<number>;
    }
  | { kind: "failed"; error: ProviderError }
  | { kind: "cancelled" };

type Asked =
  | { kind: "read"; parts: Map<number, readonly ClaimPartPlan[]> }
  | { kind: "unread" }
  | Exclude<ClaimsFound, { kind: "found" }>;

/** Names the claims among `texts`: someone else's document's, or the User's own draft's, which leaves out their opinions. */
export async function claimsAmong(
  prepared: PreparedChatModel,
  texts: readonly string[],
  whose: "someone-else" | "own",
  signal: AbortSignal,
): Promise<ClaimsFound> {
  // A sort's reply repeats each part's words, so a batch takes as long as its words: batches go
  // at once, within the provider's limit, and the first that fails ends the rest.
  const ended = new AbortController();
  const sorting = AbortSignal.any([signal, ended.signal]);
  const ask = async (
    batch: readonly { number: number; text: string }[],
    tries: number,
  ): Promise<Asked> => {
    let previousReply: string | undefined;
    for (let tried = 0; tried < tries; tried++) {
      try {
        const { text } = await generateText({
          model: prepared.model,
          instructions: whose === "own" ? FIND_OWN_CLAIMS_INSTRUCTIONS : FIND_CLAIMS_INSTRUCTIONS,
          prompt: findClaimsPrompt(batch, previousReply),
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
          maxOutputTokens: 4_000,
          maxRetries: 1,
          abortSignal: sorting,
        });
        const parts = readClaimParts(text, batch);
        if (parts) return { kind: "read", parts };
        previousReply = text;
      } catch (error) {
        if (sorting.aborted) return { kind: "cancelled" };
        return { kind: "failed", error: classifyProviderError(error) };
      }
    }
    return { kind: "unread" };
  };

  type Sorted =
    | { kind: "read"; inventories: Map<number, readonly ClaimPartPlan[]> }
    | Exclude<ClaimsFound, { kind: "found" }>;
  const sortBatch = async (batch: readonly { number: number; text: string }[]): Promise<Sorted> => {
    // A reply that can't be read is asked for once more.
    const first = await ask(batch, 2);
    if (first.kind === "unread") {
      return {
        kind: "failed",
        error: {
          kind: "no-answer",
          message: "The model's reply did not describe readable original sentence parts.",
        },
      };
    }
    if (first.kind !== "read") return first;
    const inventories = first.parts;
    // A sentence the reply says nothing of was never decided, so it isn't one that makes no claim.
    const unanswered = batch.filter((each) => !inventories.has(each.number));
    if (unanswered.length > 0) {
      const again = await ask(unanswered, 1);
      if (again.kind === "cancelled" || again.kind === "failed") return again;
      if (again.kind === "read") {
        for (const { number } of unanswered) {
          const inventory = again.parts.get(number);
          if (inventory !== undefined) inventories.set(number, inventory);
        }
      }
    }
    return { kind: "read", inventories };
  };

  const batches: { number: number; text: string }[][] = [];
  for (let start = 0; start < texts.length; start += CLAIM_BATCH) {
    batches.push(
      texts
        .slice(start, start + CLAIM_BATCH)
        .map((text, index) => ({ number: start + index + 1, text })),
    );
  }
  const limit = slots(claimsAtOnce(prepared));
  const sorted = await Promise.all(
    batches.map((batch) =>
      limit.run(async () => {
        if (sorting.aborted) return { kind: "cancelled" } as const;
        const outcome = await sortBatch(batch);
        if (outcome.kind === "failed") ended.abort();
        return outcome;
      }),
    ),
  );
  if (signal.aborted) return { kind: "cancelled" };
  const failure = sorted.find((outcome) => outcome.kind === "failed");
  if (failure) return failure;

  const claims = new Set<number>();
  const parts = new Map<number, readonly ClaimPartPlan[]>();
  const undecided = new Set<number>();
  for (const [at, batch] of batches.entries()) {
    const outcome = sorted[at];
    if (outcome?.kind !== "read") return { kind: "cancelled" };
    for (const { number } of batch) {
      const inventory = outcome.inventories.get(number);
      if (inventory === undefined) undecided.add(number - 1);
      else {
        parts.set(number - 1, inventory);
        if (inventory.some((part) => part.kind === "fact")) claims.add(number - 1);
      }
    }
  }
  return signal.aborted ? { kind: "cancelled" } : { kind: "found", claims, parts, undecided };
}
