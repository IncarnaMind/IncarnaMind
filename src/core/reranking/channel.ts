/**
 * The built-in reranking model run somewhere else, talking in messages: both
 * ends of the protocol, as for the embedding model (see ../embedding/channel).
 * The desktop app runs it in an Electron utility process of its own
 * (src/main/reranker.ts and src/main/rerankerProcess.ts); the evaluation
 * (eval/) runs it on a Node worker thread.
 *
 * Requests are { id, type: "load", files } or { id, type: "score", query,
 * texts }; the other end answers { id, scores } (or { id, device } for a load)
 * or { id, error }, taking one request at a time, in order.
 */
import type { CrossEncoder, RerankingDevice, RerankingModelFiles } from "../adapters";
import { ChannelClosedError, channelRequests } from "../channelRequests";
import { channelStops } from "../channelStop";

export type CrossEncoderCommand =
  | { type: "load"; files: RerankingModelFiles }
  | { type: "score"; query: string; texts: string[] };

/** `id` pairs a response with its request. */
export type CrossEncoderRequest = CrossEncoderCommand & { id: number };

/** Scores for "score", where the model runs for "load", or what went wrong. */
export interface CrossEncoderResponse {
  id: number;
  scores?: number[];
  device?: RerankingDevice;
  error?: string;
}

/** A running process or thread that serves the model, as the side that sends requests sees it. */
export interface CrossEncoderChannel {
  send(request: CrossEncoderRequest): void;
  onResponse(listener: (response: CrossEncoderResponse) => void): void;
  /** It stopped: crashed, ran out of memory, or was stopped. */
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
}

/**
 * The core's `CrossEncoder`, backed by a channel that `start` opens on the
 * first `load`. If it stops, or is closed, what is still out on it fails, and
 * the next `load` opens a new one.
 */
export function createChannelCrossEncoder(start: () => CrossEncoderChannel): CrossEncoder {
  let channel: CrossEncoderChannel | undefined;
  let loaded: { key: string; device: RerankingDevice } | undefined;
  let loading: { key: string; done: Promise<RerankingDevice> } | undefined;
  const stops = channelStops<CrossEncoderChannel>();
  const requests = channelRequests<CrossEncoderChannel, CrossEncoderResponse>();

  function open(): CrossEncoderChannel {
    const started = start();
    started.onResponse((response) => {
      requests.answer(response.id, response);
      stops.answered(started, response.id);
    });
    started.onExit((code) => {
      requests.rejectAll(started, new Error(`The reranking process stopped (exit code ${code}).`));
      if (channel !== started) return;
      channel = undefined;
      loaded = undefined;
    });
    return started;
  }

  function request(command: CrossEncoderCommand): Promise<CrossEncoderResponse> {
    channel ??= open();
    const target = channel;
    return requests
      .add(target, (id) => target.send({ ...command, id }))
      .then((response) => {
        if (response.error !== undefined) throw new Error(response.error);
        return response;
      });
  }

  return {
    async load(files) {
      const key = JSON.stringify(files);
      if (channel && loaded?.key === key) return loaded.device;
      if (loading?.key !== key) {
        const done = request({ type: "load", files })
          .then(({ device }) => {
            if (!device) throw new Error("The reranking process didn't say where the model runs.");
            loaded = { key, device };
            return device;
          })
          .finally(() => {
            if (loading?.done === done) loading = undefined;
          });
        loading = { key, done };
      }
      return loading.done;
    },

    async score(query, texts) {
      if (!channel || loaded === undefined) {
        throw new Error("The reranking model isn't loaded.");
      }
      const { scores } = await request({ type: "score", query, texts: [...texts] });
      if (!scores || scores.length !== texts.length) {
        throw new Error("The reranking process returned no scores.");
      }
      return scores;
    },

    close() {
      const stopping = channel;
      channel = undefined;
      loaded = undefined;
      loading = undefined;
      if (!stopping) return;
      const inFlight = new Set(requests.out(stopping));
      requests.rejectAll(stopping, new ChannelClosedError("The reranking model was stopped."));
      stops.close(stopping, inFlight);
    },
  };
}

/** The serving end's connection to the side that sends requests. */
export interface CrossEncoderPort {
  onRequest(listener: (request: CrossEncoderRequest) => void): void;
  respond(response: CrossEncoderResponse): void;
}

/** Serves `crossEncoder` over `port`: one request at a time, in the order they came. */
export function serveCrossEncoder(crossEncoder: CrossEncoder, port: CrossEncoderPort): void {
  async function handle(request: CrossEncoderRequest): Promise<CrossEncoderResponse> {
    try {
      if (request.type === "load") {
        return { id: request.id, device: await crossEncoder.load(request.files) };
      }
      return { id: request.id, scores: await crossEncoder.score(request.query, request.texts) };
    } catch (error) {
      return { id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let queue = Promise.resolve();
  port.onRequest((request) => {
    queue = queue.then(async () => port.respond(await handle(request)));
  });
}
