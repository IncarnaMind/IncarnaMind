import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { describe, expect, test, vi } from "vitest";
import {
  BUILT_IN_RERANKING_MODEL,
  type CrossEncoder,
  DEFAULT_RERANK_MODELS,
  type RerankingCheck,
  type RerankingModelDefinition,
  type RerankingModelFiles,
} from "../../src/core";
import {
  type CrossEncoderChannel,
  type CrossEncoderRequest,
  type CrossEncoderResponse,
  createChannelCrossEncoder,
  serveCrossEncoder,
} from "../../src/core/reranking/channel";
import { createFakeCrossEncoder, fakeRelevance } from "../../src/core/reranking/fake";
import { createRerankingModel, rerankText } from "../../src/core/reranking/index";
import {
  CHECK_TOLERANCE,
  createOnnxCrossEncoder,
  GPU_BATCH_SIZE,
  type PairSessionFactory,
  pairEncoder,
  pairIds,
  type SessionDevice,
} from "../../src/core/reranking/onnx";
import { asCheckWork, createRerankQueue } from "../../src/core/reranking/order";
import { createTempDataFolder, NO_MODEL_FILES } from "../helpers/core";
import { startModelServer } from "../helpers/embedding";
import { recordingLog } from "../helpers/log";

const FILES = { model: "m.onnx", tokenizer: "t.json", tokenizerConfig: "c.json", maxTokens: 512 };

const TINY_VOCAB: Record<string, number> = { "<s>": 0, "<pad>": 1, "</s>": 2, "<unk>": 3 };
for (const word of "what is the capital of france paris lies on seine a b c d e f g h".split(" ")) {
  TINY_VOCAB[word] = Object.keys(TINY_VOCAB).length;
}

const special = (id: number, content: string) => ({
  id,
  content,
  special: true,
  single_word: false,
  lstrip: false,
  rstrip: false,
  normalized: false,
});

/** A tiny tokenizer's two files, with XLM-RoBERTa's pair template: "<s> A </s></s> B </s>". */
const TINY_TOKENIZER = {
  json: {
    version: "1.0",
    added_tokens: [special(0, "<s>"), special(2, "</s>")],
    normalizer: null,
    pre_tokenizer: { type: "Whitespace" },
    post_processor: {
      type: "RobertaProcessing",
      sep: ["</s>", 2],
      cls: ["<s>", 0],
      trim_offsets: true,
      add_prefix_space: false,
    },
    decoder: null,
    model: { type: "WordLevel", vocab: TINY_VOCAB, unk_token: "<unk>" },
  },
  config: { model_max_length: 512, pad_token: "<pad>" },
};

const tinyTokenizer = () => new Tokenizer(TINY_TOKENIZER.json, TINY_TOKENIZER.config);

describe("The reranking models", () => {
  test("the built-in model is pinned, has a permissive licence and isn't a service", () => {
    const model = BUILT_IN_RERANKING_MODEL;
    expect(model.licence).toMatch(/^(Apache-2\.0|MIT)$/);
    expect(model.source.baseUrl).toMatch(/\/resolve\/[0-9a-f]{40}\/$/);
    expect(model.source.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        model.files.model,
        model.files.tokenizer,
        model.files.tokenizerConfig,
      ]),
    );
    for (const file of model.source.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(model.gpu?.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(model.gpu?.folder).not.toBe(model.folder);
    expect(model.gpu?.check.scores).toHaveLength(model.gpu?.check.texts.length ?? -1);
    // The built-in model isn't a service: it has no default model to name.
    expect(Object.keys(DEFAULT_RERANK_MODELS)).toEqual(["cohere", "voyage"]);
  });
});

describe("A query and a Passage, as one pair of tokens", () => {
  test("follow the model's pair template", () => {
    const tokenizer = tinyTokenizer();
    expect(pairIds(tokenizer, "what is", "paris lies", 512)).toEqual(
      tokenizer.encode("what is", { text_pair: "paris lies" }).ids,
    );
  });

  test("a long pair loses the end of the Passage, keeping the end-of-text token", () => {
    const tokenizer = tinyTokenizer();
    const ids = pairIds(tokenizer, "what is", "a b c d e f g h", 10);
    expect(ids).toHaveLength(10);
    const vocab = tokenizer.get_vocab();
    // <s> what is </s></s> a b c d </s>
    expect(ids).toEqual([
      0,
      vocab.get("what"),
      vocab.get("is"),
      2,
      2,
      vocab.get("a"),
      vocab.get("b"),
      vocab.get("c"),
      vocab.get("d"),
      2,
    ]);
  });

  test("a very long query is cut too, so the Passage keeps most of the room", () => {
    const tokenizer = tinyTokenizer();
    const ids = pairIds(tokenizer, "a b c d e f g h a b c d e f g h", "paris lies on seine", 16);
    expect(ids).toHaveLength(12);
    const vocab = tokenizer.get_vocab();
    // The query keeps a quarter of 16 tokens, the Passage all of its own.
    expect(ids.slice(0, 6)).toEqual([0, ...["a", "b", "c", "d"].map((w) => vocab.get(w)), 2]);
    expect(ids.slice(-5)).toEqual([
      ...["paris", "lies", "on", "seine"].map((w) => vocab.get(w)),
      2,
    ]);
  });
});

