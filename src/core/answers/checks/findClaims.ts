/**
 * Which sentences make claims, for Verify (#97) and Check this Mind (#737):
 * the model is shown them numbered, in batches, and decides each. The
 * sentences stay exactly as they are, so each claim is a sentence of the Mind.
 */
import { generateText, streamText, type TextStreamPart, type ToolSet } from "ai";
import type { ClaimPartPlan, ProviderError } from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { outputTokens } from "../../providers/outputLimits";
import { classifyProviderError } from "../../providers/providerErrors";
import { type Slots, slots } from "../../runs/stop";
import { answerTemperature } from "../engine";
import {
  CLAIM_BATCH,
  claimPartsReader,
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  FIND_OWN_LIBRARY_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
  readClaimParts,
  type SortedText,
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

/** How a sort is run with the checks of its sentences. */
export interface SortAlong {
  /** The limit on model requests at once that the sort shares with its sentences' checks. */
  slots?: Slots;
  /**
   * Hears each sentence's parts, by its index in `texts`, as soon as the reply names them, for its
   * check to start before the reply ends; the result, read from the whole reply, still decides.
   */
  named?(index: number, parts: readonly ClaimPartPlan[]): void;
}

/** A sorting reply, streamed: `named` hears each sentence's parts as its record closes. */
async function streamedReply(
  parts: AsyncIterable<TextStreamPart<ToolSet>>,
  sentences: readonly { number: number; text: string }[],
  named: (number: number, parts: readonly ClaimPartPlan[]) => void,
  signal: AbortSignal,
): Promise<string> {
  const read = claimPartsReader(sentences);
  let text = "";
  for await (const part of parts) {
    if (part.type === "text-delta") {
      text += part.text;
      for (const record of read(part.text)) named(record.number, record.parts);
    } else if (part.type === "error") throw part.error;
  }
  signal.throwIfAborted();
  return text;
}

/** Names the claims among `texts`: someone else's document's, or the User's own draft's, which leaves out their opinions. */
export async function claimsAmong(
  prepared: PreparedChatModel,
  texts: readonly SortedText[],
  whose: "someone-else" | "own",
  signal: AbortSignal,
  /** Its sentences' checks may show the Library's facts, so it sorts as those checks do (#2525). */
  library = false,
  along: SortAlong = {},
): Promise<ClaimsFound> {
  // A sort's reply repeats each part's words, so a batch takes as long as its words: batches go
  // at once, within the provider's limit, and the first that fails ends the rest.
  const ended = new AbortController();
  const sorting = AbortSignal.any([signal, ended.signal]);
  type Batch = readonly ({ number: number } & SortedText)[];
  const ask = async (batch: Batch, tries: number): Promise<Asked> => {
    for (let tried = 0; tried < tries; tried++) {
      try {
        const asked = {
          model: prepared.model,
          instructions:
            whose === "someone-else"
              ? FIND_CLAIMS_INSTRUCTIONS
              : library
                ? FIND_OWN_LIBRARY_CLAIMS_INSTRUCTIONS
                : FIND_OWN_CLAIMS_INSTRUCTIONS,
          prompt: findClaimsPrompt(batch),
          temperature: answerTemperature(prepared.capabilities.facts.temperature),
          maxRetries: 1,
          abortSignal: sorting,
        };
        const named = along.named;
        const text = named
          ? await streamedReply(
              streamText({
                ...asked,
                maxOutputTokens: outputTokens("find-claims"),
                onError: () => undefined,
              }).fullStream,
              batch,
              (number, parts) => named(number - 1, parts),
              sorting,
            )
          : (await generateText({ ...asked, maxOutputTokens: outputTokens("find-claims") })).text;
        const parts = readClaimParts(text, batch);
        if (parts) return { kind: "read", parts };
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
  const sortBatch = async (batch: Batch): Promise<Sorted> => {
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

  const batches: Batch[] = [];
  for (let start = 0; start < texts.length; start += CLAIM_BATCH) {
    batches.push(
      texts
        .slice(start, start + CLAIM_BATCH)
        .map((sentence, index) => ({ number: start + index + 1, ...sentence })),
    );
  }
  const limit = along.slots ?? slots(claimsAtOnce(prepared));
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
