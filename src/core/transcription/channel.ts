/**
 * The speech-to-text engine run somewhere else, talking in messages (#136):
 * both ends of the protocol, as for the embedding model (../embedding/channel).
 * The desktop app runs the engine in an Electron utility process
 * (src/main/transcriber.ts); the evaluation and the tests run it in this one.
 *
 * Requests: { type: "load", id, model }, { type: "open", stream, cloud },
 * { type: "words", stream, words }, { type: "audio", stream, samples },
 * { type: "finish", id, stream }, { type: "drop", stream } and
 * { type: "dropCloud", id, streams }. The other end answers a load, a finish or
 * a dropCloud with { type: "done", id } or { type: "error", id,
 * message }, and reports { type: "segment", segment }, { type: "progress",
 * stream, doneMs }, { type: "failed", stream, message }, { type: "switched",
 * change }, { type: "lost", stream, loss } and { type: "opened", stream } as
 * they happen.
 *
 * A stream opened with a cloud service (#141, #866) goes to it instead of the engine, from the
 * same process: OpenAI's live model needs Silero VAD, which runs here.
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
import { createAssemblyAiStream } from "./cloud/assemblyai";
import { createDeepgramStream } from "./cloud/deepgram";
import { createElevenLabsStream } from "./cloud/elevenlabs";
import { createGeminiStream } from "./cloud/gemini";
import { createGladiaStream } from "./cloud/gladia";
import { createOpenAiStream } from "./cloud/openai";
import { createQwenStream } from "./cloud/qwen";
import type { CloudConnect } from "./cloud/socket";
import { createSonioxStream } from "./cloud/soniox";
import { createSpeechmaticsStream } from "./cloud/speechmatics";
import type { CloudStreamHandle } from "./cloud/stream";
import { createXaiStream } from "./cloud/xai";
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
  | { type: "words"; stream: string; words: readonly string[] }
  | { type: "audio"; stream: string; samples: Int16Array }
  | { type: "finish"; id: number; stream: string }
  | { type: "drop"; stream: string }
  | { type: "dropCloud"; id: number; streams: readonly string[] };

export type TranscriberResponse =
  | { type: "done"; id: number }
  | { type: "error"; id: number; message: string }
  | { type: "segment"; segment: SpeechSegment }
  | { type: "progress"; stream: string; doneMs: number; heardMs?: number }
  | { type: "failed"; stream: string; message: string }
  | { type: "switched"; change: EngineSwitch }
  | { type: "lost"; stream: string; loss: CloudLoss }
  | { type: "opened"; stream: string };

/**
 * A running process that serves the engine, as the side that sends requests sees it. Its exit code
 * 0 is the process's word for an idle unload, never a crash: a host's own exit must use another
 * code, and a signal (null) is a crash or a stop too.
 */
export interface TranscriberChannel {
  send(request: TranscriberRequest): void;
  onResponse(listener: (response: TranscriberResponse) => void): void;
  /** It stopped: crashed, ran out of memory, was stopped, or ended its engine idle with code 0 (#2673). */
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
}

type Pending = { resolve(): void; reject(error: Error): void };

/** A request the idle unload ended before the process answered it (#2673). */
class IdleUnloadError extends Error {}

/**
 * How long the process has to confirm it dropped cloud streams before it is stopped (#2702). The
 * confirm is one message each way and a socket's close, which waits on no network. On a loaded CI
 * machine a few turns of the event loop once took over 300 ms, so this allows several times
 * that, and still keeps a User who said no waiting only briefly.
 */
const DROP_CONFIRM_MS = 2000;

/** Calls `late` once a confirm is overdue; what it returns calls that off. */
export type ConfirmDeadline = (late: () => void) => () => void;

const confirmWithin: ConfirmDeadline = (late) => {
  const timer = setTimeout(late, DROP_CONFIRM_MS);
  return () => clearTimeout(timer);
};

/**
 * The core's `Transcriber`, backed by a channel that `start` opens on the
 * first `load`. If the channel stops by itself, pending requests fail, the
 * listeners hear it, and the next `load` opens a new one. A channel that
 * doesn't confirm a `dropCloud` by `deadline` is stopped the same way.
 */
