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
 * Writes the Answer, then gives its records in one `cite` call in the same reply (#489). Claude
 * Sonnet 5.5 was measured and left out (2026-10-26): it still gave its records first, drafting
 * the Answer in its thinking, and came out slower (+1.2 s, 3.25 → 3.34 calls) with fewer
 * expected Passages cited on the gating set (62 → 59).
 */
const WRITES_THEN_CITES: readonly Admitted[] = [
  {
    model: "anthropic/claude-haiku-5-5",
    since: "2026-10-26",
    flows: ["question"],
    gate: "Against citing first, paired, within one item in 30: gating 65 on this code (load median 6), 2.89 → 2.20 calls, done −0.4 s, cited 61 → 61, judged right 61 → 59, every Citation found 63 → 62; on its earlier endings, gating 65 three times, cited 183 → 184, right 184 → 182, found 188 → 190; on earlier wordings, hard tier 225, cited 150 → 155, right 207 → 209, and everyday 39; no new duplicate, false Supported, unmade change or tool text.",
  },
];

/**
 * Searches the Question before the first call, and again in each Document a word of it names when
 * that search reached none of them, then answers from those Passages, citing as WRITES_THEN_CITES
 * has the model, falling back to the Tool loop when it needs more (#1633, an amendment to
 * ADR-0007). Admitted on paired runs against eval/speed/gates/retrieve-first.md.
 * - Claude Haiku 5.5 came off on 2026-11-04: answered in one call from the Question's own
 *   search, judged right fell from 60 to 57 of 65 on the gating set, with 2 allowed. It is back
 *   since the second search, measured on the same gate with held-out Questions written first.
 * - Claude Sonnet 5.5, citing first, was 1.4 s sooner on the gating set, but every Citation found
 *   fell from 63 to 59 of 65, mostly on quoted words the quote check misreads on both paths
 *   (#2504). It is measured again once those are fixed.
 */
const RETRIEVES_FIRST: readonly Admitted[] = [
  {
    model: "anthropic/claude-haiku-5-5",
    since: "2026-11-07",
    flows: ["question"],
    gate: "With the second search, against the loop, paired, one run of each set, within one item in 30: gating 65, done −1.2 s, 2.88 → 1.83 calls, cited 63 → 64, judged right 60 → 60, every Citation found 63 → 63; held-out 30, cited 29 → 29, right 26 → 29, found 29 → 29; hard tier 224, done −0.5 s, cited 152 → 160, right 206 → 214, found 209 → 213; no false Supported, duplicate, unmade change or tool text.",
  },
];

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
