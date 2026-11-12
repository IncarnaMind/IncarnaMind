/**
 * A paired comparison of two arms of the checks evaluation (#2910), each one or more runs of
 * Find support on one commit: how many correct Supported each kept, why their sentences came
 * back Not checked, and the sentences that came out one way in every run of one arm and another
 * way in every run of the other, each with the judge's replies from both. Two runs of one arm
 * differ by more than a small change does, so a sentence that flips in only some runs isn't one.
 */
import { isRecord } from "../../../src/core/errors";
import {
  type ChecksReport,
  causesText,
  judgeLines,
  outcomeText,
  type ReportedSentence,
} from "./report";
import type { Verdict } from "./scoring";

export interface Arm {
  name: string;
  runs: { dir: string; report: ChecksReport }[];
}

function keepsReplies(report: unknown): report is ChecksReport {
  return (
    isRecord(report) &&
    isRecord(report.results) &&
    Array.isArray(report.results.findSupport) &&
    report.results.findSupport.every(
      (each: unknown) =>
        isRecord(each) &&
        typeof each.sentence === "string" &&
        isRecord(each.outcome) &&
        Array.isArray(each.outcome.judge),
    )
  );
}

/** A run's report.json, which compares only when it was written with the replies kept. */
export function parseReport(json: string, dir: string): ChecksReport {
  const report: unknown = JSON.parse(json);
  if (!keepsReplies(report)) {
    throw new Error(
      `${dir} holds no judge replies: it was written before the evaluation kept them (#2910). Run it again.`,
    );
  }
  return report;
}

interface RunResult {
  arm: string;
  /** Which of its arm's runs, from 1. */
  run: number;
  dir: string;
  result: ReportedSentence;
}

/** A sentence whose verdict is `from` in every run of the first arm and `to` in every run of the second. */
export interface Flip {
  id: string;
  from: Verdict;
  to: Verdict;
  results: RunResult[];
}

const outcomesOf = (arm: Arm) =>
  arm.runs.flatMap(({ report }) => report.results.findSupport.map(({ outcome }) => outcome));

function sameVerdict(results: readonly RunResult[]): Verdict | null {
  const [first] = results;
  return first &&
    results.every(({ result }) => result.outcome.verdict === first.result.outcome.verdict)
    ? first.result.outcome.verdict
    : null;
}

/** The sentences that flip the same way in every run, in the order of the first arm's first run. */
export function flipsBetween(first: Arm, second: Arm): Flip[] {
  const found = (arm: Arm, id: string): RunResult[] =>
    arm.runs.flatMap(({ dir, report }, index) => {
      const result = report.results.findSupport.find((each) => each.id === id);
      return result ? [{ arm: arm.name, run: index + 1, dir, result }] : [];
    });
  const flips: Flip[] = [];
  for (const { id } of first.runs[0]?.report.results.findSupport ?? []) {
    const before = found(first, id);
    const after = found(second, id);
    if (before.length !== first.runs.length || after.length !== second.runs.length) continue;
    const from = sameVerdict(before);
    const to = sameVerdict(after);
    if (from !== null && to !== null && from !== to) {
      flips.push({ id, from, to, results: [...before, ...after] });
    }
  }
  return flips;
}

const WORDS: Record<Verdict, string> = {
  supported: "Supported",
  unsupported: "Unsupported",
  contradicted: "Contradicted",
  "not-checked": "Not checked",
};

const directionOf = (flip: Flip, first: string, second: string) =>
  `${WORDS[flip.from]} in ${first}, ${WORDS[flip.to]} in ${second}`;

/** Lost and gained Supported first, then the rest, each group in sentence order. */
function groupsOf(flips: readonly Flip[], first: string, second: string) {
  const groups = new Map<string, Flip[]>();
  for (const flip of flips) {
    const key = directionOf(flip, first, second);
    groups.set(key, [...(groups.get(key) ?? []), flip]);
  }
  const rank = ([, [flip]]: [string, Flip[]]) =>
    flip?.from === "supported" ? 0 : flip?.to === "supported" ? 1 : 2;
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function armLine(arm: Arm): string {
  const scores = arm.runs.map(({ report }) => report.findSupport);
  const each = (value: (score: (typeof scores)[number]) => number) => {
    const values = scores.map(value);
    const total = values.reduce((sum, one) => sum + one, 0);
    return values.length === 1 ? String(total) : `${values.join(" + ")} = ${total}`;
  };
  const commits = arm.runs.map(({ report }) => report.run.commit).join(", ");
  const models = [...new Set(arm.runs.map(({ report }) => report.run.model))].join(", ");
  return `- ${arm.name}: ${plural(arm.runs.length, "run")} at ${commits} with ${models}. Correct Supported ${each((score) => score.supported.truePositives)}; Contradicted on a Supported or Unsupported label ${each((score) => score.contradicted.falsePositives)}.`;
}

export function comparisonMarkdown(first: Arm, second: Arm): string {
  const flips = flipsBetween(first, second);
  const lines = [
    `# Checks evaluation: ${first.name} against ${second.name} (#2910)`,
    "",
    armLine(first),
    armLine(second),
    "",
    "## Not checked, by cause",
    "",
    ...[first, second].map(
      (arm) => `- ${arm.name}, over its runs: ${causesText(outcomesOf(arm))}.`,
    ),
    "",
    "## Sentences that flip the same way in every run",
    "",
    first.runs.length === 1 && second.runs.length === 1
      ? "Each arm has one run, so a flip here may be the run-to-run spread."
      : `A sentence is listed when it came out one way in all ${plural(first.runs.length, "run")} of ${first.name} and another way in all ${plural(second.runs.length, "run")} of ${second.name}.`,
    "",
    flips.length === 0 ? "None." : `${flips.length} in all.`,
    "",
  ];
  for (const [direction, group] of groupsOf(flips, first.name, second.name)) {
    lines.push(`### ${direction}: ${group.length}`, "");
    for (const flip of group) {
      const [{ result }] = flip.results as [RunResult];
      lines.push(`#### ${flip.id}`, "", result.sentence, "", `Labelled ${result.label}.`, "");
      for (const each of flip.results) {
        lines.push(
          `##### ${each.arm}, run ${each.run}: ${outcomeText(each.result.outcome)}`,
          "",
          `Every reply: ${each.dir}/replies.md#${flip.id}`,
          "",
          ...judgeLines(each.result.outcome.judge, "######"),
        );
      }
    }
  }
  return lines.join("\n");
}
