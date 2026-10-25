import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BUILT_IN_RERANKING_MODEL,
  type CoreAdapters,
  type CrossEncoder,
  DATABASE_FILE,
  InvalidInputError,
  type RerankSettings,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { setUpWithDocuments, unaskedModel } from "../helpers/citations";
import { createMemoryKeychain, createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { startModelServer } from "../helpers/embedding";
import { mockRerankingModels } from "../helpers/embeddingProviders";

const COHERE = { id: "https://api.cohere.com", name: "Cohere" };
const VOYAGE = { id: "https://api.voyageai.com", name: "Voyage AI" };
const COHERE_KEY = "cohere-test-key";
const DECIDED_AT = "2026-09-01T09:00:00.000Z";

/** A Markdown Document of `count` long sections, the word "lighthouse" only in `marked`. */
function sections(count: number, marked: number, topic: string): string {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const special = number === marked ? ` The ${topic} lighthouse stands here.` : "";
    const filler = Array.from(
      { length: 18 },
      (_, line) => `Section ${number} sentence ${line} talks about ordinary coastal weather.`,
    ).join(" ");
    return `## Section ${number}\n\n${filler}${special}`;
  }).join("\n\n");
}

/** A reranking model that prefers the Weather Document's Passages, whatever search found. */
const prefersWeather = (text: string) => (text.startsWith("Weather\n") ? 0.9 : 0.1);

/** A built-in reranking model that, like `prefersWeather`, puts the Weather Document first. */
function weatherCrossEncoder() {
  const calls: { query: string; texts: string[] }[] = [];
  let loaded = false;
  const crossEncoder: CrossEncoder = {
    async load() {
      loaded = true;
      return { device: "cpu" };
    },
    async score(query, texts) {
      if (!loaded) throw new Error("Not loaded.");
      calls.push({ query, texts: [...texts] });
      return texts.map((text) => (text.startsWith("Weather\n") ? 4 : -4));
    },
    close() {
      loaded = false;
    },
  };
  return { crossEncoder, calls, isLoaded: () => loaded };
}

/**
 * Two Documents and mock reranking models. Embeddings are on, so vector search
 * hands the reranker the Weather Document, which has no "lighthouse". `ask`
 * searches for "lighthouse" as a check does, and returns the Passages found.
 */
async function setUp(overrides: Partial<CoreAdapters> = {}) {
  const rerankers = mockRerankingModels(prefersWeather);
  const keychain = createMemoryKeychain();
  const setup = await setUpWithDocuments(
    unaskedModel(),
    [
      { name: "Coast.md", contents: sections(24, 12, "red") },
      { name: "Weather.md", contents: sections(6, 0, "") },
    ],
    { createRerankingModel: rerankers.createRerankingModel, keychain, ...overrides },
    { embeddings: true },
  );
  const ask = async () => {
    const found = await setup.core.searchEvidence("lighthouse");
    return found.passages.map((passage) => ({ document: passage.documentName }));
  };
  return { ...setup, rerankers, keychain, ask };
}

/** Sets Cohere up, accepting its flow. */
async function useCohere(core: Awaited<ReturnType<typeof setUp>>["core"]) {
  const accept = core.on(
    "consent.requested",
    (request) => void core.respondToConsent(request.requestId, true),
  );
  const saved = await core.saveRerankSettings({ kind: "cohere", apiKey: COHERE_KEY });
  accept();
  return saved;
}

