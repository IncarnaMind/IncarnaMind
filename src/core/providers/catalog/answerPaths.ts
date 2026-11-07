/**
 * The faster Answer paths a model takes in the Tool loop, beside its catalog entry. A model is
 * listed only once it passes the quality gate on paired runs against the default path
 * (eval/speed/README.md › Paired runs), with the day, the flows it was measured on and the result
 * that admitted it, and is taken off the same way if it regresses. A model not listed, and a
 * listed one in any other flow, answers as before.
 */
import { withoutDateSuffix } from ".";

/** The flows an Answer runs in, as its timing records name them: "question" is one asked in a Mind or the assistant. */
export type AnswerFlow = "question" | "outside-agent" | "task-answer" | "check" | "call-help";

interface Admitted {
  /** "<catalog provider>/<model id>". */
  model: string;
  /** The day it was admitted, ISO 8601. */
  since: string;
  flows: readonly AnswerFlow[];
  gate: string;
}

/**
 * Writes the Answer, then gives its records in one `cite` call in the same reply (#489). No model
 * is listed. Claude Sonnet 5.5 was measured and left out (2026-10-26): it still gave its records
 * first, drafting the Answer in its thinking, and came out slower (+1.2 s, 3.25 → 3.34 calls) with
 * fewer expected Passages cited on the gating set (62 → 59). Claude Haiku 5.5, listed for
 * Questions from 2026-10-26, came off on 2026-11-07 (#2720): on two gating runs, read by hand, a
 * found Citation whose quote doesn't state its sentence was 33.9–40.4% writing first against
 * 25.4–30.7% citing first, and a quote about a different claim 12–13% against 6%.
 */
const WRITES_THEN_CITES: readonly Admitted[] = [];

/**
 * Searches the Question before the first call, and again in each Document a word of it names when
 * that search reached none of them, then answers from those Passages, citing as WRITES_THEN_CITES
 * has the model, falling back to the Tool loop when it needs more (#1633, an amendment to
 * ADR-0007). No model is listed (2026-11-07), on paired runs against
 * eval/speed/gates/retrieve-first.md:
 * - Claude Haiku 5.5 came off on 2026-11-04 (judged right fell from 60 to 57 of 65 on the gating
 *   set, with 2 allowed) and stays off with the second search. Measured with false Supported, it
 *   had one the loop didn't on the held-out set's second Question. Run whole, it was 1.1 s sooner
 *   on the gating set, but judged right fell from 62 to 57: five of the Answers that went partly
 *   came from the Question's own search alone, where the loop searched twice.
 * - DeepSeek V4.1 Flash 1017 (2026-11-07), with the second search, held the held-out set but not
 *   the gating set: expected Passages cited fell from 64 to 61 of 65, with 2 allowed, three of
 *   them on quoted words the quote check misreads (#2504).
 * - Claude Sonnet 5.5, citing first, was 1.4 s sooner on the gating set, but every Citation found
 *   fell from 63 to 59 of 65, mostly on quoted words the quote check misreads on both paths
 *   (#2504). It is measured again once those are fixed.
 */
const RETRIEVES_FIRST: readonly Admitted[] = [];

/** A model as an Answer runs it. */
export interface ListedModel {
  catalogId: string | null;
  modelId: string;
}

/** What tests and the evaluation decide instead of the lists; undefined: the list's. */
export interface AnswerPathsOverride {
  writesThenCites?(model: ListedModel): boolean | undefined;
  retrievesFirst?(model: ListedModel): boolean | undefined;
}

const listed = (
  admitted: readonly Admitted[],
  { catalogId, modelId }: ListedModel,
  flow: AnswerFlow,
) =>
  catalogId !== null &&
  admitted.some(
    (each) =>
      each.model === `${catalogId}/${withoutDateSuffix(modelId)}` && each.flows.includes(flow),
  );

export const writesThenCites = (
  model: ListedModel,
  flow: AnswerFlow,
  override?: AnswerPathsOverride,
): boolean => override?.writesThenCites?.(model) ?? listed(WRITES_THEN_CITES, model, flow);

export const retrievesFirst = (
  model: ListedModel,
  flow: AnswerFlow,
  override?: AnswerPathsOverride,
): boolean => override?.retrievesFirst?.(model) ?? listed(RETRIEVES_FIRST, model, flow);
