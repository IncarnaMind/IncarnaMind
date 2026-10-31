/**
 * Tagging new Documents by themselves is turned on for where it sends (#2308, ADR-0022): on for a
 * model on this computer, or for one service, isn't on for another. Only setup's Use this,
 * Settings › Models' Tagging section and Turn on… turn it on, with the line on screen; a save of
 * the switch as shown never does. And the Documents it held "off" stay off when they are read
 * again, until Organize or a re-tag. Through the core's public interface, counting the requests
 * each provider gets.
 */
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  type LibraryClassifier,
  type SaveChatProviderInput,
} from "../../src/core";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { openDatabase } from "../../src/core/storage";
import {
  createMemoryKeychain,
  createTempDataFolder,
  queryDatabase,
  startCore,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  documentAt,
  linkAndProcess,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";
import { tagNamesOf, waitForTagging } from "../helpers/tags";

const OLLAMA: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};
const OPENAI: SaveChatProviderInput = { kind: "openai", apiKey: "sk-test", modelId: "gpt-6-luna" };

const NAMED = [{ name: "Quarterly reports", description: "Reports for a quarter." }];

/**
 * A scripted model for each provider, counting its own requests: it names one Tag, and Organize
 * gets no Folder. `fail` makes one provider's answers fail.
 */
function perProvider() {
  const sent: Record<string, number> = {};
  const failing = new Set<string>();
  const models = new Map<string, MockLanguageModelV4>();
  const modelFor = (kind: string) => {
    const known = models.get(kind);
    if (known) return known;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent[kind] = (sent[kind] ?? 0) + 1;
        if (failing.has(kind)) throw new Error("The service is down.");
        const format = options.responseFormat;
        const organizes = format?.type === "json" && !!format.schema?.properties?.groupId;
        const answer = organizes
          ? { groupId: "__unsorted__", tags: [], newTags: NAMED }
          : { tags: [], newTags: NAMED };
        return {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          finishReason: { unified: "stop", raw: undefined },
          warnings: [],
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        };
      },
    });
    models.set(kind, model);
    return model;
  };
  return {
    sent: (kind: string) => sent[kind] ?? 0,
    fail: (kind: string, on: boolean) => (on ? failing.add(kind) : failing.delete(kind)),
    createChatModel: (spec: ChatModelSpec) => modelFor(spec.kind),
  };
}

const chatModel = (providerId: string, modelId: string): LibraryClassifier => ({
  kind: "chat",
  choice: { providerId, modelId },
});

/** A choice in Settings › Models' select: the switch goes back as shown. */
async function chooseInModels(core: Core, classifier: LibraryClassifier) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, classifier });
}

/** Setup's Use this, Settings › Models' Tagging section or Turn on…: the line was on screen. */
async function turnOn(core: Core, classifier?: LibraryClassifier) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({
    ...settings,
    ...(classifier && { classifier }),
    automatic: true,
    turnOn: true,
  });
}

async function add(core: Core, name: string) {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), name, `${name}: a quarterly report.`),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

const taggingAccepted = async (core: Core, service: string) =>
  (await core.listDataFlows()).some(
    (each) =>
      each.flow.id === "tagging" && each.flow.service.id === service && each.consent === "accepted",
  );

