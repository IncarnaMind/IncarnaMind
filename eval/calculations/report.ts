/**
 * The calculations set's report (#441): report.json with every observation,
 * and report.md with the scores per model, arm and language, the bars, and
 * every Answer's results, a failed run kept beside the runs that went right.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaseLanguage } from "./cases";
import {
  type Bar,
  bars,
  type CaseScore,
  type GroupScore,
  type ObservedAnswer,
  type Rate,
  scoreGroup,
} from "./score";

export type Arm = "on" | "off";

export interface ArmRun {
  model: string;
  arm: Arm;
  /** True for the scripted model: its scores check the set, they measure no model. */
  scripted: boolean;
  cases: CaseScore[];
  /** What the model was asked, from the core's meter. */
  usage: {
    requests: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  /** What the core priced it at, per currency. */
  spent: { currency: string; amount: number }[];
  /** What each Answer gave, as scored: a report can be scored again from it. */
  answers: { id: string; run: number; observed: ObservedAnswer }[];
}

export interface CalculationsReport {
  /** `rescoredFrom`: the report whose Answers were scored again (rescore.ts). */
  run: { startedAt: string; seconds: number; commit: string; runs: number; rescoredFrom?: string };
  arms: ArmRun[];
}

const LANGUAGES: readonly CaseLanguage[] = ["en", "zh"];

const percent = (rate: Rate) =>
  rate.rate === null ? "n/a" : `${(rate.rate * 100).toFixed(1)}% (${rate.count}/${rate.of})`;

function groupRows(arm: ArmRun): { language: string; analysis: boolean; score: GroupScore }[] {
  const rows: { language: string; analysis: boolean; score: GroupScore }[] = [];
  for (const analysis of [false, true]) {
    for (const language of LANGUAGES) {
      const cases = arm.cases.filter(
        (each) => each.language === language && each.analysis === analysis,
      );
      if (cases.length > 0) rows.push({ language, analysis, score: scoreGroup(cases) });
    }
  }
  return rows;
}

export function armBars(
  report: CalculationsReport,
): { model: string; language: CaseLanguage; bars: Bar[] }[] {
  const out: { model: string; language: CaseLanguage; bars: Bar[] }[] = [];
  for (const on of report.arms.filter((each) => each.arm === "on" && !each.scripted)) {
    const off = report.arms.find((each) => each.arm === "off" && each.model === on.model);
    for (const language of LANGUAGES) {
      const calculation = (arm: ArmRun) =>
        arm.cases.filter((each) => each.language === language && !each.analysis);
      const onCases = calculation(on);
      if (onCases.length === 0) continue;
      out.push({
        model: on.model,
        language,
        bars: bars(scoreGroup(onCases), off ? scoreGroup(calculation(off)) : null),
      });
    }
  }
  return out;
}

