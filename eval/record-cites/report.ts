import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordCaseResult, RecordCiteMiss } from "./score";

export interface RecordCiteRunReport {
  run: {
    startedAt: string;
    seconds: number;
    commit: string;
    model: string;
    pipeline: string;
  };
  set: { documents: number; cases: number; cites: number };
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    requestSeconds: number;
    spentUsd: number;
  };
  results: RecordCaseResult[];
  misses: RecordCiteMiss[];
}

const row = (cells: readonly string[]) =>
  `| ${cells.map((cell) => cell.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;

export const matchedRecordCites = (report: Pick<RecordCiteRunReport, "set" | "misses">) =>
  report.set.cites - report.misses.filter((miss) => miss.expected !== null).length;

export function markdownRecordCiteReport(report: RecordCiteRunReport): string {
  const matched = matchedRecordCites(report);
  return [
    "# Public record-cite evaluation (#1709)",
    "",
    `Run ${report.run.startedAt} at ${report.run.commit}, ${Math.round(report.run.seconds)} s, with ${report.run.model}. ${report.run.pipeline}.`,
    "",
    `Set: ${report.set.documents} record Documents, ${report.set.cases} claims, ${report.set.cites} expected cite results. Matched ${matched} of ${report.set.cites}.`,
    "",
    `Model: ${report.usage.requests} requests, ${report.usage.inputTokens} input and ${report.usage.outputTokens} output tokens, ${report.usage.requestSeconds.toFixed(1)} s of requests, $${report.usage.spentUsd.toFixed(4)} at the core's count.`,
    "",
    "## Cases",
    "",
    row(["Id", "Interface", "Overall", "Cite outcomes", "Misses"]),
    row(["---", "---", "---", "---", "---"]),
    ...report.results.map((entry) =>
      row([
        entry.test.id,
        entry.test.language,
        entry.result?.verdict ?? "error",
        (entry.result?.recordCites ?? [])
          .map((cite) => `${cite.raw}: ${cite.outcome}`)
          .join("; ") || "–",
        String(entry.misses.length),
      ]),
    ),
    "",
    "## Every miss",
    "",
    ...(report.misses.length === 0
      ? ["None."]
      : [
          row(["Case", "Raw", "Expected", "Actual", "Why"]),
          row(["---", "---", "---", "---", "---"]),
          ...report.misses.map((miss) =>
            row([
              miss.caseId,
              miss.raw,
              miss.expected ? JSON.stringify(miss.expected) : "no extra result expected",
              miss.actual ? JSON.stringify(miss.actual) : "missing",
              miss.reasons.join("; "),
            ]),
          ),
        ]),
    "",
  ].join("\n");
}

export async function writeRecordCiteReport(
  report: RecordCiteRunReport,
  resultsDir: string,
): Promise<string> {
  const dir = join(resultsDir, `${report.run.startedAt.replace(/[:.]/g, "-")}-record-cites`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(dir, "report.md"), markdownRecordCiteReport(report));
  return dir;
}
