import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type Document,
  type EmbeddingSettings,
  InvalidInputError,
  RECOMMENDED_OLLAMA_MODEL,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import {
  createMemoryKeychain,
  createTempDataFolder,
  nextEvent,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { createControlledEmbedder, turnOnEmbeddings } from "../helpers/embedding";
import { mockEmbeddingModels, startEmbeddingsServer } from "../helpers/embeddingProviders";
import { startOllamaStub } from "../helpers/ollama";

const PLANTS = `Photosynthesis converts light energy into chemical energy stored in glucose.

Chlorophyll absorbs mostly blue and red light.`;

const MARKETS = `The central bank raised interest rates to fight inflation.

Bond yields rose after the announcement.`;

const BUILT_IN_ID = "multilingual-e5-small-int8";
const OPENAI = { id: "https://api.openai.com", name: "OpenAI" };
const OPENAI_KEY = "sk-test-embeddings-key";
const DECIDED_AT = "2026-09-01T09:00:00.000Z";
/** A server on this computer: nothing is sent elsewhere, so no consent is asked. */
const LOCAL_SERVER = "http://127.0.0.1:9/v1";

/**
 * A core with embeddings on with the built-in (fake) model, mock API
 * embedding models, and two Documents processed.
 */
async function setUp(options: { dimensions?: number; overrides?: Partial<CoreAdapters> } = {}) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const embeddings = mockEmbeddingModels({ dimensions: options.dimensions });
  const embedder = createControlledEmbedder();
  const keychain = createMemoryKeychain();
  const start = () =>
    startCore(dataDir, {
      embedder,
      keychain,
      createEmbeddingModel: embeddings.createEmbeddingModel,
      ...options.overrides,
    });
  const core = start();
  await turnOnEmbeddings(core);
  const [plants, markets] = await addAndProcess(core, [
    await writeSourceFile(sources, "Plants.md", PLANTS),
    await writeSourceFile(sources, "Markets.md", MARKETS),
  ]);
  if (!plants || !markets) throw new Error("Nothing was added.");
  return { core, dataDir, sources, embeddings, embedder, keychain, plants, markets, start };
}

/** Records every status each Document goes through, and every "embedding.changed". */
function record(core: Core) {
  const statuses = new Map<string, Document["status"][]>();
  const settings: EmbeddingSettings[] = [];
  core.on("document.status", (document) => {
    const list = statuses.get(document.id) ?? [];
    if (list.at(-1) !== document.status) list.push(document.status);
    statuses.set(document.id, list);
  });
  core.on("embedding.changed", (changed) => settings.push(changed));
  return { statusesOf: (id: string) => statuses.get(id) ?? [], settings };
}

/** Resolves once the rebuild has finished: every Document embedded with the current model. */
function rebuildFinished(core: Core, timeout = 10_000): Promise<EmbeddingSettings> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The rebuild didn't finish."));
    }, timeout);
    const stop = core.on("embedding.changed", (settings) => {
      if (settings.rebuild !== null) return;
      clearTimeout(timer);
      stop();
      resolve(settings);
    });
  });
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

const recordedModels = (dataDir: string) =>
  queryDatabase<{ name: string; embedding_model: string | null; embedding_dimensions: number }>(
    dataDir,
    "SELECT name, embedding_model, embedding_dimensions FROM documents ORDER BY name",
  );

const documentNamesOf = (results: { documentName: string }[]) =>
  [...new Set(results.map((result) => result.documentName))].sort();

