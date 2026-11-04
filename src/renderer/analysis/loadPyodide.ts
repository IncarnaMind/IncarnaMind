import type { loadPyodide as LoadPyodide } from "pyodide";

export async function loadPython(base: string, moduleUrl = `${base}pyodide.mjs`) {
  // The installed files remain separate and unmodified (ADR-0023's licence exception).
  const module: { loadPyodide: typeof LoadPyodide } = await import(/* @vite-ignore */ moduleUrl);
  return module.loadPyodide({
    indexURL: base,
    lockFileURL: `${base}pyodide-lock.json`,
    packageBaseUrl: base,
    fullStdLib: false,
    // Sets and dicts of text iterate in the same order on every run. A Worker has no page for
    // matplotlib's browser backend: it draws into PNGs.
    env: { PYTHONHASHSEED: "0", MPLBACKEND: "Agg" },
    stdout: () => {},
    stderr: () => {},
  });
}
