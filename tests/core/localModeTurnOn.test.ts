/**
 * Turning tagging on while "Keep everything on this computer" is on names no service outside this
 * computer (#2982, ADR-0022): the row's line there names none. Once Local mode is off, the switch
 * reads off for the cloud model until the User turns it on with its line on screen, and nothing
 * that arrived before then goes by itself. Through the core's public interface, counting what the
 * cloud model's stand-in receives.
 */
import { describe, expect, test, vi } from "vitest";
import type { Core, LibraryClassifier } from "../../src/core";
import {
  createMemoryKeychain,
  createTempDataFolder,
  manualClock,
  queryDatabase,
  startCore,
} from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { taggingModel, waitForTagging } from "../helpers/tags";

const ANTHROPIC = "https://api.anthropic.com";

const settled = (core: Core, ids: readonly string[]) =>
  waitForTagging(
    core,
    ids,
    (each) => !["pending", "tagging", "waiting-for-provider"].includes(each.tagging),
  );

async function add(core: Core, name: string, text: string) {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createSourceFolder(), name, text),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

/** Turn on…, with the row's line on screen. */
async function turnOn(core: Core) {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
}

/** The User's decision on each flow that tagging and Organize send by, to the cloud model. */
async function decisions(core: Core) {
  const flows = await core.listRegisteredDataFlows();
  const decisionOf = (id: string) => {
    const status = flows
      .find((flow) => flow.id === id)
      ?.services.find((each) => each.flow.service.id === ANTHROPIC);
    return { consent: status?.consent ?? "not-asked", decidedAt: status?.decidedAt ?? null };
  };
  return { tagging: decisionOf("tagging"), organize: decisionOf("classification") };
}

/** The services the stored switch was turned on for. */
function turnedOnFor(dataDir: string): string[] {
  const [row] = queryDatabase<{ value: string }>(
    dataDir,
    "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
  );
  const stored: unknown = row ? JSON.parse(row.value) : null;
  const since =
    stored && typeof stored === "object" && "automaticSince" in stored
      ? stored.automaticSince
      : null;
  return since && typeof since === "object" ? Object.keys(since) : [];
}