describe("A Passage's tokens, kept between searches", () => {
  // protects=a pair read with its text's tokens kept is exactly the pair read whole, cut the same way, and a text met again isn't read again (#2532); fails_when=a kept pair differs from pairIds, or a text a search met before is read again; no_claim=how fast reading is.
  test("are read once, and give the pairs read whole", () => {
    const tokenizer = tinyTokenizer();
    const reads = vi.spyOn(tokenizer, "encode");
    const pairs = pairEncoder(tokenizer, 10);
    for (const [query, text] of [
      ["what is", "paris lies on seine"],
      ["what is", "a b c d e f g h"],
      ["a b c d e f g h a b c d", "paris lies"],
      ["what is the capital", "paris lies on seine"],
      ["what is", ""],
    ] as const)
      expect(pairs(query, text)).toEqual(pairIds(tokenizer, query, text, 10));
    reads.mockClear();

    pairs("of france", "paris lies on seine");

    expect(reads.mock.calls.map(([text]) => text)).toEqual(["of france"]);
  });

  // protects=a tokenizer whose pair isn't its two texts between the same special tokens reads each pair whole (#2532); fails_when=a pair is put together from a template that doesn't hold; no_claim=which tokenizers the app ships.
  test("aren't kept for a tokenizer whose pairs don't follow one template", () => {
    const tokenizer = tinyTokenizer();
    const read = tokenizer.encode.bind(tokenizer);
    vi.spyOn(tokenizer, "encode").mockImplementation((text, options) => {
      const encoding = read(text, options);
      return options?.text_pair
        ? { ...encoding, ids: [...encoding.ids, encoding.ids.length] }
        : encoding;
    });
    const pairs = pairEncoder(tokenizer, 512);

    expect(pairs("what is", "paris lies")).toEqual(
      tokenizer.encode("what is", { text_pair: "paris lies" }).ids,
    );
    expect(pairs("what is the capital of france", "a b")).toEqual(
      tokenizer.encode("what is the capital of france", { text_pair: "a b" }).ids,
    );
  });
});

