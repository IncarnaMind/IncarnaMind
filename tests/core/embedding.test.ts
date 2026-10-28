import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  BUILT_IN_EMBEDDING_MODEL,
  type Core,
  type Document,
  type Embedder,
  EmbeddingModelNotReadyError,
  type EmbeddingModelStatus,
} from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  sha256,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import {
  type ControlledEmbedder,
  createControlledEmbedder,
  type ModelServer,
  startModelServer,
  turnOnEmbeddings,
  waitForModel,
} from "../helpers/embedding";

const PLANTS = `Photosynthesis converts light energy into chemical energy stored in glucose.

Chlorophyll absorbs mostly blue and red light.`;

const MARKETS = `The central bank raised interest rates to fight inflation.

Bond yields rose after the announcement.`;

const CHINESE = `注意力机制让模型能够关注输入中最重要的部分。

卷积神经网络擅长处理图像。`;

/** A fake model's files: the fake embedder doesn't read them, but they're downloaded and checked. */
const MODEL_FILES = {
  "onnx/model.onnx": 400_000,
  "tokenizer.json": 60_000,
  "tokenizer_config.json": 400,
};

const modelFolder = (dataDir: string) => join(dataDir, "models", BUILT_IN_EMBEDDING_MODEL.folder);

/** Records every status a Document goes through. */
function statusesOf(core: Core) {
  const seen = new Map<string, Document["status"][]>();
  core.on("document.status", (document) => {
    const list = seen.get(document.id) ?? [];
    if (list.at(-1) !== document.status) list.push(document.status);
    seen.set(document.id, list);
  });
  return (id: string) => seen.get(id) ?? [];
}

/** Resolves once the Document reaches `status`. */
function waitForStatus(core: Core, id: string, status: Document["status"]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`The Document didn't reach "${status}".`));
    }, 10_000);
    const check = (document: Document) => {
      if (document.id !== id || document.status !== status) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = core.on("document.status", check);
    void core.listDocuments().then((documents) => documents.forEach(check));
  });
}

/** A data folder and a way to start the core on it, with embeddings on: they are off by default. */
async function setUp(options: { server?: ModelServer; embedder?: ControlledEmbedder } = {}) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const embedder = options.embedder ?? createControlledEmbedder();
  const start = async () => {
    const core = startCore(dataDir, {
      embedder,
      embeddingModelSource: options.server?.source ?? NO_MODEL_FILES,
    });
    await turnOnEmbeddings(core);
    return core;
  };
  return { dataDir, sources, embedder, start };
}