describe.each([{ language: "en-US" }, { language: "zh-CN" }])(
  "Tagging turned on in Local mode names no service outside this computer, in $language (#2982)",
  { timeout: 30_000 },
  ({ language }) => {
    test.each([{ folder: false }, { folder: true }])(
      "a cloud model chosen for Tags (a Folder there: $folder): nothing goes during Local mode or after it, until Turn on… with Local mode off",
      async ({ folder }) => {
        const tagging = taggingModel(["Report"]);
        const clock = manualClock();
        const dataDir = await createTempDataFolder();
        const core = startCore(dataDir, {
          keychain: createMemoryKeychain(),
          createChatModel: scriptedModels(tagging.model).createChatModel,
          systemLanguages: () => [language],
          now: clock.now,
        });
        try {
          const provider = await core.saveChatProvider({
            kind: "anthropic",
            apiKey: "sk-ant-test",
            modelId: "claude-haiku-5-5",
          });
          const classifier: LibraryClassifier = {
            kind: "chat",
            choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
          };
          await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, classifier });
          if (folder) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
          const chosen = await decisions(core);
          clock.advance(60_000);

          await core.setLocalOnly(true);
          expect((await core.getTaggingModels()).localMode).toBe(true);
          await turnOn(core);
          const inLocalMode = {
            turnedOnFor: turnedOnFor(dataDir),
            decisions: await decisions(core),
          };
          const held = await add(core, "季度报告.txt", "季度报告：本季度收入增长百分之十。");
          clock.advance(60_000);

          await core.setLocalOnly(false);
          expect((await core.getTaggingModels()).localMode).toBe(false);
          const afterLocalMode = (await core.getLibrary()).settings;
          const after = await add(core, "Memo.txt", "A memo written after Local mode was off.");
          const states = await settled(core, [held.id, after.id]);

          expect(tagging.requests).toEqual([]);
          expect(states.map((each) => each.tagging)).toEqual(["off", "off"]);
          expect(afterLocalMode).toMatchObject({ classifier, automatic: false });
          expect(inLocalMode.turnedOnFor).toEqual([]);
          expect(inLocalMode.decisions).toEqual({
            tagging: { consent: "not-asked", decidedAt: null },
            organize: chosen.organize,
          });

          // Turn on… with Local mode off, its line naming the service: only what arrives after goes.
          clock.advance(60_000);
          await turnOn(core);
          expect((await core.getLibrary()).settings.automatic).toBe(true);
          expect(turnedOnFor(dataDir)).toEqual([ANTHROPIC]);
          expect((await decisions(core)).tagging.consent).toBe("accepted");
          const sent = await add(core, "Report.txt", "A quarterly report on revenue.");
          await tagging.requested(1);
          await settled(core, [sent.id]);

          expect(tagging.requests).toHaveLength(1);
          expect(tagging.requests[0]?.text).toContain("A quarterly report on revenue.");
          expect(tagging.requests[0]?.text).not.toContain("季度报告");
          expect(tagging.requests[0]?.text).not.toContain("A memo written");
          const documents = await core.listDocuments();
          expect(
            [held.id, after.id].map((id) => documents.find((each) => each.id === id)?.tagging),
          ).toEqual(["off", "off"]);
        } finally {
          core.close();
        }
      },
    );

    test.each([
      { offInLocalMode: true, onAfter: false },
      { offInLocalMode: false, onAfter: true },
    ])(
      "turned on for the cloud model before Local mode (turned off and on again in Local mode: $offInLocalMode): on once Local mode ends: $onAfter",
      async ({ offInLocalMode, onAfter }) => {
        const tagging = taggingModel(["Report"]);
        const dataDir = await createTempDataFolder();
        const core = startCore(dataDir, {
          keychain: createMemoryKeychain(),
          createChatModel: scriptedModels(tagging.model).createChatModel,
          systemLanguages: () => [language],
        });
        try {
          const provider = await core.saveChatProvider({
            kind: "anthropic",
            apiKey: "sk-ant-test",
            modelId: "claude-haiku-5-5",
          });
          await core.saveLibrarySettings({
            ...(await core.getLibrary()).settings,
            classifier: {
              kind: "chat",
              choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
            },
          });
          await turnOn(core);
          const before = await add(core, "Before.txt", "A report added before Local mode.");
          await waitForTagging(core, [before.id]);
          expect(tagging.requests).toHaveLength(1);

          await core.setLocalOnly(true);
          expect((await core.getLibrary()).settings.automatic).toBe(true);
          if (offInLocalMode) {
            await core.saveLibrarySettings({
              ...(await core.getLibrary()).settings,
              automatic: false,
            });
            await turnOn(core);
          }
          const held = offInLocalMode
            ? await add(core, "季度报告.txt", "季度报告：本季度收入增长百分之十。")
            : null;
          await core.setLocalOnly(false);

          expect((await core.getLibrary()).settings.automatic).toBe(onAfter);
          const after = await add(core, "After.txt", "A memo added after Local mode.");
          const states = await settled(core, [...(held ? [held.id] : []), after.id]);
          if (onAfter) {
            await tagging.requested(2);
            expect(tagging.requests).toHaveLength(2);
            expect(tagging.requests[1]?.text).toContain("A memo added after Local mode.");
          } else {
            expect(states.map((each) => each.tagging)).toEqual(["off", "off"]);
            expect(tagging.requests).toHaveLength(1);
            expect(turnedOnFor(dataDir)).toEqual([]);
          }
        } finally {
          core.close();
        }
      },
    );

    test("a model on this computer tags as before in Local mode", async () => {
      const tagging = taggingModel(["Report"]);
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, {
        keychain: createMemoryKeychain(),
        createChatModel: scriptedModels(tagging.model).createChatModel,
        systemLanguages: () => [language],
      });
      try {
        await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
        await core.setLocalOnly(true);
        await turnOn(core);
        expect((await core.getLibrary()).settings.automatic).toBe(true);
        const here = await add(core, "季度报告.txt", "季度报告：本季度收入增长百分之十。");
        await waitForTagging(core, [here.id]);

        expect(tagging.requests).toHaveLength(1);
        expect(turnedOnFor(dataDir)).toEqual([]);
      } finally {
        core.close();
      }
    });
  },
);

/** A cloud model chosen for Tags and turned on with its line on screen, Local mode off. */
async function turnedOnForCloud(language: string, folder: boolean) {
  const tagging = taggingModel(["Report"]);
  const core = startCore(await createTempDataFolder(), {
    keychain: createMemoryKeychain(),
    createChatModel: scriptedModels(tagging.model).createChatModel,
    systemLanguages: () => [language],
  });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  await core.saveLibrarySettings({
    ...(await core.getLibrary()).settings,
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "claude-haiku-5-5" } },
  });
  if (folder) await core.createLibraryGroup({ name: "Finance", description: "Reports." });
  await turnOn(core);
  return { core, tagging };
}

/** The User tags it by hand: Organize with a Folder there, a re-tag without. */
async function tagByHand(core: Core, id: string, folder: boolean) {
  if (folder) await core.classifyDocuments([id]);
  else await core.retagDocuments([id]);
}

const DURING = "季度报告：本季度收入增长百分之十。";