describe("The built-in reranking model", () => {
  const hits = [
    { id: "a", documentName: "Ships", text: "Boats float on water." },
    { id: "b", documentName: "Lighthouse", text: "A lighthouse guides ships at night." },
    { id: "c", documentName: "Bread", text: "Bread rises in the oven." },
    { id: "d", documentName: "Cakes", text: "Cakes rise in the oven too." },
  ];

  // protects=a search asked while warm() still loads the model waits for that load: the model behind the channel loads once, then scores (#2532); fails_when=the search starts a load of its own beside the one under way; no_claim=how long a real load takes.
  test("a search asked while warm() is still loading waits for that load, and the model loads once", async () => {
    const fake = createFakeCrossEncoder();
    const held = Promise.withResolvers<void>();
    const atModel: string[] = [];
    const served: CrossEncoder = {
      ...fake,
      load: async (files) => {
        atModel.push("load");
        await held.promise;
        return fake.load(files);
      },
      score: async (query, texts) => {
        atModel.push("score");
        return fake.score(query, texts);
      },
    };
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir: await createTempDataFolder(),
      crossEncoder: createChannelCrossEncoder(linkedChannel(served).start),
      emitStatus: () => {},
    });

    model.warm();
    await vi.waitFor(() => expect(atModel).toEqual(["load"]));
    const ranked = model.rerank("lighthouse ships", hits);
    // A turn of the event loop: the search has asked for its load before this one ends.
    await new Promise((turn) => setImmediate(turn));
    held.resolve();

    expect((await ranked)?.[0]?.id).toBe("b");
    expect(atModel).toEqual(["load", "score"]);
    model.close();
  });

  test("orders hits by the model's score, from 0 to 1, keeping ties in their order", async () => {
    const dataDir = await createTempDataFolder();
    const statuses: string[] = [];
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir,
      crossEncoder: createFakeCrossEncoder(),
      emitStatus: (status) => statuses.push(status.state),
    });

    const ranked = await model.rerank("lighthouse ships", hits);

    expect(ranked?.map((hit) => hit.id)).toEqual(["b", "a", "c", "d"]);
    for (const hit of ranked ?? []) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThan(1);
    }
    // c and d score the same: they keep search's order.
    expect(ranked?.[2]?.score).toBe(ranked?.[3]?.score);
    model.close();
  });

  test("reads each hit as its Document's name, then its text, normalised", async () => {
    const dataDir = await createTempDataFolder();
    const read: string[][] = [];
    const crossEncoder: CrossEncoder = {
      load: async () => ({ device: "cpu" }),
      score: async (query, texts) => {
        read.push([query, ...texts]);
        return texts.map(() => 0);
      },
      close: () => {},
    };
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir,
      crossEncoder,
      emitStatus: () => {},
    });

    await model.rerank("Ｑｕｅｒｙ", [{ documentName: "⼤ Report", text: "ﬁne text" }]);

    // NFKC, the Kangxi radical folded, and no space next to a CJK character, as for embedding.
    expect(read).toEqual([["Query", "大Report\nfine text"]]);
    expect(rerankText({ documentName: "Notes", text: "Body" })).toBe("Notes\nBody");
    model.close();
  });

  test("reads nothing while its files aren't downloaded", async () => {
    const dataDir = await createTempDataFolder();
    let scored = false;
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: {
        baseUrl: "http://127.0.0.1:9/",
        files: [{ path: "m.onnx", size: 10, sha256: "0".repeat(64) }],
      },
      dataDir,
      crossEncoder: {
        load: async () => ({ device: "cpu" }),
        score: async (_query, texts) => {
          scored = true;
          return texts.map(() => 0);
        },
        close: () => {},
      },
      emitStatus: () => {},
    });

    expect(model.status().state).toBe("not-downloaded");
    expect(await model.rerank("q", hits)).toBeNull();
    expect(scored).toBe(false);
    model.close();
  });

  // protects=a search is scored alone, one at a time, as one request of its own texts, and gets back exactly the scores it gets alone (#2532: several searches' texts scored together changed scores and orders on the GPU); fails_when=two scorings are sent at once, searches waiting together are scored in one request, or a search gets another's scores; no_claim=the model's own scores.
  test("searches asked at once are scored one at a time, each alone, as when asked one by one", async () => {
    const dataDir = await createTempDataFolder();
    const fake = createFakeCrossEncoder();
    const requests: string[][] = [];
    let running = 0;
    let most = 0;
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir,
      crossEncoder: {
        load: (files) => fake.load(files),
        score: async (query, texts) => {
          requests.push([query, ...texts]);
          running++;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running--;
          return fake.score(query, texts);
        },
        close: () => fake.close(),
      },
      emitStatus: () => {},
    });
    const queries = ["lighthouse ships", "bread oven", "cakes rise too"];
    const alone = [];
    for (const query of queries) alone.push(await model.rerank(query, hits));
    requests.length = 0;

    const together = await Promise.all(queries.map((query) => model.rerank(query, hits)));

    expect(together).toEqual(alone);
    expect(together.map((each) => each?.map((hit) => hit.id))).toEqual([
      ["b", "a", "c", "d"],
      ["c", "d", "a", "b"],
      ["d", "a", "b", "c"],
    ]);
    expect(requests).toEqual(queries.map((query) => [query, ...hits.map(rerankText)]));
    expect(most).toBe(1);
    model.close();
  });

  test("the fake scores the share of the query's words a text has", () => {
    expect(fakeRelevance("lighthouse ships", "A lighthouse guides ships")).toBe(1);
    expect(fakeRelevance("lighthouse ships", "Boats and ships")).toBe(0.5);
    expect(fakeRelevance("灯塔", "海边的灯塔")).toBe(1);
    expect(fakeRelevance("", "anything")).toBe(0);
  });
});

