/**
 * Which sentences make claims, for Verify (#97) and Check this Mind (#737):
 * the model is shown them numbered, in batches, and decides each. The
 * sentences stay exactly as they are, so each claim is a sentence of the Mind.
 */
import type { ClaimPartPlan, ProviderError } from "../../api";
import type { PreparedChatModel } from "../../providers/chat";
import { type Slots, slots } from "../../runs/stop";
import { answerTemperature } from "../engine";
import { json, judge } from "../judge";
import {
  CLAIM_BATCH,
  FIND_CLAIMS_INSTRUCTIONS,
  FIND_OWN_CLAIMS_INSTRUCTIONS,
  findClaimsPrompt,
  type SortedText,
  type SortWord,
  sortedWhole,
  sortWordsOf,
  sortWordsReader,
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
      /**
       * The indexes of those whose batch got no reply that could be read, asked twice (#3506), among
       * `undecided`: a file's check shows them not checked, where a Note's checks them anyway.
       */
      unsorted: ReadonlySet<number>;
    }
  | { kind: "failed"; error: ProviderError }
  | { kind: "cancelled" };

type Asked =
  | { kind: "read"; words: Map<number, SortWord> }
  | { kind: "unread"; why: string }
  | Exclude<ClaimsFound, { kind: "found" }>;

/** How a sort is run with the checks of its sentences. */
export interface SortAlong {
  /** The limit on model requests at once that the sort shares with its sentences' checks. */
  slots?: Slots;
  /** A deck's slides as the file holds them, by number, which its sentences name (#3455). */
  slides?: Readonly<Record<string, string>>;
  /** A workbook's sheets as the file holds them, by page number, which its rows name (#3506). */
  sheets?: Readonly<Record<string, string>>;
  /**
   * Hears each sentence's parts, by its index in `texts`, as soon as the reply names them, for its
   * check to start before the reply ends; the result, read from the whole reply, still decides.
   */
  named?(index: number, parts: readonly ClaimPartPlan[]): void;
}

/**
 * Names the claims among `texts`: someone else's document's, or the User's own draft's, which
 * leaves out words about the draft itself. Each sentence is sorted whole.
 */
export async function claimsAmong(
  prepared: PreparedChatModel,
  texts: readonly SortedText[],
  whose: "someone-else" | "own",
  signal: AbortSignal,
  along: SortAlong = {},
): Promise<ClaimsFound> {
  // Batches go at once, within the provider's limit, and the first that fails ends the rest.
  const ended = new AbortController();
  const sorting = AbortSignal.any([signal, ended.signal]);
  type Batch = readonly ({ number: number } & SortedText)[];
  const instructions =
    whose === "someone-else" ? FIND_CLAIMS_INSTRUCTIONS : FIND_OWN_CLAIMS_INSTRUCTIONS;
  const partsOf = (number: number, word: SortWord) =>
    sortedWhole(texts[number - 1]?.text ?? "", word);
  const ask = async (batch: Batch, tries: number): Promise<Asked> => {
    const numbers = batch.map((each) => each.number);
    let why = "no reply";
    for (let tried = 0; tried < tries; tried++) {
      const { named } = along;
      const early = named ? sortWordsReader(numbers) : null;
      let gave = "";
      const judged = await judge({
        model: prepared.model,
        question: { id: "find-claims", instructions },
        parts: [{ text: findClaimsPrompt(batch, along.slides, along.sheets) }],
        data: [],
        reply: json((value) => sortWordsOf(value, numbers)),
        retries: 1,
        signal: sorting,
        temperature: answerTemperature(prepared.capabilities.facts.temperature),
        onUnread: (reply: string) => {
          gave = reply.trim().slice(0, 300);
        },
        ...(named &&
          early && {
            onPartial: (delta: string) => {
              for (const { number, word } of early(delta)) named(number - 1, partsOf(number, word));
            },
          }),
      });
      if (judged.ok) return { kind: "read", words: judged.value };
      if (judged.reason === "stopped") return { kind: "cancelled" };
      if (judged.error) return { kind: "failed", error: judged.error };
      why = `${judged.reason}: ${JSON.stringify(gave)}`;
    }
    return { kind: "unread", why };
  };

  type Sorted =
    | { kind: "read"; words: Map<number, SortWord> }
    | { kind: "unsorted" }
    | Exclude<ClaimsFound, { kind: "found" }>;
  const sortBatch = async (batch: Batch): Promise<Sorted> => {
    // A reply that can't be read is asked for once more; then its sentences are left unsorted, never
    // the whole check lost for one batch (#3506), and what the model gave is logged.
    const first = await ask(batch, 2);
    if (first.kind === "unread") {
      console.warn(
        `The model's reply to the sort of sentences ${batch[0]?.number} to ${batch.at(-1)?.number} couldn't be read, twice (${first.why}), so they are left not sorted.`,
      );
      return { kind: "unsorted" };
    }
    if (first.kind !== "read") return first;
    const words = first.words;
    // A sentence the reply says nothing of was never decided, so it isn't one that makes no claim.
    const unanswered = batch.filter((each) => !words.has(each.number));
    if (unanswered.length > 0) {
      const second = await ask(unanswered, 1);
      if (second.kind === "cancelled" || second.kind === "failed") return second;
      if (second.kind === "read")
        for (const [number, word] of second.words) words.set(number, word);
    }
    return { kind: "read", words };
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
  const unsorted = new Set<number>();
  for (const [at, batch] of batches.entries()) {
    const outcome = sorted[at];
    if (outcome?.kind === "unsorted") {
      for (const { number } of batch) {
        undecided.add(number - 1);
        unsorted.add(number - 1);
      }
      continue;
    }
    if (outcome?.kind !== "read") return { kind: "cancelled" };
    for (const { number } of batch) {
      const word = outcome.words.get(number);
      if (word === undefined) undecided.add(number - 1);
      else {
        parts.set(number - 1, partsOf(number, word));
        if (word === "claim") claims.add(number - 1);
      }
    }
  }
  return signal.aborted
    ? { kind: "cancelled" }
    : { kind: "found", claims, parts, undecided, unsorted };
}
