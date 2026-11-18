/**
 * A fresh Library's settings are the defaults, and the switch for sorting and tagging new
 * Documents is on until the User turns it off (#3353): with a model on this computer it holds at
 * once; with a cloud model it asks before the first Document goes, so it may send nothing yet and
 * names the service. A save of another setting, which sends the switch as the core shows it,
 * never answers for the User; their own off does, also while it asks. Through the core's public
 * interface.
 */
import { expect, test } from "vitest";
import { LIBRARY_DEFAULTS, sortingSwitchOn } from "../../src/shared/libraryModels";
import { createTempDataFolder, startCore } from "../helpers/core";

const ANTHROPIC = "https://api.anthropic.com";

test("a fresh Library has the default settings, its switch on", async () => {
  const core = startCore(await createTempDataFolder());
  const library = await core.getLibrary();
  expect(library.settings).toMatchObject(LIBRARY_DEFAULTS);
  expect(library.settings.automatic).toBe(true);
  expect(library.asksFor).toEqual([]);
  expect(sortingSwitchOn(library)).toBe(true);
});

test("with a cloud model the switch is on and asks first; only the User's own off answers no", async () => {
  const core = startCore(await createTempDataFolder());
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-sonnet-5-5",
  });
  const asking = await core.getLibrary();
  expect(asking.settings.automatic).toBe(false);
  expect(asking.asksFor.map((each) => [each.id, each.name])).toEqual([[ANTHROPIC, "Anthropic"]]);
  expect(sortingSwitchOn(asking)).toBe(true);

  // Saves of other settings send the switch as the core shows it: they say nothing for the User.
  await core.saveLibrarySettings(asking.settings);
  await core.saveLibrarySettings({
    ...asking.settings,
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "claude-sonnet-5-5" } },
  });
  expect((await core.getLibrary()).asksFor.map((each) => each.id)).toEqual([ANTHROPIC]);

  // Settings' switch turned off while it asks is the User's no.
  await core.saveLibrarySettings({
    ...(await core.getLibrary()).settings,
    automatic: false,
    turnOn: false,
  });
  const off = await core.getLibrary();
  expect([off.settings.automatic, off.asksFor, sortingSwitchOn(off)]).toEqual([false, [], false]);

  // Turned on again there, it is the consent, as before.
  await core.saveLibrarySettings({ ...off.settings, automatic: true, turnOn: true });
  const on = await core.getLibrary();
  expect([on.settings.automatic, on.asksFor]).toEqual([true, []]);
});
