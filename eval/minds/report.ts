/**
 * The report of a run: a pass count per request and model against the bar,
 * the time and tokens of a run, why runs failed, and the transcripts of the
 * failures. `report.json` keeps `rows` in the shape the nightly summary reads
 * (scripts/nightlyRealModel.ts).
 */
import type { Language } from "./cases";
import { failureLine, type MindsFailure } from "./checks";
import type { Tokens } from "./record";

/** The share of a request's runs that must pass: 9 in 10. */
export const BAR = 0.9;

export interface CardRow {
  mind: string;
  created: boolean;
  changed: number;
  wrote: number;
}

export interface RunResult {
  id: string;
  language: Language;
  request: string;
  model: string;
  run: number;
  failures: MindsFailure[];
  error: string | null;
  reply: string;
  /** From asking to the end of the Answer. */
  answeredSeconds: number;
  seconds: number;
  chat: Tokens;
  judging: Tokens;
  /** How often the provider was too busy and the run was asked again. */
  retries: number;
  calls: string[];
  card: CardRow[];
  transcript: string[];
}

export const passedRun = (result: RunResult) => !result.error && result.failures.length === 0;

export interface Row {
  id: string;
  language: Language;
  model: string;
  passed: number;
  runs: number;
  floor: number;
  under: boolean;
}