describe("The order searches are scored in", () => {
  // protects=a search the User is waiting on goes before every check's, a check's next search before the searches of checks started after it, and one check's searches keep their order (#2532); fails_when=searches waiting are scored first come, first served, an Answer's search waits behind checks, or one check's searches change places; no_claim=how long a scoring takes.
  test("a search outside any check goes first, then a check's next search before checks started after it", async () => {
    const inTurn = createRerankQueue();
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const scoring = (name: string) => () =>
      new Promise<void>((resolve) => {
        started.push(name);
        finish.set(name, resolve);
      });
    const othersAsked = Promise.withResolvers<void>();
    const askedAgain = Promise.withResolvers<void>();

    const first = asCheckWork(async () => {
      const search = inTurn(scoring("first check"));
      await othersAsked.promise;
      const again = inTurn(scoring("first check, again"));
      const third = inTurn(scoring("first check, third time"));
      askedAgain.resolve();
      await Promise.all([search, again, third]);
    });
    const second = asCheckWork(() => inTurn(scoring("second check")));
    const answer = inTurn(scoring("an Answer's search"));
    othersAsked.resolve();
    await askedAgain.promise;
    for (let count = 1; count <= 5; count++) {
      await vi.waitFor(() => expect(started).toHaveLength(count));
      finish.get(started[count - 1] ?? "")?.();
    }
    await Promise.all([first, second, answer]);

    expect(started).toEqual([
      "first check",
      "an Answer's search",
      "first check, again",
      "first check, third time",
      "second check",
    ]);
  });

  // protects=while Check this Note's ten sentences wait at the reranker, a search the User asks for meanwhile (an Answer's, Cite…'s) is scored next, not after them (#2532); fails_when=it waits behind the checks' searches; no_claim=how long the one being scored takes.
  test("an Answer's search asked while ten sentences' searches wait is scored next", async () => {
    const dataDir = await createTempDataFolder();
    const scored: string[] = [];
    const open: (() => void)[] = [];
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir,
      crossEncoder: {
        load: async () => ({ device: "gpu" }),
        score: async (query, texts) => {
          scored.push(query);
          await new Promise<void>((resolve) => open.push(resolve));
          return texts.map(() => 0);
        },
        close: () => {},
      },
      emitStatus: () => {},
    });
    const hits = [
      { documentName: "Tides", text: "Spring tides come at new moon." },
      { documentName: "Harbour", text: "The harbour office opens at nine." },
    ];
    const checks = Array.from({ length: 10 }, (_, index) =>
      asCheckWork(() => model.rerank(`sentence ${index + 1}`, hits)),
    );
    await vi.waitFor(() => expect(scored).toEqual(["sentence 1"]));

    const answer = model.rerank("When are spring tides?", hits);
    open.shift()?.();

    await vi.waitFor(() => expect(scored).toHaveLength(2));
    expect(scored[1]).toBe("When are spring tides?");
    while (scored.length < 11 || open.length > 0) {
      await vi.waitFor(() => expect(open.length).toBeGreaterThan(0));
      open.shift()?.();
    }
    await Promise.all([answer, ...checks]);
    expect(scored.slice(2)).toEqual(
      Array.from({ length: 9 }, (_, index) => `sentence ${index + 2}`),
    );
    model.close();
  });
});

describe("A search waiting to be scored", () => {
  // protects=a search whose Answer or check is stopped while it waits leaves at once and is never scored, so its Stop isn't held up and the searches after it go sooner (#2532); fails_when=a stopped search waits for its turn or is scored in it; no_claim=a search already being scored, which the model finishes.
  test("leaves at once when it is stopped, is never scored, and the next goes in its place", async () => {
    const inTurn = createRerankQueue();
    const ran: string[] = [];
    let finishFirst = () => {};
    const first = inTurn(
      () =>
        new Promise<void>((resolve) => {
          ran.push("first");
          finishFirst = resolve;
        }),
    );
    const stopped = new AbortController();
    const second = inTurn(async () => {
      ran.push("second");
    }, stopped.signal);
    const third = inTurn(async () => {
      ran.push("third");
    });
    stopped.abort();

    await expect(second).rejects.toThrow();
    await expect(inTurn(async () => ran.push("never"), stopped.signal)).rejects.toThrow();
    expect(ran).toEqual(["first"]);
    finishFirst();
    await first;
    await third;
    expect(ran).toEqual(["first", "third"]);
  });

  // protects=a search that waited while the model stopped (the User turned reranking off and on, or its process restarted) loads the model again in its turn instead of failing (#2532); fails_when=the model is loaded before the wait and the search fails as not loaded; no_claim=how long loading takes.
  test("loads the model again in its turn when the model stopped while it waited", async () => {
    const hits = [
      { documentName: "Ships", text: "Boats float on water." },
      { documentName: "Bread", text: "Bread rises in the oven." },
    ];
    const dataDir = await createTempDataFolder();
    let loaded = false;
    let loads = 0;
    const scored: string[] = [];
    let finishFirst = () => {};
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir,
      crossEncoder: {
        load: async () => {
          loads++;
          loaded = true;
          return { device: "cpu" };
        },
        score: async (query, texts) => {
          if (!loaded) throw new Error("The reranking model isn't loaded.");
          scored.push(query);
          if (query === "first")
            await new Promise<void>((resolve) => {
              finishFirst = resolve;
            });
          return texts.map(() => 0);
        },
        close: () => {
          loaded = false;
        },
      },
      emitStatus: () => {},
    });
    const first = model.rerank("first", hits);
    await vi.waitFor(() => expect(scored).toEqual(["first"]));
    const second = model.rerank("second", hits);

    model.unload();
    finishFirst();

    expect(await first).toHaveLength(hits.length);
    expect(await second).toHaveLength(hits.length);
    expect(loads).toBe(2);
    model.close();
  });
});

