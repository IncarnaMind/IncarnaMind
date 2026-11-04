/**
 * The written check's fast paths (#1667, ../../answers/checks/fastPaths), beside the catalog
 * entry as the faster Answer paths are (./answerPaths). The copy test uses no model and runs for
 * every model. The quick-tasks model's first look runs only under an Answers model listed here,
 * with the quick model it was measured with, once the pair passes the quality gate on paired runs
 * against today's check (eval/speed/README.md › The written set); it is taken off the same way if
 * it regresses. An Answers model not listed checks every sentence as before.
 */
import { withoutDateSuffix } from ".";
import type { ListedModel } from "./answerPaths";

interface Admitted {
  /** The Answers model, "<catalog provider>/<model id>". */
  model: string;
  /** The quick-tasks model it was measured with, the same way. */
  quick: string;
  /** The day it was admitted, ISO 8601. */
  since: string;
  gate: string;
}

const QUICK_FIRST_LOOK: readonly Admitted[] = [];

/** What tests and the evaluation decide instead of the list; undefined: the list's. */
export interface CheckPathsOverride {
  copies?(): boolean | undefined;
  quickFirstLook?(answers: ListedModel, quick: ListedModel): boolean | undefined;
}

const named = ({ catalogId, modelId }: ListedModel) =>
  catalogId === null ? null : `${catalogId}/${withoutDateSuffix(modelId)}`;

/** Whether a sentence its Citation states word for word is Supported with no model. */
export const checksCopies = (override?: CheckPathsOverride): boolean =>
  override?.copies?.() ?? true;

/** Whether `quick` looks first at the sentences written under `answers`. */
export function quickLooksFirst(
  answers: ListedModel,
  quick: ListedModel,
  override?: CheckPathsOverride,
): boolean {
  const chosen = override?.quickFirstLook?.(answers, quick);
  if (chosen !== undefined) return chosen;
  const model = named(answers);
  const first = named(quick);
  return QUICK_FIRST_LOOK.some((each) => each.model === model && each.quick === first);
}
