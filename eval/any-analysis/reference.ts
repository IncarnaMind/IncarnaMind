/**
 * Works out each task's reference answer (README.md): writes its English
 * inputs' data into a temporary folder, runs the task's reference.py on it in
 * Pyodide with the packages the build put in resources/python, and writes
 * reference.json beside it, with the hash of each language's inputs. The app
 * never sees reference.py or what it gives.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs \
 *     eval/any-analysis/reference.ts [F01 S02 …]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPython } from "../../src/renderer/analysis/loadPyodide";
import { inputsHash } from "./inputs";
import type { Reference, ReferenceValue, Task, TaskLanguage } from "./task";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const taskFolder = (id: string): string => join(root, "eval/any-analysis/tasks", id);

/** What reference scripts import, as Pyodide names their packages. */
const PACKAGES = ["numpy", "pandas", "scipy", "statsmodels", "scikit-learn"];

async function python() {
  const require = createRequire(import.meta.url);
  const base = `${dirname(require.resolve("pyodide/package.json"))}${sep}`;
  const wheels = join(root, "resources", "python");
  const pyodide = await loadPython(base, pathToFileURL(join(base, "pyodide.mjs")).href);
  // The build's own wheels (scripts/pythonRuntime.ts): nothing is fetched.
  const lock = JSON.parse(await readFile(join(wheels, "pyodide-lock.json"), "utf8")) as {
    packages: Record<string, { file_name: string }>;
  };
  const files = PACKAGES.map((name) => lock.packages[name]?.file_name);
  if (files.some((file) => !file)) throw new Error("resources/python lacks a package: build first.");
  const needed = new Set<string>();
  const add = (name: string) => {
    const entry = lock.packages[name] as { file_name: string; depends?: string[] } | undefined;
    if (!entry || needed.has(name)) return;
    needed.add(name);
    for (const each of entry.depends ?? []) add(each);
  };
  for (const name of PACKAGES) add(name);
  await pyodide.loadPackage(
    [...needed].map((name) => join(wheels, lock.packages[name]?.file_name ?? "")),
    { messageCallback: () => {} },
  );
  return pyodide;
}

/** The values reference.py gives for `task`, from its English inputs' data. */
async function referenceValues(
  pyodide: Awaited<ReturnType<typeof python>>,
  task: Task,
): Promise<Record<string, ReferenceValue>> {
  const folder = await mkdtemp(join(tmpdir(), `incarnamind-any-analysis-${task.id}-`));
  try {
    for (const [name, text] of Object.entries(task.inputs("en").data)) {
      await writeFile(join(folder, name), text);
    }
    const mount = `/data/${task.id}`;
    pyodide.FS.mkdirTree(mount);
    pyodide.mountNodeFS(mount, folder);
    const script = await readFile(join(taskFolder(task.id), "reference.py"), "utf8");
    const scope = pyodide.toPy({ DATA: mount });
    pyodide.runPython(script, { globals: scope });
    const json = pyodide.runPython("import json\njson.dumps(result, allow_nan=False)", {
      globals: scope,
    }) as string;
    pyodide.FS.unmount(mount);
    return JSON.parse(json) as Record<string, ReferenceValue>;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The tasks named, each from its own folder, or every task. */
async function tasksNamed(ids: readonly string[]): Promise<readonly Task[]> {
  if (ids.length === 0) return (await import("./tasks")).TASKS;
  return Promise.all(
    ids.map(
      async (id) =>
        ((await import(pathToFileURL(join(taskFolder(id), "task.ts")).href)) as { task: Task }).task,
    ),
  );
}

export async function writeReferences(ids: readonly string[]): Promise<void> {
  const chosen = await tasksNamed(ids);
  const pyodide = await python();
  for (const task of chosen) {
    const started = Date.now();
    const values = await referenceValues(pyodide, task);
    const languages: TaskLanguage[] = task.question.zh ? ["en", "zh"] : ["en"];
    const reference: Reference = {
      task: task.id,
      inputs: Object.fromEntries(
        languages.map((language) => [language, inputsHash(task.inputs(language))]),
      ),
      values,
    };
    await writeFile(
      join(taskFolder(task.id), "reference.json"),
      `${JSON.stringify(reference, null, 2)}\n`,
    );
    console.log(`${task.id}: ${Object.keys(values).length} values, ${Date.now() - started} ms`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await writeReferences(process.argv.slice(2));
}
