/**
 * A stand-in for the analysis sandbox, for unit tests: it runs no code. How
 * each job ends and what it gives come from `answer`; "hang" is code that
 * never ends, which the job's time limit or its signal stops, as in the real
 * one. Jobs run one at a time, as there.
 */
import {
  ANALYSIS_TIME_LIMIT_MS,
  type AnalysisEnd,
  type AnalysisJob,
  type AnalysisOutput,
  type AnalysisResult,
  type AnalysisVersions,
  endedBefore,
  noAnalysisOutput,
} from "../../shared/analysis";
import type { AnalysisRuntime } from "../adapters";

export type FakeAnswer = { end?: AnalysisEnd; output?: Partial<AnalysisOutput> } | "hang";

export interface FakeAnalysisOptions {
  /** Defaults to every job done, printing how many inputs it had. */
  answer?: (job: AnalysisJob) => FakeAnswer;
  /** Every run is unavailable, as on a computer whose sandbox can't start. */
  unavailable?: boolean;
}

export const FAKE_PYTHON: AnalysisVersions = {
  language: "python",
  languageVersion: "3.14.2",
  runtime: "Fake",
  packages: { numpy: "2.4.6", pandas: "3.0.2" },
  helper: "fake",
  app: "test",
};

export interface FakeAnalysisRuntime extends AnalysisRuntime {
  /** The jobs run so far, in order. */
  readonly jobs: readonly AnalysisJob[];
  /** How many times it was closed. */
  readonly closes: number;
}

const printsInputs = (job: AnalysisJob): FakeAnswer => ({
  output: { printed: `${job.inputs.length} inputs\n` },
});

export function createFakeAnalysisRuntime(options: FakeAnalysisOptions = {}): FakeAnalysisRuntime {
  const answer = options.answer ?? printsInputs;
  const jobs: AnalysisJob[] = [];
  let closes = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const one = (job: AnalysisJob, signal: AbortSignal): Promise<AnalysisResult> => {
    if (signal.aborted) return Promise.resolve(endedBefore({ kind: "stopped" }));
    jobs.push(job);
    const given = answer(job);
    if (given !== "hang") {
      return Promise.resolve({
        end: given.end ?? { kind: "done" },
        output: { ...noAnalysisOutput(), ...given.output },
        ms: 1,
      });
    }
    const limitMs = job.timeLimitMs ?? ANALYSIS_TIME_LIMIT_MS;
    return new Promise((resolve) => {
      const end = (ended: AnalysisEnd) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        resolve(endedBefore(ended));
      };
      const stop = () => end({ kind: "stopped" });
      const timer = setTimeout(() => end({ kind: "timed-out", limitMs }), limitMs);
      signal.addEventListener("abort", stop, { once: true });
    });
  };

  return {
    languages: [FAKE_PYTHON],
    get jobs() {
      return jobs;
    },
    get closes() {
      return closes;
    },
    run(job, signal) {
      if (options.unavailable) {
        return Promise.resolve(
          endedBefore({ kind: "unavailable", reason: "start", detail: "The fake has no sandbox." }),
        );
      }
      const result = queue.then(() => one(job, signal));
      queue = result;
      return result;
    },
    close() {
      closes++;
    },
  };
}
