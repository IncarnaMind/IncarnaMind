/**
 * Embeddings are off by default (ADR-0009, 2026-10-10): Documents are ready
 * once their keyword index is, nothing is downloaded, loaded or embedded, and
 * search finds Passages by their words, reranked. The User can turn them on
 * in Settings; an install from before keeps them on only if the User had
 * chosen a provider other than the built-in model.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type Document, InvalidInputError } from "../../src/core";
import { fuseRankingScores } from "../../src/core/documents/search";
import { openDatabase } from "../../src/core/storage";
import { organizeState } from "../../src/renderer/src/libraryPage";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";
import {
  type ControlledEmbedder,
  createControlledEmbedder,
  startModelServer,
  turnOnEmbeddings,
} from "../helpers/embedding";
import { mockEmbeddingModels } from "../helpers/embeddingProviders";
import { classifierModel } from "../helpers/library";

const PLANTS = `Photosynthesis converts light energy into chemical energy stored in glucose.

Chlorophyll absorbs mostly blue and red light.`;

/** A note that names a customer in Orders.csv once, among other words. */
const NOTES = `# Supplier notes

Evergreen Labs asked for its invoices by post from now on.

The Leeds warehouse closes early on Fridays, and the loading bay is shut for repairs.`;

/** A fake built-in model's files: the fake embedder doesn't read them, but they're downloaded and checked. */
const MODEL_FILES = { "onnx/model.onnx": 40_000, "tokenizer.json": 6_000 };

/** A server on this computer: no consent is asked. */
const LOCAL_SERVER = "http://127.0.0.1:9/v1";

const orders = () =>
  new Uint8Array(readFileSync(new URL("../fixtures/formats/Orders.csv", import.meta.url)));

/** Records every status each Document goes through. */
function statusesOf(core: Core) {
  const seen = new Map<string, Document["status"][]>();
  core.on("document.status", (document) => {
    const list = seen.get(document.id) ?? [];
    if (list.at(-1) !== document.status) list.push(document.status);
    seen.set(document.id, list);
  });
  return (id: string) => seen.get(id) ?? [];
}

const vectorCount = (dataDir: string) =>
  queryDatabase<{ count: number }>(
    dataDir,
    "SELECT count(embedding) AS count FROM passages WHERE deleted_at IS NULL",
  )[0]?.count;

/** Forgets the stored on/off, as in an install from before embeddings could be off. */
function forgetEmbeddingsChoice(dataDir: string): void {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("DELETE FROM device_settings WHERE key = 'embeddingsOn'");
  } finally {
    db.close();
  }
}

