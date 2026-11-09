import { describe, expect, test } from "vitest";
import type { Core, SaveChatProviderInput } from "../../src/core";
import { LocalModeError } from "../../src/core/errors";
import { setUpJevForSorting } from "../../src/renderer/src/components/providers/jevSetUp";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";
import { JEV_KEY, startFakeJev } from "../helpers/jev";
import { scriptedModels } from "../helpers/models";
import { taggingModel } from "../helpers/tags";

/*
 * "Use TypeSafe Jev…" in the sorting picker (#2615), through the core as the picker drives it:
 * what it reads while the key is typed, then Use this, which tries the key, saves it and makes Jev
 * what sorts; tagging stays off until Settings › Models' Turn on… turns it on. Requests to
 * TypeSafe's hosted Jev go to a fake.
 */

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const TYPESAFE = { id: "https://api.typesafe.ai", name: "TypeSafe Jev" };

async function startWithFakeTypeSafe() {
  const jev = await startFakeJev();
  const keychain = createMemoryKeychain();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(taggingModel(["Notes"]).model).createChatModel,
    keychain,
    jevHostedUrl: jev.url,
  });
  await core.saveChatProvider(LOCAL);
  return { core, jev, keychain };
}

/** What the picker reads while it offers the row and the key is typed. */
async function readAsThePickerDoes(core: Core) {
  await core.getJevSettings();
  await core.getTaggingModels();
  await core.getLibrary();
  await core.getSecretStorage();
}

/** What the sorting row's Use this saves: the choice alone, as the picker does. */
const chooseJev = (core: Core) => async () => {
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, classifier: { kind: "jev" } });
  return true;
};

const useThis = (core: Core, apiKey: string) =>
  setUpJevForSorting(
    core,
    { apiKey, endpoint: null, model: null, reviewBand: { low: 0.35, high: 0.65 } },
    chooseJev(core),
  );

const typeSafeFlows = async (core: Core) =>
  (await core.listDataFlows())
    .filter((each) => each.flow.service.id === TYPESAFE.id)
    .map((each) => `${each.flow.id}: ${each.consent}`)
    .sort();

describe("Jev set up from the sorting picker (#2615)", { timeout: 30_000 }, () => {
  test("nothing reaches TypeSafe before Use this; then the key is tried, saved, and Jev sorts", async () => {
    const { core, jev, keychain } = await startWithFakeTypeSafe();
    const asked: string[] = [];
    core.on("consent.requested", (request) => asked.push(request.flow.id));

    await readAsThePickerDoes(core);
    expect(jev.requests).toEqual([]);
    expect(await typeSafeFlows(core)).toEqual([]);

    expect(await useThis(core, JEV_KEY)).toMatchObject({
      kind: "saved",
      saved: { enabled: true, hasApiKey: true, service: TYPESAFE },
      chosen: true,
    });

    // One request, the key's check, which carries a fixed text and nothing of the User's.
    expect(jev.requests).toHaveLength(1);
    expect(jev.requests[0]?.authorization).toBe(`Bearer ${JEV_KEY}`);
    expect(jev.requests[0]?.body.state).toBe(
      "IncarnaMind is checking that it can reach this server.",
    );
    expect(keychain.secrets.get("jev:api-key")).toBe(JEV_KEY);
    const { settings } = await core.getLibrary();
    expect(settings.classifier).toEqual({ kind: "jev" });
    // Choosing Jev for sorting never turns tagging on: Turn on… does, with its line on screen.
    expect(settings.automatic).toBe(false);
    // Its Use this, under the line naming what goes, is the consent for sorting and Organize: nothing
    // else asks.
    expect(await typeSafeFlows(core)).toEqual(["classification: accepted", "tagging: accepted"]);
    expect(asked).toEqual([]);
    // Jev is what the picker lists first now.
    const models = await core.getTaggingModels();
    expect(models.options[0]?.classifier).toEqual({ kind: "jev" });
    expect(models.saved).toEqual({
      classifier: { kind: "jev" },
      destination: { kind: "service", service: TYPESAFE },
    });
  });

  test("a refused key is saved nowhere and chooses nothing: the choice and the consents stay as they were", async () => {
    const { core, jev, keychain } = await startWithFakeTypeSafe();
    const before = (await core.getLibrary()).settings;

    expect(await useThis(core, "a-wrong-key")).toEqual({
      kind: "failed",
      result: { ok: false, error: { kind: "auth", message: "Invalid API key.", status: 401 } },
    });

    expect(jev.requests).toHaveLength(1);
    expect(await core.getJevSettings()).toMatchObject({ enabled: false, hasApiKey: false });
    expect(keychain.secrets.has("jev:api-key")).toBe(false);
    expect((await core.getLibrary()).settings).toEqual(before);
    expect(await typeSafeFlows(core)).toEqual([]);

    // The right key, pressed again, goes through.
    expect(await useThis(core, JEV_KEY)).toMatchObject({ kind: "saved", chosen: true });
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "jev" });
  });

  test("left while the key is tried (Cancel, another row), the press saves and chooses nothing", async () => {
    const { core, jev, keychain } = await startWithFakeTypeSafe();
    const before = (await core.getLibrary()).settings;
    let chosen = false;

    expect(
      await setUpJevForSorting(
        core,
        { apiKey: JEV_KEY, endpoint: null, model: null, reviewBand: { low: 0.35, high: 0.65 } },
        async () => {
          chosen = true;
          return true;
        },
        () => false,
      ),
    ).toEqual({ kind: "given-up" });

    expect(jev.requests).toHaveLength(1);
    expect(chosen).toBe(false);
    expect(keychain.secrets.has("jev:api-key")).toBe(false);
    expect((await core.getLibrary()).settings).toEqual(before);
    expect(await typeSafeFlows(core)).toEqual([]);
  });

  test("in Local mode the key goes to no cloud server, and a Jev server on this computer is tried", async () => {
    const { core, jev } = await startWithFakeTypeSafe();
    await core.setLocalOnly(true);

    await expect(useThis(core, JEV_KEY)).rejects.toThrow(LocalModeError);
    expect(jev.requests).toEqual([]);
    expect(await core.getJevSettings()).toMatchObject({ enabled: false, hasApiKey: false });

    const here = await setUpJevForSorting(
      core,
      { apiKey: JEV_KEY, endpoint: jev.url, model: null, reviewBand: { low: 0.35, high: 0.65 } },
      chooseJev(core),
    );
    expect(here).toMatchObject({ kind: "saved", saved: { service: null }, chosen: true });
    expect(jev.requests).toHaveLength(1);
    expect((await core.getLibrary()).settings.classifier).toEqual({ kind: "jev" });
  });
});