export function rowsOf(results: readonly RunResult[]): Row[] {
  const rows = new Map<string, Row>();
  for (const result of results) {
    const key = `${result.id}\n${result.model}`;
    const row = rows.get(key) ?? {
      id: result.id,
      language: result.language,
      model: result.model,
      passed: 0,
      runs: 0,
      floor: BAR,
      under: false,
    };
    row.runs++;
    if (passedRun(result)) row.passed++;
    row.under = row.passed / row.runs < BAR;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const MIND_WRITES = /^- (?:edit_mind|add_to_mind|create_mind)\b.*\bproposed\b/;

const percent = (passed: number, total: number) => `${Math.round((100 * passed) / total)}%`;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const thousands = (count: number) => Math.round(count).toLocaleString("en");
const average = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export interface ReportMeta {
  commit: string;
  judge: string;
  /** What the run cost, counted from every request's tokens at the catalog's prices. */
  spentDollars: number;
  /** Why the run stopped before every request was asked, if it did. */
  stopped: string | null;
}

export function report(
  results: readonly RunResult[],
  rows: readonly Row[],
  meta: ReportMeta,
): string {
  const under = rows.filter((row) => row.under);
  const ran = results.filter((result) => !result.error);
  const failing = results.filter((result) => !passedRun(result));
  const causes = new Map<string, { runs: number; ids: Set<string> }>();
  for (const result of failing) {
    for (const kind of result.error
      ? ["error"]
      : new Set(result.failures.map((each) => each.kind))) {
      const cause = causes.get(kind) ?? { runs: 0, ids: new Set<string>() };
      cause.runs++;
      cause.ids.add(`${result.id} (${result.model})`);
      causes.set(kind, cause);
    }
  }
  const models = [...new Set(results.map((result) => result.model))];
  const tokensOf = (some: readonly RunResult[], key: "chat" | "judging") => ({
    input: some.reduce((sum, each) => sum + each[key].inputTokens, 0),
    cached: some.reduce((sum, each) => sum + each[key].cachedInputTokens, 0),
    output: some.reduce((sum, each) => sum + each[key].outputTokens, 0),
  });
  return [
    "# Requests that change several Notes",
    "",
    `${rows.length - under.length} of ${rows.length} requests at or above the bar of ${percent(BAR * 100, 100)} of their runs; ${results.length - failing.length} of ${results.length} runs passed. Commit ${meta.commit}. Models asked: ${models.join(", ")}.`,
    "",
    `Every check is code, but what the reply claims, which a model judges: ${meta.judge}. Spend $${meta.spentDollars.toFixed(2)}, counted from every request's tokens at the catalog's prices${meta.stopped ? `. **${meta.stopped}**` : ""}.`,
    "",
    ...models.flatMap((model) => {
      const own = results.filter((result) => result.model === model);
      const chat = tokensOf(own, "chat");
      const judging = tokensOf(own, "judging");
      return [
        `${model}: ${thousands(chat.input)} tokens in (${thousands(chat.cached)} from the cache) and ${thousands(chat.output)} out over ${own.length} runs, the rewrites edit_mind asks for included; the judge's ${thousands(judging.input)} in and ${thousands(judging.output)} out.`,
        "",
      ];
    }),
    "## By request",
    "",
    "The last column counts the Notes changed in all of a request's runs: those whose changes the app applies at once, and those that wait for the User to accept them.",
    "",
    "| Request | Language | Model | Passed | Median s | Tokens in / out a run | Applied at once / waiting |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => {
      const own = results.filter((result) => result.id === row.id && result.model === row.model);
      const fates = own.flatMap((each) => each.calls).filter((line) => MIND_WRITES.test(line));
      const applied = fates.filter((line) => line.includes("applied in the Note at once")).length;
      return `| ${row.id} | ${row.language} | ${row.model} | ${row.passed} of ${row.runs}${row.under ? " **under the bar**" : ""} | ${median(own.map((each) => each.answeredSeconds)).toFixed(0)} | ${thousands(average(own.map((each) => each.chat.inputTokens)))} / ${thousands(average(own.map((each) => each.chat.outputTokens)))} | ${applied} / ${fates.length - applied} |`;
    }),
    "",
    "## By language",
    "",
    "| Model | Language | Passed |",
    "|---|---|---|",
    ...models.flatMap((model) =>
      (["en", "zh-CN"] as const).flatMap((language) => {
        const own = results.filter((each) => each.model === model && each.language === language);
        const passed = own.filter(passedRun).length;
        return own.length === 0
          ? []
          : [
              `| ${model} | ${language} | ${passed} of ${own.length} (${percent(passed, own.length)}) |`,
            ];
      }),
    ),
    "",
    "## Why runs failed",
    "",
    ...(causes.size === 0
      ? ["No run failed."]
      : [
          "A run can fail for more than one cause.",
          "",
          "| Cause | Runs | Requests |",
          "|---|---|---|",
          ...[...causes].map(
            ([kind, cause]) => `| ${kind} | ${cause.runs} | ${[...cause.ids].join(", ")} |`,
          ),
        ]),
    "",
    "## Each run",
    "",
    "| Request | Model | Run | Result | s | Tokens in / out |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (each) =>
        `| ${each.id} | ${each.model} | ${each.run} | ${cell(
          each.error
            ? `didn't run: ${each.error}`
            : each.failures.length === 0
              ? "passed"
              : each.failures.map(failureLine).join("; "),
        )} | ${each.answeredSeconds.toFixed(0)} | ${thousands(each.chat.inputTokens)} / ${thousands(each.chat.outputTokens)} |`,
    ),
    "",
    "## The failures, with their transcripts",
    "",
    ...(failing.length === 0
      ? ["None."]
      : failing.flatMap((each) => [
          `### ${each.id}, ${each.model}, run ${each.run} (${each.answeredSeconds.toFixed(0)} s)`,
          "",
          `> ${each.request}`,
          "",
          ...(each.error
            ? [`Didn't run: ${each.error}`, ""]
            : each.failures.map((failure) => `- ${failureLine(failure)}`)),
          ...(each.card.length > 0
            ? [
                "",
                "The card listed:",
                "",
                ...each.card.map(
                  (row) =>
                    `- ${row.mind}${row.created ? " (new)" : ""}: ${row.changed} changed, ${row.wrote} written`,
                ),
              ]
            : ["", "The card listed no Note."]),
          "",
          "What the app recorded its Tools doing:",
          "",
          ...(each.calls.length > 0 ? each.calls : ["- Nothing."]),
          "",
          "What the model said, called and was told:",
          "",
          "```",
          ...each.transcript,
          "```",
          "",
          "Its reply:",
          "",
          `> ${(each.reply || "(no reply)").replace(/\n/g, "\n> ")}`,
          "",
        ])),
    "",
    `${ran.length} of ${results.length} runs ran to the end; ${results.reduce((total, each) => total + each.retries, 0)} were asked again after the provider was too busy.`,
  ].join("\n");
}
