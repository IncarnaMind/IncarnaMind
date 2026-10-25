/**
 * A local tagging model installed in Ollama after Documents wait for a model:
 * Tagging works out which model it uses again when a Document is added, on
 * Re-tag and when Settings › Models opens, so it is picked up with no restart
 * and no settings change. Through the core's public interface, with a stand-in
 * for Ollama's list and decision models: no network, no waiting.
 */
import { describe, expect, test, vi } from "vitest";
import type { ChatModelSpec, Core, Document } from "../../src/core";
import { createTempDataFolder, startCore, turnOnAutomaticTagging } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { tagNamesOf, waitForTagging } from "../helpers/tags";

const TEV1 = "tev1:4b";

/** A core whose Ollama has `installed` models, which a test changes; and the decision model's stand-in. */
async function start() {
  const ollama = await startFakeJev({ apiKey: "ollama" });
  ollama.answer({ Paper: 0.92 });
  let installed: string[] = [];
  const asked: string[] = [];
  const chatModels: ChatModelSpec[] = [];
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    ollamaUrl: ollama.url,
    localModels: async (baseUrl) => {
      asked.push(baseUrl);
      return installed;
    },
    createChatModel: (spec) => {
      chatModels.push(spec);
      throw new Error("No chat model is scripted here.");
    },
  });
  return {
    core,
    ollama,
    asked,
    chatModels,
    install(...models: string[]) {
      installed = models;
    },
  };
}

async function add(core: Core, name: string): Promise<Document> {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), `${name}.md`, `${name}. A paper.`),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

const waiting = (document: Document) => document.tagging === "waiting-for-provider";

describe("a model installed after Documents wait", () => {
  test("new Documents are tagged, and so are those that waited, with no restart", async () => {
    const { core, ollama, install } = await start();
    const first = await add(core, "First");
    expect(first.tagging).toBe("waiting-for-provider");
    expect(ollama.requests).toEqual([]);

    install(TEV1);
    const second = await add(core, "Second");

    await waitForTagging(core, [first.id, second.id]);
    expect(ollama.requests).toHaveLength(2);
    expect(await tagNamesOf(core, first.id)).toEqual(["Paper"]);
    expect((await core.listDocuments()).filter(waiting)).toEqual([]);
  });

  test("Re-tag picks it up for a Document that waits", async () => {
    const { core, ollama, install } = await start();
    const document = await add(core, "First");
    expect(document.tagging).toBe("waiting-for-provider");

    install(TEV1);
    await core.retagDocuments([document.id]);

    await waitForTagging(core, [document.id]);
    expect(ollama.requests).toHaveLength(1);
  });

  test("opening Settings › Models picks it up: the Documents that waited start tagging", async () => {
    const { core, install } = await start();
    const document = await add(core, "First");
    expect((await core.getTaggingModels()).automatic).toBeNull();

    install(TEV1);
    expect((await core.getTaggingModels()).automatic).toMatchObject({ reason: "decision-models" });

    await waitForTagging(core, [document.id]);
  });

  test("it costs one list call to Ollama, and no model call while there is none", async () => {
    const { core, ollama, asked, install } = await start();
    const document = await add(core, "First");
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0));

    const before = asked.length;
    await core.retagDocuments([document.id]);
    expect(asked.length - before).toBe(1);
    expect(ollama.requests).toEqual([]);
    expect((await core.listDocuments()).filter(waiting)).toHaveLength(1);

    install(TEV1);
    await core.retagDocuments([document.id]);
    await waitForTagging(core, [document.id]);
  });

  test("in Local mode a cloud model is still never asked", async () => {
    const { core, ollama, chatModels, install } = await start();
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-5-5",
    });
    await turnOnAutomaticTagging(core);
    await core.setLocalOnly(true);
    const first = await add(core, "First");
    expect(first.tagging).toBe("waiting-for-provider");

    install(TEV1);
    const second = await add(core, "Second");

    await waitForTagging(core, [first.id, second.id]);
    expect(ollama.requests).toHaveLength(2);
    expect(chatModels).toEqual([]);
  });
});
