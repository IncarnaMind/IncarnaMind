import type { loadPyodide as LoadPyodide } from "pyodide";

export async function loadPython(base: string, moduleUrl = `${base}pyodide.mjs`) {
  // The installed files remain separate and unmodified (ADR-0023's licence exception).
  const module: { loadPyodide: typeof LoadPyodide } = await import(/* @vite-ignore */ moduleUrl);
  return module.loadPyodide({
    indexURL: base,
    lockFileURL: `${base}pyodide-lock.json`,
    packageBaseUrl: base,
    fullStdLib: false,
    env: { PYTHONHASHSEED: "0" },
    stdout: () => {},
    stderr: () => {},
  });
}
