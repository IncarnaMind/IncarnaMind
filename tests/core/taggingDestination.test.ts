/**
 * Tagging new Documents by themselves is turned on for where it sends (#2308, ADR-0022): on for a
 * model on this computer, or for one service, isn't on for another. Only setup's Use this,
 * Settings › Models' Tagging section and Turn on… turn it on, with the line on screen; a save of
 * the switch as shown never does. And the Documents it held "off" stay off when they are read
 * again, until Organize or a re-tag. Through the core's public interface, counting the requests
 * each provider gets.
 */
import { readFileSync } from "node:fs";
import { rename, utimes } from "node:fs/promises";
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
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import type { WatchFolder, WatchListener } from "../../src/core/documents/watcher";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { openDatabase } from "../../src/core/storage";
import {
  createMemoryKeychain,
  createTempDataFolder,
  NO_MODEL_FILES,
  queryDatabase,
  startCore,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  documentAt,
  linkAndProcess,
  sha256,
  waitForDocuments,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";
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

/** Organize has made no assignment for these Documents, so it sends none of them by itself. */
const unassigned = async (core: Core, ids: readonly string[]) =>
  (await core.getLibrary()).assignments.filter((each) => ids.includes(each.documentId));

describe("A Document held off stays off, for every sender", () => {
  test.each([
    { where: "with a Folder there, so Organize files new ones", folderFirst: true },
    { where: "with no Folder, so automatic tagging tags new ones", folderFirst: false },
  ])(
    "$where: after a Linked folder's file change and an update's re-read none is sent; Organize then sends each once",
    async ({ folderFirst }) => {
      const dataDir = await createTempDataFolder();
      const keychain = createMemoryKeychain();
      const providers = perProvider();
      const options = { keychain, createChatModel: providers.createChatModel };
      let core = startCore(dataDir, options);
      const anthropic = await core.saveChatProvider(ANTHROPIC);
      if (folderFirst) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
      const folder = await createSourceFolder();
      for (const at of [1, 2, 3, 4, 5]) {
        await writeSourceFile(folder, `Report ${at}.txt`, `Quarterly report ${at}.`);
      }
      const linked = await linkAndProcess(core, folder);
      const ids = linked.map((each) => each.id);
      await waitForTagging(core, ids, (each) => each.tagging === "off");

      await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
      expect(providers.sent("anthropic")).toBe(0);

      // A file in the Linked folder changes, read again through the public rescan.
      const revisedText = "Quarterly report 1, revised.";
      const revisedPath = await writeSourceFile(folder, "Report 1.txt", revisedText);
      await core.reconcileDocuments();
      const revisedId = documentAt(linked, revisedPath).id;
      await waitForProcessing(core, [revisedId]);
      const [revised] = await waitForTagging(core, [revisedId], (each) => each.tagging === "off");
      expect(revised?.contentHash).toBe(sha256(revisedText));
      expect(revised?.tagging).toBe("off");
      expect(await unassigned(core, ids)).toEqual([]);

      // An update with a newer pipeline reads every Document again at the next start.
      core.close();
      const db = openDatabase(join(dataDir, DATABASE_FILE));
      try {
        db.run("UPDATE documents SET processing_version = 1");
      } finally {
        db.close();
      }
      core = startCore(dataDir, options);
      await vi.waitFor(() =>
        expect(
          queryDatabase<{ processing_version: number }>(
            dataDir,
            "SELECT DISTINCT processing_version FROM documents WHERE deleted_at IS NULL",
          ).map((row) => row.processing_version),
        ).toEqual([PROCESSING_VERSION]),
      );
      await waitForProcessing(core, ids);
      const reread = await waitForTagging(core, ids, (each) => each.tagging === "off");

      expect(reread.map((each) => each.tagging)).toEqual(["off", "off", "off", "off", "off"]);
      expect(await unassigned(core, ids)).toEqual([]);
      expect(providers.sent("anthropic")).toBe(0);

      if (!folderFirst) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
      await core.classifyDocuments(ids);
      await waitForTagging(core, ids);
      expect(providers.sent("anthropic")).toBe(5);
      expect(await tagNamesOf(core, ids[0] ?? "")).toEqual(["Quarterly reports"]);
      core.close();
    },
  );

  test("what Organize waits to file by itself is held when where it sends changes: none goes to the new service", async () => {
    const providers = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await core.createLibraryGroup({ name: "Finance", description: "Reports." });
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    await core.setLocalOnly(true);
    const waiting = await add(core, "Waiting.txt");
    await vi.waitFor(async () =>
      expect((await unassigned(core, [waiting.id]))[0]?.status).toBe("waiting"),
    );

    const openai = await core.saveChatProvider(OPENAI);
    await chooseInModels(core, chatModel(openai.id, OPENAI.modelId));
    await core.setLocalOnly(false);
    const [held] = await waitForTagging(core, [waiting.id], (each) => each.tagging === "off");

    expect(held?.tagging).toBe("off");
    expect(await unassigned(core, [waiting.id])).toEqual([]);
    expect(providers.sent("openai")).toBe(0);
    expect(providers.sent("anthropic")).toBe(0);

    await core.classifyDocuments([waiting.id]);
    await waitForTagging(core, [waiting.id]);
    expect(providers.sent("openai")).toBe(1);
  });
});

describe("Every Document already here is held, whatever its state", () => {
  test.each([
    { where: "with a Folder there", folderFirst: true },
    { where: "with no Folder", folderFirst: false },
  ])(
    "$where: an empty file filled later and a broken file mended are sent by nobody, while one added after is",
    async ({ folderFirst }) => {
      const providers = perProvider();
      const core = startCore(await createTempDataFolder(), {
        createChatModel: providers.createChatModel,
      });
      const anthropic = await core.saveChatProvider(ANTHROPIC);
      if (folderFirst) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
      const folder = await createSourceFolder();
      await writeSourceFile(folder, "Report 1.txt", "Quarterly report 1.");
      const blankPath = await writeSourceFile(folder, "Blank.txt", "");
      const brokenPath = await writeSourceFile(folder, "Broken.pdf", "not a PDF at all");
      const linked = await linkAndProcess(core, folder);
      const blank = documentAt(linked, blankPath);
      const broken = documentAt(linked, brokenPath);
      expect([blank.status, broken.status]).not.toContain("ready");

      await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
      await writeSourceFile(folder, "Blank.txt", "Quarterly report 2, written in later.");
      await writeSourceFile(folder, "Broken.pdf", buildPdf([{ lines: ["Quarterly report 3."] }]));
      await core.reconcileDocuments();
      const read = await waitForDocuments(core, (documents) => {
        expect(documentAt(documents, blankPath).status).toBe("ready");
        expect(documentAt(documents, brokenPath).status).toBe("ready");
      });

      expect(read.map((each) => each.tagging)).toEqual(["off", "off", "off"]);
      expect(await unassigned(core, [blank.id, broken.id])).toEqual([]);
      expect(providers.sent("anthropic")).toBe(0);

      const added = await add(core, "Added after.txt");
      await waitForTagging(core, [added.id]);
      expect(providers.sent("anthropic")).toBe(1);

      if (!folderFirst) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
      await core.classifyDocuments(linked.map((each) => each.id));
      await waitForTagging(
        core,
        linked.map((each) => each.id),
      );
      expect(providers.sent("anthropic")).toBe(4);
    },
  );

  test("a scan read again once the text recognition model is there is sent by nobody", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const providers = perProvider();
    let core = startCore(dataDir, { keychain, createChatModel: providers.createChatModel });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    const scan = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
    const [unread] = await addAndProcess(core, [
      await writeSourceFile(await createSourceFolder(), "Scan.pdf", buildPdf([{ scan }])),
    ]);
    if (!unread) throw new Error("Nothing was added.");
    expect(unread.status).toBe("no-text");
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE documents SET processing_version = 1");
    } finally {
      db.close();
    }

    core = startCore(dataDir, {
      keychain,
      createChatModel: providers.createChatModel,
      textRecognizer: createFakeTextRecognizer({
        script: { pages: { "1": { lines: ["Quarterly report on sales."] } } },
      }),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const [read] = await waitForDocuments(core, (documents) => {
      expect(documents[0]?.status).toBe("ready");
    });

    expect(read?.tagging).toBe("off");
    expect(providers.sent("anthropic")).toBe(0);
    core.close();
  });

  test("a quit right after tagging is turned on leaves no Document unheld: the next start sends none", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const providers = perProvider();
    let core = startCore(dataDir, { keychain, createChatModel: providers.createChatModel });
    // Turned on for Anthropic once, so its consent is there; then tagging on this computer fails.
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    const ollama = await core.saveChatProvider(OLLAMA);
    await chooseInModels(core, chatModel(ollama.id, "local-model"));
    providers.fail("ollama", true);
    const failed = await add(core, "Failed.txt");
    await waitForTagging(core, [failed.id], (each) => each.tagging === "failed");

    const { settings } = await core.getLibrary();
    const saving = core.saveLibrarySettings({
      ...settings,
      classifier: chatModel(anthropic.id, ANTHROPIC.modelId),
      automatic: true,
      turnOn: true,
    });
    core.close();
    await saving.catch(() => undefined);

    core = startCore(dataDir, { keychain, createChatModel: providers.createChatModel });
    expect((await core.getLibrary()).settings.automatic).toBe(true);
    const [held] = await waitForTagging(core, [failed.id], (each) => each.tagging === "off");
    const added = await add(core, "Added after.txt");
    await waitForTagging(core, [added.id]);

    expect(held?.tagging).toBe("off");
    expect(providers.sent("anthropic")).toBe(1);
    core.close();
  });
});

