/**
 * The embedding model run in another process or thread (src/core/embedding/channel.ts):
 * the desktop app's utility process and the evaluation's worker thread both
 * use these two ends. Here the "process" is a channel to `serveEmbedder` in
 * this thread, with messages cloned as they would be between processes.
 */
import { describe, expect, test, vi } from "vitest";
import type { Embedder } from "../../src/core";
import {
  createChannelEmbedder,
  type EmbedderChannel,
  type EmbedderRequest,
  type EmbedderResponse,
  serveEmbedder,
} from "../../src/core/embedding/channel";
import { createFakeEmbedder, fakeVector } from "../../src/core/embedding/fake";
import { createTempDataFolder, nextTurn, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { turnOnEmbeddings } from "../helpers/embedding";
import { mockEmbeddingModels } from "../helpers/embeddingProviders";

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

/** The fake model, where each text `holds` picks waits, unanswered, until the test calls `release`. */
function heldModel(holds: (text: string) => boolean) {
  const fake = createFakeEmbedder();
  const reached: string[] = [];
  let gate = Promise.withResolvers<void>();
  const model: Embedder = {
    ...fake,
    async embed(text) {
      if (holds(text)) {
        reached.push(text);
        await gate.promise;
      }
      return fake.embed(text);
    },
  };
  return {
    model,
    /** The held texts that reached the model, in order. */
    reached,
    release() {
      gate.resolve();
      gate = Promise.withResolvers();
    },
  };
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

  // protects=a text still out when the model is closed fails in words instead of waiting for ever, while one answered before keeps its vector (#2930); fails_when=the closed process's request stays pending; no_claim=how long a real process takes to stop.
  test("closing it fails the text still out, and a text answered before keeps its vector", async () => {
    const held = heldModel((text) => text === "query: held");
    const processes = fakeProcesses(held.model);
    const embedder = createChannelEmbedder(processes.start);
    await embedder.load(FILES);

    const answered = embedder.embed("query: tides");
    const out = embedder.embed("query: held");
    expect(await answered).toEqual(fakeVector("query: tides"));
    embedder.close();

    await expect(out).rejects.toThrow("The embedding model was stopped.");
    expect(processes.started[0]?.stopped).toBe(true);
  });

  // protects=a closed process's late exit fails only what was out on it, never the next process's requests (#2930); fails_when=the old exit rejects the new text, or the old text never settles; no_claim=the order a real process's messages arrive in.
  test("a closed process's late exit leaves the next process's text to be answered", async () => {
    const held = heldModel((text) => text === "query: old" || text === "query: new");
    const processes = fakeProcesses(held.model);
    const embedder = createChannelEmbedder(processes.start);
    await embedder.load(FILES);
    const old = expect(embedder.embed("query: old")).rejects.toThrow(
      "The embedding model was stopped.",
    );
    embedder.close();

    await embedder.load(FILES);
    const next = embedder.embed("query: new");
    await vi.waitFor(() => expect(held.reached).toEqual(["query: old", "query: new"]));
    processes.started[0]?.crash(137);
    held.release();

    expect(await next).toEqual(fakeVector("query: new"));
    await old;
    expect(processes.started).toHaveLength(2);
  });

  // protects=a load still out when the model is closed fails, and a load asked right after starts a new process instead of joining the closed one's (#2930); fails_when=the second load waits on, or fails with, the first; no_claim=a real model's load time.
  test("a load still out when it is closed fails, and the next load starts a new process", async () => {
    const processes = fakeProcesses(createFakeEmbedder());
    const embedder = createChannelEmbedder(processes.start);

    const first = embedder.load(FILES);
    embedder.close();
    const again = embedder.load(FILES);

    await expect(first).rejects.toThrow("The embedding model was stopped.");
    await again;
    expect(await embedder.embed("query: tides")).toEqual(fakeVector("query: tides"));
    expect(processes.started).toHaveLength(2);
  });
});

