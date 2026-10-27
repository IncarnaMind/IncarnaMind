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

/** A model as an Answer runs it. */
export interface ListedModel {
  catalogId: string | null;
  modelId: string;
}

/** What tests and the evaluation decide instead of the lists; undefined: the list's. */
export interface AnswerPathsOverride {
  writesThenCites?(model: ListedModel): boolean | undefined;
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