/** Both ends of the channel in one process, as a utility process would serve them. */
function linkedChannel(served: CrossEncoder) {
  let onRequest: (request: CrossEncoderRequest) => void = () => {};
  let onResponse: (response: CrossEncoderResponse) => void = () => {};
  let onExit: (code: number | null) => void = () => {};
  const started: string[] = [];
  serveCrossEncoder(served, {
    onRequest: (listener) => {
      onRequest = listener;
    },
    respond: (response) => queueMicrotask(() => onResponse(response)),
  });
  const start = (): CrossEncoderChannel => {
    started.push("started");
    return {
      send: (request) => queueMicrotask(() => onRequest(request)),
      onResponse: (listener) => {
        onResponse = listener;
      },
      onExit: (listener) => {
        onExit = listener;
      },
      stop: () => onExit(0),
    };
  };
  return { start, started, crash: (code: number) => onExit(code) };
}

describe("The reranking channel", () => {
  test("loads once, then scores texts in order, over messages", async () => {
    const link = linkedChannel(createFakeCrossEncoder());
    const crossEncoder = createChannelCrossEncoder(link.start);

    await crossEncoder.load(FILES);
    await crossEncoder.load(FILES);
    expect(await crossEncoder.score("ships", ["ships at sea", "bread"])).toEqual([1, 0]);
    expect(link.started).toHaveLength(1);
  });

  test("scores fail before a load, and errors come back as errors", async () => {
    const failing: CrossEncoder = {
      load: async () => ({ device: "cpu" }),
      score: async () => {
        throw new Error("The model failed on this text.");
      },
      close: () => {},
    };
    const crossEncoder = createChannelCrossEncoder(linkedChannel(failing).start);

    await expect(crossEncoder.score("q", ["t"])).rejects.toThrow(/isn't loaded/);
    await crossEncoder.load(FILES);
    await expect(crossEncoder.score("q", ["t"])).rejects.toThrow("The model failed on this text.");
  });

  // protects=closing the model on purpose (reranking turned off, the model unloaded) fails what waits on it, so the searches queued behind it go on, and the next load starts afresh (#2532); fails_when=a scoring under way when the model is closed never settles and holds every search after it; no_claim=a process that exits by itself, which the next test covers.
  test("closing it while it scores fails that scoring, so the searches after it go on", async () => {
    let reachedModel = () => {};
    const reached = new Promise<void>((resolve) => {
      reachedModel = resolve;
    });
    const slow: CrossEncoder = {
      load: async () => ({ device: "cpu" }),
      score: (query, texts) =>
        query === "held"
          ? new Promise(() => {
              reachedModel();
            })
          : Promise.resolve(texts.map(() => 0)),
      close: () => {},
    };
    // Each start is a process of its own, as the app's are: a stopped one's work goes with it.
    let starts = 0;
    const start = (): CrossEncoderChannel => {
      starts++;
      let onRequest: (request: CrossEncoderRequest) => void = () => {};
      let onResponse: (response: CrossEncoderResponse) => void = () => {};
      serveCrossEncoder(slow, {
        onRequest: (listener) => {
          onRequest = listener;
        },
        respond: (response) => queueMicrotask(() => onResponse(response)),
      });
      return {
        send: (request) => queueMicrotask(() => onRequest(request)),
        onResponse: (listener) => {
          onResponse = listener;
        },
        onExit: () => {},
        stop: () => {},
      };
    };
    const model = createRerankingModel({
      definition: BUILT_IN_RERANKING_MODEL,
      source: NO_MODEL_FILES,
      dataDir: await createTempDataFolder(),
      crossEncoder: createChannelCrossEncoder(start),
      emitStatus: () => {},
    });
    const hits = [
      { documentName: "Tides", text: "Spring tides come at new moon." },
      { documentName: "Harbour", text: "The harbour office opens at nine." },
    ];

    const held = model.rerank("held", hits);
    await reached;
    const after = model.rerank("after", hits);
    model.unload();

    await expect(held).rejects.toThrow(/was stopped/);
    expect(await after).toHaveLength(2);
    expect(starts).toBe(2);
    model.close();
  });

  test("when the process stops, pending requests fail and the next load starts a new one", async () => {
    let release = () => {};
    let reachedModel = () => {};
    const reached = new Promise<void>((resolve) => {
      reachedModel = resolve;
    });
    const slow: CrossEncoder = {
      load: async () => ({ device: "cpu" }),
      score: (_query, texts) =>
        new Promise((resolve) => {
          release = () => resolve(texts.map(() => 0));
          reachedModel();
        }),
      close: () => {},
    };
    const link = linkedChannel(slow);
    const crossEncoder = createChannelCrossEncoder(link.start);
    await crossEncoder.load(FILES);

    const scoring = crossEncoder.score("q", ["t"]);
    await reached;
    link.crash(1);
    await expect(scoring).rejects.toThrow(/stopped \(exit code 1\)/);
    release();

    await crossEncoder.load(FILES);
    expect(link.started).toHaveLength(2);
  });
});

interface FakeRun {
  device: SessionDevice;
  /** Each row's tokens, by its attention mask. */
  lengths: number[];
  width: number;
  /** The ids under the mask's zeros. */
  padding: bigint[];
}

/**
 * Sessions that keep what they ran and score a row by its number of tokens,
 * plus `gpuOffset` on the GPU; `adapter: false` finds no GPU adapter,
 * `gpuFails` fails to open the model on the GPU, and `gpuBreaks` fails on the
 * GPU after the check.
 */
function fakeSessions(
  options: { adapter?: boolean; gpuFails?: boolean; gpuBreaks?: boolean; gpuOffset?: number } = {},
) {
  const { adapter = true, gpuFails = false, gpuBreaks = false, gpuOffset = 0.02 } = options;
  const opened: string[] = [];
  const released: string[] = [];
  const ran: FakeRun[] = [];
  const createSession: PairSessionFactory = async (model, device) => {
    const name = `${typeof model === "string" ? model.split(/[/\\]/).at(-1) : "probe"} on ${device}`;
    if (device === "gpu" && !adapter) throw new Error("Failed to get a WebGPU adapter.");
    if (device === "gpu" && gpuFails && typeof model === "string") {
      throw new Error("The WebGPU execution provider can't run this model.");
    }
    opened.push(name);
    let runs = 0;
    return {
      async run(ids, mask, rows, width) {
        if (device === "gpu" && gpuBreaks && runs++ > 0) throw new Error("WebGPU device lost.");
        const run: FakeRun = { device, lengths: [], width, padding: [] };
        for (let row = 0; row < rows; row++) {
          let length = 0;
          for (let at = row * width; at < (row + 1) * width; at++) {
            if (mask[at] === 1n) length++;
            else run.padding.push(ids[at] ?? -1n);
          }
          run.lengths.push(length);
        }
        ran.push(run);
        return Float32Array.from(
          run.lengths,
          (length) => length + (device === "gpu" ? gpuOffset : 0),
        );
      },
      release: async () => {
        released.push(name);
      },
    };
  };
  return { createSession, opened, released, runs: ran };
}

const pairLength = (query: string, text: string) =>
  pairIds(tinyTokenizer(), query, text, 512).length;

/** What the fake sessions score on the CPU, which stands in for the model as trained. */
const CHECK: RerankingCheck = {
  query: "what is",
  texts: ["paris lies on seine", "a"],
  scores: ["paris lies on seine", "a"].map((text) => pairLength("what is", text)),
};

/** The tiny tokenizer's files in a new folder, and the model's files as a load is given them. */
async function tinyModelFiles(directory?: string): Promise<RerankingModelFiles> {
  const folder = directory ?? (await createTempDataFolder());
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "tokenizer.json"), JSON.stringify(TINY_TOKENIZER.json));
  await writeFile(join(folder, "tokenizer_config.json"), JSON.stringify(TINY_TOKENIZER.config));
  return {
    model: join(folder, "int8.onnx"),
    tokenizer: join(folder, "tokenizer.json"),
    tokenizerConfig: join(folder, "tokenizer_config.json"),
    maxTokens: 512,
  };
}

