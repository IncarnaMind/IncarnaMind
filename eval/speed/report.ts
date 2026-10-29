/**
 * The speed baseline's tables (eval/speed/README.md): per flow, model and language, the median and
 * 90th percentile of the time to the first sign of work, the first words, the first change in
 * the page and the end, against the rule every flow is held to (a sign within 0.5 s, no silent
 * wait over 2 s); then each model request and local step the flows made, by flow and step.
 */
import type { FlowSigns, Language } from "./flows";

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

export const SIGN_WITHIN_MS = 500;
export const QUIET_AT_MOST_MS = 2000;

/** The value at `share` (0–1) of `values`, the nearest rank; null for none. */
export function percentile(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? null;
}

const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const pair = (values: readonly number[]) =>
  `${seconds(percentile(values, 0.5))} / ${seconds(percentile(values, 0.9))}`;
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
      // A flow's requests are tagged with the core's flows it runs, not with its own id.
      const calls = each.map(
        (run) =>
          run.records.filter((record) => record.kind === "model" && record.flow !== null).length,
      );
      const signOk = (percentile(sign, 0.9) ?? Number.POSITIVE_INFINITY) <= SIGN_WITHIN_MS;
      const quietOk = (percentile(quiet, 0.9) ?? Number.POSITIVE_INFINITY) <= QUIET_AT_MOST_MS;
      return `| ${flow} | ${model} | ${language} | ${timed.length}/${each.length} | ${pair(sign)} | ${pair(known(timed.map((run) => run.firstWordsMs)))} | ${pair(known(timed.map((run) => run.firstChangeMs)))} | ${pair(timed.map((run) => run.doneMs))} | ${pair(quiet)} | ${percentile(calls, 0.5) ?? "–"} | ${signOk ? "yes" : "**no**"} | ${quietOk ? "yes" : "**no**"} |`;
    },
  );
  return [
    "| Flow | Model | Language | Runs | First sign (median / p90) | First words | First change in the page | Done | Longest silent wait | Model calls | Sign ≤ 0.5 s | Silence ≤ 2 s |",
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
    // From a call's first Tool input to its end: how long a write's input streams (#1635).
    const toolToEnd = (record: TimingRecord) =>
      record.first_tool_ms === null ? null : record.end_ms - record.first_tool_ms;
    return `| ${flow} | ${step} | ${model} | ${reasoning} | ${language} | ${each.length} | ${of((record) => record.first_byte_ms)} | ${of((record) => record.first_reasoning_ms)} | ${of((record) => record.first_text_ms)} | ${of(toolToEnd)} | ${of((record) => record.end_ms)} | ${tokens((record) => record.input_tokens)} / ${tokens((record) => record.output_tokens)} |`;
  });
  return [
    "| Flow | Step | Model | Reasoning | Language | Requests | First byte (median / p90) | First reasoning | First text | First Tool → end | End | Tokens in / out (median) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
