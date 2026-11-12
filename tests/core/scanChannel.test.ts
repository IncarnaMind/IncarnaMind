/**
 * The text recognition model in a process of its own: a picture that hangs it
 * is given up after the time limit, the process is stopped, and the next
 * picture is read by a new one.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createChannelTextRecognizer,
  type TextRecognizerChannel,
  type TextRecognizerRequest,
  type TextRecognizerResponse,
} from "../../src/core/documents/scan/channel";

/**
 * Processes that answer every load, and read a picture file unless it is told to hang. One exits
 * only when the test calls its listener in `exits`, by its place in `started`.
 */
function processes(hangs: (page: number) => boolean) {
  const started: { stopped: boolean }[] = [];
  const exits: ((code: number | null) => void)[] = [];
  const start = (): TextRecognizerChannel => {
    const process = { stopped: false };
    started.push(process);
    let respond: (response: TextRecognizerResponse) => void = () => undefined;
    return {
      send(request: TextRecognizerRequest) {
        if (request.type === "load") queueMicrotask(() => respond({ id: request.id }));
        else if (request.type === "readFile" && !hangs(request.page)) {
          queueMicrotask(() =>
            respond({ id: request.id, lines: [], size: { width: 100, height: 50 } }),
          );
        }
      },
      onResponse: (listener) => {
        respond = listener;
      },
      onExit: (listener) => {
        exits.push(listener);
      },
      stop: () => {
        process.stopped = true;
      },
    };
  };
  return { start, started, exits };
}

const FILES = { detector: "detector.onnx", recognizer: "recognizer.onnx" };

describe("the text recognition process", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a picture it doesn't read in time stops it, and the next picture is read by a new one", async () => {
    vi.useFakeTimers();
    const { start, started } = processes((page) => page === 1);
    const recognizer = createChannelTextRecognizer(start);

    await recognizer.load(FILES);
    const hanging = recognizer.readFile(new Uint8Array([1]), 1);
    const given = expect(hanging).rejects.toThrow("wasn't read in");
    await vi.advanceTimersByTimeAsync(60_000);
    await given;
    expect(started).toEqual([{ stopped: true }]);

    await recognizer.load(FILES);
    expect(await recognizer.readFile(new Uint8Array([2]), 2)).toEqual({
      lines: [],
      width: 100,
      height: 50,
    });
    expect(started).toEqual([{ stopped: true }, { stopped: false }]);
  });

  // protects=a picture still out when the model is closed fails in words instead of waiting for ever, one read before keeps its lines, and the closed process's late exit never fails the next one's picture (#2930); fails_when=the closed process's request stays pending, or its exit rejects the new one; no_claim=a real process's stop.
  test("closing it fails the picture still out, and its late exit leaves the next process's picture", async () => {
    const { start, started, exits } = processes((page) => page === 1);
    const recognizer = createChannelTextRecognizer(start);
    const read = { lines: [], width: 100, height: 50 };
    await recognizer.load(FILES);
    expect(await recognizer.readFile(new Uint8Array([2]), 2)).toEqual(read);

    const out = expect(recognizer.readFile(new Uint8Array([1]), 1)).rejects.toThrow(
      "The text recognition model was stopped.",
    );
    recognizer.close();
    await out;

    await recognizer.load(FILES);
    const next = recognizer.readFile(new Uint8Array([3]), 3);
    exits[0]?.(137);
    expect(await next).toEqual(read);
    expect(started).toEqual([{ stopped: true }, { stopped: false }]);
  });
});