describe("Embeddings off, the default", { timeout: 30_000 }, () => {
  test("Documents are ready once their keyword index is: nothing is downloaded, loaded or embedded", async () => {
    const server = await startModelServer(MODEL_FILES);
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const embedder = createControlledEmbedder();
    const core = startCore(dataDir, { embedder, embeddingModelSource: server.source });
    const statuses = statusesOf(core);

    expect(await core.getEmbeddingSettings()).toEqual({
      provider: {
        kind: "off",
        baseUrl: null,
        modelId: "",
        hasApiKey: false,
        dimensions: null,
        service: null,
      },
      localOnly: false,
      rebuild: null,
      error: null,
    });
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(sources, "plants.md", PLANTS),
    ]);

    expect(plants).toMatchObject({ status: "ready", progress: null });
    expect(statuses(plants?.id as string)).toEqual(["queued", "extracting", "ready"]);
    expect(server.requests).toEqual([]);
    expect((await core.getEmbeddingModel()).state).toBe("not-downloaded");
    expect(embedder.texts).toEqual([]);
    expect(vectorCount(dataDir)).toBe(0);
    expect(
      queryDatabase(dataDir, "SELECT embedding_model, embedding_dimensions FROM documents"),
    ).toEqual([{ embedding_model: null, embedding_dimensions: null }]);
  });

  test("search finds Passages by their words: hybrid search is keyword search, and vector search is refused", async () => {
    const embedder = createControlledEmbedder();
    const core = startCore(await createTempDataFolder(), { embedder });
    await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);

    const keyword = await core.searchPassages("chlorophyll", { mode: "keyword" });

    expect(keyword).toHaveLength(1);
    expect(await core.searchPassages("chlorophyll")).toEqual(keyword);
    // No word in common: nothing, where vector search would rank every Passage.
    expect(await core.searchPassages("photosynthetic conversion of sunlight")).toEqual([]);
    await expect(core.searchPassages("chlorophyll", { mode: "vector" })).rejects.toThrow(
      InvalidInputError,
    );
    // Searches embed nothing either.
    expect(embedder.texts).toEqual([]);
  });

  test("turned on, Documents are embedded in the background, and vector search finds them", async () => {
    const server = await startModelServer(MODEL_FILES);
    const embedder = createControlledEmbedder();
    const core = startCore(await createTempDataFolder(), {
      embedder,
      embeddingModelSource: server.source,
    });
    const statuses = statusesOf(core);
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    const id = plants?.id as string;
    expect(server.requests).toEqual([]);

    const settings = await core.saveEmbeddingProvider({ kind: "built-in" });

    expect(settings.provider).toMatchObject({ kind: "built-in", modelId: "multilingual-e5-small" });
    // The model downloads now, as the Document needs it.
    await waitForDocuments(core, (documents) => expect(documents[0]?.status).toBe("ready"));
    expect(statuses(id)).toEqual([
      "queued",
      "extracting",
      "ready",
      "waiting-for-model",
      "embedding",
      "ready",
    ]);
    expect(server.requests.length).toBeGreaterThan(0);
    expect(embedder.texts.length).toBeGreaterThan(0);
    const vector = await core.searchPassages("photosynthetic conversion", { mode: "vector" });
    expect(vector.map((passage) => passage.documentId)).toEqual([id]);
    expect((await core.getEmbeddingSettings()).rebuild).toBeNull();
  });

  test("turned off again, Documents are ready at once and keep their vectors, which turning on uses again", async () => {
    const dataDir = await createTempDataFolder();
    const embedder = createControlledEmbedder();
    const core = startCore(dataDir, { embedder });
    await turnOnEmbeddings(core);
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    const embedded = embedder.texts.length;
    const vectors = vectorCount(dataDir);
    expect(vectors).toBeGreaterThan(0);

    const off = await core.saveEmbeddingProvider({ kind: "off" });

    expect(off).toMatchObject({ provider: { kind: "off" }, rebuild: null, error: null });
    expect(vectorCount(dataDir)).toBe(vectors);
    await expect(core.searchPassages("light", { mode: "vector" })).rejects.toThrow(
      InvalidInputError,
    );

    await core.saveEmbeddingProvider({ kind: "built-in" });

    // Nothing to embed: its vectors were kept, and are used again.
    expect((await core.listDocuments())[0]?.status).toBe("ready");
    const found = await core.searchPassages("photosynthetic conversion", { mode: "vector" });
    expect(found.map((passage) => passage.documentId)).toEqual([plants?.id]);
    expect(embedder.texts.length - embedded).toBe(1); // the query
  });

  test("a Document added while they were off gets its vectors when they are turned on, keeping those it had", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const embedder = createControlledEmbedder();
    const core = startCore(dataDir, { embedder });
    await turnOnEmbeddings(core);
    await addAndProcess(core, [await writeSourceFile(sources, "plants.md", PLANTS)]);
    await core.saveEmbeddingProvider({ kind: "off" });
    await addAndProcess(core, [await writeSourceFile(sources, "notes.md", NOTES)]);
    const before = embedder.texts.length;

    await core.saveEmbeddingProvider({ kind: "built-in" });
    await waitForDocuments(core, (documents) =>
      expect(documents.map((each) => each.status)).toEqual(["ready", "ready"]),
    );

    // Only the notes' Passages were embedded; the plants' vectors were there. Every Passage has one now.
    expect(embedder.texts.length).toBeGreaterThan(before);
    expect(embedder.texts.slice(before).every((text) => text.includes("Supplier notes"))).toBe(
      true,
    );
    expect(vectorCount(dataDir)).toBe(
      queryDatabase<{ count: number }>(
        dataDir,
        "SELECT count(*) AS count FROM passages WHERE deleted_at IS NULL",
      )[0]?.count,
    );
  });

  test("turning them off settles what was waiting for the model, and changing nothing is refused for a test", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("onnx/model.onnx", { held: true });
    const core = startCore(await createTempDataFolder(), {
      embedder: createControlledEmbedder(),
      embeddingModelSource: server.source,
    });
    await turnOnEmbeddings(core);
    const [plants] = (
      await core.addDocuments([
        await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
      ])
    ).documents;
    await waitForDocuments(core, (documents) =>
      expect(documents[0]?.status).toBe("waiting-for-model"),
    );

    await core.saveEmbeddingProvider({ kind: "off" });

    expect(await core.listDocuments()).toEqual([
      expect.objectContaining({ id: plants?.id, status: "ready" }),
    ]);
    await expect(core.testEmbeddingConnection({ kind: "off" })).rejects.toThrow(InvalidInputError);
    await expect(core.saveEmbeddingProvider({ kind: "off", modelId: "x" })).rejects.toThrow(
      InvalidInputError,
    );
  });
});

