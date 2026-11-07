/**
 * The written check's quick first look (#1667, ../../answers/checks/fastPaths), beside the catalog
 * entry as the faster Answer paths are (./answerPaths). It runs only under an Answers model listed
 * here, with the quick model it was measured with, once the pair passes the quality gate on paired
 * runs against today's check (eval/speed/README.md › The written set); it is taken off the same
 * way if it regresses. An Answers model not listed checks every sentence as before.
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
 * Models that write a check's verdict in the same reply as the `cite` call recording its quote,
 * one request fewer per sentence (#2532). A model joins only once it holds
 * eval/speed/gates/verdict-beside-cite.md on paired runs against today's check, and leaves the
 * same way. A model not listed records its quote, then writes its verdict once `cite` returns.
 */
// Not Claude Haiku 5.5 or Sonnet 5.5: on the held-out set each Supported a sentence that drops
// the terms' condition, which today's check didn't (#2532).
const VERDICT_BESIDE_CITE: readonly { model: string; since: string; gate: string }[] = [
  {
    model: "deepseek/deepseek-flash",
    since: "2026-11-07",
    gate: "Against today's check, paired, the third held-out set twice (52 items): 4.81 → 3.96 calls, done 5.8 → 4.5 s, sooner in 44 of 52, judged right 44 → 44, every Citation found 52 → 52, false Supported 8 → 6 with none new, other guards 8 → 8, none failed.",
  },
];

/** What tests and the evaluation decide instead of the lists; undefined: the list's. */
export interface CheckPathsOverride {
  quickFirstLook?(answers: ListedModel, quick: ListedModel): boolean | undefined;
  verdictBesideCite?(model: ListedModel): boolean | undefined;
}

const named = ({ catalogId, modelId }: ListedModel) =>
  catalogId === null ? null : `${catalogId}/${withoutDateSuffix(modelId)}`;

/** Whether a check on `model` asks for its verdict beside `cite`. */
export function verdictBesideCite(model: ListedModel, override?: CheckPathsOverride): boolean {
  const chosen = override?.verdictBesideCite?.(model);
  if (chosen !== undefined) return chosen;
  const name = named(model);
  return VERDICT_BESIDE_CITE.some((each) => each.model === name);
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
