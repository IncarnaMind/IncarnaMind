/**
 * Turning tagging on while "Keep everything on this computer" is on names no service outside this
 * computer (#2982, ADR-0022): the row's line there names none. Once Local mode is off, the switch
 * reads off for the cloud model until the User turns it on with its line on screen, and nothing
 * that arrived before then goes by itself. Through the core's public interface, counting what the
 * cloud model's stand-in receives.
 */
import { describe, expect, test } from "vitest";
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