describe("The built-in embedding model", { timeout: 30_000 }, () => {
  test("a Document added before the model is ready waits for it, then carries on by itself", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("onnx/model.onnx", { held: true });
    const { sources, start } = await setUp({ server });
    const core = await start();
    const statuses = statusesOf(core);
    expect(await core.getEmbeddingModel()).toEqual({
      name: "multilingual-e5-small",
      host: new URL(server.source.baseUrl).host,
      state: "not-downloaded",
      downloadedBytes: 0,
      totalBytes: 460_400,
      error: null,
    });

    const [added] = (await core.addDocuments([await writeSourceFile(sources, "plants.md", PLANTS)]))
      .documents;
    if (!added) throw new Error("Nothing was added.");
    await waitForStatus(core, added.id, "waiting-for-model");

    // Nothing of the User's is needed, so the download starts by itself.
    expect((await core.getEmbeddingModel()).state).toBe("downloading");
    // Keyword search already works; hybrid search uses it alone; vector search has to wait.
    const keyword = await core.searchPassages("chlorophyll", { mode: "keyword" });
    expect(keyword.map((result) => result.documentId)).toEqual([added.id]);
    expect(await core.searchPassages("chlorophyll")).toEqual(keyword);
    await expect(core.searchPassages("chlorophyll", { mode: "vector" })).rejects.toThrow(
      EmbeddingModelNotReadyError,
    );

    server.release();
    const [ready] = await waitForProcessing(core, [added.id]);

    expect(ready?.status).toBe("ready");
    expect(statuses(added.id)).toEqual([
      "queued",
      "extracting",
      "waiting-for-model",
      "embedding",
      "ready",
    ]);
    expect((await core.getEmbeddingModel()).state).toBe("ready");
    const vector = await core.searchPassages("chlorophyll", { mode: "vector" });
    expect(vector.map((result) => result.documentId)).toEqual([added.id]);
  });

  test("the download reports its progress, checks each file and keeps it in the data folder", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("onnx/model.onnx", { chunkDelayMs: 80 });
    const { dataDir, start } = await setUp({ server });
    const core = await start();
    const events: EmbeddingModelStatus[] = [];
    core.on("embeddingModel.status", (status) => events.push(status));

    const started = await core.downloadEmbeddingModel();
    await waitForModel(core, (status) => status.state === "ready");

    expect(started.state).toBe("downloading");
    expect(events[0]).toMatchObject({ state: "downloading", downloadedBytes: 0 });
    expect(events.at(-1)).toMatchObject({ state: "ready", downloadedBytes: 460_400, error: null });
    const progress = events.map((event) => event.downloadedBytes);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.some((bytes) => bytes > 0 && bytes < 400_000)).toBe(true);
    for (const [path, content] of server.contents) {
      expect(new Uint8Array(await readFile(join(modelFolder(dataDir), path)))).toEqual(content);
    }
    const folder = await readdir(modelFolder(dataDir), { recursive: true });
    expect(folder.filter((name) => name.endsWith(".partial"))).toEqual([]);
    expect(server.requests.map((request) => request.range)).toEqual([null, null, null]);
  });

  test("a file that fails its integrity check is thrown away, and retrying downloads it again", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("tokenizer.json", { corrupt: true });
    const { dataDir, sources, start } = await setUp({ server });
    const core = await start();

    await core.downloadEmbeddingModel();
    const failed = await waitForModel(core, (status) => status.state === "failed");

    expect(failed.error).toEqual({
      kind: "integrity",
      message: expect.stringContaining("tokenizer.json from 127.0.0.1"),
      sources: [{ source: "huggingface", message: expect.stringContaining("recorded SHA-256") }],
    });
    const folder = await readdir(modelFolder(dataDir), { recursive: true });
    expect(folder).not.toContain("tokenizer.json");
    expect(folder).not.toContain("tokenizer.json.partial");
    expect(folder).toContain(join("onnx", "model.onnx")); // checked, so kept

    server.behave("tokenizer.json", {});
    const retried = await core.downloadEmbeddingModel();
    await waitForModel(core, (status) => status.state === "ready");
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "plants.md", PLANTS),
    ]);

    expect(retried).toMatchObject({ state: "downloading", error: null });
    expect(document?.status).toBe("ready");
    const tokenizer = await readFile(join(modelFolder(dataDir), "tokenizer.json"));
    expect(new Uint8Array(tokenizer)).toEqual(server.contents.get("tokenizer.json"));
    // The model file wasn't downloaded twice.
    expect(server.requests.filter((request) => request.path === "onnx/model.onnx")).toHaveLength(1);
  });

  test("a download that stops part way resumes where it stopped", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("onnx/model.onnx", { cutAfter: 150_000 });
    const { dataDir, start } = await setUp({ server });
    const core = await start();

    await core.downloadEmbeddingModel();
    const failed = await waitForModel(core, (status) => status.state === "failed");

    expect(failed.error?.kind).toBe("network");
    const partial = join(modelFolder(dataDir), "onnx/model.onnx.partial");
    const kept = (await stat(partial)).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(150_000);

    server.behave("onnx/model.onnx", {});
    await core.downloadEmbeddingModel();
    await waitForModel(core, (status) => status.state === "ready");

    const model = await readFile(join(modelFolder(dataDir), "onnx/model.onnx"));
    expect(new Uint8Array(model)).toEqual(server.contents.get("onnx/model.onnx"));
    const modelRequests = server.requests.filter((request) => request.path === "onnx/model.onnx");
    expect(modelRequests.map((request) => request.range)).toEqual([null, `bytes=${kept}-`]);
  });

  test("quitting during the download keeps what arrived, and the next start resumes it", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("onnx/model.onnx", { chunkDelayMs: 100 });
    const { dataDir, sources, start } = await setUp({ server });
    const before = await start();
    const [added] = (
      await before.addDocuments([await writeSourceFile(sources, "plants.md", PLANTS)])
    ).documents;
    if (!added) throw new Error("Nothing was added.");
    await waitForModel(before, (status) => status.downloadedBytes > 100_000);
    before.close();
    // Its download has stopped when the server's end of the connection is closed.
    await vi.waitFor(() => expect(server.requests.every((request) => request.closed)).toBe(true), {
      timeout: 10_000,
    });

    server.behave("onnx/model.onnx", {});
    const after = await start();
    const [ready] = await waitForProcessing(after, [added.id]);

    expect(ready?.status).toBe("ready");
    // It went on from what had arrived, not from the start: the Range names a place inside the file.
    const modelRequests = server.requests.filter((request) => request.path === "onnx/model.onnx");
    const resumedFrom = Number(modelRequests.at(-1)?.range?.match(/^bytes=(\d+)-$/)?.[1]);
    expect(resumedFrom).toBeGreaterThan(0);
    expect(resumedFrom).toBeLessThan(server.contents.get("onnx/model.onnx")?.byteLength ?? 0);
    const model = await readFile(join(modelFolder(dataDir), "onnx/model.onnx"));
    expect(new Uint8Array(model)).toEqual(server.contents.get("onnx/model.onnx"));
  });

  test("after the download, Documents are embedded with no network", async () => {
    const server = await startModelServer(MODEL_FILES);
    const { sources, start } = await setUp({ server });
    const before = await start();
    await before.downloadEmbeddingModel();
    await waitForModel(before, (status) => status.state === "ready");
    before.close();
    await server.close();
    const requests = server.requests.length;

    const after = await start();
    expect(await after.getEmbeddingModel()).toMatchObject({ state: "ready", error: null });
    const [document] = await addAndProcess(after, [
      await writeSourceFile(sources, "plants.md", PLANTS),
    ]);

    expect(document?.status).toBe("ready");
    expect(server.requests).toHaveLength(requests);
    const found = await after.searchPassages("light energy", { mode: "vector" });
    expect(found[0]?.documentId).toBe(document?.id);
  });

  test("a model that can't start leaves Documents waiting, and retrying carries on", async () => {
    const embedder = createControlledEmbedder();
    embedder.failLoads = true;
    const { sources, start } = await setUp({ embedder });
    const core = await start();
    const statuses = statusesOf(core);

    const [added] = (await core.addDocuments([await writeSourceFile(sources, "plants.md", PLANTS)]))
      .documents;
    if (!added) throw new Error("Nothing was added.");
    const failed = await waitForModel(core, (status) => status.state === "failed");
    await waitForStatus(core, added.id, "waiting-for-model");

    expect(failed.error).toEqual({ kind: "load", message: "This computer can't run the model." });
    await expect(core.searchPassages("light", { mode: "vector" })).rejects.toThrow(
      EmbeddingModelNotReadyError,
    );

    embedder.failLoads = false;
    await core.downloadEmbeddingModel();
    const [ready] = await waitForProcessing(core, [added.id]);

    expect(ready?.status).toBe("ready");
    expect(statuses(added.id)).toEqual([
      "queued",
      "extracting",
      "embedding",
      "waiting-for-model",
      "embedding",
      "ready",
    ]);
  });

  test("when the embedding process crashes, it is started again and the Passage retried", async () => {
    const embedder = createControlledEmbedder();
    embedder.failEmbeds = 1;
    const { sources, start } = await setUp({ embedder });
    const core = await start();

    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "plants.md", PLANTS),
    ]);

    expect(document?.status).toBe("ready");
    expect(embedder.failEmbeds).toBe(0);
    expect(embedder.texts).toHaveLength(1);
  });

  test("only the Document being embedded says so, with its progress; those waiting their turn are queued", async () => {
    const fake = createFakeEmbedder();
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let firstEmbed = () => {};
    const embedding = new Promise<void>((resolve) => {
      firstEmbed = resolve;
    });
    // Holds every Passage until the gate opens: the first Document's turn lasts until then.
    const embedder: Embedder = {
      load: (files) => fake.load(files),
      embed: async (text) => {
        firstEmbed();
        await gate;
        return fake.embed(text);
      },
      close: () => fake.close(),
    };
    const sources = await createTempDataFolder();
    const core = startCore(await createTempDataFolder(), { embedder });
    await turnOnEmbeddings(core);
    const statuses = statusesOf(core);
    let turn = true;
    const embeddingEarly: string[] = [];
    core.on("document.status", (document) => {
      if (turn && document.status === "embedding" && document.name !== "Big") {
        embeddingEarly.push(document.name);
      }
    });
    const long = Array.from(
      { length: 400 },
      (_, index) => `Sentence ${index} is about photosynthesis and light.`,
    ).join(" ");
    const { documents } = await core.addDocuments([
      await writeSourceFile(sources, "Big.md", long),
      await writeSourceFile(sources, "plants.md", PLANTS),
      await writeSourceFile(sources, "markets.md", MARKETS),
    ]);
    const [big, plants, markets] = documents;
    if (!big || !plants || !markets) throw new Error("Nothing was added.");

    await embedding;
    // The small ones are extracted, then wait for the big one: queued again, not "Embedding… 0%".
    // A slow machine can take them through extracting more than once first.
    await expect
      .poll(
        async () =>
          (await core.listDocuments()).map((each) => [each.name, each.status, each.progress]),
        { timeout: 20_000 },
      )
      .toEqual([
        ["markets", "queued", null],
        ["plants", "queued", null],
        ["Big", "embedding", 0],
      ]);
    expect(embeddingEarly).toEqual([]);

    turn = false;
    open();
    await waitForProcessing(core, [big.id, plants.id, markets.id]);
    expect(statuses(big.id).slice(-2)).toEqual(["embedding", "ready"]);
    for (const small of [plants, markets]) {
      expect(statuses(small.id).slice(-3)).toEqual(["queued", "embedding", "ready"]);
    }
  });

  test("a new version extracted during the old one's last batch is embedded before the Document is ready", async () => {
    const fake = createFakeEmbedder();
    let held = true;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let batchStarted = () => {};
    const inBatch = new Promise<void>((resolve) => {
      batchStarted = resolve;
    });
    // Holds the first version's Passages: its only batch, so its last, stays in flight.
    const embedder: Embedder = {
      load: (files) => fake.load(files),
      embed: async (text) => {
        if (held && text.startsWith("passage: ")) {
          batchStarted();
          await gate;
        }
        return fake.embed(text);
      },
      close: () => fake.close(),
    };
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { embedder });
    await turnOnEmbeddings(core);
    const path = await writeSourceFile(sources, "notes.md", PLANTS);
    const [added] = (await core.addDocuments([path])).documents;
    if (!added) throw new Error("Nothing was added.");
    await inBatch;

    // Meanwhile the file changes, and its new version is extracted and stored.
    await writeFile(path, MARKETS);
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      expect(documents[0]?.contentHash).toBe(sha256(MARKETS));
    });
    held = false;
    release();
    const [ready] = await waitForProcessing(core, [added.id]);

    expect(ready).toMatchObject({ status: "ready", contentHash: sha256(MARKETS) });
    // Every Passage of the new version has its vector, so vector search finds it.
    expect(
      queryDatabase(
        dataDir,
        `SELECT count(*) AS total, count(embedding) AS embedded FROM passages
         WHERE deleted_at IS NULL`,
      ),
    ).toEqual([{ total: 1, embedded: 1 }]);
    const found = await core.searchPassages("interest rates", { mode: "vector" });
    expect(found.map((result) => result.text)).toEqual([expect.stringContaining("central bank")]);
  });

  test("Passages are embedded one at a time, with the Document's name and the e5 prefixes", async () => {
    const { sources, start, embedder } = await setUp();
    const core = await start();
    const long = Array.from(
      { length: 120 },
      (_, index) => `Sentence ${index} talks about photosynthesis and light.`,
    ).join(" ");

    await addAndProcess(core, [
      await writeSourceFile(sources, "Plant notes.md", long),
      await writeSourceFile(sources, "Markets.md", MARKETS),
    ]);
    await core.searchPassages("  Light ⼤ energy  ", { mode: "vector" });

    expect(embedder.maxConcurrent).toBe(1);
    const passages = embedder.texts.filter((text) => text.startsWith("passage: "));
    expect(passages.length).toBeGreaterThan(3);
    expect(
      passages.filter((text) => text.startsWith("passage: Plant notes\nSentence 0 ")),
    ).toHaveLength(1);
    expect(passages.at(-1)).toBe(
      "passage: Markets\nThe central bank raised interest rates to fight inflation. Bond yields rose after the announcement.",
    );
    // Queries are normalised like Passages.
    expect(embedder.texts.at(-1)).toBe("query: Light大energy");
  });
});

