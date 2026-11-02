/**
 * The any-analysis set's report (README.md), from saved runs alone: each task's
 * result per model, pass counts per need against the bar, every C4 failure,
 * the failure classes, and the spend with the token counts it is priced from.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs \
 *     eval/any-analysis/report.ts <run.json>...
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { taskFolder } from "./load";
import type { RunRecord } from "./record";
import {
  type FailureClass,
  MEDIAN_SECONDS,
  type RunScore,
  SLOWEST_SECONDS,
  scoreRun,
  type TaskScore,
} from "./score";
import { tokensByModel } from "./spend";
import type { Need, Reference, Task } from "./task";
import { TASKS } from "./tasks";

/** The bar for the Analysis sandbox as it is: at least 22 of the 25 P tasks. */
export const P_BAR = 22;

const NEEDS: readonly Need[] = ["P", "N", "F", "T", "X"];

export function referencesOf(tasks: readonly Task[]): Record<string, Reference> {
  return Object.fromEntries(
    tasks.map((task) => [
      task.id,
      JSON.parse(readFileSync(join(taskFolder(task.id), "reference.json"), "utf8")) as Reference,
    ]),
  );
}

/**
 * One record per model from runs made in parts: a task asked again in a later run replaces its
 * earlier Answer, and the requests of both stay counted, since both were paid for.
 */
export function byModel(
  runs: readonly RunRecord[],
): { record: RunRecord; paid: RunRecord["answers"] }[] {
  const models = new Map<string, { record: RunRecord; paid: RunRecord["answers"] }>();
  for (const run of runs) {
    const kept = models.get(run.run.model) ?? { record: { run: run.run, answers: [] }, paid: [] };
    for (const answer of run.answers) {
      kept.record.answers = kept.record.answers.filter(
        (each) => each.task !== answer.task || each.language !== answer.language,
      );
      kept.record.answers.push(answer);
      kept.paid.push(answer);
    }
    models.set(run.run.model, kept);
  }
  return [...models.values()];
}

export interface ModelResult {
  model: string;
  run: RunScore;
  /** Tasks passed of those run, per need, English only (the design's counts are per task). */
  passed: Record<Need, { passed: number; of: number }>;
  failures: Partial<Record<FailureClass, number>>;
}

export function modelResults(
  runs: readonly RunRecord[],
  tasks: readonly Task[] = TASKS,
): ModelResult[] {
  const references = referencesOf(tasks);
  return runs.map((record) => {
    const run = scoreRun(tasks, references, record.answers);
    const passed = Object.fromEntries(
      NEEDS.map((need) => [need, { passed: 0, of: 0 }]),
    ) as ModelResult["passed"];
    const failures: ModelResult["failures"] = {};
    for (const score of run.scores) {
      if (score.failure) failures[score.failure] = (failures[score.failure] ?? 0) + 1;
      if (score.language !== "en") continue;
      for (const need of score.needs) {
        passed[need].of++;
        if (score.passed) passed[need].passed++;
      }
    }
    return { model: record.run.model, run, passed, failures };
  });
}

const mark = (score: TaskScore | undefined): string => {
  if (!score) return "–";
  if (score.passed) return "pass";
  const failed = (["C1", "C2", "C3", "C4", "C5"] as const).filter((check) => !score.checks[check]);
  return `${failed.join(" ")}: ${score.failure ?? ""}, ${score.end}`;
};

const dollars = (value: number) => `$${value.toFixed(4)}`;

export function reportLines(given: readonly RunRecord[], tasks: readonly Task[] = TASKS): string[] {
  const merged = byModel(given);
  const runs = merged.map((each) => each.record);
  const results = modelResults(runs, tasks);
  const models = results.map((each) => each.model.replace(/^anthropic\//, ""));
  const lines: string[] = [];
  lines.push(
    `| Task | Needs | Language | ${models.join(" | ")} |`,
    `|---|---|---|${models.map(() => "---").join("|")}|`,
  );
  for (const task of tasks) {
    for (const language of task.question.zh ? (["en", "zh"] as const) : (["en"] as const)) {
      const cells = results.map((result) =>
        mark(
          result.run.scores.find((score) => score.task === task.id && score.language === language),
        ),
      );
      if (cells.every((cell) => cell === "–")) continue;
      lines.push(
        `| ${task.id} ${task.title} | ${task.needs.join(", ")} | ${language} | ${cells.join(" | ")} |`,
      );
    }
  }
  lines.push(
    "",
    `| Passed (English) | ${NEEDS.join(" | ")} | Chinese | P bar (${P_BAR} of 25) |`,
    `|---|${NEEDS.map(() => "--:").join("|")}|--:|---|`,
  );
  for (const result of results) {
    const chinese = result.run.scores.filter((score) => score.language === "zh");
    const p = result.passed.P;
    lines.push(
      `| ${result.model} | ${NEEDS.map((need) => `${result.passed[need].passed}/${result.passed[need].of}`).join(" | ")} | ${chinese.filter((each) => each.passed).length}/${chinese.length} | ${p.of < 25 ? `${p.passed} of ${p.of} run` : p.passed >= P_BAR ? "met" : "not met"} |`,
    );
  }
  lines.push("", "Hard gates:");
  for (const result of results) {
    const uncontained = result.run.scores.filter((score) => !score.checks.C4);
    const falseRecalculated = result.run.scores.flatMap((score) =>
      score.falseRecalculated.map((each) => `${score.task} ${score.language}: ${each}`),
    );
    const unlabelled = result.run.scores.flatMap((score) =>
      score.wrongUnlabelled.map((each) => `${score.task} ${score.language}: ${each}`),
    );
    lines.push(
      `- ${result.model}: C4 failures ${uncontained.length}${uncontained.length ? ` (${uncontained.map((each) => `${each.task} ${each.language}`).join(", ")})` : ""}; false "recalculated" ${falseRecalculated.length}${falseRecalculated.length ? ` (${falseRecalculated.join("; ")})` : ""}; wrong numbers without the calculated label ${unlabelled.length}${unlabelled.length ? ` (${unlabelled.join("; ")})` : ""}; median ${result.run.medianSeconds.toFixed(0)} s (bar ${MEDIAN_SECONDS}), 95th percentile ${result.run.p95Seconds.toFixed(0)} s (bar ${SLOWEST_SECONDS}).`,
    );
  }
  lines.push("", "Failure classes:");
  for (const result of results) {
    const classes = Object.entries(result.failures).sort((a, b) => b[1] - a[1]);
    lines.push(
      `- ${result.model}: ${classes.map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`,
    );
  }
  lines.push(
    "",
    "| Model | Requests | Uncached input | Cache reads | Cache writes | Output | Spend |",
    "|---|--:|--:|--:|--:|--:|--:|",
  );
  let total = 0;
  for (const { record, paid } of merged) {
    for (const [model, tokens] of tokensByModel(paid.flatMap((each) => each.requests))) {
      total += tokens.dollars;
      lines.push(
        `| ${model} (run on ${record.run.model.replace(/^anthropic\//, "")}) | ${tokens.requests} | ${tokens.uncached} | ${tokens.cacheReads} | ${tokens.cacheWrites} | ${tokens.output} | ${dollars(tokens.dollars)} |`,
      );
    }
  }
  lines.push(`| All | | | | | | ${dollars(total)} |`);
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const runs = process.argv
    .slice(2)
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as RunRecord);
  console.log(reportLines(runs).join("\n"));
}