/**
 * A Linked folder watcher the test drives: it reports a path when told, as the system's watcher
 * does when a file arrives or changes, so no test waits on the system's timing.
 */
function scriptedWatcher() {
  const listeners = new Map<string, WatchListener>();
  const watch: WatchFolder = (root, listener) => {
    listeners.set(root, listener);
    return { close: () => listeners.delete(root) };
  };
  return {
    watch,
    /** Resolves once the folder's watcher is on, after its scan. */
    watching: (folder: string) => vi.waitFor(() => expect(listeners.has(folder)).toBe(true)),
    report(folder: string, ...paths: string[]) {
      const listener = listeners.get(folder);
      if (!listener) throw new Error(`Nothing watches ${folder}.`);
      listener.onChange(paths);
    },
  };
}

/** How long the forty-Document test waits for a state at most, on a loaded machine. */
const FORTY_WAIT_MS = 60_000;

/** A file already on disk before tagging was turned on: written an hour ago. */
async function writtenBefore(folder: string, name: string, text: string) {
  const path = await writeSourceFile(folder, name, text);
  const hourAgo = new Date(Date.now() - 3_600_000);
  await utimes(path, hourAgo, hourAgo);
  return path;
}

describe("Only what is new since tagging was turned on goes by itself", () => {
  test("a Document restored from Recently deleted after the turn-on is sent by nobody", async () => {
    const providers = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
    });
    const restored = await add(core, "Restored.txt");
    await core.deleteDocument(restored.id);
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));

    await core.restore([{ kind: "document", id: restored.id }]);
    const [held] = await waitForTagging(core, [restored.id], (each) => each.tagging === "off");
    const added = await add(core, "Added after.txt");
    await waitForTagging(core, [added.id]);

    expect(held?.tagging).toBe("off");
    expect(providers.sent("anthropic")).toBe(1);
  });

  test("a Linked folder linked before the turn-on: the 40 files its scan adds after, and one renamed, go only with the User's Organize", async () => {
    const providers = perProvider();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    const folder = await createSourceFolder();
    for (let at = 1; at <= 40; at++) {
      await writtenBefore(folder, `Report ${at}.txt`, `Quarterly report ${at}.`);
    }
    const linked = await core.addLinkedFolder(folder);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    await core.reconcileDocuments();
    const ids = (await core.listDocuments({ linkedFolderId: linked.id })).map((each) => each.id);
    expect(ids).toHaveLength(40);
    await waitForProcessing(core, ids, FORTY_WAIT_MS);
    await waitForTagging(core, ids, (each) => each.tagging === "off", FORTY_WAIT_MS);
    expect(providers.sent("anthropic")).toBe(0);

    await rename(join(folder, "Report 1.txt"), join(folder, "Report one.txt"));
    await core.reconcileDocuments();
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, join(folder, "Report one.txt")).status).toBe("ready");
    });
    await waitForTagging(core, ids, (each) => each.tagging === "off", FORTY_WAIT_MS);
    expect(providers.sent("anthropic")).toBe(0);

    await core.createLibraryGroup({ name: "Finance", description: "Reports." });
    await core.classifyDocuments(ids);
    await waitForTagging(core, ids, undefined, FORTY_WAIT_MS);
    expect(providers.sent("anthropic")).toBe(40);
  }, 180_000);

  test("a paused Linked folder resumed after the turn-on: the file already there and one written while paused wait, one its watcher sees after goes", async () => {
    const providers = perProvider();
    const watcher = scriptedWatcher();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
      linkedFolders: { watch: watcher.watch },
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    const folder = await createSourceFolder();
    await writtenBefore(folder, "Before.txt", "Quarterly report, before.");
    const [first] = await linkAndProcess(core, folder);
    if (!first?.linkedFolderId) throw new Error("Not linked.");
    await core.setLinkedFolderPaused(first.linkedFolderId, true);
    const pausedPath = await writeSourceFile(folder, "While paused.txt", "Written while paused.");
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));

    await core.setLinkedFolderPaused(first.linkedFolderId, false);
    await core.reconcileDocuments();
    const [already] = await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, pausedPath).status).toBe("ready");
    }).then((documents) => [documentAt(documents, pausedPath)]);
    await waitForTagging(core, [already?.id ?? ""], (each) => each.tagging === "off");
    expect(providers.sent("anthropic")).toBe(0);

    await watcher.watching(folder);
    const afterPath = await writeSourceFile(folder, "After resume.txt", "Written after resume.");
    watcher.report(folder, afterPath);
    const [after] = await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, afterPath).status).toBe("ready");
    }).then((documents) => [documentAt(documents, afterPath)]);
    await waitForTagging(core, [after?.id ?? ""]);
    expect(providers.sent("anthropic")).toBe(1);
  });

  test("a Linked folder linked after the turn-on is new: its files and one added later each go once", async () => {
    const providers = perProvider();
    const watcher = scriptedWatcher();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: providers.createChatModel,
      linkedFolders: { watch: watcher.watch },
    });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    const folder = await createSourceFolder();
    await writtenBefore(folder, "Old file.txt", "Written long ago, linked now.");
    const linked = await linkAndProcess(core, folder);
    await waitForTagging(
      core,
      linked.map((each) => each.id),
    );
    expect(providers.sent("anthropic")).toBe(1);

    await watcher.watching(folder);
    const newPath = await writeSourceFile(folder, "New file.txt", "Written after.");
    watcher.report(folder, newPath);
    const [added] = await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, newPath).status).toBe("ready");
    }).then((documents) => [documentAt(documents, newPath)]);
    await waitForTagging(core, [added?.id ?? ""]);
    expect(providers.sent("anthropic")).toBe(2);
  });

  test("a save from a window with an older view never turns the switch on, and never moves when it was turned on", async () => {
    const dataDir = await createTempDataFolder();
    const providers = perProvider();
    const core = startCore(dataDir, { createChatModel: providers.createChatModel });
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    const stored = () =>
      queryDatabase<{ value: string }>(
        dataDir,
        "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
      ).map((row) => JSON.parse(row.value).automaticSince);
    const since = stored();
    const older = (await core.getLibrary()).settings;
    await core.saveLibrarySettings({ ...older, automatic: false });

    await core.saveLibrarySettings({ ...older, organizeWith: null });
    const held = await add(core, "After the older save.txt");

    expect(older.automatic).toBe(true);
    expect((await core.getLibrary()).settings.automatic).toBe(false);
    expect(stored()).toEqual(since);
    expect(held.tagging).toBe("off");
    expect(providers.sent("anthropic")).toBe(0);
  });
});