describe("Switching the embedding provider", { timeout: 30_000 }, () => {
  test("turned on, embeddings use the built-in model unless another is chosen, and its vectors are recorded with its id and size", async () => {
    const { core, dataDir, embeddings } = await setUp();

    expect(await core.getEmbeddingSettings()).toEqual({
      provider: {
        kind: "built-in",
        baseUrl: null,
        modelId: "multilingual-e5-small",
        hasApiKey: false,
        dimensions: 384,
        service: null,
      },
      localOnly: false,
      rebuild: null,
      error: null,
    });
    expect(recordedModels(dataDir)).toEqual([
      { name: "Markets", embedding_model: BUILT_IN_ID, embedding_dimensions: 384 },
      { name: "Plants", embedding_model: BUILT_IN_ID, embedding_dimensions: 384 },
    ]);
    expect(embeddings.calls).toEqual([]);
  });

  test("switching embeds every Document again through the usual statuses, reporting the rebuild", async () => {
    const { core, dataDir, embeddings, plants, markets } = await setUp();
    const { statusesOf, settings } = record(core);
    const finished = rebuildFinished(core);

    const switched = await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });

    expect(switched.provider).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "mock-embed",
      hasApiKey: false,
      dimensions: null,
      service: null,
    });
    expect(switched.rebuild).toMatchObject({ reason: "provider-changed", total: 2 });
    const done = await finished;
    expect(done).toMatchObject({ rebuild: null, error: null, provider: { dimensions: 64 } });

    // Plants (added first) is embedded at once; Markets is queued until its turn.
    expect(statusesOf(plants.id)).toEqual(["embedding", "ready"]);
    expect(statusesOf(markets.id)).toEqual(["queued", "embedding", "ready"]);
    // The overall progress went up a Document at a time.
    const progress = settings.flatMap((each) => (each.rebuild ? [each.rebuild.done] : []));
    expect(progress).toContain(1);
    expect(progress).toEqual([...progress].sort());
    // Each Passage (one per short Document) was sent once, after its Document's name.
    expect(embeddings.passages()).toHaveLength(2);
    expect(embeddings.passages()).toContainEqual(
      expect.stringMatching(/^Plants\nPhotosynthesis .* red light\.$/),
    );
    // The vectors are recorded with the provider, server, model and size.
    expect(recordedModels(dataDir)).toEqual([
      {
        name: "Markets",
        embedding_model: "openai-compatible@http://127.0.0.1:9/v1:mock-embed",
        embedding_dimensions: 64,
      },
      {
        name: "Plants",
        embedding_model: "openai-compatible@http://127.0.0.1:9/v1:mock-embed",
        embedding_dimensions: 64,
      },
    ]);
    // Searches are embedded by the new model too.
    const found = await core.searchPassages("chlorophyll light", { mode: "vector", limit: 1 });
    expect(found[0]?.documentName).toBe("Plants");
    expect(embeddings.queries()).toEqual(["chlorophyll light"]);
  });

  test("vectors from different models are never compared: during a switch, vector search covers only Documents already embedded again", async () => {
    // The same size as the built-in model's vectors, in another space: only the recorded model keeps them apart.
    const { core, dataDir, embeddings, embedder, plants, markets } = await setUp({
      dimensions: 384,
    });
    embeddings.hold();
    const embeddedBefore = embedder.texts.length;

    await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mirror-embed",
    });
    // Plants (added first) is being embedded again; Markets waits its turn, queued, with its old vectors.
    await embeddings.passageRequests(1);
    expect((await core.listDocuments()).map((each) => [each.name, each.status])).toEqual([
      ["Markets", "queued"],
      ["Plants", "embedding"],
    ]);
    const passages = (name: string) =>
      queryDatabase<{ embedded: number }>(
        dataDir,
        `SELECT count(p.embedding) AS embedded FROM passages p JOIN documents d ON d.id = p.document_id
         WHERE d.name = ? AND p.deleted_at IS NULL`,
        [name],
      )[0]?.embedded;
    expect(passages("Markets")).toBe(1);
    expect(passages("Plants")).toBe(0);

    // Neither Document has vectors from the new model yet: vector search finds nothing,
    // although Markets still has the built-in model's, of the same size.
    expect(await core.searchPassages("interest rates", { mode: "vector" })).toEqual([]);
    // Keyword search still finds everything, so hybrid search keeps working.
    expect(
      documentNamesOf(await core.searchPassages("interest rates inflation", { mode: "hybrid" })),
    ).toEqual(["Markets"]);

    // Plants is done; Markets is next.
    embeddings.release(1);
    await waitForStatus(core, plants.id, "ready");
    await embeddings.passageRequests(2);
    const vector = await core.searchPassages("interest rates", { mode: "vector", limit: 50 });
    expect(documentNamesOf(vector)).toEqual(["Plants"]);

    embeddings.release();
    await waitForStatus(core, markets.id, "ready");
    const after = await core.searchPassages("interest rates", { mode: "vector", limit: 1 });
    expect(after[0]?.documentName).toBe("Markets");
    // The built-in model embedded nothing more.
    expect(embedder.texts.length).toBe(embeddedBefore);
  });

  test("switching back before a Document's turn costs nothing for it", async () => {
    const { core, embeddings, embedder, plants, markets } = await setUp();
    embeddings.hold();
    const embeddedBefore = embedder.texts.length;

    await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });
    await embeddings.passageRequests(1);
    const finished = rebuildFinished(core);
    const back = await core.saveEmbeddingProvider({ kind: "built-in" });
    expect(back.provider.kind).toBe("built-in");
    embeddings.release();
    await finished;

    const documents = await core.listDocuments();
    expect(documents.map((each) => each.status)).toEqual(["ready", "ready"]);
    // Only Plants, whose old vectors were dropped, was embedded again with the built-in model.
    const again = embedder.texts.slice(embeddedBefore);
    expect(again).toHaveLength(1);
    expect(again.every((text) => text.includes("Plants"))).toBe(true);
    expect(markets.id).not.toBe(plants.id);
    const found = await core.searchPassages("interest rates", { mode: "vector", limit: 1 });
    expect(found[0]?.documentName).toBe("Markets");
  });

  test("saving the same model again with a new key embeds nothing again", async () => {
    const { core, embeddings } = await setUp();
    const finished = rebuildFinished(core);
    await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      apiKey: "first-key",
      modelId: "mock-embed",
    });
    await finished;
    const sent = embeddings.passages().length;

    const saved = await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      apiKey: "second-key",
      modelId: "mock-embed",
    });

    expect(saved.rebuild).toBeNull();
    expect(saved.provider).toMatchObject({ hasApiKey: true, dimensions: 64 });
    expect((await core.listDocuments()).map((each) => each.status)).toEqual(["ready", "ready"]);
    expect(embeddings.passages()).toHaveLength(sent);
    expect(embeddings.calls.at(-1)?.spec.apiKey).toBe("first-key");
    await core.searchPassages("light", { mode: "vector" });
    expect(embeddings.calls.at(-1)?.spec.apiKey).toBe("second-key");
  });

  test("the rebuild carries on after a restart", async () => {
    const { core, embeddings, start } = await setUp();
    embeddings.hold();
    await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });
    await embeddings.passageRequests(1);
    core.close();
    embeddings.release();

    const restarted = start();
    const settings = await restarted.getEmbeddingSettings();
    expect(settings.provider.modelId).toBe("mock-embed");
    expect(settings.rebuild).toMatchObject({ reason: "provider-changed", total: 2 });
    const ids = (await restarted.listDocuments()).map((each) => each.id);
    const documents = await waitForProcessing(restarted, ids);
    expect(documents.map((each) => each.status)).toEqual(["ready", "ready"]);
    expect((await restarted.getEmbeddingSettings()).rebuild).toBeNull();
  });

  test("input is checked: a key for OpenAI, a server for OpenAI-compatible, a model name", async () => {
    const { core, embeddings } = await setUp();

    await expect(
      core.saveEmbeddingProvider({ kind: "openai", modelId: "text-embedding-3-small" }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveEmbeddingProvider({ kind: "openai-compatible", modelId: "mock-embed" }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveEmbeddingProvider({ kind: "ollama", baseUrl: LOCAL_SERVER, modelId: " " }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      core.saveEmbeddingProvider({ kind: "built-in", modelId: "another" }),
    ).rejects.toThrow(InvalidInputError);
    await expect(core.saveEmbeddingProvider({ kind: "cohere" } as never)).rejects.toThrow(
      InvalidInputError,
    );
    expect((await core.getEmbeddingSettings()).provider.kind).toBe("built-in");
    expect(embeddings.calls).toEqual([]);
  });
});

describe("Consent for cloud embeddings", { timeout: 30_000 }, () => {
  test("choosing a cloud provider, where the dialog says what goes, allows it: nothing asks", async () => {
    const { core } = await setUp();
    const asked = vi.fn();
    core.on("consent.requested", asked);
    const finished = rebuildFinished(core);

    await core.saveEmbeddingProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "text-embedding-3-small",
    });
    await finished;

    expect(asked).not.toHaveBeenCalled();
    expect(await core.listDataFlows()).toContainEqual({
      flow: { id: "embeddings", service: OPENAI, sends: ["document-text", "queries"] },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });
  });

  test("choosing the provider again is a new choice: it replaces a decline made before, and nothing asks", async () => {
    const { core, embeddings, dataDir } = await setUp();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `INSERT INTO data_flow_consents
           (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
         VALUES (?, 'embeddings', ?, ?, 'declined', '[]', ?, ?)`,
        [randomUUID(), OPENAI.id, OPENAI.name, DECIDED_AT, DECIDED_AT],
      );
    } finally {
      db.close();
    }
    const asked = vi.fn();
    core.on("consent.requested", asked);
    const finished = rebuildFinished(core);

    await core.saveEmbeddingProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "text-embedding-3-small",
    });
    await finished;

    expect(asked).not.toHaveBeenCalled();
    expect(embeddings.passages()).toHaveLength(2);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "embeddings", service: OPENAI }),
        consent: "accepted",
        chosen: true,
      }),
    );
  });

  test("once accepted, every Document's text goes to the provider, and searches too", async () => {
    const { core, embeddings, keychain } = await setUp();
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const finished = rebuildFinished(core);

    const saved = await core.saveEmbeddingProvider({
      kind: "openai",
      apiKey: ` ${OPENAI_KEY} `,
      modelId: "text-embedding-3-small",
    });

    expect(saved.provider).toEqual({
      kind: "openai",
      baseUrl: null,
      modelId: "text-embedding-3-small",
      hasApiKey: true,
      dimensions: null,
      service: OPENAI,
    });
    await finished;
    expect(keychain.secrets.get("embedding-provider:api-key")).toBe(OPENAI_KEY);
    expect(embeddings.calls[0]?.spec).toEqual({
      kind: "openai",
      baseUrl: null,
      apiKey: OPENAI_KEY,
      modelId: "text-embedding-3-small",
    });
    expect(embeddings.passages()).toHaveLength(2);
    await core.searchPassages("bond yields", { mode: "hybrid" });
    expect(embeddings.queries()).toEqual(["bond yields"]);
  });

  test("the connection test sends nothing of the User's, so it asks nothing, and reports the size", async () => {
    const { core, embeddings } = await setUp();
    const asked = vi.fn();
    core.on("consent.requested", asked);

    expect(
      await core.testEmbeddingConnection({
        kind: "openai",
        apiKey: OPENAI_KEY,
        modelId: "text-embedding-3-small",
      }),
    ).toEqual({ ok: true, dimensions: 64 });
    expect(asked).not.toHaveBeenCalled();
    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0]?.values[0]).toContain("checking");
    // Testing saves nothing.
    expect((await core.getEmbeddingSettings()).provider.kind).toBe("built-in");
  });

  test("Google embeds Passages and searches with their task types", async () => {
    const { core, embeddings } = await setUp();
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const finished = rebuildFinished(core);
    await core.saveEmbeddingProvider({
      kind: "google",
      apiKey: "google-key",
      modelId: "gemini-embedding-001",
    });
    await finished;
    await core.searchPassages("light", { mode: "vector" });

    expect(embeddings.calls[0]?.providerOptions).toEqual({
      google: { taskType: "RETRIEVAL_DOCUMENT" },
    });
    expect(embeddings.calls.at(-1)?.providerOptions).toEqual({
      google: { taskType: "RETRIEVAL_QUERY" },
    });
  });

  test("declining later leaves Documents waiting and search by words; allowing again carries on", async () => {
    const { core, embeddings, plants } = await setUp();
    const accept = core.on(
      "consent.requested",
      (request) => void core.respondToConsent(request.requestId, true),
    );
    const finished = rebuildFinished(core);
    await core.saveEmbeddingProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "text-embedding-3-small",
    });
    await finished;
    accept();
    await core.revokeConsent("embeddings", OPENAI.id);
    const decline = core.on(
      "consent.requested",
      (request) => void core.respondToConsent(request.requestId, false),
    );
    const sent = embeddings.calls.length;

    // The search asks, the User declines: it finds Passages by their words alone.
    const found = await core.searchPassages("chlorophyll", { mode: "hybrid" });
    expect(documentNamesOf(found)).toEqual(["Plants"]);
    await expect(core.searchPassages("chlorophyll", { mode: "vector" })).rejects.toThrow(
      /can't be used/,
    );
    expect(embeddings.calls).toHaveLength(sent);
    const settings = await core.getEmbeddingSettings();
    expect(settings.error).toMatchObject({ kind: "consent-declined" });

    // A new Document waits for the provider.
    const sources = await createTempDataFolder();
    const { documents } = await core.addDocuments([
      await writeSourceFile(sources, "Tides.md", "The moon pulls the tides."),
    ]);
    const tides = documents[0] as Document;
    await waitForStatus(core, tides.id, "waiting-for-model");
    expect(embeddings.calls).toHaveLength(sent);

    // Allowing again: the next try carries on.
    decline();
    await core.revokeConsent("embeddings", OPENAI.id);
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const retried = await core.retryEmbedding();
    expect(retried.error).toBeNull();
    await waitForStatus(core, tides.id, "ready");
    const moon = await core.searchPassages("moon", { mode: "vector", limit: 1 });
    expect(moon[0]?.documentId).toBe(tides.id);
    expect(plants.id).not.toBe(tides.id);
  });
});

