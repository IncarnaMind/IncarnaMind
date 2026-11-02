/**
 * The desktop app's side of `run_code` (ADR-0025), which it passes the core as its `codeRuntime`
 * adapter: the runner, and IncarnaMind's own Python where this build has one.
 */
import type { CodeHost, PythonRuntimeManifest } from "../../core/runCode";
import helper from "../../shared/incarnamind.py?raw";
import { createPythonRuntime } from "./python";
import { createCodeRunner } from "./runner";

export interface CodeHostOptions {
  /** The runtime this build goes with; null: bash only. */
  python: PythonRuntimeManifest | null;
  /** The font plots draw what matplotlib's own fonts lack with; null: none. */
  font: string | null;
  appVersion: string;
  /** How long one run may take; the runner's own limit unless a test says. */
  timeLimitMs?: number;
}

export function createCodeHost(options: CodeHostOptions): CodeHost {
  return {
    start(context) {
      const python = options.python
        ? createPythonRuntime({
            dataDir: context.dataDir,
            manifest: options.python,
            executor: context.executor,
            fetch: context.fetch,
            emitStatus: context.emitStatus,
            ...(context.log && { log: context.log }),
          })
        : null;
      const runner = createCodeRunner({
        executor: context.executor,
        tempDir: context.tempDir,
        python,
        helper,
        font: options.font,
        appVersion: options.appVersion,
        ...(options.timeLimitMs !== undefined && { timeLimitMs: options.timeLimitMs }),
      });
      return { runner, python };
    },
  };
}
