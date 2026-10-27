/**
 * The Worker that runs Python in the analysis window (ADR-0023): Pyodide and
 * numpy and pandas from the bundled files, never a package index, and the
 * helper every job runs through (./incarnamind.py).
 */
import { PYTHON_PATH } from "../../shared/analysisWindow";
import helper from "./incarnamind.py?raw";
import { loadPython } from "./loadPyodide";

const HELPER_FOLDER = "/incarnamind";
const PACKAGES = ["numpy", "pandas"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function start(): Promise<(job: string) => string> {
  const base = new URL(PYTHON_PATH, self.location.href).href;
  const pyodide = await loadPython(base);
  const failed: string[] = [];
  await pyodide.loadPackage(PACKAGES, {
    messageCallback: () => {},
    errorCallback: (message) => failed.push(message),
  });
  if (failed.length > 0) throw new Error(failed.join("\n"));
  pyodide.FS.mkdirTree(HELPER_FOLDER);
  pyodide.FS.writeFile(`${HELPER_FOLDER}/incarnamind.py`, helper);
  pyodide.runPython(`import sys\nsys.path.insert(0, "${HELPER_FOLDER}")`);
  const runner = pyodide.pyimport("incarnamind");
  return (job) => String(runner.run(job));
}

const ready = start();
ready.then(
  () => self.postMessage({ kind: "ready" }),
  (error: unknown) => self.postMessage({ kind: "failed", message: messageOf(error) }),
);

self.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
  if (!isRecord(data) || typeof data.id !== "number" || typeof data.job !== "string") return;
  const { id, job } = data;
  ready.then(
    (run) => {
      try {
        self.postMessage({ kind: "done", id, result: run(job) });
      } catch (error) {
        self.postMessage({ kind: "done", id, failure: messageOf(error) });
      }
    },
    (error: unknown) => self.postMessage({ kind: "done", id, failure: messageOf(error) }),
  );
});
