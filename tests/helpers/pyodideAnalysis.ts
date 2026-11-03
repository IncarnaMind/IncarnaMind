/**
 * An Analysis runtime for live tests: the app's own Python helper (incarnamind.py) in the Pyodide
 * and numpy and pandas a build puts in resources/python, run under Node. It runs what the app's
 * sandboxed window runs, one job at a time; without that window's sandbox, the code is kept from
 * the JavaScript bridge (`js`, `pyodide_js`) instead. Build first, so resources/python exists.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnalysisRuntime } from "../../src/core";
import { loadPython } from "../../src/renderer/analysis/loadPyodide";
import {
  ANALYSIS_LIMITS,
  type AnalysisResult,
  type AnalysisVersions,
  endedBefore,
  noAnalysisOutput,
  readAnalysisEnd,
  readAnalysisOutput,
} from "../../src/shared/analysis";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function pyodideAnalysisRuntime(): Promise<AnalysisRuntime> {
  const folder = join(ROOT, "resources", "python");
  const base = `${folder}${sep}`;
  const python = await loadPython(base, pathToFileURL(join(folder, "pyodide.mjs")).href);
  const listing = JSON.parse(await readFile(join(folder, "packages.json"), "utf8")) as {
    pyodide: string;
    python: string;
    packages: { name: string; version: string; file: string }[];
  };
  await python.loadPackage(
    listing.packages.map((each) => join(folder, each.file)),
    { messageCallback: () => {} },
  );
  const helper = await readFile(
    join(ROOT, "src", "shared", "incarnamind.py"),
    "utf8",
  );
  python.FS.mkdirTree("/incarnamind");
  python.FS.writeFile("/incarnamind/incarnamind.py", helper);
  python.runPython(
    'import sys\nsys.path.insert(0, "/incarnamind")\nsys.modules["js"] = None\nsys.modules["pyodide_js"] = None',
  );
  const runner = python.pyimport("incarnamind");
  const versions: AnalysisVersions = {
    language: "python",
    languageVersion: listing.python,
    runtime: `Pyodide ${listing.pyodide}`,
    packages: Object.fromEntries(listing.packages.map((each) => [each.name, each.version])),
    helper: createHash("sha256").update(helper).digest("hex"),
    app: "live test",
  };
  let queue: Promise<unknown> = Promise.resolve();
  const one = async (job: Parameters<AnalysisRuntime["run"]>[0], signal: AbortSignal) => {
    if (signal.aborted) return endedBefore({ kind: "stopped" });
    const started = Date.now();
    let read: { end?: unknown; output?: unknown } = {};
    try {
      const given = { code: job.code, inputs: job.inputs, limits: ANALYSIS_LIMITS };
      read = JSON.parse(String(runner.run(JSON.stringify(given)))) as typeof read;
    } catch (error) {
      console.error(`The live test's Analysis couldn't run: ${String(error)}`);
    }
    const ms = Date.now() - started;
    const end = readAnalysisEnd(read.end);
    const result: AnalysisResult = end
      ? { end, output: readAnalysisOutput(read.output), ms }
      : {
          end: { kind: "error", message: "The helper gave back no result.", line: null },
          output: noAnalysisOutput(),
          ms,
        };
    return result;
  };
  return {
    languages: [versions],
    run(job, signal) {
      const run = queue.then(() => one(job, signal));
      queue = run.catch(() => undefined);
      return run;
    },
    close() {},
  };
}
