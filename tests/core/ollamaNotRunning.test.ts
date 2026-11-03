import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  type CoreAdapters,
  type CoreEvents,
  createOllamaModels,
  type OllamaApp,
  RECOMMENDED_OLLAMA_MODEL,
} from "../../src/core";
import {
  classifyProviderError,
  OllamaNotRunningError,
} from "../../src/core/providers/providerErrors";
import { translate } from "../../src/shared/i18n";
import { askNew } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { startOllamaStub, unusedLocalUrl } from "../helpers/ollama";

function switchableOllama() {
  const state = { up: false, asked: [] as string[] };
  const ollamaModels: CoreAdapters["ollamaModels"] = {
    describe: async () => null,
    loaded: async () => null,
    running: async (baseUrl) => {
      state.asked.push(baseUrl);
      return state.up;
    },
  };
  return { state, ollamaModels };
}

async function setUp(baseUrl: string, adapters: Partial<CoreAdapters>) {
  const model = scriptedModel(() => ({ text: "At new and full moon." }));
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
    ...adapters,
  });
  await core.saveChatProvider({ kind: "ollama", baseUrl, modelId: "local-model" });
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  const failures: CoreEvents["answer.failed"][] = [];
  core.on("answer.failed", (payload) => failures.push(payload));
  return { core, mind, client, model, models, failures };
}

describe("A Question to a model in Ollama while Ollama isn't running", () => {
  test("fails at once as ollama-not-running, with nothing built or sent, and Try again asks it once Ollama runs", async () => {
    const { state, ollamaModels } = switchableOllama();
    const { core, mind, client, model, models, failures } = await setUp("http://127.0.0.1:11434", {
      ollamaModels,
    });

    const answerId = await askNew(core, client, mind.id, "When are spring tides?");
    await vi.waitFor(() => expect(failures).toHaveLength(1));

    expect(failures[0]).toMatchObject({
      answerId,
      error: {
        kind: "ollama-not-running",
        message: "Ollama isn’t running on this computer.",
        wording: { key: "error.provider.ollamaNotRunning" },
      },
    });
    expect(state.asked).toEqual(["http://127.0.0.1:11434"]);
    expect(models.specs).toEqual([]);
    expect(model.doStreamCalls).toEqual([]);

    state.up = true;
    expect(await core.regenerateAnswer({ mindId: mind.id, answerId })).toEqual({
      asked: true,
      answerId,
    });
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(1));
    expect(failures).toHaveLength(1);
  });

  test("a server that isn't on this computer is not asked first", async () => {
    const { state, ollamaModels } = switchableOllama();
    const { core, mind, client, model, failures } = await setUp("http://ollama.example.com:11434", {
      ollamaModels,
    });
    await core.allowDataFlow("chat", "http://ollama.example.com:11434");

    await askNew(core, client, mind.id, "When are spring tides?");
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(1));

    expect(state.asked).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("is told in both languages, with the wording the window says it in", () => {
    const error = new OllamaNotRunningError();

    expect(classifyProviderError(error)).toEqual({
      kind: "ollama-not-running",
      message: "Ollama isn’t running on this computer.",
      wording: { key: "error.provider.ollamaNotRunning" },
    });
    expect(translate("zh-CN", "error.provider.ollamaNotRunning")).toBe(
      "Ollama 没有在这台电脑上运行。",
    );
  });
});