const TEXTS = [
  "a b c d e f g h",
  "a",
  "paris lies on seine",
  "a b",
  "a b c",
  "c d e f g",
  "c",
  "d e",
];
const MORE_TEXTS = [...TEXTS, "f g h", "e"];

describe("The built-in reranking model on the GPU", () => {
  test("scores in batches of 8 texts sorted by length, padded with the padding token, and gives the scores in the order given", async () => {
    const sessions = fakeSessions();
    const crossEncoder = createOnnxCrossEncoder({ createSession: sessions.createSession });

    const device = await crossEncoder.load({
      ...(await tinyModelFiles()),
      gpu: { model: "fp16.onnx", check: CHECK },
    });

    expect(device).toEqual({ device: "gpu" });
    expect(sessions.opened).toEqual(["probe on gpu", "fp16.onnx on gpu"]);
    // The check ran first, as one padded batch.
    expect(sessions.runs).toEqual([
      { device: "gpu", lengths: [7, 10], width: 10, padding: [1n, 1n, 1n] },
    ]);

    sessions.runs.length = 0;
    const scores = await crossEncoder.score("what is", MORE_TEXTS);

    const lengths = MORE_TEXTS.map((text) => pairLength("what is", text));
    expect(scores).toEqual(lengths.map((length) => expect.closeTo(length + 0.02, 5)));
    const sorted = [...lengths].sort((a, b) => a - b);
    expect(sessions.runs.map((run) => run.lengths)).toEqual([
      sorted.slice(0, GPU_BATCH_SIZE),
      sorted.slice(GPU_BATCH_SIZE),
    ]);
    expect(sessions.runs.map((run) => run.width)).toEqual([sorted[7], sorted[9]]);
    expect(new Set(sessions.runs.flatMap((run) => run.padding))).toEqual(new Set([1n]));
  });

  test("on the CPU, scores one pair at a time, in the order given, as before", async () => {
    const sessions = fakeSessions();
    const crossEncoder = createOnnxCrossEncoder({ createSession: sessions.createSession });

    expect(await crossEncoder.load(await tinyModelFiles())).toEqual({ device: "cpu" });
    const scores = await crossEncoder.score("what is", TEXTS);

    // A model with no GPU file never asks for an adapter.
    expect(sessions.opened).toEqual(["int8.onnx on cpu"]);
    const lengths = TEXTS.map((text) => pairLength("what is", text));
    expect(scores).toEqual(lengths);
    expect(sessions.runs.map((run) => run.lengths)).toEqual(lengths.map((length) => [length]));
    expect(sessions.runs.flatMap((run) => run.padding)).toEqual([]);
  });

  test.each([
    [
      "no GPU adapter is found",
      { adapter: false },
      { reason: "no-adapter", message: expect.stringMatching(/adapter/) },
      ["int8.onnx on cpu"],
    ],
    [
      "the GPU file isn't downloaded",
      {},
      { reason: "not-downloaded", message: expect.any(String) },
      ["probe on gpu", "int8.onnx on cpu"],
    ],
    [
      "the model fails on the GPU",
      { gpuFails: true },
      { reason: "session", message: expect.stringMatching(/WebGPU/) },
      ["probe on gpu", "int8.onnx on cpu"],
    ],
    [
      "the GPU's scores for the check are off",
      { gpuOffset: CHECK_TOLERANCE + 0.4 },
      { reason: "check", message: expect.stringMatching(/0\.500 logits/) },
      ["probe on gpu", "fp16.onnx on gpu", "int8.onnx on cpu"],
    ],
  ])("runs on the CPU, one pair at a time, when %s", async (_case, options, fallback, opened) => {
    const sessions = fakeSessions(options);
    const crossEncoder = createOnnxCrossEncoder({ createSession: sessions.createSession });
    const downloaded = fallback.reason !== "not-downloaded";

    const device = await crossEncoder.load({
      ...(await tinyModelFiles()),
      gpu: { model: downloaded ? "fp16.onnx" : null, check: CHECK },
    });

    expect(device).toEqual({ device: "cpu", fallback });
    expect(sessions.opened).toEqual(opened);
    // A GPU session that didn't pass is let go.
    expect(sessions.released).toEqual(opened.filter((name) => name.endsWith("on gpu")));
    sessions.runs.length = 0;
    expect(await crossEncoder.score("what is", TEXTS)).toEqual(
      TEXTS.map((text) => pairLength("what is", text)),
    );
    expect(sessions.runs.every((run) => run.device === "cpu" && run.lengths.length === 1)).toBe(
      true,
    );
  });
});