describe("Tagging new Documents is turned on for where it sends", () => {
  test("on for a model on this computer is off for a cloud model chosen in Settings › Models, until turned on there", async () => {
    const providers = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
    });
    const ollama = await core.saveChatProvider(OLLAMA);
    await chooseInModels(core, chatModel(ollama.id, "local-model"));
    expect((await core.getLibrary()).settings.automatic).toBe(true);
    const here = await add(core, "On this computer.txt");
    await waitForTagging(core, [here.id]);
    expect(providers.sent("ollama")).toBe(1);

    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await chooseInModels(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    const held = await add(core, "Held.txt");

    expect((await core.getLibrary()).settings.automatic).toBe(false);
    expect(held.tagging).toBe("off");
    expect(providers.sent("anthropic")).toBe(0);
    expect(await taggingAccepted(core, "https://api.anthropic.com")).toBe(false);

    await turnOn(core);
    const sent = await add(core, "Sent.txt");
    await waitForTagging(core, [sent.id]);

    expect(providers.sent("anthropic")).toBe(1);
    expect(await tagNamesOf(core, sent.id)).toEqual(["Quarterly reports"]);
    expect(await taggingAccepted(core, "https://api.anthropic.com")).toBe(true);
  });

  test("on for Anthropic is off for an OpenAI model until it is turned on for OpenAI", async () => {
    const providers = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    const first = await add(core, "First.txt");
    await waitForTagging(core, [first.id]);
    expect(providers.sent("anthropic")).toBe(1);

    const openai = await core.saveChatProvider(OPENAI);
    await chooseInModels(core, chatModel(openai.id, OPENAI.modelId));
    const held = await add(core, "Held.txt");

    expect((await core.getLibrary()).settings.automatic).toBe(false);
    expect(held.tagging).toBe("off");
    expect(providers.sent("openai")).toBe(0);
    expect(providers.sent("anthropic")).toBe(1);

    await turnOn(core);
    const sent = await add(core, "Sent.txt");
    await waitForTagging(core, [sent.id]);

    expect((await core.getLibrary()).settings.automatic).toBe(true);
    expect(providers.sent("openai")).toBe(1);
    expect(await taggingAccepted(core, "https://api.openai.com")).toBe(true);
  });

  test("Turn on… holds the Documents an earlier re-tag left failed: none is sent by itself", async () => {
    const providers = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
    });
    const ollama = await core.saveChatProvider(OLLAMA);
    await chooseInModels(core, chatModel(ollama.id, "local-model"));
    const ids: string[] = [];
    for (const name of ["One.txt", "Two.txt", "Three.txt"]) ids.push((await add(core, name)).id);
    await waitForTagging(core, ids);
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await chooseInModels(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    // A re-tag the User asked for meets a model that fails: the three are left "failed".
    await core.allowDataFlow("tagging", "https://api.anthropic.com");
    providers.fail("anthropic", true);
    await core.retagDocuments(ids);
    await waitForTagging(core, ids, (each) => each.tagging === "failed");
    providers.fail("anthropic", false);
    const before = providers.sent("anthropic");

    await turnOn(core);
    await waitForTagging(core, ids, (each) => each.tagging === "off");

    expect(providers.sent("anthropic")).toBe(before);
  });
});

describe("A Document held off stays off when it is read again", () => {
  test("after an update's re-read and a Linked folder's file change, none is sent; Organize then tags them", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const providers = perProvider();
    const options = { keychain, createChatModel: providers.createChatModel };
    let core = startCore(dataDir, options);
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    const folder = await createSourceFolder();
    for (const at of [1, 2, 3, 4, 5]) {
      await writeSourceFile(folder, `Report ${at}.txt`, `Quarterly report ${at}.`);
    }
    const linked = await linkAndProcess(core, folder);
    const ids = linked.map((each) => each.id);
    await waitForTagging(core, ids, (each) => each.tagging === "off");

    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    expect(providers.sent("anthropic")).toBe(0);

    // A file in the Linked folder changes.
    const revisedPath = await writeSourceFile(
      folder,
      "Report 1.txt",
      "Quarterly report 1, revised.",
    );
    await waitForDocuments(core, (documents) => {
      const revised = documentAt(documents, revisedPath);
      expect(revised.status).toBe("ready");
      expect(revised.contentHash).not.toBe(documentAt(linked, revisedPath).contentHash);
    });
    // An update with a newer pipeline reads every Document again at the next start.
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = 1");
    } finally {
      db.close();
    }
    core = startCore(dataDir, options);
    await vi.waitFor(
      () => {
        const versions = queryDatabase<{ processing_version: number }>(
          dataDir,
          "SELECT DISTINCT processing_version FROM documents WHERE status = 'ready'",
        ).map((row) => row.processing_version);
        expect(versions).toEqual([PROCESSING_VERSION]);
      },
      { timeout: 15_000 },
    );
    await waitForDocuments(core, (documents) => {
      expect(documents.every((each) => each.status === "ready")).toBe(true);
    });

    const after = await core.listDocuments();
    expect(after.map((each) => each.tagging)).toEqual(["off", "off", "off", "off", "off"]);
    expect(providers.sent("anthropic")).toBe(0);

    await core.createLibraryGroup({ name: "Finance", description: "Reports." });
    await core.classifyDocuments(ids);
    await waitForTagging(core, ids);
    expect(providers.sent("anthropic")).toBe(5);
    expect(await tagNamesOf(core, ids[0] ?? "")).toEqual(["Quarterly reports"]);
    core.close();
  });
});