describe("Rerank", { timeout: 30_000 }, () => {
  test("is on by default, with the built-in model: no key, no consent, and nothing is sent", async () => {
    const weather = weatherCrossEncoder();
    const { core, rerankers, ask } = await setUp({ crossEncoder: weather.crossEncoder });
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    expect(await core.getRerankSettings()).toEqual({
      enabled: true,
      byDefault: true,
      kind: "built-in",
      modelId: BUILT_IN_RERANKING_MODEL.name,
      hasApiKey: false,
      service: null,
      paused: false,
      model: expect.objectContaining({ name: BUILT_IN_RERANKING_MODEL.name, state: "ready" }),
      runsOn: null,
    });
    const shown = await ask();

    // The built-in model prefers Weather, so its Passages come first.
    expect(shown[0]?.document).toBe("Weather");
    expect(await core.getRerankSettings()).toMatchObject({ runsOn: "cpu" });
    expect(weather.calls).toHaveLength(1);
    expect(requests).toEqual([]);
    expect(rerankers.calls).toEqual([]);
    expect((await core.listDataFlows()).some((flow) => flow.flow.id === "rerank")).toBe(false);
    const flow = (await core.listRegisteredDataFlows()).find((each) => each.id === "rerank");
    expect(flow?.services).toEqual([]);
  });

  test("turned off, search keeps its own order, and stays off after a restart", async () => {
    const weather = weatherCrossEncoder();
    const { core, dataDir, ask } = await setUp({ crossEncoder: weather.crossEncoder });

    expect(await core.removeRerankSettings()).toMatchObject({
      enabled: false,
      byDefault: false,
      kind: null,
    });
    expect((await ask())[0]?.document).toBe("Coast");
    expect(weather.calls).toEqual([]);

    core.close();
    const reopened = startCore(dataDir, { crossEncoder: weather.crossEncoder });
    expect(await reopened.getRerankSettings()).toMatchObject({ enabled: false, kind: null });
  });

  test("a service the User chose stays chosen after a restart", async () => {
    const { core, dataDir, keychain } = await setUp();
    await useCohere(core);

    core.close();
    const reopened = startCore(dataDir, { keychain });
    expect(await reopened.getRerankSettings()).toMatchObject({
      enabled: true,
      byDefault: false,
      kind: "cohere",
    });
  });

  test("with a Cohere key, document search reranks its candidates: the order changes", async () => {
    const { core, rerankers, ask } = await setUp();
    const changed = nextEvent(core, "rerank.changed");

    const saved = await useCohere(core);

    const expected = {
      enabled: true,
      byDefault: false,
      kind: "cohere",
      modelId: "rerank-v3.5",
      hasApiKey: true,
      service: COHERE,
      paused: false,
      model: expect.objectContaining({ name: BUILT_IN_RERANKING_MODEL.name }),
      runsOn: null,
    };
    expect(saved).toEqual(expected);
    expect(await changed).toEqual(expected);
    const shown = await ask();

    // The reranking model prefers Weather, so its Passages now come first.
    expect(shown[0]?.document).toBe("Weather");
    expect(rerankers.calls).toHaveLength(1);
    const call = rerankers.calls[0];
    expect(call?.spec).toEqual({ kind: "cohere", apiKey: COHERE_KEY, modelId: "rerank-v3.5" });
    expect(call?.query).toBe("lighthouse");
    // The candidates, each with its Document's name.
    expect(call?.documents.length).toBeGreaterThan(1);
    expect(call?.documents.some((text) => text.startsWith("Coast\n"))).toBe(true);
    expect(call?.documents.some((text) => text.startsWith("Weather\n"))).toBe(true);
  });

  test("Voyage AI works the same way, with its own default model, and the model can be named", async () => {
    const { core, rerankers, ask } = await setUp();
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));

    expect(await core.saveRerankSettings({ kind: "voyage", apiKey: "voyage-key" })).toMatchObject({
      kind: "voyage",
      modelId: "rerank-2.5",
      service: VOYAGE,
    });
    await ask();
    expect(rerankers.calls[0]?.spec).toEqual({
      kind: "voyage",
      apiKey: "voyage-key",
      modelId: "rerank-2.5",
    });

    expect(
      await core.saveRerankSettings({ kind: "voyage", modelId: "rerank-2.5-lite" }),
    ).toMatchObject({
      modelId: "rerank-2.5-lite",
      hasApiKey: true,
    });
    // Another provider needs its own key.
    await expect(core.saveRerankSettings({ kind: "cohere" })).rejects.toThrow(InvalidInputError);
  });

  test("a failing reranking request keeps search's order", async () => {
    const { core, rerankers, ask } = await setUp();
    await useCohere(core);
    rerankers.fail({ status: 500, message: "Internal server error." });

    const shown = await ask();

    expect(rerankers.calls.length).toBeGreaterThan(0);
    expect(shown[0]?.document).toBe("Coast");
  });

  test("removing the key goes back to search's own order", async () => {
    const { core, rerankers, keychain, ask } = await setUp();
    await useCohere(core);

    expect(await core.removeRerankSettings()).toMatchObject({ enabled: false, hasApiKey: false });
    expect(keychain.secrets.has("rerank:api-key")).toBe(false);
    const shown = await ask();

    expect(shown[0]?.document).toBe("Coast");
    expect(rerankers.calls).toEqual([]);
  });

  test("local mode pauses it: nothing is sent, and it can't be set up meanwhile", async () => {
    const { core, rerankers, ask } = await setUp();
    await useCohere(core);
    const paused = nextEvent(core, "rerank.changed");

    await core.setLocalOnly(true);

    expect(await paused).toMatchObject({ enabled: true, paused: true });
    const shown = await ask();
    expect(shown[0]?.document).toBe("Coast");
    expect(rerankers.calls).toEqual([]);
    await expect(core.saveRerankSettings({ kind: "voyage", apiKey: "voyage-key" })).rejects.toThrow(
      /Keep everything on this computer/,
    );
    await expect(core.testRerankConnection()).rejects.toThrow(/Keep everything on this computer/);

    await core.setLocalOnly(false);
    expect((await ask())[0]?.document).toBe("Weather");
  });

  test("its key goes to the keychain, never into SQLite", async () => {
    const { core, keychain, dataDir } = await setUp();
    await useCohere(core);

    expect(keychain.secrets.get("rerank:api-key")).toBe(COHERE_KEY);
    const databaseFiles = (await readdir(dataDir)).filter((name) => name.startsWith(DATABASE_FILE));
    expect(databaseFiles).toContain(DATABASE_FILE);
    for (const name of databaseFiles) {
      expect((await readFile(join(dataDir, name))).includes(COHERE_KEY)).toBe(false);
    }
  });
});

