/**
 * The core's `Transcriber` (#136), backed by an Electron utility process of
 * its own (./transcriberProcess), so speech-to-text never runs on the main
 * process and never waits behind the embedding or reranking model. The
 * process starts on the first `load`, when a Meeting first needs it. If it
 * dies (a crash, or out of memory), the core hears it, marks the gap and
 * loads it again (see `createChannelTranscriber`).
 */
import type { Transcriber } from "../core";
import { createChannelTranscriber, type TranscriberResponse } from "../core/transcription/channel";
import type { FakeTranscriberOptions } from "../core/transcription/fake";
import { startEngineProcess } from "./engineProcess";
import transcriberProcessPath from "./transcriberProcess?modulePath";

export interface UtilityProcessTranscriberOptions {
  /** Runs the fake engine instead of the real one, as these options ask (smoke tests). */
  fake?: FakeTranscriberOptions;
}

export function createUtilityProcessTranscriber(
  options: UtilityProcessTranscriberOptions = {},
): Transcriber {
  const args = options.fake ? ["--fake", `--fake-options=${JSON.stringify(options.fake)}`] : [];
  return createChannelTranscriber(() => {
    const child = startEngineProcess(transcriberProcessPath, args, "IncarnaMind transcription");
    return {
      send: (request) => child.postMessage(request),
      onResponse: (listener) =>
        child.on("message", (response: TranscriberResponse) => listener(response)),
      onExit: (listener) => child.on("exit", (code) => listener(code)),
      stop: () => child.kill(),
    };
  });
}
