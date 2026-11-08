/**
 * Organize's plan proposes Folders only, so the Documents it finishes with are handed to the
 * tagger (#1569). The hand-off goes no wider than an Organize press did: it keeps no clearance,
 * walls and stops hold, and with tagging by itself Off it still tags. Through the core's public
 * interface, with a scripted model on a cloud service: no network.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, SaveChatProviderInput } from "../../src/core";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { tagNamesOf, waitForTagging } from "../helpers/tags";

const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};

const userText = (options: LanguageModelV4CallOptions) =>
  options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

/** A model that proposes one new Folder for every Document and tags each one "Report". */
function planAndTagModel() {
  const tagging: string[] = [];
  const reply = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    warnings: [],
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  });
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const schema = (
        call.responseFormat?.type === "json" ? call.responseFormat.schema : undefined
      ) as { properties?: Record<string, unknown> } | undefined;
      const text = userText(call);
      if (schema?.properties?.folders) {
        const { documents } = JSON.parse(text) as { documents: { ref: string }[] };
        return reply({
          folders: [{ key: "N1", name: "Leases", description: "Leases" }],
          documents: documents.map((doc) => ({ ref: doc.ref, folder: "N1" })),
        });
      }
      if (schema?.properties?.placements) {
        const { documents } = JSON.parse(text) as { documents: { ref: string }[] };
        return reply({ placements: documents.map((doc) => ({ ref: doc.ref, folder: "none" })) });
      }
      tagging.push(text);
      return reply({ tags: ["Report"], newTags: [] });
    },
  });
  return {
    model,
    /** How many tagging requests carried this text. */
    taggedFor: (words: string) => tagging.filter((text) => text.includes(words)).length,
  };
}

/**
 * A core that organizes and tags on Anthropic, with both flows allowed for it, and tagging by
 * itself never turned on.
 */
async function start() {
  const scripted = planAndTagModel();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(scripted.model).createChatModel,
  });
  const provider = await core.saveChatProvider(ANTHROPIC);
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: ANTHROPIC.modelId } },
    automatic: false,
  });
  const route = await core.getTaggingRoute("classification");
  if (route.where !== "cloud") throw new Error("Expected tagging to send to a service.");
  await core.allowDataFlow("classification", route.service.id);
  await core.allowDataFlow("tagging", route.service.id);
  const sources = await createSourceFolder();
  const add = async (name: string, text: string): Promise<Document> => {
    const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
    if (!document) throw new Error(`Nothing was added for ${name}.`);
    return document;
  };
  return { core, dataDir, add, taggedFor: scripted.taggedFor };
}

const clearedFor = (dataDir: string, id: string) =>
  queryDatabase<{ service_id: string }>(
    dataDir,
    "SELECT service_id FROM tagging_clearances WHERE document_id = ? AND deleted_at IS NULL",
    [id],
  ).map((row) => row.service_id);

/** Every tagging state each Document showed, in order, from now on. */
function taggingStates(core: Core) {
  const seen = new Map<string, string[]>();
  const record = (document: Document) =>
    seen.set(document.id, [...(seen.get(document.id) ?? []), document.tagging]);
  core.on("documents.tagged", (documents) => {
    for (const document of documents) record(document);
  });
  core.on("document.status", record);
  return (id: string) => seen.get(id) ?? [];
}

describe("Tags after Organize's plan, on a cloud service (#1569)", () => {
  test("with tagging by itself Off, the Documents the plan finished with are still tagged", async () => {
    const { core, add, taggedFor } = await start();
    const first = await add("Lease 1.txt", "First lease, of unit one.");
    const second = await add("Lease 2.txt", "Second lease, of unit two.");
    expect(first.tagging).toBe("off");

    expect(await core.organizeLibrary()).toMatchObject({ status: "done", documents: 2 });

    await waitForTagging(core, [first.id, second.id]);
    expect(await tagNamesOf(core, first.id)).toEqual(["Report"]);
    expect(await tagNamesOf(core, second.id)).toEqual(["Report"]);
    expect(taggedFor("First lease")).toBe(1);
    expect(taggedFor("Second lease")).toBe(1);
  });

  test("with tagging by itself On, Documents from before it was turned on are tagged after the User's Organize, as its press tagged them", async () => {
    const { core, add, taggedFor } = await start();
    const first = await add("Lease 1.txt", "First lease, of unit one.");
    const second = await add("Lease 2.txt", "Second lease, of unit two.");
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      automatic: true,
      turnOn: true,
    });
    expect((await core.getLibrary()).settings.automatic).toBe(true);
    // Here before tagging by itself was turned on, they don't go by themselves.
    await vi.waitFor(async () => {
      const documents = await core.listDocuments();
      for (const id of [first.id, second.id])
        expect(documents.find((each) => each.id === id)?.tagging).toBe("off");
    });
    expect(taggedFor("First lease")).toBe(0);

    expect(await core.organizeLibrary()).toMatchObject({ status: "done", documents: 2 });

    await waitForTagging(core, [first.id, second.id]);
    expect(await tagNamesOf(core, first.id)).toEqual(["Report"]);
    expect(await tagNamesOf(core, second.id)).toEqual(["Report"]);
    expect(taggedFor("First lease")).toBe(1);
  });

  test("tagging a Document after the plan keeps no clearance for that service", async () => {
    const { core, dataDir, add } = await start();
    const lease = await add("Lease 1.txt", "First lease, of unit one.");
    await add("Lease 2.txt", "Second lease, of unit two.");

    await core.organizeLibrary();

    await waitForTagging(core, [lease.id]);
    expect(await tagNamesOf(core, lease.id)).toEqual(["Report"]);
    expect(clearedFor(dataDir, lease.id)).toEqual([]);
  });

  test("a Document in a walled Folder, or in one whose tagging is stopped, isn't sent", async () => {
    const { core, add, taggedFor } = await start();
    const matters = await core.createLibraryGroup({ name: "Matters", description: "" });
    await core.updateLibraryGroup(matters.id, {
      name: matters.name,
      description: matters.description,
      keepInside: true,
    });
    const archive = await core.createLibraryGroup({ name: "Archive", description: "" });
    await core.setTaggingWithAi(archive.id, false);
    const current = await core.createLibraryGroup({ name: "Current", description: "" });
    const walled = await add("Matter lease.txt", "Walled lease, of unit one.");
    const stopped = await add("Archived lease.txt", "Archived lease, of unit two.");
    const open = await add("Current lease.txt", "Current lease, of unit three.");
    await core.assignDocumentGroup(walled.id, matters.id);
    await core.assignDocumentGroup(stopped.id, archive.id);
    await core.assignDocumentGroup(open.id, current.id);
    const statesOf = taggingStates(core);

    for (const folder of [matters, archive, current])
      expect(await core.organizeLibrary({ folderId: folder.id })).toMatchObject({
        status: "done",
        documents: 1,
      });

    await waitForTagging(core, [open.id]);
    expect(taggedFor("Current lease")).toBe(1);
    await vi.waitFor(() => {
      for (const id of [walled.id, stopped.id]) {
        const states = statesOf(id);
        expect(states).toContain("pending");
        expect(states.at(-1)).toBe("off");
      }
    });
    expect(taggedFor("Walled lease")).toBe(0);
    expect(taggedFor("Archived lease")).toBe(0);
    expect(await tagNamesOf(core, walled.id)).toEqual([]);
    expect(await tagNamesOf(core, stopped.id)).toEqual([]);
  });
});
