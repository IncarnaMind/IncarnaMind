/**
 * Tagging by itself (#2308, #2339): an empty answer leaves a Document with nothing proposed, in
 * one request; choosing a cloud model for Tags turns tagging on, for the Documents added after.
 * Through the core's public interface, with a scripted model.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE, type SaveChatProviderInput } from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { proposedTagNamesOf, taggingModel, waitForTagging } from "../helpers/tags";

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};

async function start() {
  const tagging = taggingModel([]);
  const models = scriptedModels(tagging.model);
  const core = startCore(await createTempDataFolder(), { createChatModel: models.createChatModel });
  return { core, tagging };
}

async function add(core: Core, name: string, text: string) {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), name, text),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

describe("Tagging in the background", () => {
  test("an empty first answer leaves a Document with no Tag, in one request", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    tagging.choose([]);
    tagging.name([]);

    const order = await add(
      core,
      "Golden Wok order.txt",
      "Golden Wok takeaway. Order 6021. Kung pao chicken 1 x 12.00. Paid 12.00 by card.",
    );
    const [done] = await waitForTagging(core, [order.id]);

    expect(done?.tags).toEqual([]);
    expect(await proposedTagNamesOf(core, order.id)).toEqual([]);
    expect(tagging.requests).toHaveLength(1);
  });
});

describe("Choosing a model for Tags", () => {
  test("a cloud model chosen for Tags turns tagging on, and new Documents are tagged", async () => {
    const { core, tagging } = await start();
    tagging.choose(["Report"]);
    const provider = await core.saveChatProvider(ANTHROPIC);
    const { settings } = await core.getLibrary();
    expect(settings.automatic).toBe(false);

    // As setup's "Use this" and Settings › Tagging send it.
    await core.saveLibrarySettings({
      ...settings,
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
      automatic: true,
      turnOn: true,
    });
    const document = await add(core, "Report.txt", "A quarterly report.");
    await waitForTagging(core, [document.id]);

    expect((await core.getLibrary()).settings.automatic).toBe(true);
    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Report"]);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "tagging" }),
        consent: "accepted",
      }),
    );
  });

  test("a save for another setting that shows the switch off leaves it off", async () => {
    const { core, tagging } = await start();
    const provider = await core.saveChatProvider(ANTHROPIC);
    const { settings } = await core.getLibrary();

    await core.saveLibrarySettings({
      ...settings,
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
    });
    const document = await add(core, "Report.txt", "A quarterly report.");

    expect((await core.getLibrary()).settings.automatic).toBe(false);
    expect(document.tagging).toBe("off");
    expect(tagging.requests).toEqual([]);
  });

  test("an upgraded profile with a Tags model chosen and the switch off keeps it off, through saves that show it off", async () => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const tagging = taggingModel(["Report"]);
    const models = scriptedModels(tagging.model);
    const first = startCore(dataDir, { keychain, createChatModel: models.createChatModel });
    const provider = await first.saveChatProvider(ANTHROPIC);
    first.close();
    // As setup saved a choice before #2308: the model, and no switch of the User's.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const at = "2026-10-30T09:00:00.000Z";
      db.run(
        `INSERT INTO device_settings (id, key, value, created_at, updated_at) VALUES (?, 'library', ?, ?, ?)`,
        [
          randomUUID(),
          JSON.stringify({
            classifier: {
              kind: "chat",
              choice: { providerId: provider.id, modelId: ANTHROPIC.modelId },
            },
            organizeWith: null,
            taggingStopped: [],
          }),
          at,
          at,
        ],
      );
    } finally {
      db.close();
    }
    const core = startCore(dataDir, { keychain, createChatModel: models.createChatModel });
    expect((await core.getLibrary()).settings.automatic).toBe(false);

    // Saves of what the switch shows, another model among them, as Settings › Models sends one.
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings });
    await core.saveLibrarySettings({
      ...settings,
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: "claude-sonnet-5-5" },
      },
    });
    const document = await add(core, "Report.txt", "A quarterly report.");

    expect((await core.getLibrary()).settings.automatic).toBe(false);
    expect(document.tagging).toBe("off");
    expect(tagging.requests).toEqual([]);
  });

  test("choosing a cloud model sends none of the Documents already here: they wait for what the User starts", async () => {
    const { core, tagging } = await start();
    tagging.choose(["Report"]);
    await core.saveChatProvider(LOCAL);
    tagging.fail(new Error("The model on this computer is down."));
    const existing: string[] = [];
    for (let at = 1; at <= 10; at++) {
      existing.push((await add(core, `Report ${at}.txt`, `Quarterly report ${at}.`)).id);
    }
    await waitForTagging(core, existing, (each) => each.tagging === "failed");
    tagging.fail(null);
    const asked = tagging.requests.length;

    const provider = await core.saveChatProvider(ANTHROPIC);
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({
      ...settings,
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
      automatic: true,
      turnOn: true,
    });
    const after = await waitForTagging(core, existing, (each) => each.tagging === "off");
    expect(after).toHaveLength(10);
    expect(tagging.requests).toHaveLength(asked);

    const fresh = await add(core, "New report.txt", "A new quarterly report.");
    await waitForTagging(core, [fresh.id]);
    expect(tagging.requests).toHaveLength(asked + 1);

    await core.retagDocuments(existing.slice(0, 2));
    await waitForTagging(core, existing.slice(0, 2));
    expect(tagging.requests).toHaveLength(asked + 3);
    expect(tagging.requests.at(-1)?.text).toContain("Quarterly report");
  });
});
