/**
 * The packaged app's engine check (#1239). Started with `--check-engines=<file>`, the app opens no
 * window of its own and uses a data folder of its own. It starts each engine process as the app
 * does and has it load its modules through the engine's own loaders (../core/engineModules), loads
 * the OS sandbox's module here, and runs a line of Python in the hidden Analyses window. It writes
 * what it found to <file> as JSON and exits, with 1 when anything didn't load. No model is
 * downloaded. e2e/packaged/engines.packaged.ts runs it, and the release runs that before it
 * uploads anything.
 */
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { app } from "electron";
import {
  checkEngineModules,
  ENGINE_CHECK_ARGUMENT,
  type EngineModule,
  type EngineModuleCheck,
} from "../core/engineModules";
import type { AnalysisEnd } from "../shared/analysis";
import { EMBEDDING_PROCESS } from "./embedder";
import { type EngineProcess, startEngineProcess } from "./engineProcess";
import type { FileLogger } from "./log";
import { analysisRuntime, seccompHelper } from "./platform";
import { RERANKING_PROCESS } from "./reranker";
import { SANDBOX_RUNTIME } from "./sandbox";
import { TEXT_RECOGNITION_PROCESS } from "./scanReader";
import { SPEAKER_PROCESS } from "./speakerSeparator";
import { TRANSCRIPTION_PROCESS } from "./transcriber";

export const CHECK_ENGINES_SWITCH = "check-engines";

/** One module, in the process that loads it; `module` is null when the process itself failed. */
export interface EngineCheck {
  process: string;
  module: string | null;
  problem: string | null;
}

export interface EngineCheckReport {
  platform: NodeJS.Platform;
  arch: string;
  checks: EngineCheck[];
}

const ENGINE_PROCESSES: readonly EngineProcess[] = [
  EMBEDDING_PROCESS,
  RERANKING_PROCESS,
  TEXT_RECOGNITION_PROCESS,
  TRANSCRIPTION_PROCESS,
  SPEAKER_PROCESS,
];

/** A process loads its modules in seconds; a slow runner's virus scan of a new library takes longer. */
const ANSWER_LIMIT_MS = 120_000;

function checkProcess(engine: EngineProcess): Promise<EngineCheck[]> {
  return new Promise((resolve) => {
    const child = startEngineProcess(engine, [ENGINE_CHECK_ARGUMENT]);
    let checks: EngineCheck[] | undefined;
    const answer = (found: EngineCheck[]) => {
      if (checks) return;
      checks = found;
      clearTimeout(timer);
      child.kill();
    };
    const failed = (problem: string) =>
      answer([{ process: engine.serviceName, module: null, problem }]);
    const timer = setTimeout(
      () => failed(`didn't answer within ${ANSWER_LIMIT_MS / 1000} s`),
      ANSWER_LIMIT_MS,
    );
    child.once("message", (found: EngineModuleCheck[]) =>
      answer(found.map((each) => ({ process: engine.serviceName, ...each }))),
    );
    child.once("error", (type, location) => failed(`stopped with a ${type} at ${location}`));
    // Settled only once the process has gone: the app exiting while one still ran, or while the
    // Analyses window was open, crashed it on macOS (SIGBUS) two times in three.
    child.once("exit", (code) => {
      failed(`stopped before it answered (exit code ${code})`);
      resolve(checks ?? []);
    });
  });
}

/** What the main process loads itself: the OS sandbox, where there is one (./platform). */
function mainModules(): EngineModule[] {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  const helper = seccompHelper();
  return [
    SANDBOX_RUNTIME,
    ...(helper === undefined
      ? []
      : [
          {
            name: "sandbox-runtime's seccomp helper",
            load: () => access(helper, constants.X_OK),
          },
        ]),
  ];
}

function problemOf(end: AnalysisEnd): string | null {
  switch (end.kind) {
    case "done":
      return null;
    case "error":
      return end.message;
    case "unavailable":
      return end.detail;
    default:
      return `the run ended: ${end.kind}`;
  }
}

async function checkPython(log: FileLogger): Promise<EngineCheck> {
  const runtime = analysisRuntime(log);
  const { end } = await runtime
    .run(
      {
        language: "python",
        code: "import numpy, pandas\nprint(numpy.__version__, pandas.__version__)",
        inputs: [],
      },
      new AbortController().signal,
    )
    .finally(() => runtime.close());
  return {
    process: "Analyses window",
    module: "Pyodide, numpy and pandas",
    problem: problemOf(end),
  };
}

export async function checkEngines(log: FileLogger): Promise<EngineCheck[]> {
  const [processes, main, python] = await Promise.all([
    Promise.all(ENGINE_PROCESSES.map(checkProcess)),
    checkEngineModules(mainModules()),
    checkPython(log),
  ]);
  return [
    ...processes.flat(),
    ...main.map((each) => ({ process: "main process", ...each })),
    python,
  ];
}

/** Writes the report and exits; any error on the way is printed and exits with 1. */
export async function runEngineCheck(report: string, log: FileLogger): Promise<void> {
  const fail = (error: unknown) => {
    log.exception("engineCheck.failed", error);
    console.error("The engine check failed:", error);
    app.exit(1);
  };
  // Electron answers an uncaught error with a dialog, which nobody closes on a runner.
  process.on("uncaughtException", fail);
  try {
    const checks = await checkEngines(log);
    const written: EngineCheckReport = { platform: process.platform, arch: process.arch, checks };
    await writeFile(report, JSON.stringify(written, null, 2));
    app.exit(checks.some((each) => each.problem !== null) ? 1 : 0);
  } catch (error) {
    fail(error);
  } finally {
    process.off("uncaughtException", fail);
  }
}
