/**
 * The speech-to-text engine run somewhere else, talking in messages (#136):
 * both ends of the protocol, as for the embedding model (../embedding/channel).
 * The desktop app runs the engine in an Electron utility process
 * (src/main/transcriber.ts); the evaluation and the tests run it in this one.
 *
 * Requests: { type: "load", id, model }, { type: "open", stream, cloud },
 * { type: "audio", stream, samples }, { type: "finish", id, stream } and
 * { type: "drop", stream }. The other end answers a load or a finish with
 * { type: "done", id } or { type: "error", id, message }, and reports
 * { type: "segment", segment }, { type: "progress", stream, doneMs },
 * { type: "failed", stream, message }, { type: "switched", change },
 * { type: "lost", stream, loss } and { type: "opened", stream } as they happen.
 *
 * A stream opened with a cloud service (#141) goes to it instead of the engine, from the same
 * process: OpenAI's live model needs Silero VAD, which runs here.
 */
import type {
  CloudLoss,
  CloudStream,
  EngineSwitch,
  SpeechSegment,
  Transcriber,
  TranscriberListener,
  TranscriptionModelFiles,
} from "../adapters";
import { createOpenAiStream } from "./cloud/openai";
import type { CloudConnect } from "./cloud/socket";
import { createSonioxStream } from "./cloud/soniox";
import type { CloudStreamHandle } from "./cloud/stream";
import {
  createSpeechHost,
  type SpeechEngine,
  type SpeechHost,
  toFloat,
  type VoiceDetector,
} from "./speech";

export type TranscriberRequest =
  | { type: "load"; id: number; model: TranscriptionModelFiles }
  | { type: "open"; stream: string; cloud: CloudStream }
  | { type: "audio"; stream: string; samples: Int16Array }
  | { type: "finish"; id: number; stream: string }
  | { type: "drop"; stream: string };

export type TranscriberResponse =
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "segment"; segment: SpeechSegment }
  | { type: "progress"; stream: string; doneMs: number }
  | { type: "failed"; stream: string; message: string }
  | { type: "switched"; change: EngineSwitch }
  | { type: "lost"; stream: string; loss: CloudLoss }
  | { type: "opened"; stream: string };

/** A running process that serves the engine, as the side that sends requests sees it. */
export interface TranscriberChannel {
  send(request: TranscriberRequest): void;
  onResponse(listener: (response: TranscriberResponse) => void): void;
  /** It stopped: crashed, ran out of memory, or was stopped. */
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
}

type Pending = { resolve(): void; reject(error: Error): void };

/**
 * The core's `Transcriber`, backed by a channel that `start` opens on the
 * first `load`. If the channel stops by itself, pending requests fail, the
 * listeners hear it, and the next `load` opens a new one.
 */
export function createChannelTranscriber(start: () => TranscriberChannel): Transcriber {
  let channel: TranscriberChannel | undefined;
  let loadedKey: string | undefined;
  let loading: { key: string; done: Promise<void> } | undefined;
  /** Streams going to a cloud service: they need no engine loaded. */
  const clouds = new Set<string>();
  const pending = new Map<number, Pending>();
  const listeners: TranscriberListener[] = [];
  let nextId = 1;

  function open(): TranscriberChannel {
    const started = start();
    started.onResponse((response) => {
      switch (response.type) {
        case "done":
        case "error": {
          const waiting = pending.get(response.id);
          pending.delete(response.id);
          if (response.type === "done") waiting?.resolve();
          else waiting?.reject(new Error(response.message));
          return;
        }
        case "segment":
          for (const listener of listeners) listener.segment(response.segment);
          return;
        case "progress":
          for (const listener of listeners) listener.progress(response.stream, response.doneMs);
          return;
        case "failed":
          for (const listener of listeners) listener.failed(response.stream, response.message);
          return;
        case "switched":
          for (const listener of listeners) listener.switched(response.change);
          return;
        case "lost":
          clouds.delete(response.stream);
          for (const listener of listeners) listener.lost(response.stream, response.loss);
          return;
        case "opened":
          for (const listener of listeners) listener.opened(response.stream);
          return;
      }
    });
    started.onExit((code) => {
      if (channel !== started) return;
      channel = undefined;
      loadedKey = undefined;
      clouds.clear();
      const reason = `The transcription process stopped (exit code ${code}).`;
      const error = new Error(reason);
      for (const waiting of pending.values()) waiting.reject(error);
      pending.clear();
      for (const listener of listeners) listener.stopped(reason);
    });
    return started;
  }

  function request(
    command: { type: "load"; model: TranscriptionModelFiles } | { type: "finish"; stream: string },
  ): Promise<void> {
    channel ??= open();
    const target = channel;
    const id = nextId++;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.send({ ...command, id });
    });
  }

  return {
    async load(model) {
      const key = JSON.stringify(model);
      if (channel && loadedKey === key) return;
      if (loading?.key !== key) {
        const done = request({ type: "load", model })
          .then(() => {
            loadedKey = key;
          })
          .finally(() => {
            if (loading?.done === done) loading = undefined;
          });
        loading = { key, done };
      }
      await loading.done;
    },

    open(stream, cloud) {
      channel ??= open();
      clouds.add(stream);
      channel.send({ type: "open", stream, cloud });
    },

    push(stream, samples) {
      if (!channel || samples.length === 0) return;
      if (loadedKey === undefined && !clouds.has(stream)) return;
      channel.send({ type: "audio", stream, samples });
    },

    finish(stream) {
      if (!channel || (loadedKey === undefined && !clouds.has(stream))) {
        return Promise.reject(new Error("The transcription model isn't loaded."));
      }
      return request({ type: "finish", stream });
    },

    drop(stream) {
      clouds.delete(stream);
      channel?.send({ type: "drop", stream });
    },

    listen(listener) {
      listeners.push(listener);
    },

    close() {
      const stopping = channel;
      channel = undefined;
      loadedKey = undefined;
      clouds.clear();
      stopping?.stop();
    },
  };
}

