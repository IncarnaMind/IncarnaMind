/**
 * The checks' faster paths, beside the catalog entry as the faster Answer paths are
 * (./answerPaths). Each runs only on a model listed here, once it passes the quality gate on paired
 * runs against today's check, and is taken off the same way if it regresses; a model not listed
 * checks every sentence as before. The written check's quick first look (#1667,
 * ../../answers/checks/fastPaths) is listed by its Answers model with the quick model it was
 * measured with (eval/speed/README.md › The written set).
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

// None yet: Claude Haiku 5.5 looking first under Claude Sonnet 5.5 read a Chinese "may" for the
// terms' "must" as stated, a false Supported Sonnet's check didn't give, and saved 6% of the time
// per sentence on the held-out sets (#1667).
const QUICK_FIRST_LOOK: readonly Admitted[] = [];

/**
 * The search-first check (#2532, ../../answers/checks/firstReply): the app searches a sentence's
 * own words before the check's first request and hands its Passages over, and a sentence whose
 * parts are known is answered part by part in one reply, each part the reply can't settle going
 * on to the check's Run. A model is listed once it holds eval/evidence/2532-search-first's bars.
 */
const SEARCH_FIRST: readonly Omit<Admitted, "quick">[] = [];

/** What tests and the evaluation decide instead of the lists; undefined: the list's. */
export interface CheckPathsOverride {
  quickFirstLook?(answers: ListedModel, quick: ListedModel): boolean | undefined;
  searchFirst?(model: ListedModel): boolean | undefined;
  /** Hears how a first reply went for each part: its verdict, or why the part went on to its Run. */
  firstReplied?(heard: { sentence: string; part: string; outcome: string }): void;
}

const named = ({ catalogId, modelId }: ListedModel) =>
  catalogId === null ? null : `${catalogId}/${withoutDateSuffix(modelId)}`;

/** Whether a check on `model` searches first and answers a sentence's parts in one reply. */
export function searchesFirst(model: ListedModel, override?: CheckPathsOverride): boolean {
  const chosen = override?.searchFirst?.(model);
  if (chosen !== undefined) return chosen;
  const listed = named(model);
  return SEARCH_FIRST.some((each) => each.model === listed);
}

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
