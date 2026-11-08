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
 * Searches the Question before the first call and answers from those Passages, citing as
 * WRITES_THEN_CITES has the model, falling back to the Tool loop when it needs more (#1633, an
 * amendment to ADR-0007). No model is listed (2026-11-04), on paired runs against
 * eval/speed/gates/retrieve-first.md:
 * - Claude Haiku 5.5, listed from 2026-10-26, came off. On the gating set it finished 1.0 s
 *   sooner, with 1.15 calls instead of 2.05, but judged right fell from 60 to 57 of 65, with 2
 *   allowed. Answers made in one call from the Question's own words were partial: en-12, en-16,
 *   en-17, en-19 and zh-01 went from right to partly, and xl-10 and para-en-01 went to wrong.
 *   On the whole hard tier it held (right 210 → 209 of 224, 7 allowed).
 * - Claude Sonnet 5.5, citing first, was 1.4 s sooner on the gating set, but every Citation found
 *   fell from 63 to 59 of 65, mostly on quoted words the quote check misreads on both paths
 *   (#2504).
 * A model comes back only through the same gate, with a second search made where the first
 * Passages don't cover every part of the Question.
 */
const RETRIEVES_FIRST: readonly Admitted[] = [];

/**
 * Call help offered no `cite`: each marker carries the number of the Passage it rests on ("[^3]"
 * for P3), and IncarnaMind picks its quote (src/core/answers/markedPassages.ts), so a model that
 * thinks after each Tool's result (Claude Sonnet 5.5 on a direct key) writes the reply in one call
 * (#2526). A model joins only on paired runs against eval/speed/gates/call-help-marks-passages.md.
 * Left out (2026-11-07), each holding every quality line on the fresh slice: Claude Haiku 5.5,
 * whose first English option came 0.10 s later (0.79 → 0.89 s), and DeepSeek V4.1 Flash 1017,
 * whose first Chinese option came 0.09 s later (1.12 → 1.21 s). Sonnet 5.5 is off until the
 * gate's third look holds, its picker having changed since it was listed.
 */
const MARKS_PASSAGES: readonly Admitted[] = [];

/** A model as an Answer runs it. */
export interface ListedModel {
  catalogId: string | null;
  modelId: string;
}

/** What tests and the evaluation decide instead of the lists; undefined: the list's. */
export interface AnswerPathsOverride {
  writesThenCites?(model: ListedModel): boolean | undefined;
  retrievesFirst?(model: ListedModel): boolean | undefined;
  marksPassages?(model: ListedModel): boolean | undefined;
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

export const marksPassages = (
  model: ListedModel,
  flow: AnswerFlow,
  override?: AnswerPathsOverride,
): boolean => override?.marksPassages?.(model) ?? listed(MARKS_PASSAGES, model, flow);