describe("Looking for Ollama", () => {
  test("is reachable when a server answers, with its models", async () => {
    const ollama = await startOllamaStub({ models: ["llama3.2:latest"] });
    const core = startCore(await createTempDataFolder());

    expect(await core.detectOllama({ baseUrl: ollama.baseUrl })).toMatchObject({
      running: true,
      models: ["llama3.2:latest"],
    });
    expect(await createOllamaModels().running(ollama.baseUrl)).toBe(true);
  });

  test("anything that answers counts as reachable, a refusal included: the request itself then says what is wrong", async () => {
    const server = createServer((_request, response) => response.writeHead(401).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;

    expect(await createOllamaModels().running(`http://127.0.0.1:${port}`)).toBe(true);
  });

  test("isn't running when nothing answers, and its app is there to open", async () => {
    const baseUrl = await unusedLocalUrl();
    const app: OllamaApp = { installed: async () => true, open: async () => undefined };
    const core = startCore(await createTempDataFolder(), { ollamaApp: app });

    expect(await core.detectOllama({ baseUrl })).toEqual({
      running: false,
      baseUrl,
      installed: true,
      recommendedModel: RECOMMENDED_OLLAMA_MODEL,
    });
    expect(await createOllamaModels().running(baseUrl)).toBe(false);
  });

  test("isn't running and isn't installed when there is no app to open: Get Ollama", async () => {
    const baseUrl = await unusedLocalUrl();
    const app: OllamaApp = { installed: async () => false, open: async () => undefined };
    const core = startCore(await createTempDataFolder(), { ollamaApp: app });

    expect(await core.detectOllama({ baseUrl })).toMatchObject({
      running: false,
      installed: false,
    });
  });

  test("a computer that can't tell is treated as not installed", async () => {
    const baseUrl = await unusedLocalUrl();
    const core = startCore(await createTempDataFolder());

    expect(await core.detectOllama({ baseUrl })).toMatchObject({
      running: false,
      installed: false,
    });
  });

  test("says nothing when the probe runs out of time, rather than that it isn't running", async () => {
    // A server that takes the request and holds it past the probe's two seconds, as a loaded
    // computer's app may: silence is not an answer, and only a refused address means "not running".
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const app: OllamaApp = { installed: async () => true, open: async () => undefined };
    const core = startCore(await createTempDataFolder(), { ollamaApp: app });

    expect(await core.detectOllama({ baseUrl })).toMatchObject({
      running: false,
      unknown: true,
      installed: true,
    });
    // A model call says it isn't running, as it must: nothing can answer.
    expect(await createOllamaModels().running(baseUrl)).toBe(false);
  }, 15_000);
});

describe("Open Ollama", () => {
  async function startsWhenOpened(baseUrl: string) {
    const { port } = new URL(baseUrl);
    let server: Server | undefined;
    const opened: string[] = [];
    const app: OllamaApp = {
      installed: async () => true,
      async open() {
        opened.push("opened");
        server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ models: [] }));
        });
        await new Promise<void>((resolve) => server?.listen(Number(port), "127.0.0.1", resolve));
        onTestFinished(() => new Promise<void>((resolve) => server?.close(() => resolve())));
        expect((server.address() as AddressInfo).port).toBe(Number(port));
      },
    };
    return { app, opened };
  }

  test("opens the app and gives the status once Ollama answers", async () => {
    const baseUrl = await unusedLocalUrl();
    const { app, opened } = await startsWhenOpened(baseUrl);
    const core = startCore(await createTempDataFolder(), { ollamaApp: app });

    expect(await core.openOllama({ baseUrl })).toMatchObject({ running: true, baseUrl });
    expect(opened).toEqual(["opened"]);
  });

  test("gives up waiting when Ollama doesn't come up, and says it still isn't running", async () => {
    const baseUrl = await unusedLocalUrl();
    const app: OllamaApp = { installed: async () => true, open: async () => undefined };
    const core = startCore(await createTempDataFolder(), {
      ollamaApp: app,
      ollamaStartTimeoutMs: 50,
    });

    expect(await core.openOllama({ baseUrl })).toMatchObject({
      running: false,
      installed: true,
    });
  });

  test("is refused where the app can't be opened from here", async () => {
    const core = startCore(await createTempDataFolder());

    await expect(core.openOllama({ baseUrl: await unusedLocalUrl() })).rejects.toThrow(
      /can’t open Ollama/,
    );
  });
});