describe("A search waiting on the embedding process", { timeout: 30_000 }, () => {
  const TIDES = "Spring tides come at new moon and at full moon.";

  /** A core whose embedding model runs in fake processes, with one Document embedded; its searches wait while held. */
  async function setUp() {
    let holding = false;
    const held = heldModel((text) => holding && text.startsWith("query: "));
    const processes = fakeProcesses(held.model);
    const core = startCore(await createTempDataFolder(), {
      embedder: createChannelEmbedder(processes.start),
      createEmbeddingModel: mockEmbeddingModels().createEmbeddingModel,
    });
    await turnOnEmbeddings(core);
    const [tides] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "Tides.md", TIDES),
    ]);
    if (tides?.status !== "ready") throw new Error("The Document wasn't embedded.");
    const search = (text: string) => core.findPassages({ text, mindId: null, scope: null });
    const found = async (text: string) => (await search(text)).map((each) => each.documentId);
    return {
      core,
      processes,
      held,
      tides,
      search,
      found,
      hold() {
        holding = true;
      },
    };
  }

  // protects=a search the User waits on when the embedding model is changed or turned off finishes on its words, as search does until the new model has read the Documents, starting no process again (#2930); fails_when=it waits for ever on the closed process; no_claim=a provider's own requests.
  test.each([
    ["turned off", { kind: "off" }],
    [
      "switched to another model",
      { kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", modelId: "mock-embed" },
    ],
  ] as const)("%s while a search waits, the search finishes on its words", async (_, change) => {
    const { core, processes, held, tides, search, found, hold } = await setUp();
    expect(await found("spring tides")).toEqual([tides.id]);
    hold();

    const searching = search("full moon");
    await vi.waitFor(() => expect(held.reached).toHaveLength(1));
    await core.saveEmbeddingProvider(change);

    expect((await searching).map((each) => each.documentId)).toEqual([tides.id]);
    expect(processes.started).toHaveLength(1);
    expect(processes.started[0]?.stopped).toBe(true);
  });

  // protects=a search whose process crashes is sent once more after the model starts again, and only once: a second crash leaves it to its words (#2930); fails_when=the search fails, waits, or starts processes again and again; no_claim=why a real process crashes.
  test("a search whose process crashes is asked once more of a new one, and only once", async () => {
    const { processes, held, tides, search, hold } = await setUp();
    hold();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const once = search("spring tides");
    await vi.waitFor(() => expect(held.reached).toHaveLength(1));
    processes.started[0]?.crash(137);
    await vi.waitFor(() => expect(held.reached).toHaveLength(2));
    held.release();
    expect((await once).map((each) => each.documentId)).toEqual([tides.id]);
    expect(processes.started).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();

    const twice = search("full moon");
    await vi.waitFor(() => expect(held.reached).toHaveLength(3));
    processes.started[1]?.crash(137);
    await vi.waitFor(() => expect(held.reached).toHaveLength(4));
    processes.started[2]?.crash(137);

    expect((await twice).map((each) => each.documentId)).toEqual([tides.id]);
    expect(processes.started).toHaveLength(3);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The embedding process stopped (exit code 137)." }),
    );
    errors.mockRestore();
  });

  // protects=quitting with a search out: the search's failed request starts no model again, the search reads no closed database, and no rejection is left unhandled (#2930); fails_when=the model loads again after the close, or the search reads the closed database and rejects; no_claim=the order the app's other parts stop in.
  test("closing the core with a search out starts nothing again and reads nothing more", async () => {
    const { core, processes, held, tides, search, found, hold } = await setUp();
    expect(await found("spring tides")).toEqual([tides.id]);
    hold();
    const errors = vi.spyOn(console, "error");

    let settled = false;
    const searching = search("full moon");
    searching.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(held.reached).toHaveLength(1));
    core.close();
    await nextTurn();

    expect(settled).toBe(false);
    expect(processes.started).toHaveLength(1);
    expect(processes.started[0]?.requests.filter((type) => type === "load")).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