describe.each([{ language: "en-US" }, { language: "zh-CN" }])(
  "What arrives while Local mode is on never goes by itself, then or later, in $language (#2982)",
  { timeout: 30_000 },
  ({ language }) => {
    test.each([{ folder: false }, { folder: true }])(
      "switched on before Local mode (a Folder there: $folder): what arrives before and after goes, what arrives during reads off until tagged by hand",
      async ({ folder }) => {
        const { core, tagging } = await turnedOnForCloud(language, folder);
        try {
          const before = await add(core, "Before.txt", "A report added before Local mode.");
          await tagging.requested(1);
          await settled(core, [before.id]);

          await core.setLocalOnly(true);
          const during = await add(core, "季度报告.txt", DURING);
          // Held at once, as one from before a turn-on: it doesn't wait for Local mode to end.
          expect((await settled(core, [during.id]))[0]?.tagging).toBe("off");
          await core.setLocalOnly(false);
          expect((await core.getLibrary()).settings.automatic).toBe(true);
          const after = await add(core, "After.txt", "A memo added after Local mode.");
          await tagging.requested(2);
          const states = await settled(core, [during.id, after.id]);

          expect(states[0]?.tagging).toBe("off");
          expect(tagging.requests).toHaveLength(2);
          expect(tagging.requests[0]?.text).toContain("A report added before Local mode.");
          expect(tagging.requests[1]?.text).toContain("A memo added after Local mode.");
          expect(tagging.requests.some((request) => request.text.includes(DURING))).toBe(false);

          await tagByHand(core, during.id, folder);
          await tagging.requested(3);
          await settled(core, [during.id]);
          expect(tagging.requests).toHaveLength(3);
          expect(tagging.requests[2]?.text).toContain(DURING);
        } finally {
          core.close();
        }
      },
    );

    test.each([{ folder: false }, { folder: true }])(
      "a Document still waiting when Local mode begins goes once it ends (a Folder there: $folder)",
      async ({ folder }) => {
        const { core, tagging } = await turnedOnForCloud(language, folder);
        try {
          tagging.hold();
          const first = await add(core, "First.txt", "The first report, on its way.");
          await tagging.requested(1);
          const waiting = await add(core, "Waiting.txt", "A report waiting its turn.");
          await core.setLocalOnly(true);
          tagging.release();
          await settled(core, [first.id]);
          expect(tagging.requests).toHaveLength(1);
          if (folder) {
            // It waits with the reason, for Local mode to end.
            await vi.waitFor(async () =>
              expect(
                (await core.getLibrary()).assignments.find(
                  (each) => each.documentId === waiting.id,
                ),
              ).toMatchObject({
                status: "waiting",
                error: { wording: { key: "error.tagging.cloudPaused" } },
              }),
            );
          }

          await core.setLocalOnly(false);
          await tagging.requested(2);
          await settled(core, [waiting.id]);

          expect(tagging.requests).toHaveLength(2);
          expect(tagging.requests[1]?.text).toContain("A report waiting its turn.");
        } finally {
          core.close();
        }
      },
    );

    test.each([{ folder: false }, { folder: true }])(
      "Local mode on, off, on and off again: what arrives in either spell stays off, what arrives between and after goes (a Folder there: $folder)",
      async ({ folder }) => {
        const { core, tagging } = await turnedOnForCloud(language, folder);
        try {
          await core.setLocalOnly(true);
          const first = await add(core, "First spell.txt", "第一次本地模式期间加入的报告。");
          await core.setLocalOnly(false);
          const between = await add(core, "Between.txt", "A memo added between the spells.");
          await tagging.requested(1);
          await settled(core, [between.id]);
          await core.setLocalOnly(true);
          const second = await add(core, "Second spell.txt", "第二次本地模式期间加入的报告。");
          await core.setLocalOnly(false);
          const after = await add(core, "After.txt", "A memo added after both spells.");
          await tagging.requested(2);
          const states = await settled(core, [first.id, second.id, after.id]);

          expect(states.slice(0, 2).map((each) => each.tagging)).toEqual(["off", "off"]);
          expect(tagging.requests).toHaveLength(2);
          expect(tagging.requests[0]?.text).toContain("A memo added between the spells.");
          expect(tagging.requests[1]?.text).toContain("A memo added after both spells.");
          expect(tagging.requests.some((request) => request.text.includes("本地模式期间"))).toBe(
            false,
          );
        } finally {
          core.close();
        }
      },
    );

    test("a cloud model chosen for Tags in Local mode records no consent: Organize asks at its first use after", async () => {
      const tagging = taggingModel(["Report"]);
      const core = startCore(await createTempDataFolder(), {
        keychain: createMemoryKeychain(),
        createChatModel: scriptedModels(tagging.model).createChatModel,
        systemLanguages: () => [language],
      });
      try {
        const provider = await core.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-test",
          modelId: "claude-haiku-5-5",
        });
        await core.createLibraryGroup({ name: "Finance", description: "Reports." });
        await core.setLocalOnly(true);
        await core.saveLibrarySettings({
          ...(await core.getLibrary()).settings,
          classifier: {
            kind: "chat",
            choice: { providerId: provider.id, modelId: "claude-haiku-5-5" },
          },
        });
        expect(await decisions(core)).toEqual({
          tagging: { consent: "not-asked", decidedAt: null },
          organize: { consent: "not-asked", decidedAt: null },
        });

        await core.setLocalOnly(false);
        expect(await core.startOrganize()).toMatchObject({
          ready: false,
          needs: "consent",
          service: { id: ANTHROPIC },
        });
        expect(tagging.requests).toEqual([]);
      } finally {
        core.close();
      }
    });
  },
);