function markdown(report: CalculationsReport): string {
  const lines = [
    "# Calculations evaluation",
    "",
    `Started ${report.run.startedAt}, ${Math.round(report.run.seconds)} s, commit ${report.run.commit}, ${report.run.runs} run(s) of each Question.${report.run.rescoredFrom ? ` Scored again from ${report.run.rescoredFrom}.` : ""}`,
    "",
    "| Model | Tools | Questions | Language | Failed | Complete | Right | Inputs right | Right where inputs right | Tool coverage | Stated kept | Refused rightly | Left out | Refused | Traps | Hedged | False checked | Unmatched checked | s / Answer | s / request |",
    "|---|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  for (const arm of report.arms) {
    for (const { language, analysis, score } of groupRows(arm)) {
      lines.push(
        `| ${arm.model}${arm.scripted ? " (scripted)" : ""} | ${arm.arm} | ${analysis ? "analysis" : "calculation"} | ${language} | ${score.failed} | ${percent(score.completeness)} | ${percent(score.figureCorrectness)} | ${percent(score.inputCorrectness)} | ${percent(score.correctWhereInputsRight)} | ${percent(score.toolCoverage)} | ${percent(score.quotedKept)} | ${percent(score.refusals)} | ${score.omitted} | ${score.refused} | ${score.trapsHit} | ${score.hedged} | ${score.falseChecked} | ${score.unmatched} | ${score.meanSeconds?.toFixed(1) ?? "n/a"} | ${score.meanSecondsPerRequest?.toFixed(1) ?? "n/a"} |`,
      );
    }
  }
  lines.push(
    "",
    "## Usage",
    "",
    "| Model | Tools | Requests | Input tokens | Cache reads | Cache writes | Output tokens | Spent |",
    "|---|---|--:|--:|--:|--:|--:|---|",
  );
  for (const arm of report.arms) {
    const { usage } = arm;
    lines.push(
      `| ${arm.model} | ${arm.arm} | ${usage.requests} | ${usage.inputTokens} | ${usage.cacheReadTokens} | ${usage.cacheWriteTokens} | ${usage.outputTokens} | ${arm.spent.map((each) => `${each.amount.toFixed(4)} ${each.currency}`).join(", ") || "none"} |`,
    );
  }
  lines.push(
    "",
    "## Bars (calculation Questions, Tools on, against the same Questions with them withheld)",
    "",
  );
  for (const { model, language, bars: each } of armBars(report)) {
    lines.push(`### ${model}, ${language}`, "");
    for (const bar of each) {
      lines.push(
        `- ${bar.met === null ? "not measured" : bar.met ? "met" : "missed"}: ${bar.name}: ${bar.detail}`,
      );
    }
    lines.push("");
  }
  lines.push("## Every Answer", "");
  for (const arm of report.arms) {
    lines.push(`### ${arm.model}, Tools ${arm.arm}`, "");
    for (const [at, each] of arm.cases.entries()) {
      const run = report.run.runs > 1 ? `, run ${arm.answers[at]?.run}` : "";
      const results = each.results
        .map(
          (result) =>
            `${result.label}: ${result.outcome}${result.got ? ` (${result.got})` : ""}${result.inputsRight === false ? ", inputs wrong" : ""}${result.trap ? `, ${result.trap}` : ""}`,
        )
        .join("; ");
      const refusal = each.refusal
        ? `${each.refusal.refused ? "refused" : "not refused"}${each.refusal.gave.length ? `, gave ${each.refusal.gave.join(", ")}` : ""}`
        : "";
      const hedged = each.hedges.length ? `; also gave ${each.hedges.join("; ")}` : "";
      const unmatched = each.unmatched.length
        ? `; checked figures that are no requested result: ${each.unmatched.join(", ")}`
        : "";
      const checked = each.falseChecked.length
        ? `; false checked: ${each.falseChecked.join("; ")}`
        : "";
      lines.push(
        `- ${each.id}${run}${each.failed ? " (failed)" : ""}: ${results}${refusal}${hedged}${checked}${unmatched}, ${each.seconds.toFixed(1)} s`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeCalculationsReport(
  report: CalculationsReport,
  resultsDir: string,
): Promise<string> {
  const dir = join(resultsDir, `${report.run.startedAt.replace(/[:.]/g, "-")}-calculations`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.md"), markdown(report));
  return dir;
}

export function summaryLines(report: CalculationsReport, dir: string): string[] {
  const lines = [`Calculations: report in ${dir}`];
  for (const arm of report.arms) {
    for (const { language, analysis, score } of groupRows(arm)) {
      lines.push(
        `  ${arm.model}${arm.scripted ? " (scripted)" : ""}, Tools ${arm.arm}, ${analysis ? "analysis" : "calculation"} ${language}: complete ${percent(score.completeness)}, right ${percent(score.figureCorrectness)}, inputs right ${percent(score.inputCorrectness)}, Tool coverage ${percent(score.toolCoverage)}, refused rightly ${percent(score.refusals)}, false checked ${score.falseChecked}`,
      );
    }
  }
  return lines;
}
