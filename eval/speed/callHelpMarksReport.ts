/**
 * What a call-help paired run's record says of its requests, as the call-help reports read it:
 * which runs are void (shared-key rule 3) and which presses failed with every request finished.
 */
import type { PairedRow } from "./pairedReport";

/** How a press's error starts when the judge's request threw: refused or failed, after its retry. */
export const JUDGE_FAILED = "The judge's request failed";

export interface RunRecord {
  /** The model requests the record holds, and those of them that ended other than finished. */
  requests: number;
  unfinished: number;
  /** Why the run is void (shared-key rule 3): empty when it counts. */
  voids: string[];
  /** Presses that failed with every request of them finished: never a void. */
  failures: string[];
}

export function recordOf(rows: readonly PairedRow[]): RunRecord {
  const record: RunRecord = { requests: 0, unfinished: 0, voids: [], failures: [] };
  for (const row of rows) {
    for (const [arm, run] of [
      ["main", row.baseline],
      ["the branch", row.candidate],
    ] as const) {
      const press = `${arm}, ${row.id} run ${row.run}`;
      const why = `${run.status}${run.error ? `: ${run.error}` : ""}`;
      if (run.requests === undefined) {
        record.voids.push(`${press} kept none of its requests, so the record can't tell (${why})`);
        continue;
      }
      const models = run.requests.filter((request) => request.kind === "model");
      const unfinished = models.filter((request) => request.outcome !== "finished");
      record.requests += models.length;
      record.unfinished += unfinished.length;
      for (const request of unfinished) {
        record.voids.push(
          `${press}: a request (${request.step ?? "the reply"}) ${request.outcome ?? "with no outcome recorded"}`,
        );
      }
      if (run.status === "done" && models.length === 0)
        record.voids.push(`${press} finished with no model request in the record`);
      if (run.status !== "failed") continue;
      if (run.error?.startsWith(JUDGE_FAILED)) record.voids.push(`${press}: ${run.error}`);
      else if (unfinished.length === 0) record.failures.push(`${press}: ${why}`);
    }
  }
  return record;
}