describe("Vector and hybrid search", { timeout: 30_000 }, () => {
  async function library() {
    const { dataDir, sources, start, embedder } = await setUp();
    const core = await start();
    const [plants, markets, chinese] = await addAndProcess(core, [
      await writeSourceFile(sources, "plants.md", PLANTS),
      await writeSourceFile(sources, "markets.md", MARKETS),
      await writeSourceFile(sources, "笔记.txt", CHINESE),
    ]);
    if (!plants || !markets || !chinese) throw new Error("Nothing was added.");
    return { dataDir, sources, start, embedder, core, plants, markets, chinese };
  }

  const ids = (results: { documentId: string }[]) => results.map((result) => result.documentId);

  test("vector search finds Passages that share no word with the query", async () => {
    const { core, plants, chinese } = await library();

    expect(await core.searchPassages("photosynthetic conversion", { mode: "keyword" })).toEqual([]);
    const vector = await core.searchPassages("photosynthetic conversion", { mode: "vector" });
    const hybrid = await core.searchPassages("photosynthetic conversion");

    // Vector search always ranks every Passage; the closest comes first.
    expect(vector).toHaveLength(3);
    expect(vector[0]?.documentId).toBe(plants.id);
    expect(hybrid[0]?.documentId).toBe(plants.id);
    expect((await core.searchPassages("模型关注什么", { mode: "vector" }))[0]?.documentId).toBe(
      chinese.id,
    );
  });

  test("hybrid search fuses the keyword and vector rankings by reciprocal rank fusion, k = 60", async () => {
    const { core, sources } = await library();
    await addAndProcess(core, [
      await writeSourceFile(sources, "light.md", "Light travels fast. Red light bends less."),
      await writeSourceFile(sources, "energy.md", "Energy prices rose with inflation."),
    ]);
    const query = "light energy inflation";

    const keyword = await core.searchPassages(query, { mode: "keyword", limit: 50 });
    const vector = await core.searchPassages(query, { mode: "vector", limit: 50 });
    const hybrid = await core.searchPassages(query, { limit: 50 });

    const scores = new Map<string, number>();
    for (const list of [keyword, vector]) {
      list.forEach((result, index) => {
        scores.set(result.passageId, (scores.get(result.passageId) ?? 0) + 1 / (60 + index + 1));
      });
    }
    const expected = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(keyword.length).toBeGreaterThan(1);
    expect(hybrid.map((result) => result.passageId)).toEqual(expected);
    expect(
      (await core.searchPassages(query, { limit: 2 })).map((result) => result.passageId),
    ).toEqual(expected.slice(0, 2));
  });

  test("each kind of search can be limited to some Documents", async () => {
    const { core, plants, markets, chinese } = await library();

    for (const mode of ["keyword", "vector", "hybrid"] as const) {
      const scoped = await core.searchPassages("light inflation 模型", {
        mode,
        documentIds: [markets.id, chinese.id],
      });
      expect(ids(scoped).sort()).toEqual([markets.id, chinese.id].sort());
      expect(ids(scoped)).not.toContain(plants.id);
    }
    expect(
      await core.searchPassages("light", { mode: "vector", documentIds: ["no-such-document"] }),
    ).toEqual([]);
    await expect(core.searchPassages("light", { documentIds: "all" as never })).rejects.toThrow(
      "documentIds",
    );
    await expect(core.searchPassages("light", { mode: "fuzzy" as never })).rejects.toThrow(
      "search mode",
    );
  });

  test("the vectors held in memory follow deletes, new Documents and renames", async () => {
    const { core, sources, plants, markets } = await library();
    // The first search loads the vectors into memory.
    expect(ids(await core.searchPassages("light", { mode: "vector" }))).toContain(plants.id);

    await core.deleteDocument(plants.id);
    expect(ids(await core.searchPassages("light", { mode: "vector" }))).not.toContain(plants.id);
    expect(ids(await core.searchPassages("light"))).not.toContain(plants.id);

    const [optics] = await addAndProcess(core, [
      await writeSourceFile(sources, "optics.md", "Lenses focus light onto a sensor."),
    ]);
    expect(
      (await core.searchPassages("lenses focusing light", { mode: "vector" }))[0]?.documentId,
    ).toBe(optics?.id);

    await core.renameDocument(markets.id, "Monetary policy");
    expect(ids(await core.searchPassages("bond yields", { mode: "vector" }))[0]).toBe(markets.id);
  });

  test("vectors survive a restart", async () => {
    const { core, start } = await library();
    const before = await core.searchPassages("energy in plants", { mode: "vector" });
    core.close();

    const after = await start();

    expect(await after.searchPassages("energy in plants", { mode: "vector" })).toEqual(before);
  });

  test("keyword search finds Chinese words in a sentence, and ignores stopwords", async () => {
    const { core, plants, chinese } = await library();

    expect(ids(await core.searchPassages("什么是注意力？", { mode: "keyword" }))).toEqual([
      chinese.id,
    ]);
    expect(ids(await core.searchPassages("图像", { mode: "keyword" }))).toEqual([chinese.id]);
    expect(ids(await core.searchPassages("What is chlorophyll?", { mode: "keyword" }))).toEqual([
      plants.id,
    ]);
    // Only stopwords: nothing to look for.
    expect(await core.searchPassages("what is the", { mode: "keyword" })).toEqual([]);
    expect(await core.searchPassages("是什么", { mode: "keyword" })).toEqual([]);
  });

  test("renaming a Document re-indexes its name for keyword search", async () => {
    const { core, markets } = await library();
    // The name is indexed once for the Document, in its own index.
    expect(ids(await core.searchPassages("markets", { mode: "keyword" }))).toEqual([markets.id]);

    await core.renameDocument(markets.id, "Monetary policy");

    expect(await core.searchPassages("markets", { mode: "keyword" })).toEqual([]);
    expect(ids(await core.searchPassages("monetary", { mode: "keyword" }))).toEqual([markets.id]);
  });
});