describe("Consent for rerank", { timeout: 30_000 }, () => {
  test("choosing a service, where its form says what goes, allows it: nothing asks", async () => {
    const { core } = await setUp();
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    await core.saveRerankSettings({ kind: "cohere", apiKey: COHERE_KEY });

    expect(requests).toEqual([]);
    expect(await core.listDataFlows()).toContainEqual({
      flow: { id: "rerank", service: COHERE, sends: ["queries", "passages"] },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });
  });

  test("choosing the service again is a new choice: it replaces a decline made before, and nothing asks", async () => {
    const { core, rerankers, ask, dataDir } = await setUp();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `INSERT INTO data_flow_consents
           (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
         VALUES (?, 'rerank', ?, ?, 'declined', '[]', ?, ?)`,
        [randomUUID(), COHERE.id, COHERE.name, DECIDED_AT, DECIDED_AT],
      );
    } finally {
      db.close();
    }
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    await core.saveRerankSettings({ kind: "cohere", apiKey: COHERE_KEY });
    await ask();

    expect(requests).toEqual([]);
    expect(rerankers.calls).toHaveLength(1);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "rerank", service: COHERE }),
        consent: "accepted",
        chosen: true,
      }),
    );
  });

  test("revoked later, a search asks again; declining keeps search's order and sends nothing", async () => {
    const { core, rerankers, ask } = await setUp();
    await useCohere(core);
    await core.revokeConsent("rerank", COHERE.id);
    const requests: string[] = [];
    core.on("consent.requested", (request) => {
      requests.push(request.flow.id);
      void core.respondToConsent(request.requestId, false);
    });

    const shown = await ask();

    expect(requests).toEqual(["rerank"]);
    expect(shown[0]?.document).toBe("Coast");
    expect(rerankers.calls).toEqual([]);
  });
});

describe("Testing the rerank connection", { timeout: 30_000 }, () => {
  test("sends nothing of the User's, so it asks nothing, and saves nothing", async () => {
    const { core, rerankers } = await setUp();
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));

    expect(await core.testRerankConnection({ kind: "cohere", apiKey: COHERE_KEY })).toEqual({
      ok: true,
    });
    expect(requests).toEqual([]);
    expect(rerankers.calls).toHaveLength(1);
    expect(rerankers.calls[0]?.query).toContain("capital of France");
    expect(await core.getRerankSettings()).toMatchObject({ kind: "built-in", byDefault: true });
  });

  test("errors are classified: a bad key, a rate limit, no connection", async () => {
    const { core, rerankers } = await setUp();
    await useCohere(core);

    rerankers.fail({ status: 401, message: "invalid api token" });
    expect(await core.testRerankConnection()).toEqual({
      ok: false,
      error: { kind: "auth", message: "invalid api token", status: 401 },
    });
    rerankers.fail({ status: 429, message: "Too many requests." });
    expect(await core.testRerankConnection()).toMatchObject({
      ok: false,
      error: { kind: "rate-limit" },
    });
    rerankers.fail({ message: "Cannot connect to API." });
    expect(await core.testRerankConnection()).toMatchObject({
      ok: false,
      error: { kind: "network" },
    });
    // With no key given or saved for the provider, it refuses.
    await expect(core.testRerankConnection({ kind: "voyage" })).rejects.toThrow(InvalidInputError);
  });
});

