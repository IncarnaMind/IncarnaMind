/**
 * The core's `Embedder`, backed by an Electron utility process
 * (./embedderProcess), so the embedding model never runs on the main process.
 * The process starts on the first `load`. If it dies (a crash, or out of
 * memory), pending requests fail, and the core's next `load` starts a new one
 * (see `createChannelEmbedder`).
 */
import type { Embedder } from "../core";
import { createChannelEmbedder, type EmbedderResponse } from "../core/embedding/channel";
import embedderProcessPath from "./embedderProcess?modulePath";
import { startEngineProcess } from "./engineProcess";

export interface UtilityProcessEmbedderOptions {
  /** Runs the deterministic fake model instead of the real one (smoke tests). */
  fake?: boolean;
}

export function createUtilityProcessEmbedder(
  options: UtilityProcessEmbedderOptions = {},
): Embedder {
  return createChannelEmbedder(() => {
    const child = startEngineProcess(
      embedderProcessPath,
      options.fake ? ["--fake"] : [],
      "IncarnaMind embedding",
    );
    return {
      send: (request) => child.postMessage(request),
      onResponse: (listener) =>
        child.on("message", (response: EmbedderResponse) => listener(response)),
      onExit: (listener) => child.on("exit", (code) => listener(code)),
      stop: () => child.kill(),
    };
  });
}
