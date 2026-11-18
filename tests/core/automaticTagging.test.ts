/**
 * Tagging and sorting new Documents by themselves (#1617, #3353): one switch for both, on until
 * the User turns it off. For a model on this computer it holds at once; for a cloud model it asks
 * before the first Document goes, and sends nothing until the User allows it. What is asserted is
 * what leaves: nothing, until then, however the Documents arrive. Through the core's public
 * interface, with scripted models standing in for every provider.
 */
import { APICallError } from "ai";
import { describe, expect, test, vi } from "vitest";
import type { Core, SaveChatProviderInput } from "../../src/core";
import { createTempDataFolder, startCore, turnOnAutomaticTagging } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";
import { scriptedModels } from "../helpers/models";
import { proposedTagNamesOf, taggingModel, waitForTagging } from "../helpers/tags";

const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-sonnet-5-5",
};
const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const ANTHROPIC_SERVICE = "https://api.anthropic.com";

async function start() {
  const tagging = taggingModel(["Paper"]);
  const models = scriptedModels(tagging.model);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
  });
  return { core, tagging, models };
}

async function add(core: Core, name: string, text = "Attention Is All You Need. A paper.") {
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), name, text),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

const switchOf = async (core: Core) => (await core.getLibrary()).settings.automatic;
const asksFor = async (core: Core) =>
  (await core.getLibrary()).asksFor.map((service) => service.name);

describe("The switch for tagging and sorting new Documents", () => {
  test("a cloud model asks first: nothing is sent for new Documents, whatever their kind", async () => {
    const { core, tagging, models } = await start();
    await core.saveChatProvider(ANTHROPIC);
    await core.createLibraryGroup({ name: "Papers", description: "Research papers" });
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));
    const specsBefore = models.specs.length;

    const text = await add(core, "Attention.md");
    const [pdf] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), "Scan.txt", "A second Document."),
    ]);

    expect(await switchOf(core)).toBe(false);
    expect(await asksFor(core)).toEqual(["Anthropic"]);
    expect([text.tagging, pdf?.tagging]).toEqual(["off", "off"]);
    expect(tagging.requests).toEqual([]);
    expect(models.specs).toHaveLength(specsBefore);
    expect(requests).toEqual([]);
    expect((await core.getLibrary()).assignments).toEqual([]);
    // Choosing the provider allowed what runs by itself, not tagging or sorting.
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "tagging" }),
        consent: "not-asked",
      }),
    );
  });

  test("a model on this computer is on and asks nothing: new Documents are tagged, as before", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);

    const document = await add(core, "Attention.md");
    await waitForTagging(core, [document.id]);

    expect(await switchOf(core)).toBe(true);
    expect(await asksFor(core)).toEqual([]);
    expect(tagging.requests).toHaveLength(1);
    expect(await proposedTagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test("turning it on shows in Privacy with its date, tags the Documents added since, and leaves the earlier ones", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(ANTHROPIC);
    const earlier = await add(core, "Earlier.md");

    await turnOnAutomaticTagging(core);
    const since = await add(core, "Attention.md");
    await waitForTagging(core, [since.id]);

    expect(await switchOf(core)).toBe(true);
    expect(tagging.requests).toHaveLength(1);
    expect((await core.listDocuments()).find((each) => each.id === earlier.id)?.tagging).toBe(
      "off",
    );
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({
          id: "tagging",
          service: expect.objectContaining({ id: ANTHROPIC_SERVICE }),
        }),
        consent: "accepted",
        decidedAt: expect.any(String),
        chosen: true,
      }),
    );
  });

  test("revoking the flow in Privacy stops it: new Documents wait, nothing is sent and nothing asks", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    const first = await add(core, "Attention.md");
    await waitForTagging(core, [first.id]);

    await core.revokeConsent("tagging", ANTHROPIC_SERVICE);
    const second = await add(core, "Report.md");

    expect(second.tagging).toBe("off");
    expect(await switchOf(core)).toBe(false);
    expect(await asksFor(core)).toEqual([]);
    expect(tagging.requests).toHaveLength(1);
  });

  test("turning it off again stops it at once", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    const { settings } = await core.getLibrary();

    await core.saveLibrarySettings({ ...settings, automatic: false });
    const document = await add(core, "Attention.md");

    expect(await switchOf(core)).toBe(false);
    expect(document.tagging).toBe("off");
    expect(tagging.requests).toEqual([]);
  });

  test("it holds for a model on this computer and asks for a cloud one until the User sets it, and then stays as they set it", async () => {
    const { core } = await start();
    await core.saveChatProvider(ANTHROPIC);
    expect(await switchOf(core)).toBe(false);
    expect(await asksFor(core)).toEqual(["Anthropic"]);

    // A save for another setting answers nothing.
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings(settings);
    expect(await asksFor(core)).toEqual(["Anthropic"]);
    const local = await core.saveChatProvider(LOCAL);
    await core.updateSettings({
      user: { chatModel: { providerId: local.id, modelId: "local-model" } },
    });
    await vi.waitFor(async () => expect(await switchOf(core)).toBe(true));
    expect(await asksFor(core)).toEqual([]);

    // Set by hand, it stays.
    const { settings: now } = await core.getLibrary();
    await core.saveLibrarySettings({ ...now, automatic: false });
    expect(await switchOf(core)).toBe(false);
    const cloud = (await core.listChatProviders()).find((each) => each.kind === "anthropic");
    await core.updateSettings({
      user: { chatModel: { providerId: cloud?.id ?? "", modelId: ANTHROPIC.modelId } },
    });
    expect(await asksFor(core)).toEqual([]);
    await core.updateSettings({
      user: { chatModel: { providerId: local.id, modelId: "local-model" } },
    });
    expect(await switchOf(core)).toBe(false);
  });

  test("Organize by hand still works with it off, on the model the User chose", async () => {
    const fake = classifierModel();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(fake.model).createChatModel,
    });
    const provider = await core.saveChatProvider(ANTHROPIC);
    await core.createLibraryGroup({ name: "Papers", description: "Research papers" });
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
      automatic: false,
    });
    const document = await add(core, "Attention.md");
    expect((await core.getLibrary()).assignments).toEqual([]);
    expect(fake.calls).toHaveLength(0);

    await core.classifyDocuments([document.id]);

    await vi.waitFor(async () =>
      expect((await core.getLibrary()).assignments[0]).toMatchObject({ status: "classified" }),
    );
    expect(fake.calls).toHaveLength(1);
  });

  test("a re-tag the User started that failed keeps its failure and its Retry with the switch off", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(ANTHROPIC);
    await turnOnAutomaticTagging(core);
    await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
    const document = await add(core, "Attention.md");
    tagging.fail(
      new APICallError({
        message: "The model does not exist",
        url: "https://api.example.com/v1/messages",
        requestBodyValues: {},
        statusCode: 404,
        isRetryable: false,
      }),
    );
    await core.retagDocuments([document.id]);
    await waitForTagging(core, [document.id], (each) => each.tagging === "failed");

    await core.saveLibrarySettings((await core.getLibrary()).settings);

    const [after] = (await core.listDocuments()).filter((each) => each.id === document.id);
    expect(after).toMatchObject({ tagging: "failed", taggingError: { kind: "model" } });
  });
});
