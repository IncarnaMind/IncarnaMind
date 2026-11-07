/**
 * The faster Answer paths a model takes in the Tool loop, beside its catalog entry. A model is
 * listed only once it passes the quality gate on paired runs against the default path
 * (eval/speed/README.md › Paired runs), with the day, the flows it was measured on and the result
 * that admitted it, and is taken off the same way if it regresses. A model not listed, and a
 * listed one in any other flow, answers as before.
 */
import { withoutDateSuffix } from ".";

/**
 * The flows an Answer runs in, as its timing records name them: "question" is one asked in a Mind
 * or the assistant; "check" a check Run, a Meeting's notes among them. A comparison table's cell
 * is a check Run too, but the lists know it apart, as "comparison-cell".
 */
export type AnswerFlow =
  | "question"
  | "outside-agent"
  | "task-answer"
  | "check"
  | "comparison-cell"
  | "call-help";

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
 * expected Passages cited on the gating set (62 → 59). A Meeting's notes were measured and left
 * out (2026-11-07, eval/speed/gates/write-then-cite-tasks.md): on Claude Haiku 5.5 their first
 * case gave 10 sentences a found Citation that didn't state them, against 1 citing first; on
 * DeepSeek Flash two of four replies ran out of output and the fourth gave a new false Supported.
 */
const WRITES_THEN_CITES: readonly Admitted[] = [
  {
    model: "anthropic/claude-haiku-5-5",
    since: "2026-10-26",
    flows: ["question"],
    gate: "Against citing first, paired, within one item in 30: gating 65 on this code (load median 6), 2.89 → 2.20 calls, done −0.4 s, cited 61 → 61, judged right 61 → 59, every Citation found 63 → 62; on its earlier endings, gating 65 three times, cited 183 → 184, right 184 → 182, found 188 → 190; on earlier wordings, hard tier 225, cited 150 → 155, right 207 → 209, and everyday 39; no new duplicate, false Supported, unmade change or tool text.",
  },
  {
    model: "anthropic/claude-haiku-5-5",
    since: "2026-11-07",
    flows: ["comparison-cell"],
    gate: "eval/speed/gates/write-then-cite-tasks.md, against citing first, paired, within one item in 30: the cells set's 65 Questions (load median 6), 2.83 → 2.11 calls, done −0.3 s (sooner in 40), cited 65 → 63, judged right 57 → 60, every Citation found 64 → 64; no new false Supported, duplicate, unmade change or tool text.",
  },
  {
    model: "deepseek/deepseek-flash",
    since: "2026-11-07",
    flows: ["comparison-cell"],
    gate: "eval/speed/gates/write-then-cite-tasks.md, against citing first, paired, within one item in 30: the cells set's 65 Questions (load median 5.7), 2.89 → 2.11 calls, done −0.8 s (sooner in 58), cited 65 → 64, judged right 59 → 57, every Citation found 65 → 65; no new false Supported, duplicate, unmade change or tool text.",
  },
];

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
