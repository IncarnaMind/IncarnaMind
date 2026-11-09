/**
 * The embedding model run in another process or thread (src/core/embedding/channel.ts):
 * the desktop app's utility process and the evaluation's worker thread both
 * use these two ends. Here the "process" is a channel to `serveEmbedder` in
 * this thread, with messages cloned as they would be between processes.
 */
import { describe, expect, test } from "vitest";
import type { Embedder } from "../../src/core";
import {
  createChannelEmbedder,
  type EmbedderChannel,
  type EmbedderRequest,
  type EmbedderResponse,
  serveEmbedder,
} from "../../src/core/embedding/channel";
import { createFakeEmbedder, fakeVector } from "../../src/core/embedding/fake";

const FILES = {
  model: "/m.onnx",
  tokenizer: "/t.json",
  tokenizerConfig: "/c.json",
  maxTokens: 512,
};

interface FakeProcess {
  /** Requests it was sent, in order. */
  requests: EmbedderRequest["type"][];
  /** It dies, e.g. out of memory: nothing more is answered. */
  crash(code: number): void;
  stopped: boolean;
}

/** Starts fake "processes" serving `embedder`, and records them. */
function fakeProcesses(embedder: Embedder) {
  const started: FakeProcess[] = [];
  const start = (): EmbedderChannel => {
    let deliver: (response: EmbedderResponse) => void = () => {};
    let exited: (code: number | null) => void = () => {};
    let serve: (request: EmbedderRequest) => void = () => {};
    const process: FakeProcess = {
      requests: [],
      stopped: false,
      crash(code) {
        process.stopped = true;
        exited(code);
      },
    };
    serveEmbedder(embedder, {
      onRequest: (listener) => {
        serve = listener;
      },
      respond: (response) => {
        if (!process.stopped) setTimeout(() => deliver(structuredClone(response)));
      },
    });
    started.push(process);
    return {
      send(request) {
        process.requests.push(request.type);
        setTimeout(() => serve(structuredClone(request)));
      },
      onResponse: (listener) => {
        deliver = listener;
      },
      onExit: (listener) => {
        exited = listener;
      },
      stop: () => {
        process.stopped = true;
      },
    };
  };
  return { start, started };
}

describe("The embedding model in another process", () => {
  test("starts on the first load, and embeds texts one at a time, in order", async () => {
    const processes = fakeProcesses(createFakeEmbedder({ delayMs: 5 }));
    const embedder = createChannelEmbedder(processes.start);
    await expect(embedder.embed("query: tides")).rejects.toThrow("isn't loaded");
    expect(processes.started).toHaveLength(0);

    await embedder.load(FILES);
    await embedder.load(FILES);
    const vectors = await Promise.all([embedder.embed("passage: one"), embedder.embed("two")]);

    expect(vectors).toEqual([fakeVector("passage: one"), fakeVector("two")]);
    expect(processes.started).toHaveLength(1);
    expect(processes.started[0]?.requests).toEqual(["load", "embed", "embed"]);
  });

  test("when the process dies, what is pending fails, and the next load starts a new one", async () => {
    const processes = fakeProcesses(createFakeEmbedder({ delayMs: 50 }));
    const embedder = createChannelEmbedder(processes.start);
    await embedder.load(FILES);

    const pending = embedder.embed("a long Passage");
    processes.started[0]?.crash(137);
    await expect(pending).rejects.toThrow("The embedding process stopped (exit code 137).");
    await expect(embedder.embed("next")).rejects.toThrow("isn't loaded");

    await embedder.load(FILES);
    expect(await embedder.embed("next")).toEqual(fakeVector("next"));
    expect(processes.started).toHaveLength(2);
  });

  test("the model's errors come back as rejections, and closing stops the process", async () => {
    const failing: Embedder = {
      ...createFakeEmbedder(),
      embed: async () => {
        throw new Error("The model ran out of memory.");
      },
    };
    const processes = fakeProcesses(failing);
    const embedder = createChannelEmbedder(processes.start);
    await embedder.load(FILES);

    await expect(embedder.embed("text")).rejects.toThrow("The model ran out of memory.");
    embedder.close();
    expect(processes.started[0]?.stopped).toBe(true);
    await expect(embedder.embed("text")).rejects.toThrow("isn't loaded");
  });

  // protects=closing while a text is embedded stops the process only once it has answered, as stopping a Node worker thread under onnxruntime aborts the whole process (#2830: a check of what the assistant wrote may still search as the core closes); fails_when=close stops it under the run; no_claim=how a real worker aborts.
  test("closing while a text is embedded stops the process once it has answered", async () => {
    const processes = fakeProcesses(createFakeEmbedder({ delayMs: 20 }));
    const embedder = createChannelEmbedder(processes.start);
    await embedder.load(FILES);

    const embedded = embedder.embed("a long Passage");
    embedder.close();
    expect(processes.started[0]?.stopped).toBe(false);

    expect(await embedded).toEqual(fakeVector("a long Passage"));
    expect(processes.started[0]?.stopped).toBe(true);
  });
});
