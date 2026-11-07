/**
 * The speed baseline's tables (eval/speed/README.md): per flow, model and language, the median and
 * 95th percentile of the time to the first sign of work, the first words, the first change in
 * the page and the end, against the rule every flow is held to (a sign within 0.5 s, no silent
 * wait over 2 s) and the time budgets of #1624; then each model request and local step the flows
 * made, by flow and step.
 */
import { LIBRARY_FLOW_IDS } from "./libraryFlows";
import type { FlowSigns, Language } from "./signs";

/** One row of the core's timing records (src/core/timing/timings.ts), as stored. */
export interface TimingRecord {
  kind: "model" | "local";
  flow: string | null;
  step: string | null;
  data_flow: string | null;
  provider_kind: string | null;
  model_id: string;
  reasoning: string | null;
  first_byte_ms: number | null;
  first_reasoning_ms: number | null;
  first_text_ms: number | null;
  first_tool_ms: number | null;
  end_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  units: number | null;
  outcome: string;
}

export interface FlowRun {
  flow: string;
  model: string;
  language: Language;
  signs: FlowSigns | null;
  error: string | null;
  records: TimingRecord[];
}

/** The data flows the Library's background queue sends on, untagged with any flow. */
const BACKGROUND = new Set(["tagging", "classification"]);

export const SIGN_WITHIN_MS = 500;
export const QUIET_AT_MOST_MS = 2000;

/** The value at `share` (0–1) of `values`, the nearest rank; null for none. */
export function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? null;
}

const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
/** The share every rule and budget is held at: with three runs, the slowest. */
const HELD_AT = 0.95;

const pair = (values: readonly number[]) =>
  `${seconds(percentile(values, 0.5))} / ${seconds(percentile(values, HELD_AT))}`;
const known = (values: readonly (number | null)[]) =>
  values.filter((value): value is number => value !== null);

function groups<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}