describe("Embedding provider errors", { timeout: 30_000 }, () => {
  test("a failing provider leaves Documents waiting with its error; search still finds words; retrying carries on", async () => {
    const { core, embeddings, plants, markets } = await setUp();
    embeddings.fail({ status: 429, message: "Rate limit reached for requests." });

    await core.saveEmbeddingProvider({
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    });
    await waitForStatus(core, markets.id, "waiting-for-model");
    await waitForStatus(core, plants.id, "waiting-for-model");
    const settings = await core.getEmbeddingSettings();
    expect(settings.error).toEqual({
      kind: "rate-limit",
      message: "Rate limit reached for requests.",
    });
    expect(settings.rebuild).toMatchObject({ total: 2, done: 0 });
    expect(
      documentNamesOf(await core.searchPassages("photosynthesis", { mode: "hybrid" })),
    ).toEqual(["Plants"]);

    embeddings.fail(null);
    const finished = rebuildFinished(core);
    await core.retryEmbedding();
    await finished;
    expect((await core.listDocuments()).map((each) => each.status)).toEqual(["ready", "ready"]);
    expect((await core.getEmbeddingSettings()).error).toBeNull();
  });

  test("the connection test classifies errors: a bad key, an unknown model, no connection", async () => {
    const { core, embeddings } = await setUp();
    const input = {
      kind: "openai-compatible",
      baseUrl: LOCAL_SERVER,
      modelId: "mock-embed",
    } as const;

    embeddings.fail({ status: 401, message: "Incorrect API key provided." });
    expect(await core.testEmbeddingConnection(input)).toEqual({
      ok: false,
      error: { kind: "auth", message: "Incorrect API key provided.", status: 401 },
    });
    embeddings.fail({ status: 404, message: "The model does not exist." });
    expect(await core.testEmbeddingConnection(input)).toMatchObject({
      ok: false,
      error: { kind: "model" },
    });
    embeddings.fail({ message: "Cannot connect to API." });
    expect(await core.testEmbeddingConnection(input)).toMatchObject({
      ok: false,
      error: { kind: "network" },
    });
  });
});

