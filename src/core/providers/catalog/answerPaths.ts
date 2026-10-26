/**
 * The faster Answer paths a model takes in the Tool loop, beside its catalog entry. A model is
 * listed only once it passes the quality gate on paired runs against the default path
 * (eval/speed/README.md › Paired runs), with the day and the result that admitted it, and is
 * taken off the same way if it regresses. A model not listed answers as before.
 */
import { withoutDateSuffix } from ".";

interface Admitted {
  /** "<catalog provider>/<model id>". */
  model: string;
  /** The day it was admitted, ISO 8601. */
  since: string;
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
    gate: "Against citing first, paired, within one item in 30: gating 65, 3.09 → 2.25 calls, done −0.8 s, cited 56 → 57, judged right 61 → 59, every Citation found 60 → 64; hard tier 225, cited 150 → 155, right 207 → 209; hard 30, done −1.6 s, right 28 → 27; everyday 39; no new duplicate, false Supported or unmade change.",
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

const listed = (admitted: readonly Admitted[], { catalogId, modelId }: ListedModel) =>
  catalogId !== null &&
  admitted.some((each) => each.model === `${catalogId}/${withoutDateSuffix(modelId)}`);

export const writesThenCites = (model: ListedModel, override?: AnswerPathsOverride): boolean =>
  override?.writesThenCites?.(model) ?? listed(WRITES_THEN_CITES, model);