describe("Turning embeddings on leaves every Document's Organize state as it was", {
  timeout: 30_000,
}, () => {
  /** Waits until turning embeddings on has embedded the Documents again. */
  const embeddedAgain = (core: Core, embedder: ControlledEmbedder) =>
    vi.waitFor(async () => {
      expect(embedder.texts.length).toBeGreaterThan(0);
      expect((await core.listDocuments()).map((document) => document.status)).toEqual(
        expect.not.arrayContaining(["embedding", "waiting-for-model"]),
      );
    });

  /** Where Get info says Organize is with the Document: no assignment reads Not organized yet. */
  const organizeStateOf = async (core: Core, id: string) =>
    organizeState(
      (await core.listDocuments()).find((each) => each.id === id),
      (await core.getLibrary()).assignments.find((each) => each.documentId === id),
    );

  test("a Document added before the first Folder stays Not organized yet", async () => {
    const embedder = createControlledEmbedder();
    const core = startCore(await createTempDataFolder(), { embedder });
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    const id = plants?.id as string;
    // The first Folder comes after it: Organize never had it to file.
    await core.createLibraryGroup({ name: "Research", description: "Scientific papers." });
    expect(await organizeStateOf(core, id)).toBe("library.notClassified");

    await turnOnEmbeddings(core);
    await embeddedAgain(core, embedder);

    expect((await core.getLibrary()).assignments).toEqual([]);
    expect(await organizeStateOf(core, id)).toBe("library.notClassified");
  });

  test("a Document restored from Recently deleted stays Not organized yet", async () => {
    const embedder = createControlledEmbedder();
    const core = startCore(await createTempDataFolder(), { embedder });
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    const id = plants?.id as string;
    await core.deleteDocument(id);
    await core.createLibraryGroup({ name: "Research", description: "Scientific papers." });
    await core.restore([{ kind: "document", id }]);
    await waitForDocuments(core, (documents) => expect(documents[0]?.id).toBe(id));
    expect(await organizeStateOf(core, id)).toBe("library.notClassified");

    await turnOnEmbeddings(core);
    await embeddedAgain(core, embedder);

    expect((await core.getLibrary()).assignments).toEqual([]);
    expect(await organizeStateOf(core, id)).toBe("library.notClassified");
  });

  test("a Document that had an assignment keeps it", async () => {
    const fake = classifierModel();
    const embedder = createControlledEmbedder();
    const core = startCore(await createTempDataFolder(), {
      embedder,
      createChatModel: () => fake.model,
    });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const group = await core.createLibraryGroup({
      name: "Research",
      description: "Scientific papers.",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "classifier" } },
      automatic: true,
    });
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    const id = plants?.id as string;
    const before = await vi.waitFor(async () => {
      const assignment = (await core.getLibrary()).assignments.find(
        (each) => each.documentId === id,
      );
      expect(assignment).toMatchObject({ groupId: group.id, status: "classified" });
      return assignment;
    });

    await turnOnEmbeddings(core);
    await embeddedAgain(core, embedder);

    expect((await core.getLibrary()).assignments).toEqual([before]);
  });

  test("a re-embed that fails, retried, is filed as it would be on main", async () => {
    const fake = classifierModel();
    const embedder = createControlledEmbedder();
    const core = startCore(await createTempDataFolder(), {
      embedder,
      createChatModel: () => fake.model,
    });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    // Added before the first Folder: nothing Organize had it to file.
    const [plants] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    const id = plants?.id as string;
    const group = await core.createLibraryGroup({
      name: "Research",
      description: "Scientific papers.",
    });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "classifier" } },
      automatic: true,
    });
    expect(await organizeStateOf(core, id)).toBe("library.notClassified");

    // Making its vectors again fails, and its restart too: still nothing Organize files.
    embedder.failEmbeds = 2;
    await turnOnEmbeddings(core);
    await vi.waitFor(async () =>
      expect((await core.listDocuments()).find((each) => each.id === id)?.status).toBe("failed"),
    );
    expect(await organizeStateOf(core, id)).toBe("library.notClassified");

    // Retried from the failed status, it is embedded and filed as main files it.
    await core.retryDocument(id);
    await vi.waitFor(async () => expect(await organizeStateOf(core, id)).toBe("library.suggested"));
    expect(
      (await core.getLibrary()).assignments.find((each) => each.documentId === id),
    ).toMatchObject({ groupId: group.id, status: "classified", suggested: true });
  });
});

