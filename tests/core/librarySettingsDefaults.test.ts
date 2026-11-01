/**
 * Settings › Models keeps Tagging and Organize folded under Advanced until the User changes one
 * of the Library's settings (#1570). A fresh Library's settings are the defaults, except the
 * switch for tagging and sorting by themselves, which follows the model (#1617); each change the
 * User can make is told apart from them. Through the core's public interface.
 */
import { expect, test } from "vitest";
import type { Core } from "../../src/core";
import { changedFromDefaults, LIBRARY_DEFAULTS } from "../../src/shared/libraryModels";
import { createTempDataFolder, startCore } from "../helpers/core";

const changed = async (core: Core) => {
  const library = await core.getLibrary();
  return changedFromDefaults(library.settings, library.automaticDefault);
};

test("a fresh Library has the default settings", async () => {
  const core = startCore(await createTempDataFolder());
  const { settings, automaticDefault } = await core.getLibrary();
  expect(settings).toMatchObject(LIBRARY_DEFAULTS);
  expect(settings.automatic).toBe(true);
  expect(automaticDefault).toBe(true);
  expect(await changed(core)).toBe(false);
});

test("a cloud model keeps the switch's own default, so nothing is a choice of the User's until they set it", async () => {
  const core = startCore(await createTempDataFolder());
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-sonnet-5-5",
  });

  const { settings, automaticDefault } = await core.getLibrary();
  expect(settings.automatic).toBe(false);
  expect(automaticDefault).toBe(false);
  expect(await changed(core)).toBe(false);

  await core.saveLibrarySettings({ ...settings, automatic: true, turnOn: true });
  expect(await changed(core)).toBe(true);
});

test("a model chosen by hand, the moves into Folders turned off, Organize's model and a stop each differ from the defaults", async () => {
  const core = startCore(await createTempDataFolder());
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "small" });
  const chosen = { kind: "chat", choice: { providerId: provider.id, modelId: "small" } } as const;

  await core.saveLibrarySettings({ classifier: chosen, automatic: true });
  expect(await changed(core)).toBe(true);
  await core.saveLibrarySettings({ classifier: null, automatic: true });
  expect(await changed(core)).toBe(false);

  await core.saveLibrarySettings({ classifier: null, automatic: false });
  expect(await changed(core)).toBe(true);
  await core.saveLibrarySettings({ classifier: null, automatic: true, turnOn: true });
  expect(await changed(core)).toBe(false);

  await core.saveLibrarySettings({ classifier: null, automatic: true, organizeWith: chosen });
  expect(await changed(core)).toBe(true);
  await core.saveLibrarySettings({ classifier: null, automatic: true, organizeWith: null });
  expect(await changed(core)).toBe(false);

  await core.setTaggingWithAi(null, false);
  expect(await changed(core)).toBe(true);
  await core.setTaggingWithAi(null, true);
  expect(await changed(core)).toBe(false);
});
