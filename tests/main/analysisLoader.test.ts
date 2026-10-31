import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { loadPython } from "../../src/renderer/analysis/loadPyodide";

test("the app's loader starts the installed Pyodide engine and executes Python", async () => {
  const require = createRequire(import.meta.url);
  const base = `${dirname(require.resolve("pyodide/package.json"))}${sep}`;
  const python = await loadPython(base, pathToFileURL(join(base, "pyodide.mjs")).href);

  expect(python.runPython("sum([120, 150.5, 80, 60, 40])")).toBe(450.5);
  expect(python.runPython("import sys; sys.version_info[:2] == (3, 14)")).toBe(true);
  expect(typeof python.loadPackage).toBe("function");
  expect(typeof python.pyimport).toBe("function");
  expect(typeof python.FS.writeFile).toBe("function");
});
