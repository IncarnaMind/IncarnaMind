/**
 * The Worker that runs Python in the analysis window (ADR-0023): Pyodide and
 * numpy and pandas from the bundled files, never a package index, and the
 * helper every job runs through (./incarnamind.py). The other bundled
 * packages (scipy, statsmodels, scikit-learn, matplotlib) are loaded for a job
 * only when its code uses them, so a job that needs only pandas starts as fast
 * as it did without them (ADR-0025).
 */
import { PYTHON_PATH } from "../../shared/analysisWindow";
import helper from "./incarnamind.py?raw";
import { loadPython } from "./loadPyodide";

const HELPER_FOLDER = "/incarnamind";
const BASE_PACKAGES = ["numpy", "pandas"];

type Python = Awaited<ReturnType<typeof loadPython>>;
type Run = (job: string, started: () => void) => Promise<string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function load(pyodide: Python, packages: string[]): Promise<void> {
  const failed: string[] = [];
  await pyodide.loadPackage(packages, {
    messageCallback: () => {},
    errorCallback: (message) => failed.push(message),
  });
  if (failed.length > 0) throw new Error(failed.join("\n"));
}

/** The bundled packages not loaded yet, each with the names code imports it by, from packages.json. */
function extraPackages(listing: unknown, loaded: object): Record<string, string[]> {
  const packages = isRecord(listing) && Array.isArray(listing.packages) ? listing.packages : [];
  const extras: Record<string, string[]> = {};
  for (const each of packages) {
    if (!isRecord(each) || typeof each.name !== "string" || each.name in loaded) continue;
    const imports = Array.isArray(each.imports) ? each.imports : [];
    extras[each.name] = imports.filter((name): name is string => typeof name === "string");
  }
  return extras;
}

async function start(): Promise<Run> {
  const base = new URL(PYTHON_PATH, self.location.href).href;
  const [pyodide, listing] = await Promise.all([
    loadPython(base),
    fetch(`${base}packages.json`).then((response) => response.json() as Promise<unknown>),
  ]);
  await load(pyodide, BASE_PACKAGES);
  pyodide.FS.mkdirTree(HELPER_FOLDER);
  pyodide.FS.writeFile(`${HELPER_FOLDER}/incarnamind.py`, helper);
  pyodide.runPython(`import sys\nsys.path.insert(0, "${HELPER_FOLDER}")`);
  const runner = pyodide.pyimport("incarnamind");
  runner.declare_packages(JSON.stringify(extraPackages(listing, pyodide.loadedPackages)));
  return async (job, started) => {
    const { code } = JSON.parse(job) as { code: string };
    const packages = JSON.parse(String(runner.packages_for(code))) as string[];
    if (packages.length > 0) {
      await load(pyodide, packages);
      if (packages.includes("matplotlib")) runner.prepare_plots();
    }
    started();
    return String(runner.run(job));
  };
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
    async (run) => {
      try {
        const result = await run(job, () => self.postMessage({ kind: "started", id }));
        self.postMessage({ kind: "done", id, result });
      } catch (error) {
        self.postMessage({ kind: "done", id, failure: messageOf(error) });
      }
    },
    (error: unknown) => self.postMessage({ kind: "done", id, failure: messageOf(error) }),
  );
});