/** What the serving end needs for streams that go to a cloud service. */
export interface CloudServing {
  connect: CloudConnect;
  /** Silero VAD from its file, for OpenAI's turns. */
  detectors(vadFile: string): Promise<() => VoiceDetector>;
}

/** The serving end's connection to the side that sends requests. */
export interface TranscriberPort {
  onRequest(listener: (request: TranscriberRequest) => void): void;
  respond(response: TranscriberResponse): void;
}

/**
 * Serves an engine over `port`: `createEngine` loads one for the files a
 * load names, and a load of other files replaces it.
 */
export function serveTranscriber(
  createEngine: (model: TranscriptionModelFiles) => Promise<SpeechEngine>,
  port: TranscriberPort,
  cloud?: CloudServing,
): void {
  let host: SpeechHost | undefined;
  let loadedKey: string | undefined;
  /** Loads run one after the other; audio waits for the load before it. */
  let ready: Promise<void> = Promise.resolve();
  const report = {
    segment: (segment: SpeechSegment) => port.respond({ type: "segment", segment }),
    progress: (stream: string, doneMs: number) =>
      port.respond({ type: "progress", stream, doneMs }),
    failed: (stream: string, message: string) => port.respond({ type: "failed", stream, message }),
  };
  const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
  /** Cloud streams, each once its connection is made: requests for one wait for it, in order. */
  const clouds = new Map<string, Promise<CloudStreamHandle | null>>();
  const detectors = new Map<string, Promise<() => VoiceDetector>>();

  async function openCloud(stream: string, config: CloudStream): Promise<CloudStreamHandle | null> {
    const lost = (loss: CloudLoss) => {
      clouds.delete(stream);
      port.respond({ type: "lost", stream, loss });
    };
    if (!cloud) {
      lost("dropped");
      return null;
    }
    const streamReport = {
      segment: report.segment,
      progress: (doneMs: number) => report.progress(stream, doneMs),
      lost,
      opened: () => port.respond({ type: "opened", stream }),
    };
    const options = {
      stream,
      model: config.model,
      apiKey: config.apiKey,
      connect: cloud.connect,
      report: streamReport,
    };
    if (config.service === "soniox") return createSonioxStream(options);
    try {
      let made = detectors.get(config.vad);
      if (!made) {
        made = cloud.detectors(config.vad);
        detectors.set(config.vad, made);
        made.catch(() => detectors.delete(config.vad));
      }
      return createOpenAiStream({ ...options, detector: (await made)() });
    } catch (error) {
      // The process has no logger of its own: its output goes to the app's log.
      console.error("Silero VAD couldn't load for a cloud stream:", messageOf(error));
      lost("dropped");
      return null;
    }
  }

  port.onRequest((request) => {
    const handle = "stream" in request ? clouds.get(request.stream) : undefined;
    if (handle) {
      switch (request.type) {
        case "audio":
          void handle.then((each) => each?.push(request.samples));
          return;
        case "finish":
          void handle
            .then((each) => each?.finish())
            .then(() => port.respond({ type: "done", id: request.id }));
          return;
        case "drop":
          clouds.delete(request.stream);
          void handle.then((each) => each?.drop());
          return;
      }
    }
    switch (request.type) {
      case "open":
        clouds.set(request.stream, openCloud(request.stream, request.cloud));
        return;
      case "load":
        ready = ready.then(async () => {
          try {
            const key = JSON.stringify(request.model);
            if (loadedKey !== key) {
              host?.close();
              host = undefined;
              loadedKey = undefined;
              host = createSpeechHost(await createEngine(request.model), report);
              loadedKey = key;
            }
            port.respond({ type: "done", id: request.id });
          } catch (error) {
            port.respond({ type: "error", id: request.id, message: messageOf(error) });
          }
        });
        return;
      case "audio":
        void ready.then(() => host?.push(request.stream, toFloat(request.samples)));
        return;
      case "finish":
        void ready.then(async () => {
          if (!host) {
            port.respond({ type: "error", id: request.id, message: "No engine is loaded." });
            return;
          }
          try {
            await host.finish(request.stream);
            port.respond({ type: "done", id: request.id });
          } catch (error) {
            port.respond({ type: "error", id: request.id, message: messageOf(error) });
          }
        });
        return;
      case "drop":
        void ready.then(() => host?.drop(request.stream));
        return;
    }
  });
}
