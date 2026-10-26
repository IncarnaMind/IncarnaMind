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
    gate: "Against citing first: gating 65, 2.98 → 2.29 calls, done −0.6 s, cited 56 → 56, judged right 59 → 59, every Citation found 58 → 61; hard tier 225, cited 150 → 155, right 207 → 209; hard 30 twice and everyday 30 within one in 30; no new duplicate, false Supported or unmade change.",
  },
];

/**
 * Searches the Question before the first call and answers from those Passages in one call,
 * falling back to the Tool loop when it needs more (#1633, an amendment to ADR-0007). Empty
 * until a model passes the gate against the Tool loop.
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

const listed = (admitted: readonly Admitted[], { catalogId, modelId }: ListedModel) =>
  catalogId !== null &&
  admitted.some((each) => each.model === `${catalogId}/${withoutDateSuffix(modelId)}`);

export const writesThenCites = (model: ListedModel, override?: AnswerPathsOverride): boolean =>
  override?.writesThenCites?.(model) ?? listed(WRITES_THEN_CITES, model);

export const retrievesFirst = (model: ListedModel, override?: AnswerPathsOverride): boolean =>
  override?.retrievesFirst?.(model) ?? listed(RETRIEVES_FIRST, model);
