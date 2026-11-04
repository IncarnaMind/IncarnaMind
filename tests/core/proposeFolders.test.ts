/**
 * Organize with no Folders (#2308): Organize's chat model proposes a few Folders from what the
 * Documents say, named in the interface language, the core makes them, and Organize then
 * suggests one for each Document, waiting in To review. A decision model can't name a Folder.
 * Through the core's public interface, with a scripted model.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { type Core, InvalidInputError, type SaveChatProviderInput } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { startFakeJev } from "../helpers/jev";
import { scriptedModels } from "../helpers/models";

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };

const textOf = (options: LanguageModelV4CallOptions, role?: "user") =>
  options.prompt
    .filter((message) => !role || message.role === role)
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

/**
 * Proposes "Kitchen" and "Race", then files each Document in the Folder its name begins with,
 * recording what each request read.
 */
function organizer() {
  const proposals: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema = (
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined
      ) as { properties?: Record<string, { enum?: string[] }> } | undefined;
      let reply: unknown = { tags: [], newTags: [] };
      if (schema?.properties?.folders) {
        proposals.push(textOf(options));
        reply = {
          folders: [
            { name: "Kitchen", description: "The kitchen renovation." },
            { name: "Race", description: "The marathon: registration and training." },
            { name: "kitchen", description: "The same again." },
          ],
        };
      } else if (schema?.properties?.groupId) {
        const data = JSON.parse(textOf(options, "user")) as {
          groups: { id: string; name: string }[];
          document: { name: string };
        };
        const group = data.groups.find((each) => data.document.name.startsWith(each.name));
        reply = { groupId: group?.id ?? "__unsorted__", tags: [], newTags: [] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
  });
  return { model, proposals };
}

async function start() {
  const sorting = organizer();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(sorting.model).createChatModel,
  });
  const provider = await core.saveChatProvider(LOCAL);
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: LOCAL.modelId } },
    automatic: false,
  });
  return { core, sorting };
}

async function addFour(core: Core) {
  const folder = await createTempDataFolder();
  return addAndProcess(core, [
    await writeSourceFile(folder, "Kitchen quote.txt", "Quartz countertop quote. Total 4,200."),
    await writeSourceFile(folder, "Kitchen tiles.txt", "Notes on the tile samples."),
    await writeSourceFile(folder, "Race registration.txt", "Registration confirmed. Bib 1042."),
    await writeSourceFile(folder, "Race plan.txt", "Week 1: 5 km easy. Week 2: intervals."),
  ]);
}

describe("Organize with no Folders", () => {
  test("proposes Folders from what the Documents say, makes them once, and suggests one for each", async () => {
    const { core, sorting } = await start();
    const documents = await addFour(core);
    const ids = documents.map((each) => each.id);

    const made = await core.proposeFolders(ids);
    await core.classifyDocuments(ids);

    expect(made.map((each) => each.name)).toEqual(["Kitchen", "Race"]);
    expect((await core.getLibrary()).groups.map((each) => each.name)).toEqual(["Kitchen", "Race"]);
    expect(sorting.proposals).toHaveLength(1);
    expect(sorting.proposals[0]).toContain("Quartz countertop quote");
    expect(sorting.proposals[0]).toContain('"language":"English"');
    const byName = new Map(made.map((each) => [each.name, each.id]));
    await vi.waitFor(async () => {
      const { assignments } = await core.getLibrary();
      const placed = documents.map((each) => {
        const item = assignments.find((one) => one.documentId === each.id);
        return [each.name, item?.groupId, item?.suggested];
      });
      expect(placed).toEqual([
        ["Kitchen quote", byName.get("Kitchen"), true],
        ["Kitchen tiles", byName.get("Kitchen"), true],
        ["Race registration", byName.get("Race"), true],
        ["Race plan", byName.get("Race"), true],
      ]);
    });
  });

  test("names the Folders in the interface language", async () => {
    const { core, sorting } = await start();
    await core.updateSettings({ user: { language: "zh-CN" } });
    const documents = await addFour(core);

    await core.proposeFolders(documents.map((each) => each.id));

    expect(sorting.proposals[0]).toContain('"language":"Simplified Chinese"');
  });

  test("a decision model can't name a Folder: nothing is made", async () => {
    const jev = await startFakeJev({ apiKey: "ollama" });
    const { core } = await start();
    await core.saveLibrarySettings({
      classifier: { kind: "ollama", baseUrl: jev.url, modelId: "tev1:4b" },
      automatic: false,
    });
    const documents = await addFour(core);

    await expect(core.proposeFolders(documents.map((each) => each.id))).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect((await core.getLibrary()).groups).toEqual([]);
    expect(jev.requests).toEqual([]);
  });
});