/** Resolves with rerank's settings once they pass `until`: now, or at a "rerank.changed". */
function rerankWhen(
  core: Awaited<ReturnType<typeof setUp>>["core"],
  until: (settings: RerankSettings) => boolean,
): Promise<RerankSettings> {
  return new Promise((resolve) => {
    const stop = core.on("rerank.changed", (settings) => {
      if (!until(settings)) return;
      stop();
      resolve(settings);
    });
    void core.getRerankSettings().then((settings) => {
      if (!until(settings)) return;
      stop();
      resolve(settings);
    });
  });
}

/** The built-in model's files, as a local server serves them (see `startModelServer`). */
const MODEL_FILES = {
  [BUILT_IN_RERANKING_MODEL.files.model]: 4000,
  [BUILT_IN_RERANKING_MODEL.files.tokenizer]: 300,
  [BUILT_IN_RERANKING_MODEL.files.tokenizerConfig]: 20,
};

describe("The built-in reranking model", { timeout: 30_000 }, () => {
  test("chosen again after turning it off, it reranks the candidates on this computer", async () => {
    const weather = weatherCrossEncoder();
    const { core, rerankers, ask } = await setUp({ crossEncoder: weather.crossEncoder });
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));
    await core.removeRerankSettings();

    const saved = await core.saveRerankSettings({ kind: "built-in" });

    expect(saved).toEqual({
      enabled: true,
      byDefault: false,
      kind: "built-in",
      modelId: BUILT_IN_RERANKING_MODEL.name,
      hasApiKey: false,
      service: null,
      paused: false,
      model: expect.objectContaining({ name: BUILT_IN_RERANKING_MODEL.name, state: "ready" }),
      runsOn: null,
    });
    const shown = await ask();

    expect(shown[0]?.document).toBe("Weather");
    expect(weather.calls).toHaveLength(1);
    expect(weather.calls[0]?.query).toBe("lighthouse");
    // Keyword search's top 10 and vector search's, each once, with its Document's name.
    const texts = weather.calls[0]?.texts ?? [];
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.length).toBeLessThanOrEqual(20);
    expect(texts.some((text) => text.startsWith("Coast\n"))).toBe(true);
    expect(requests).toEqual([]);
    expect(rerankers.calls).toEqual([]);
    const flow = (await core.listRegisteredDataFlows()).find((each) => each.id === "rerank");
    expect(flow?.services).toEqual([]);
  });

  test("local mode doesn't pause it, and choosing it forgets a service's key", async () => {
    const weather = weatherCrossEncoder();
    const { core, keychain, ask } = await setUp({ crossEncoder: weather.crossEncoder });
    await useCohere(core);
    await core.setLocalOnly(true);

    expect(await core.saveRerankSettings({ kind: "built-in" })).toMatchObject({
      kind: "built-in",
      paused: false,
    });

    expect(keychain.secrets.has("rerank:api-key")).toBe(false);
    expect((await ask())[0]?.document).toBe("Weather");
    // It takes no key or model name.
    await expect(
      core.saveRerankSettings({ kind: "built-in", apiKey: "a-key" } as never),
    ).rejects.toThrow(InvalidInputError);
    await expect(core.testRerankConnection({ kind: "built-in" } as never)).rejects.toThrow(
      InvalidInputError,
    );
  });

  test("its files aren't downloaded while there is nothing to search, nor when reranking is off", async () => {
    const server = await startModelServer(MODEL_FILES);
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    const core = startCore(dataDir, { rerankingModelSource: server.source });
    const traffic = async () => (await core.listNetworkTraffic()).map((each) => each.id);

    expect((await core.getRerankSettings()).model.state).toBe("not-downloaded");
    expect(await traffic()).toContain("reranking-model");
    await core.removeRerankSettings();
    expect(await traffic()).not.toContain("reranking-model");
    await addAndProcess(core, [
      await writeSourceFile(sources, "Tides.md", "Tides rise twice a day."),
    ]);

    expect((await core.getRerankSettings()).model.state).toBe("not-downloaded");
    expect(server.requests).toEqual([]);
  });

  test("an existing library where nothing was chosen gets the built-in model when the app next starts", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave(BUILT_IN_RERANKING_MODEL.files.model, { held: true });
    const dataDir = await createTempDataFolder();
    const sources = await createTempDataFolder();
    // An earlier start, with Documents and nothing to download (as before reranking had a default).
    const earlier = startCore(dataDir);
    await addAndProcess(earlier, [await writeSourceFile(sources, "Tides.md", "Tides rise.")]);
    earlier.close();

    const core = startCore(dataDir, { rerankingModelSource: server.source });

    expect(await core.getRerankSettings()).toMatchObject({
      kind: "built-in",
      byDefault: true,
      model: { state: "downloading" },
    });
  });

  test("by default its files download once Documents are ready to search; until then search keeps its own order", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave(BUILT_IN_RERANKING_MODEL.files.model, { held: true });
    const weather = weatherCrossEncoder();
    const { core, dataDir, ask } = await setUp({
      crossEncoder: weather.crossEncoder,
      rerankingModelSource: server.source,
    });

    // The Documents were processed: the download started by itself.
    expect((await core.getRerankSettings()).model.state).toBe("downloading");
    await expect.poll(() => server.requests.length).toBeGreaterThan(0);
    expect((await ask())[0]?.document).toBe("Coast");
    expect(weather.calls).toEqual([]);

    const ready = rerankWhen(core, (settings) => settings.model.state === "ready");
    server.release();
    expect((await ready).model).toMatchObject({ state: "ready", error: null });
    expect((await ask())[0]?.document).toBe("Weather");
    const stored = await readFile(
      join(
        dataDir,
        "models",
        BUILT_IN_RERANKING_MODEL.folder,
        BUILT_IN_RERANKING_MODEL.files.model,
      ),
    );
    expect(stored.byteLength).toBe(4000);
  });

  test("a failed download says why, search keeps its order, and downloading it again retries", async () => {
    const server = await startModelServer(MODEL_FILES);
    server.behave(BUILT_IN_RERANKING_MODEL.files.tokenizer, { corrupt: true });
    const weather = weatherCrossEncoder();
    const { core, ask } = await setUp({
      crossEncoder: weather.crossEncoder,
      rerankingModelSource: server.source,
    });

    const failed = await rerankWhen(core, (settings) => settings.model.state === "failed");
    expect(failed.model.error).toMatchObject({ kind: "integrity" });
    expect(failed).toMatchObject({ kind: "built-in", byDefault: true });
    expect((await ask())[0]?.document).toBe("Coast");

    server.behave(BUILT_IN_RERANKING_MODEL.files.tokenizer, {});
    expect((await core.downloadRerankingModel()).model.state).toBe("downloading");
    await rerankWhen(core, (settings) => settings.model.state === "ready");
    expect((await ask())[0]?.document).toBe("Weather");
  });

  test("a model that fails as it reranks leaves search's order", async () => {
    const failing: CrossEncoder = {
      load: async () => ({ device: "cpu" }),
      score: async () => {
        throw new Error("The reranking process stopped (exit code 1).");
      },
      close: () => {},
    };
    const { ask } = await setUp({ crossEncoder: failing });

    expect((await ask())[0]?.document).toBe("Coast");
  });

  test("stopping reranking stops the model: search is as before", async () => {
    const weather = weatherCrossEncoder();
    const { core, ask } = await setUp({ crossEncoder: weather.crossEncoder });
    await ask();
    expect(weather.isLoaded()).toBe(true);

    expect(await core.removeRerankSettings()).toMatchObject({ enabled: false, kind: null });

    expect(weather.isLoaded()).toBe(false);
    expect((await ask())[0]?.document).toBe("Coast");
    expect(weather.calls).toHaveLength(1);
  });
});