describe("An install from before embeddings could be off", { timeout: 30_000 }, () => {
  test("with the built-in model, the old default, they go off: Documents are ready, and their vectors stay for later", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const before = startCore(dataDir, { embedder: createControlledEmbedder() });
    await turnOnEmbeddings(before);
    const [plants] = await addAndProcess(before, [
      await writeSourceFile(sources, "plants.md", PLANTS),
    ]);
    before.close();
    forgetEmbeddingsChoice(dataDir);
    const vectors = vectorCount(dataDir);

    const embedder = createControlledEmbedder();
    const after = startCore(dataDir, { embedder });

    expect((await after.getEmbeddingSettings()).provider.kind).toBe("off");
    expect((await after.listDocuments())[0]).toMatchObject({ id: plants?.id, status: "ready" });
    expect(vectorCount(dataDir)).toBe(vectors);
    expect(embedder.texts).toEqual([]);
    // Turned on again, the vectors are used: nothing is embedded but the query.
    await after.saveEmbeddingProvider({ kind: "built-in" });
    const found = await after.searchPassages("photosynthetic conversion", { mode: "vector" });
    expect(found.map((passage) => passage.documentId)).toEqual([plants?.id]);
    expect(embedder.texts).toHaveLength(1);
  });

  test("a Document waiting for the built-in model is ready after the update", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave("onnx/model.onnx", { held: true });
    const dataDir = await createTempDataFolder();
    const before = startCore(dataDir, {
      embedder: createControlledEmbedder(),
      embeddingModelSource: server.source,
    });
    await turnOnEmbeddings(before);
    await before.addDocuments([
      await writeSourceFile(await createSourceFolder(), "plants.md", PLANTS),
    ]);
    await waitForDocuments(before, (documents) =>
      expect(documents[0]?.status).toBe("waiting-for-model"),
    );
    before.close();
    forgetEmbeddingsChoice(dataDir);

    const after = startCore(dataDir, {
      embedder: createControlledEmbedder(),
      embeddingModelSource: server.source,
    });

    expect((await after.listDocuments())[0]?.status).toBe("ready");
    expect((await after.getEmbeddingModel()).state).not.toBe("downloading");
  });

  test("with a provider the User chose, they stay on", async () => {
    const dataDir = await createTempDataFolder();
    const embeddings = mockEmbeddingModels();
    const start = () =>
      startCore(dataDir, {
        embedder: createControlledEmbedder(),
        createEmbeddingModel: embeddings.createEmbeddingModel,
      });
    const before = start();
    await before.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });
    before.close();
    forgetEmbeddingsChoice(dataDir);

    const after = start();

    expect((await after.getEmbeddingSettings()).provider).toMatchObject({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });
  });
});

describe("Hybrid search while vectors are missing", { timeout: 30_000 }, () => {
  test("a Passage with no vector yet keeps its keyword rank: plain fusion would put a Passage both searches found first", async () => {
    const embeddings = mockEmbeddingModels();
    const core = startCore(await createTempDataFolder(), {
      embedder: createControlledEmbedder(),
      createEmbeddingModel: embeddings.createEmbeddingModel,
    });
    const sources = await createSourceFolder();
    await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });
    const [notes] = await addAndProcess(core, [
      await writeSourceFile(sources, "Supplier notes.md", NOTES),
    ]);
    // The orders are added while the provider holds their Passages: they have no vectors yet.
    embeddings.hold();
    const added = await core.addDocuments([await writeSourceFile(sources, "Orders.csv", orders())]);
    const ordersId = added.documents[0]?.id as string;
    await waitForDocuments(core, (documents) =>
      expect(documents.find((each) => each.id === ordersId)?.status).toBe("embedding"),
    );
    const ids = (found: { documentId: string }[]) => [
      ...new Set(found.map((each) => each.documentId)),
    ];

    const keyword = await core.searchPassages("Evergreen Labs", { mode: "keyword" });
    const vector = await core.searchPassages("Evergreen Labs", { mode: "vector" });
    const hybrid = await core.searchPassages("Evergreen Labs");

    expect(ids(keyword)).toEqual([ordersId, notes?.id]);
    expect(ids(vector)).toEqual([notes?.id]);
    expect(ids(hybrid)).toEqual([ordersId, notes?.id]);
    expect(hybrid[0]?.passageId).toBe(keyword[0]?.passageId);
    embeddings.release();
  });

  test("fusion counts such a Passage's keyword rank for both lists, and changes nothing without vector search's", () => {
    const keyword = [1, 2, 3];
    const vector = [2, 4];
    const order = (keywordOnly?: Set<number>) =>
      fuseRankingScores([keyword, vector], 10, keywordOnly).map((hit) => hit.seq);

    // Plain fusion: 2, in both lists, comes first, though keyword search put 1 first.
    expect(order()).toEqual([2, 1, 4, 3]);
    // 1 and 3 have no vector: their keyword ranks count for vector search's list too.
    expect(order(new Set([1, 3]))).toEqual([1, 2, 3, 4]);
    expect(fuseRankingScores([keyword, vector], 1, new Set([1]))).toEqual([
      { seq: 1, score: 2 / 61 },
    ]);
    expect(fuseRankingScores([keyword, []], 10, new Set([1, 3]))).toEqual(
      fuseRankingScores([keyword, []], 10),
    );
  });
});