describe("The built-in reranking model's GPU file", () => {
  const HITS = TEXTS.map((text, index) => ({ id: `${index}`, documentName: "a", text }));

  /** A model whose GPU file `server` serves, with its tokenizer in place, and the log it writes. */
  async function gpuModel(options: Parameters<typeof fakeSessions>[0]) {
    const dataDir = await createTempDataFolder();
    const server = await startModelServer({ "fp16.onnx": 4096 });
    const [file] = server.source.files;
    if (!file) throw new Error("The model server serves no GPU file.");
    const definition: RerankingModelDefinition = {
      ...BUILT_IN_RERANKING_MODEL,
      folder: "tiny",
      files: {
        model: "int8.onnx",
        tokenizer: "tokenizer.json",
        tokenizerConfig: "tokenizer_config.json",
      },
      gpu: { folder: "tiny-gpu", file, check: CHECK },
    };
    await tinyModelFiles(join(dataDir, "models", "tiny"));
    const sessions = fakeSessions(options);
    const { log, entries } = recordingLog();
    const model = createRerankingModel({
      definition,
      source: { baseUrl: server.source.baseUrl, files: [] },
      dataDir,
      crossEncoder: createOnnxCrossEncoder({ createSession: sessions.createSession }),
      emitStatus: () => {},
      log,
    });
    return { model, server, sessions, entries };
  }

  const downloaded = (entries: { event: string }[]) =>
    vi.waitFor(() =>
      expect(entries.map((entry) => entry.event)).toContain("reranking.gpuDownloaded"),
    );

  test("downloads only once a GPU adapter is found, and reranks on the GPU from the next search", async () => {
    const { model, server, sessions, entries } = await gpuModel({});
    expect(model.device()).toBeNull();

    await model.rerank("what is", HITS);
    expect(model.device()).toBe("cpu");
    await downloaded(entries);
    expect(server.requests.map((request) => request.path)).toEqual(["fp16.onnx"]);

    const ranked = await model.rerank("what is", HITS);
    expect(model.device()).toBe("gpu");
    expect(sessions.opened.at(-1)).toBe("fp16.onnx on gpu");
    expect(ranked?.[0]?.text).toBe("a b c d e f g h");
    expect(entries.filter((entry) => entry.event === "reranking.device")).toEqual([
      {
        level: "info",
        event: "reranking.device",
        fields: { device: "cpu", reason: "not-downloaded", message: expect.any(String) },
      },
      { level: "info", event: "reranking.device", fields: { device: "gpu" } },
    ]);
    model.close();
  });

  test("with no GPU adapter, downloads nothing and logs why it reranks on the CPU", async () => {
    const { model, server, entries } = await gpuModel({ adapter: false });

    await model.rerank("what is", HITS);
    await model.rerank("what is", HITS);

    expect(model.device()).toBe("cpu");
    expect(server.requests).toEqual([]);
    expect(entries).toEqual([
      {
        level: "warn",
        event: "reranking.device",
        fields: { device: "cpu", reason: "no-adapter", message: expect.stringMatching(/adapter/) },
      },
    ]);
    model.close();
  });

  test("when the model fails on the GPU as it reranks, reranks on the CPU from then on, and logs why", async () => {
    const { model, sessions, entries } = await gpuModel({ gpuBreaks: true });
    await model.rerank("what is", HITS);
    await downloaded(entries);

    const ranked = await model.rerank("what is", HITS);
    await model.rerank("what is", HITS);

    expect(model.device()).toBe("cpu");
    expect(ranked?.[0]?.text).toBe("a b c d e f g h");
    expect(sessions.opened.slice(-3)).toEqual([
      "probe on gpu",
      "fp16.onnx on gpu",
      "int8.onnx on cpu",
    ]);
    expect(entries.at(-1)).toEqual({
      level: "warn",
      event: "reranking.device",
      fields: { device: "cpu", reason: "session", message: "WebGPU device lost." },
    });
    model.close();
  });

  test.each([
    ["the model fails on the GPU", { gpuFails: true }, "session"],
    ["the GPU's scores for the check are off", { gpuOffset: 1 }, "check"],
  ])("when %s, logs why it reranks on the CPU", async (_case, options, reason) => {
    const { model, entries } = await gpuModel(options);

    await model.rerank("what is", HITS);
    await downloaded(entries);
    const ranked = await model.rerank("what is", HITS);

    expect(model.device()).toBe("cpu");
    expect(ranked?.[0]?.text).toBe("a b c d e f g h");
    expect(entries.at(-1)).toEqual({
      level: "warn",
      event: "reranking.device",
      fields: { device: "cpu", reason, message: expect.any(String) },
    });
    model.close();
  });
});
