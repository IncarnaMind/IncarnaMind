/**
 * The citation-style engine's thread (ADR-0016): formatting a few hundred references in a
 * note style takes most of a second, so it happens here, never on the core's thread. It loads
 * the engine from the folder it is given and styles and locales from its pack, parses each
 * style once for each locale it is asked in, and answers one request at a time.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { formatJob } from "./format";
import { createPackStyles } from "./packStyles";
import type { EngineStyle, WorkerRequest, WorkerResponse } from "./protocol";
import { CslEngine, type StyleDescription, StyleError } from "./wasm";

const { folder } = workerData as { folder: string };

let module: WebAssembly.Module | undefined;
let engine: CslEngine | undefined;
const pack = createPackStyles(folder);
const styles = new Map<string, { handle: number; description: StyleDescription }>();

function styleOf(style: EngineStyle) {
  const key = `${style.packId} ${style.locale ?? ""}`;
  const known = styles.get(key);
  if (known) return known;
  module ??= new WebAssembly.Module(readFileSync(join(folder, "engine.wasm")));
  engine ??= new CslEngine(module);
  const { text, locales } = pack.style(style);
  const parsed = engine.parse(text, locales);
  styles.set(key, parsed);
  return parsed;
}

function answer(request: Exclude<WorkerRequest, { close: true }>): WorkerResponse {
  try {
    const { handle, description } = styleOf(request.style);
    const live = engine as CslEngine;
    const output = formatJob(request.job, (each) => live.render(handle, each));
    return { id: request.id, ok: true, description, output };
  } catch (error) {
    // A panic in the engine traps its instance, which can't be used again: start afresh.
    if (error instanceof WebAssembly.RuntimeError) {
      engine = undefined;
      styles.clear();
    }
    return {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      style: error instanceof StyleError,
    };
  }
}

parentPort?.on("message", (request: WorkerRequest) => {
  if ("close" in request) {
    parentPort?.close();
    return;
  }
  parentPort?.postMessage(answer(request));
});
