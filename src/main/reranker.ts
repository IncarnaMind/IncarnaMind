/**
 * The core's `CrossEncoder`, backed by an Electron utility process of its own
 * (./rerankerProcess), so the built-in reranking model never runs on the main
 * process and never waits behind Passages being embedded. The process starts
 * on the first `load`, once the User has turned the built-in model on. If it
 * dies, pending requests fail and search keeps its own order; the next `load`
 * starts a new one (see `createChannelCrossEncoder`).
 */
import type { CrossEncoder } from "../core";
import { type CrossEncoderResponse, createChannelCrossEncoder } from "../core/reranking/channel";
import { startEngineProcess } from "./engineProcess";
import rerankerProcessPath from "./rerankerProcess?modulePath";

export interface UtilityProcessCrossEncoderOptions {
  /** Runs the deterministic fake model instead of the real one (smoke tests). */
  fake?: boolean;
}

export function createUtilityProcessCrossEncoder(
  options: UtilityProcessCrossEncoderOptions = {},
): CrossEncoder {
  return createChannelCrossEncoder(() => {
    const child = startEngineProcess(
      rerankerProcessPath,
      options.fake ? ["--fake"] : [],
      "IncarnaMind reranking",
    );
    return {
      send: (request) => child.postMessage(request),
      onResponse: (listener) =>
        child.on("message", (response: CrossEncoderResponse) => listener(response)),
      onExit: (listener) => child.on("exit", (code) => listener(code)),
      stop: () => child.kill(),
    };
  });
}