export function createChannelTranscriber(
  start: () => TranscriberChannel,
  deadline: ConfirmDeadline = confirmWithin,
): Transcriber {
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
          for (const listener of listeners)
            listener.progress(response.stream, response.doneMs, response.heardMs);
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
      if (code === 0) unloaded(started);
      else gone(started, `The transcription process stopped (exit code ${code}).`);
    });
    return started;
  }

  function gone(started: TranscriberChannel, reason: string): void {
    if (channel !== started) return;
    channel = undefined;
    loadedKey = undefined;
    clouds.clear();
    const error = new Error(reason);
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    for (const listener of listeners) listener.stopped(reason);
  }

  /** The process ended its work on purpose: its engine was idle (#2673), which is not a crash. */
  function unloaded(started: TranscriberChannel): void {
    if (channel !== started) return;
    channel = undefined;
    loadedKey = undefined;
    clouds.clear();
    const error = new IdleUnloadError("The transcription process unloaded its models while idle.");
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
    for (const listener of listeners) listener.unloaded();
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
      // Always ask, even for the files the process runs: the ask tells it a Meeting needs the
      // engine, so an idle unload waits (#2673), and it answers at once when they are loaded.
      if (loading?.key !== key) {
        const done = request({ type: "load", model })
          // The process may end idle between this ask leaving and its answer: the engine it named
          // never heard it, so it is asked once more, of the process the ask starts (#2673).
          .catch((error: unknown) => {
            if (!(error instanceof IdleUnloadError)) throw error;
            return request({ type: "load", model });
          })
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

    words(stream, words) {
      if (!channel || loadedKey === undefined || clouds.has(stream)) return;
      channel.send({ type: "words", stream, words });
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

    dropCloud(streams) {
      for (const stream of streams) clouds.delete(stream);
      const target = channel;
      if (!target || streams.length === 0) return Promise.resolve();
      const id = nextId++;
      return new Promise<void>((resolve) => {
        const cancel = deadline(() => {
          pending.delete(id);
          gone(
            target,
            "The transcription process didn't confirm in time that it dropped its cloud streams, so it was stopped.",
          );
          target.stop();
          resolve();
        });
        const settle = () => {
          cancel();
          resolve();
        };
        pending.set(id, { resolve: settle, reject: settle });
        target.send({ type: "dropCloud", id, streams });
      });
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

/**
 * How long the engine and its models stay loaded once the last stream is finished (#2673): a
 * Meeting saved and left alone gives the computer its memory back. The next Meeting loads them
 * again, its audio waiting meanwhile as it does while the engine starts.
 */
const IDLE_UNLOAD_MS = 5 * 60_000;

export interface ServingOptions {
  /** The idle wait, for tests that would not wait minutes. */
  idleMs?: number;
  /**
   * Called once the engine is closed and forgotten: the app ends its process here, which is what
   * frees the native models a closed recognizer still holds.
   */
  unloaded?(): void;
}

/** What the serving end needs for streams that go to a cloud service. */
export interface CloudServing {
  connect: CloudConnect;
  /** For the requests a service needs before its socket: Gladia's session. */
  fetch: typeof fetch;
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
 * load names, and a load of other files replaces it. With no stream open for
 * `IDLE_UNLOAD_MS`, the engine is closed, and `unloaded` hears it.
 */
export function serveTranscriber(
  createEngine: (model: TranscriptionModelFiles) => Promise<SpeechEngine>,
  port: TranscriberPort,
  cloud?: CloudServing,
  serving: ServingOptions = {},
): void {
  let host: SpeechHost | undefined;
  let loadedKey: string | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  /** Cloud streams open now: the idle unload must not end one, nor the process serving it. */
  const cloudOpen = new Set<string>();
  /** Loads run one after the other; audio waits for the load before it. */
  let ready: Promise<void> = Promise.resolve();
  const report = {
    segment: (segment: SpeechSegment) => port.respond({ type: "segment", segment }),
    progress: (stream: string, doneMs: number, heardMs?: number) =>
      port.respond({
        type: "progress",
        stream,
        doneMs,
        ...(heardMs !== undefined && { heardMs }),
      }),
    failed: (stream: string, message: string) => port.respond({ type: "failed", stream, message }),
  };
  const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function cancelIdle(): void {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
  }

  /** An idle engine, a cloud stream with none: the wait to unload starts again. */
  function maybeIdle(): void {
    cancelIdle();
    if (!host?.idle() || cloudOpen.size > 0) return;
    idle = setTimeout(unload, serving.idleMs ?? IDLE_UNLOAD_MS);
    idle.unref();
  }

  function unload(): void {
    idle = undefined;
    if (!host?.idle() || cloudOpen.size > 0) return;
    host.close();
    host = undefined;
    loadedKey = undefined;
    serving.unloaded?.();
  }

  /** Cloud streams, each once its connection is made: requests for one wait for it, in order. */
  const clouds = new Map<string, Promise<CloudStreamHandle | null>>();
  /**
   * What came for a cloud stream before it was made: one that ended with no audio (stopped
   * while OpenAI's voice detector loads) is never connected, so the key goes nowhere (#866).
   */
  const before = new Map<string, { audio: boolean; ended: boolean }>();
  const detectors = new Map<string, Promise<() => VoiceDetector>>();
  /**
   * Cloud audio received and not sent yet, by stream. It goes on a later turn, so a drop that
   * arrives with it is handled first and none of it is sent (#2702).
   */
  const outbox = new Map<string, Int16Array[]>();
  let sendQueued = false;

  function sendHeld(stream: string): void {
    const audio = outbox.get(stream);
    outbox.delete(stream);
    const handle = clouds.get(stream);
    if (!audio || !handle) return;
    void handle.then((each) => {
      for (const samples of audio) each?.push(samples);
    });
  }

  /** Forgets a cloud stream and its audio not sent: resolves once its socket is closed. */
  function forgetCloud(stream: string): Promise<void> {
    outbox.delete(stream);
    const handle = clouds.get(stream);
    clouds.delete(stream);
    const early = before.get(stream);
    if (early) early.ended = true;
    const closed = handle ? handle.then((each) => each?.drop()) : Promise.resolve();
    // One still being made, as while OpenAI's voice detector loads, sees `ended` and never
    // connects: the confirm doesn't wait for it.
    return early ? Promise.resolve() : closed;
  }

  async function openCloud(stream: string, config: CloudStream): Promise<CloudStreamHandle | null> {
    const lost = (loss: CloudLoss) => {
      clouds.delete(stream);
      cloudOpen.delete(stream);
      port.respond({ type: "lost", stream, loss });
      maybeIdle();
    };
    if (!cloud) {
      lost("dropped");
      return null;
    }
    const streamReport = {
      segment: report.segment,
      progress: (doneMs: number, heardMs?: number) => report.progress(stream, doneMs, heardMs),
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
    switch (config.service) {
      case "soniox":
        return createSonioxStream(options);
      case "qwen":
        return createQwenStream({ ...options, url: config.url });
      case "deepgram":
        return createDeepgramStream({ ...options, url: config.url });
      case "assemblyai":
        return createAssemblyAiStream(options);
      case "gemini":
        return createGeminiStream(options);
      case "elevenlabs":
        return createElevenLabsStream(options);
      case "speechmatics":
        return createSpeechmaticsStream(options);
      case "gladia":
        return createGladiaStream({ ...options, languages: config.languages, fetch: cloud.fetch });
      case "xai":
        return createXaiStream(options);
    }
    try {
      let made = detectors.get(config.vad);
      if (!made) {
        made = cloud.detectors(config.vad);
        detectors.set(config.vad, made);
        made.catch(() => detectors.delete(config.vad));
      }
      const detector = (await made)();
      if (before.get(stream)?.ended) return null;
      return createOpenAiStream({ ...options, detector });
    } catch (error) {
      // The process has no logger of its own: its output goes to the app's log.
      console.error("Silero VAD couldn't load for a cloud stream:", messageOf(error));
      lost("dropped");
      return null;
    }
  }

  port.onRequest((request) => {
    cancelIdle();
    const handle = "stream" in request ? clouds.get(request.stream) : undefined;
    if (handle) {
      const early = "stream" in request ? before.get(request.stream) : undefined;
      switch (request.type) {
        case "audio": {
          if (early) early.audio = true;
          const audio = outbox.get(request.stream);
          if (audio) audio.push(request.samples);
          else outbox.set(request.stream, [request.samples]);
          if (!sendQueued) {
            sendQueued = true;
            setTimeout(() => {
              sendQueued = false;
              for (const stream of [...outbox.keys()]) sendHeld(stream);
            }, 0);
          }
          return;
        }
        case "finish":
          if (early && !early.audio) early.ended = true;
          sendHeld(request.stream);
          void handle
            .then((each) => each?.finish())
            .then(() => port.respond({ type: "done", id: request.id }))
            .finally(() => {
              cloudOpen.delete(request.stream);
              maybeIdle();
            });
          return;
        case "drop":
          cloudOpen.delete(request.stream);
          void forgetCloud(request.stream).finally(maybeIdle);
          return;
      }
    }
    switch (request.type) {
      case "dropCloud":
        for (const stream of request.streams) cloudOpen.delete(stream);
        void Promise.all(request.streams.map(forgetCloud))
          .then(() => port.respond({ type: "done", id: request.id }))
          .finally(maybeIdle);
        return;
      case "open": {
        const { stream } = request;
        cloudOpen.add(stream);
        before.set(stream, { audio: false, ended: false });
        const made = openCloud(stream, request.cloud);
        clouds.set(stream, made);
        const forget = () => before.delete(stream);
        void made.then(forget, forget);
        return;
      }
      case "load":
        ready = ready.then(async () => {
          try {
            const key = JSON.stringify(request.model);
            if (loadedKey !== key) {
              host?.close();
              host = undefined;
              loadedKey = undefined;
              host = createSpeechHost(await createEngine(request.model), report, {
                onIdle: maybeIdle,
              });
              loadedKey = key;
            }
            port.respond({ type: "done", id: request.id });
            // A Meeting that never sends audio would otherwise keep the engine: no host event
            // follows this load to start the wait again.
            maybeIdle();
          } catch (error) {
            port.respond({ type: "error", id: request.id, message: messageOf(error) });
          }
        });
        return;
      case "words":
        void ready.then(() => host?.words(request.stream, request.words));
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
        void ready.then(() => {
          host?.drop(request.stream);
          // A stream that finished already leaves the host unchanged, and with it no idle event.
          maybeIdle();
        });
        return;
    }
  });
}
