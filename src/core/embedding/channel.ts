/**
 * The built-in embedding model run somewhere else, talking in messages: both
 * ends of the protocol, so every host speaks the same one. The desktop app
 * runs the model in an Electron utility process (src/main/embedder.ts and
 * src/main/embedderProcess.ts); the evaluation (eval/) runs it on a Node
 * worker thread.
 *
 * Requests are { id, type: "load", files } or { id, type: "embed", text };
 * the other end answers { id, vector } (or { id } for a load) or { id, error },
 * taking one request at a time, in order (ADR-0009): a query waits for at
 * most the Passage in progress.
 */
import type { Embedder, EmbeddingModelFiles } from "../adapters";
import { ChannelClosedError, channelRequests } from "../channelRequests";
import { channelStops } from "../channelStop";

export type EmbedderCommand =
  | { type: "load"; files: EmbeddingModelFiles }
  | { type: "embed"; text: string };

/** `id` pairs a response with its request. */
export type EmbedderRequest = EmbedderCommand & { id: number };

/** A vector for "embed", nothing more for "load", or what went wrong. */
export interface EmbedderResponse {
  id: number;
  vector?: Float32Array;
  error?: string;
}

/** A running process or thread that serves the model, as the side that sends requests sees it. */
export interface EmbedderChannel {
  send(request: EmbedderRequest): void;
  onResponse(listener: (response: EmbedderResponse) => void): void;
  /** It stopped: crashed, ran out of memory, or was stopped. */
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
}

/**
 * The core's `Embedder`, backed by a channel that `start` opens. The channel
 * opens on the first `load`. If it stops, or is closed, what is still out on
 * it fails, and the core's next `load` opens a new one.
 */
export function createChannelEmbedder(start: () => EmbedderChannel): Embedder {
  let channel: EmbedderChannel | undefined;
  /** The files the open channel has loaded. */
  let loadedKey: string | undefined;
  let loading: { key: string; done: Promise<void> } | undefined;
  const stops = channelStops<EmbedderChannel>();
  const requests = channelRequests<EmbedderChannel, EmbedderResponse>();

  function open(): EmbedderChannel {
    const started = start();
    started.onResponse((response) => {
      requests.answer(response.id, response);
      stops.answered(started, response.id);
    });
    started.onExit((code) => {
      requests.rejectAll(started, new Error(`The embedding process stopped (exit code ${code}).`));
      if (channel !== started) return;
      channel = undefined;
      loadedKey = undefined;
    });
    return started;
  }

  function request(command: EmbedderCommand): Promise<EmbedderResponse> {
    channel ??= open();
    const target = channel;
    return requests
      .add(target, (id) => target.send({ ...command, id }))
      .then((response) => {
        if (response.error !== undefined) throw new Error(response.error);
        return response;
      });
  }

  async function loadFiles(files: EmbeddingModelFiles, key: string): Promise<void> {
    await request({ type: "load", files });
    loadedKey = key;
  }

  return {
    async load(files) {
      const key = JSON.stringify(files);
      if (channel && loadedKey === key) return;
      if (loading?.key !== key) {
        const done = loadFiles(files, key).finally(() => {
          if (loading?.done === done) loading = undefined;
        });
        loading = { key, done };
      }
      await loading.done;
    },

    async embed(text) {
      if (!channel || loadedKey === undefined) throw new Error("The embedding model isn't loaded.");
      const { vector } = await request({ type: "embed", text });
      if (!vector) throw new Error("The embedding process returned no vector.");
      return new Float32Array(vector);
    },

    close() {
      const stopping = channel;
      channel = undefined;
      loadedKey = undefined;
      loading = undefined;
      if (!stopping) return;
      const inFlight = new Set(requests.out(stopping));
      requests.rejectAll(stopping, new ChannelClosedError("The embedding model was stopped."));
      stops.close(stopping, inFlight);
    },
  };
}

/** The serving end's connection to the side that sends requests. */
export interface EmbedderPort {
  onRequest(listener: (request: EmbedderRequest) => void): void;
  respond(response: EmbedderResponse): void;
}

/** Serves `embedder` over `port`: one request at a time, in the order they came. */
export function serveEmbedder(embedder: Embedder, port: EmbedderPort): void {
  async function handle(request: EmbedderRequest): Promise<EmbedderResponse> {
    try {
      if (request.type === "load") {
        await embedder.load(request.files);
        return { id: request.id };
      }
      return { id: request.id, vector: await embedder.embed(request.text) };
    } catch (error) {
      return { id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let queue = Promise.resolve();
  port.onRequest((request) => {
    queue = queue.then(async () => port.respond(await handle(request)));
  });
}