export function flowTable(runs: readonly FlowRun[]): string {
  const rows = [...groups(runs, (run) => `${run.flow}\t${run.model}\t${run.language}`)].map(
    ([key, each]) => {
      const [flow, model, language] = key.split("\t");
      const timed = each.flatMap((run) => (run.signs ? [run.signs] : []));
      const sign = known(timed.map((run) => run.firstSignMs));
      const quiet = timed.map((run) => run.longestQuietMs);
      // A flow's requests are tagged with the core's flows it runs, not with its own id; the
      // Library's run in its background queue, tagged with their data flow alone.
      const calls = each.map(
        (run) =>
          run.records.filter(
            (record) =>
              record.kind === "model" &&
              (record.flow !== null ||
                (LIBRARY_FLOW_IDS.has(run.flow) && BACKGROUND.has(record.data_flow ?? ""))),
          ).length,
      );
      // A run that showed no sign at all misses the rule, as a slow one does.
      const signOk =
        sign.length === timed.length &&
        (percentile(sign, HELD_AT) ?? Number.POSITIVE_INFINITY) <= SIGN_WITHIN_MS;
      const quietOk = (percentile(quiet, HELD_AT) ?? Number.POSITIVE_INFINITY) <= QUIET_AT_MOST_MS;
      return `| ${flow} | ${model} | ${language} | ${timed.length}/${each.length} | ${pair(sign)} | ${pair(known(timed.map((run) => run.firstWordsMs)))} | ${pair(known(timed.map((run) => run.firstChangeMs)))} | ${pair(timed.map((run) => run.doneMs))} | ${pair(quiet)} | ${percentile(calls, 0.5) ?? "–"} | ${signOk ? "yes" : "**no**"} | ${quietOk ? "yes" : "**no**"} |`;
    },
  );
  return [
    "| Flow | Model | Language | Runs | First sign (median / p95) | First words | First change in the page | Done | Longest silent wait | Model calls | Sign ≤ 0.5 s | Silence ≤ 2 s |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export function requestTable(runs: readonly FlowRun[]): string {
  const records = runs.flatMap((run) => run.records.map((record) => ({ run, record })));
  const rows = [
    ...groups(
      records,
      ({ run, record }) =>
        `${record.flow ?? record.data_flow ?? "?"}\t${record.step ?? "–"}\t${record.kind === "local" ? record.model_id : run.model}\t${record.reasoning ?? "–"}\t${run.language}`,
    ),
  ].map(([key, each]) => {
    const [flow, step, model, reasoning, language] = key.split("\t");
    const of = (pick: (record: TimingRecord) => number | null) =>
      pair(known(each.map(({ record }) => pick(record))));
    const tokens = (pick: (record: TimingRecord) => number | null) =>
      percentile(known(each.map(({ record }) => pick(record))), 0.5) ?? "–";
    return `| ${flow} | ${step} | ${model} | ${reasoning} | ${language} | ${each.length} | ${of((record) => record.first_byte_ms)} | ${of((record) => record.first_reasoning_ms)} | ${of((record) => record.first_text_ms)} | ${of((record) => record.end_ms)} | ${tokens((record) => record.input_tokens)} / ${tokens((record) => record.output_tokens)} |`;
  });
  return [
    "| Flow | Step | Model | Reasoning | Language | Requests | First byte (median / p95) | First reasoning | First text | End | Tokens in / out (median) |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** A budget of #1624 for one flow on a class of model, each time from the User's action. */
interface Budget {
  flows: readonly string[];
  /** The models it holds for: "<kind>/<model id>". */
  models(model: string): boolean;
  label: string;
  firstSignMs: number;
  /** The first words, or for an edit the first change in the page. */
  first: { of: "words" | "change"; ms: number };
  doneMs: number;
}

/** A model of Claude Sonnet's class or above; every other model, Kimi's included, is held to the Haiku-class budget. */
const SONNET_CLASS = /sonnet|opus|-pro\b|sol\b/;

const BUDGETS: readonly Budget[] = [
  {
    flows: ["question"],
    models: (model) => !SONNET_CLASS.test(model),
    label: "Ask a Question, a Haiku-class model",
    firstSignMs: 500,
    first: { of: "words", ms: 3000 },
    doneMs: 6000,
  },
  {
    flows: ["question"],
    models: (model) => SONNET_CLASS.test(model),
    label: "Ask a Question, a Sonnet-class model",
    firstSignMs: 500,
    first: { of: "words", ms: 6000 },
    doneMs: 12_000,
  },
  {
    flows: ["assistant-edit", "assistant-longer", "edit-with-ai"],
    models: () => true,
    label: "Edit a note",
    firstSignMs: 500,
    first: { of: "change", ms: 8000 },
    doneMs: 15_000,
  },
];

/**
 * A time at the 95th percentile against its limit, in bold when over it. A run that never got
 * there (no sign, no change in the page) misses it, and the count of those is shown.
 */
function held(values: readonly (number | null)[], limit: number): { met: boolean; shown: string } {
  const times = known(values);
  const at = percentile(times, HELD_AT);
  const never = values.length - times.length;
  const met = never === 0 && at !== null && at <= limit;
  const shown = `${seconds(at)}${never > 0 ? `, none in ${never} of ${values.length}` : ""}`;
  return { met, shown: `${met ? shown : `**${shown}**`} of ${seconds(limit)}` };
}

/**
 * Each flow, model and language a budget of #1624 holds for, against it at the 95th percentile:
 * met, or missed with the times that missed it. A run that failed misses it too.
 */
export function budgetTable(runs: readonly FlowRun[]): string {
  const rows = [...groups(runs, (run) => `${run.flow}\t${run.model}\t${run.language}`)].flatMap(
    ([key, each]) => {
      const [flow = "", model = "", language] = key.split("\t");
      const budget = BUDGETS.find((one) => one.flows.includes(flow) && one.models(model));
      if (!budget) return [];
      const timed = each.flatMap((run) => (run.signs ? [run.signs] : []));
      const sign = held(
        timed.map((run) => run.firstSignMs),
        budget.firstSignMs,
      );
      const first = held(
        timed.map((run) => (budget.first.of === "words" ? run.firstWordsMs : run.firstChangeMs)),
        budget.first.ms,
      );
      const done = held(
        timed.map((run) => run.doneMs),
        budget.doneMs,
      );
      const met = timed.length === each.length && sign.met && first.met && done.met;
      return [
        `| ${budget.label} | ${flow} | ${model} | ${language} | ${sign.shown} | ${first.shown} (${budget.first.of === "words" ? "words" : "change in the page"}) | ${done.shown} | ${met ? "met" : "**missed**"} |`,
      ];
    },
  );
  return [
    "| Budget | Flow | Model | Language | First sign (p95) | First words or change (p95) | Done (p95) | |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