describe("New means IncarnaMind saw it arrive, whatever the file's times say", () => {
  test("in a folder linked before the turn-on: an edit, a save by rename, and files a scan finds (a copy keeping its old date, one synced in with today's) wait; a file its watcher sees arrive goes", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const providers = perProvider();
    const watcher = scriptedWatcher();
    const options = {
      keychain,
      createChatModel: providers.createChatModel,
      linkedFolders: { watch: watcher.watch },
    };
    let core = startCore(dataDir, options);
    const anthropic = await core.saveChatProvider(ANTHROPIC);
    const folder = await createSourceFolder();
    const editedPath = await writtenBefore(folder, "Report 1.txt", "Quarterly report 1.");
    const renamedPath = await writtenBefore(folder, "Report 2.txt", "Quarterly report 2.");
    const linked = await linkAndProcess(core, folder);
    await turnOn(core, chatModel(anthropic.id, ANTHROPIC.modelId));
    await watcher.watching(folder);

    // Edited after the turn-on: a new file time, the same Document.
    const editedText = "Quarterly report 1, edited after.";
    await writeSourceFile(folder, "Report 1.txt", editedText);
    watcher.report(folder, editedPath);
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, editedPath)).toMatchObject({
        status: "ready",
        contentHash: sha256(editedText),
      });
    });
    // Saved as an app saves: a new file, renamed over the old one.
    const savedText = "Quarterly report 2, saved by rename.";
    const temporary = await writeSourceFile(folder, "Report 2.txt.tmp", savedText);
    await rename(temporary, renamedPath);
    watcher.report(folder, temporary, renamedPath);
    await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, renamedPath)).toMatchObject({
        status: "ready",
        contentHash: sha256(savedText),
      });
    });
    const held = linked.map((each) => each.id);
    await waitForTagging(core, held, (each) => each.tagging === "off");
    expect(providers.sent("anthropic")).toBe(0);

    // A file the watcher sees arrive is new.
    const arrivedPath = await writeSourceFile(folder, "Arrived.txt", "Written after the turn-on.");
    watcher.report(folder, arrivedPath);
    const [arrived] = await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, arrivedPath).status).toBe("ready");
    }).then((documents) => [documentAt(documents, arrivedPath)]);
    await waitForTagging(core, [arrived?.id ?? ""]);
    expect(providers.sent("anthropic")).toBe(1);

    // Copied in keeping its old date, and synced in with today's, while the app was closed: the
    // scan at the next start finds both. Neither file's time makes it new.
    core.close();
    const copiedPath = await writtenBefore(folder, "Copied.txt", "Copied in, keeping its date.");
    const syncedPath = await writeSourceFile(folder, "Synced.txt", "Synced in while closed.");
    core = startCore(dataDir, options);
    const found = await waitForDocuments(core, (documents) => {
      expect(documentAt(documents, copiedPath).status).toBe("ready");
      expect(documentAt(documents, syncedPath).status).toBe("ready");
    }).then((documents) => [documentAt(documents, copiedPath), documentAt(documents, syncedPath)]);
    const scanned = found.map((each) => each.id);
    await waitForTagging(core, scanned, (each) => each.tagging === "off");
    expect(providers.sent("anthropic")).toBe(1);

    await core.createLibraryGroup({ name: "Finance", description: "Reports." });
    await core.classifyDocuments([...held, ...scanned]);
    await waitForTagging(core, [...held, ...scanned]);
    expect(providers.sent("anthropic")).toBe(5);
    core.close();
  });
});
