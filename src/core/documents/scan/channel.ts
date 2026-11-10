/**
 * The text recognition model run somewhere else, talking in messages (#397):
 * both ends of the protocol, as for the embedding model (see
 * ../../embedding/channel). The desktop app runs it in an Electron utility
 * process of its own (src/main/scanReader.ts and src/main/scanReaderProcess.ts).
 *
 * Requests are { id, type: "load", files } or { id, type: "read", picture,
 * page }; the other end answers { id, lines } (or { id } for a load) or
 * { id, error }, taking one request at a time, in order.
 */
import type {
  PagePicture,
  RecognizedLine,
  TextRecognitionFiles,
  TextRecognizer,
} from "../../adapters";
import { ChannelClosedError, channelRequests } from "../../channelRequests";

export type TextRecognizerCommand =
  | { type: "load"; files: TextRecognitionFiles }
  | { type: "read"; picture: PagePicture; page: number }
  | { type: "readFile"; file: Uint8Array; page: number };

/** `id` pairs a response with its request. */
export type TextRecognizerRequest = TextRecognizerCommand & { id: number };

/** The lines read for "read", nothing more for "load", or what went wrong. */
export interface TextRecognizerResponse {
  id: number;
  lines?: RecognizedLine[];
  /** For "readFile": the size the picture was read at. */
  size?: { width: number; height: number };
  error?: string;
}

/** A running process that serves the model, as the side that sends requests sees it. */
export interface TextRecognizerChannel {
  send(request: TextRecognizerRequest): void;
  onResponse(listener: (response: TextRecognizerResponse) => void): void;
  /** It stopped: crashed, ran out of memory, or was stopped. */
  onExit(listener: (code: number | null) => void): void;
  stop(): void;
}

/** Far longer than a picture takes to read: one that hangs the process mustn't hold up the rest. */
const READ_FILE_MS = 60_000;

/**
 * The core's `TextRecognizer`, backed by a channel that `start` opens on the
 * first `load`. If it stops, or is closed, what is still out on it fails, and
 * the next `load` opens a new one. A picture file not read in `READ_FILE_MS`
 * stops it.
 */
export function createChannelTextRecognizer(start: () => TextRecognizerChannel): TextRecognizer {
  let channel: TextRecognizerChannel | undefined;
  let loadedKey: string | undefined;
  let loading: { key: string; done: Promise<void> } | undefined;
  const requests = channelRequests<TextRecognizerChannel, TextRecognizerResponse>();

  /** The process is done with: what it was asked fails, and the next `load` starts another. */
  function drop(target: TextRecognizerChannel, error: Error): void {
    requests.rejectAll(target, error);
    if (channel !== target) return;
    channel = undefined;
    loadedKey = undefined;
  }

  function open(): TextRecognizerChannel {
    const started = start();
    started.onResponse((response) => requests.answer(response.id, response));
    started.onExit((code) =>
      drop(started, new Error(`The text recognition process stopped (exit code ${code}).`)),
    );
    return started;
  }

  function request(command: TextRecognizerCommand): Promise<TextRecognizerResponse> {
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
      if (channel && loadedKey === key) return;
      if (loading?.key !== key) {
        const done = request({ type: "load", files })
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

    async read(picture, page) {
      if (!channel || loadedKey === undefined) {
        throw new Error("The text recognition model isn't loaded.");
      }
      const { lines } = await request({ type: "read", picture, page });
      if (!lines) throw new Error("The text recognition process returned no lines.");
      return lines;
    },

    async readFile(file, page) {
      const target = channel;
      if (!target || loadedKey === undefined) {
        throw new Error("The text recognition model isn't loaded.");
      }
      const timer = setTimeout(() => {
        drop(target, new Error(`The picture wasn't read in ${READ_FILE_MS} ms.`));
        target.stop();
      }, READ_FILE_MS);
      try {
        const { lines, size } = await request({ type: "readFile", file, page });
        if (!lines || !size) throw new Error("The text recognition process returned no lines.");
        return { lines, ...size };
      } finally {
        clearTimeout(timer);
      }
    },

    close() {
      const stopping = channel;
      channel = undefined;
      loadedKey = undefined;
      loading = undefined;
      if (!stopping) return;
      requests.rejectAll(
        stopping,
        new ChannelClosedError("The text recognition model was stopped."),
      );
      stopping.stop();
    },
  };
}

/** The serving end's connection to the side that sends requests. */
export interface TextRecognizerPort {
  onRequest(listener: (request: TextRecognizerRequest) => void): void;
  respond(response: TextRecognizerResponse): void;
}

/** Serves `recognizer` over `port`: one request at a time, in the order they came. */
export function serveTextRecognizer(recognizer: TextRecognizer, port: TextRecognizerPort): void {
  async function handle(request: TextRecognizerRequest): Promise<TextRecognizerResponse> {
    try {
      if (request.type === "load") {
        await recognizer.load(request.files);
        return { id: request.id };
      }
      if (request.type === "readFile") {
        const { lines, width, height } = await recognizer.readFile(request.file, request.page);
        return { id: request.id, lines, size: { width, height } };
      }
      return { id: request.id, lines: await recognizer.read(request.picture, request.page) };
    } catch (error) {
      return { id: request.id, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let queue = Promise.resolve();
  port.onRequest((request) => {
    queue = queue.then(async () => port.respond(await handle(request)));
  });
}