describe("Ollama embeddings", { timeout: 30_000 }, () => {
  test("go through Ollama's OpenAI-compatible endpoint, on this computer, with no consent", async () => {
    const ollama = await startEmbeddingsServer({ models: ["bge-m3"], dimensions: 48 });
    const { core, dataDir } = await setUp({
      overrides: { createEmbeddingModel: undefined },
    });
    let asked = false;
    core.on("consent.requested", () => {
      asked = true;
    });

    expect(
      await core.testEmbeddingConnection({
        kind: "ollama",
        baseUrl: ollama.baseUrl,
        modelId: "bge-m3",
      }),
    ).toEqual({ ok: true, dimensions: 48 });
    expect(
      await core.testEmbeddingConnection({
        kind: "ollama",
        baseUrl: ollama.baseUrl,
        modelId: "not-pulled",
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: "model", message: expect.stringContaining("pull") },
    });

    const finished = rebuildFinished(core);
    const saved = await core.saveEmbeddingProvider({
      kind: "ollama",
      baseUrl: ollama.baseUrl,
      modelId: "bge-m3",
    });
    expect(saved.provider).toMatchObject({ kind: "ollama", service: null, hasApiKey: false });
    await finished;

    expect(asked).toBe(false);
    expect(ollama.requests.every((request) => request.path === "/v1/embeddings")).toBe(true);
    expect(ollama.requests.at(-1)?.body).toMatchObject({
      model: "bge-m3",
      input: [expect.stringMatching(/^Markets\nThe central bank .* announcement\.$/)],
    });
    expect(recordedModels(dataDir)[0]).toEqual({
      name: "Markets",
      embedding_model: `ollama@${ollama.baseUrl}:bge-m3`,
      embedding_dimensions: 48,
    });
    const found = await core.searchPassages("bond yields", { mode: "vector", limit: 1 });
    expect(found[0]?.documentName).toBe("Markets");
  });

  test("an OpenAI-compatible server's refused key is reported as such", async () => {
    const server = await startEmbeddingsServer({ models: ["embedder"], apiKey: "right-key" });
    const { core } = await setUp({ overrides: { createEmbeddingModel: undefined } });

    const result = await core.testEmbeddingConnection({
      kind: "openai-compatible",
      baseUrl: `${server.baseUrl}/v1`,
      apiKey: "wrong-key",
      modelId: "embedder",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "auth" } });
    expect(server.requests[0]?.authorization).toBe("Bearer wrong-key");
  });
});

