/**
 * Runs an Analysis through the host's `AnalysisRuntime` (ADR-0023) and
 * records the run: SHA-256 hashes of its code, of each input's values and of
 * what it came to, and the versions it ran with, so a run can be told apart
 * from another and run again to the same result. What the runtime gives is
 * cut to the limits again here, whatever runtime it was.
 */
import { createHash } from "node:crypto";
import {
  type AnalysisInput,
  type AnalysisJob,
  type AnalysisResult,
  type AnalysisVersions,
  endedBefore,
  readAnalysisOutput,
} from "../../shared/analysis";
import type { AnalysisRuntime } from "../adapters";

export interface AnalysisRun {
  /** SHA-256 of the code, in hex. */
  code: string;
  /** SHA-256 of each input's values, by its name: its headings and rows, or its number. */
  inputs: { name: string; sha256: string }[];
  /** What it ran with; null when no runtime ran it. */
  versions: AnalysisVersions | null;
  result: AnalysisResult;
  /** SHA-256 of what it came to, its end and output: the same for the same job, run again. */
  output: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const valuesOf = (input: AnalysisInput) =>
  JSON.stringify(input.kind === "table" ? [input.columns, input.rows] : input.value);

/**
 * Runs `job` with `runtime` (none: Analyses can't run here) and records it.
 * Never throws: a runtime that fails anyway ends the run as unavailable.
 */
export async function runAnalysis(
  runtime: AnalysisRuntime | undefined,
  job: AnalysisJob,
  signal: AbortSignal,
): Promise<AnalysisRun> {
  const versions = runtime?.languages.find((each) => each.language === job.language) ?? null;
  let result: AnalysisResult;
  if (!runtime || !versions) {
    result = endedBefore({
      kind: "unavailable",
      reason: "missing",
      detail: runtime ? `This runtime doesn't run ${job.language}.` : "There is no runtime.",
    });
  } else {
    try {
      const given = await runtime.run(job, signal);
      result = { end: given.end, output: readAnalysisOutput(given.output), ms: given.ms };
    } catch (error) {
      result = endedBefore({
        kind: "unavailable",
        reason: "start",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    code: sha256(job.code),
    inputs: job.inputs.map((input) => ({ name: input.name, sha256: sha256(valuesOf(input)) })),
    versions,
    result,
    output: sha256(JSON.stringify({ end: result.end, output: result.output })),
  };
}