describe("Local mode", { timeout: 30_000 }, () => {
  /** A core using OpenAI's embeddings (accepted), every Document embedded with them. */
  async function withOpenAi() {
    const setup = await setUp();
    const accept = setup.core.on(
      "consent.requested",
      (request) => void setup.core.respondToConsent(request.requestId, true),
    );
    const finished = rebuildFinished(setup.core);
    await setup.core.saveEmbeddingProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "text-embedding-3-small",
    });
    await finished;
    accept();
    return setup;
  }

  test("turning it on switches a cloud provider back to the built-in model and embeds again, saying why", async () => {
    const { core, dataDir, keychain, embeddings } = await withOpenAi();
    const { statusesOf } = record(core);
    const finished = rebuildFinished(core);
    const sent = embeddings.calls.length;

    const settings = await core.setLocalOnly(true);

    expect(settings).toMatchObject({
      provider: { kind: "built-in", service: null },
      localOnly: true,
      rebuild: { reason: "local-mode", total: 2 },
    });
    expect(keychain.secrets.has("embedding-provider:api-key")).toBe(false);
    await finished;
    // Newest first: Markets waited, queued, while Plants (added first) was embedded.
    const [markets, plants] = await core.listDocuments();
    expect(statusesOf(plants?.id as string)).toEqual(["embedding", "ready"]);
    expect(statusesOf(markets?.id as string)).toEqual(["queued", "embedding", "ready"]);
    expect(recordedModels(dataDir).map((row) => row.embedding_model)).toEqual([
      BUILT_IN_ID,
      BUILT_IN_ID,
    ]);
    // Nothing more went to OpenAI, searches included.
    await core.searchPassages("light", { mode: "hybrid" });
    expect(embeddings.calls).toHaveLength(sent);
    // Its flow no longer goes anywhere; the decision stays listed, so it can be revoked.
    const flows = await core.listDataFlows();
    expect(flows.filter((flow) => flow.flow.id === "embeddings")).toHaveLength(1);

    // While it is on, cloud providers are refused.
    await expect(
      core.saveEmbeddingProvider({
        kind: "openai",
        apiKey: OPENAI_KEY,
        modelId: "text-embedding-3-small",
      }),
    ).rejects.toThrow(/Keep everything on this computer/);
    await expect(
      core.testEmbeddingConnection({
        kind: "openai",
        apiKey: OPENAI_KEY,
        modelId: "text-embedding-3-small",
      }),
    ).rejects.toThrow(/Keep everything on this computer/);
    expect(embeddings.calls).toHaveLength(sent);

    // Turning it off changes nothing by itself.
    const off = await core.setLocalOnly(false);
    expect(off).toMatchObject({ localOnly: false, provider: { kind: "built-in" }, rebuild: null });
  });

  test("turned on while a search waits for consent to send its words: the prompt closes, and nothing is sent, even when the old prompt is answered", async () => {
    const { core, embeddings } = await withOpenAi();
    await core.revokeConsent("embeddings", OPENAI.id);
    const sent = embeddings.calls.length;
    const asked = nextEvent(core, "consent.requested");
    const searching = core.searchPassages("chlorophyll", { mode: "hybrid" });
    const request = await asked;
    const closed = nextEvent(core, "consent.resolved");

    await core.setLocalOnly(true);

    expect(await closed).toEqual({ requestId: request.requestId, accepted: false });
    await core.respondToConsent(request.requestId, true);
    expect(documentNamesOf(await searching)).toEqual(["Plants"]);
    expect(embeddings.calls).toHaveLength(sent);
  });

  test("choosing local models with the box ticked turns it on, switching cloud embeddings back too", async () => {
    const ollama = await startOllamaStub({ models: [RECOMMENDED_OLLAMA_MODEL] });
    const { core, dataDir } = await withOpenAi();
    const changed = new Promise<EmbeddingSettings>((resolve) => {
      const stop = core.on("embedding.changed", (settings) => {
        if (settings.rebuild?.reason !== "local-mode") return;
        stop();
        resolve(settings);
      });
    });
    const finished = rebuildFinished(core);

    await core.selectOllama({ baseUrl: ollama.baseUrl, localOnly: true });

    expect(await changed).toMatchObject({ localOnly: true, provider: { kind: "built-in" } });
    await finished;
    expect(recordedModels(dataDir).map((row) => row.embedding_model)).toEqual([
      BUILT_IN_ID,
      BUILT_IN_ID,
    ]);
  });

  test("choosing local models without the choice leaves Local mode and the cloud embeddings as they were", async () => {
    const ollama = await startOllamaStub({ models: [RECOMMENDED_OLLAMA_MODEL] });
    const { core } = await withOpenAi();

    await core.selectOllama({ baseUrl: ollama.baseUrl });
    expect(await core.getEmbeddingSettings()).toMatchObject({
      localOnly: false,
      provider: { kind: "openai" },
    });

    await core.setLocalOnly(true);
    await core.selectOllama({ baseUrl: ollama.baseUrl });
    expect((await core.getEmbeddingSettings()).localOnly).toBe(true);

    await core.selectOllama({ baseUrl: ollama.baseUrl, localOnly: false });
    expect((await core.getEmbeddingSettings()).localOnly).toBe(false);
  });

  test("an embedding provider on this computer, such as Ollama, is kept", async () => {
    const ollama = await startEmbeddingsServer({ models: ["bge-m3"] });
    const { core } = await setUp({ overrides: { createEmbeddingModel: undefined } });
    const finished = rebuildFinished(core);
    await core.saveEmbeddingProvider({
      kind: "ollama",
      baseUrl: ollama.baseUrl,
      modelId: "bge-m3",
    });
    await finished;
    const requests = ollama.requests.length;

    const settings = await core.setLocalOnly(true);

    expect(settings).toMatchObject({
      localOnly: true,
      rebuild: null,
      provider: { kind: "ollama", modelId: "bge-m3" },
    });
    expect((await core.listDocuments()).map((each) => each.status)).toEqual(["ready", "ready"]);
    expect(ollama.requests).toHaveLength(requests);
    // Local servers can still be chosen.
    await core.saveEmbeddingProvider({ kind: "built-in" });
    expect((await core.getEmbeddingSettings()).localOnly).toBe(true);
  });
});

describe("Embedding keys", { timeout: 30_000 }, () => {
  test("go to the keychain, never into SQLite; switching to the built-in model deletes them", async () => {
    const { core, dataDir, keychain } = await setUp();
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    const finished = rebuildFinished(core);
    await core.saveEmbeddingProvider({
      kind: "openai",
      apiKey: OPENAI_KEY,
      modelId: "text-embedding-3-small",
    });
    await finished;

    expect(keychain.secrets.get("embedding-provider:api-key")).toBe(OPENAI_KEY);
    const databaseFiles = (await readdir(dataDir)).filter((name) => name.startsWith(DATABASE_FILE));
    expect(databaseFiles).toContain(DATABASE_FILE);
    for (const name of databaseFiles) {
      expect((await readFile(join(dataDir, name))).includes(OPENAI_KEY)).toBe(false);
    }

    await core.saveEmbeddingProvider({ kind: "built-in" });
    expect(keychain.secrets.has("embedding-provider:api-key")).toBe(false);
  });
});
