/**
 * Tags named from what the Documents say (#2308): the chat model chooses the Tags that exist
 * where they fit and names new ones where none does. A new Tag is made once and found again by
 * its name however it is written; the User's own decisions, and the Tags they deleted, stay
 * theirs; a Document gets at most three. And choosing a cloud model for Tags turns tagging on.
 * Through the core's public interface, with a scripted model.
 */
import { describe, expect, test } from "vitest";
import type { Core, SaveChatProviderInput } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { taggingModel, tagNamed, tagNamesOf, waitForTagging } from "../helpers/tags";

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

const tagNames = async (core: Core) => (await core.listTags()).map((tag) => tag.name);

describe("Tags named from what a Document says", () => {
  test("a new Tag is made once, in the words the model gave, and the next Document finds it again", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    tagging.name((request) =>
      request.text.includes("马拉松")
        ? [{ name: "训练计划", description: "跑步训练安排。" }]
        : [{ name: "Kitchen renovation", description: "The kitchen remodel." }],
    );

    const quote = await add(core, "Countertop quote.txt", "Quartz countertop quote. Total 4,200.");
    const plan = await add(core, "马拉松训练.txt", "第一周：慢跑 5 公里。第二周：间歇跑。");
    const tiles = await add(core, "Tile samples.txt", "Notes on the tile samples for the kitchen.");
    await waitForTagging(core, [quote.id, plan.id, tiles.id]);

    expect(await tagNamesOf(core, quote.id)).toEqual(["Kitchen renovation"]);
    expect(await tagNamesOf(core, tiles.id)).toEqual(["Kitchen renovation"]);
    expect(await tagNamesOf(core, plan.id)).toEqual(["训练计划"]);
    const names = await tagNames(core);
    expect(names.filter((name) => name === "Kitchen renovation")).toHaveLength(1);
    expect(names).toContain("训练计划");
    // The second request offered the Tag the first one made.
    expect(tagging.requests.at(-1)?.names).toContain("Kitchen renovation");
  });

  test("a name written another way is the Tag that exists: case, full width and plural", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    const invoice = await tagNamed(core, "Invoice");
    const before = (await core.listTags()).length;
    tagging.name([
      { name: "invoices", description: "Bills." },
      { name: "ＩＮＶＯＩＣＥ", description: "Bills again." },
    ]);

    const bill = await add(core, "Bill.txt", "Invoice 2026-14. Amount due: 300.");
    await waitForTagging(core, [bill.id]);

    expect(await tagNamesOf(core, bill.id)).toEqual([invoice.name]);
    expect((await core.listTags()).length).toBe(before);
  });

  test("a Tag the User took off or deleted doesn't come back by name", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    tagging.name([{ name: "Kitchen", description: "The kitchen." }]);
    const quote = await add(core, "Quote.txt", "Countertop quote.");
    await waitForTagging(core, [quote.id]);
    const kitchen = await tagNamed(core, "Kitchen");

    await core.removeTagFromDocuments([quote.id], kitchen.id);
    tagging.name([{ name: "kitchen", description: "Again." }]);
    await core.retagDocuments([quote.id]);
    await waitForTagging(core, [quote.id]);
    expect(await tagNamesOf(core, quote.id)).toEqual([]);

    await core.deleteTag(kitchen.id);
    const tiles = await add(core, "Tiles.txt", "Tile samples.");
    await waitForTagging(core, [tiles.id]);
    expect(await tagNamesOf(core, tiles.id)).toEqual([]);
    expect(await tagNames(core)).not.toContain("Kitchen");
  });

  test("a Document gets at most three Tags, those chosen first, and a long name is no Tag", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    tagging.choose(["Report", "Notes"]);
    tagging.name([
      { name: "A name far too long to be any sort of Tag", description: "" },
      { name: "Budget", description: "Money planned." },
      { name: "Planning", description: "Plans." },
    ]);
    const budget = await add(core, "Budget report.txt", "Report and notes on the budget.");
    await waitForTagging(core, [budget.id]);
    expect(await tagNamesOf(core, budget.id)).toEqual(["Budget", "Notes", "Report"]);
    expect(await tagNames(core)).not.toContain("Planning");

    tagging.choose(["Report", "Notes", "Paper", "Book"]);
    tagging.name([{ name: "Reading", description: "Things to read." }]);
    const many = await add(core, "Reading list.txt", "A report, notes, a paper and a book.");
    await waitForTagging(core, [many.id]);
    expect(await tagNamesOf(core, many.id)).toEqual(["Notes", "Paper", "Report"]);
    expect(await tagNames(core)).not.toContain("Reading");
  });

  test("past sixty Tags no new one is made, and the ones that exist still apply", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    for (let at = (await core.listTags()).length; at < 60; at++) {
      await core.createTag({ name: `Topic ${at}`, description: "" });
    }
    tagging.choose(["Report"]);
    tagging.name([{ name: "Budget", description: "Money planned." }]);

    const document = await add(core, "Budget report.txt", "A report on the budget.");
    await waitForTagging(core, [document.id]);

    expect(await tagNamesOf(core, document.id)).toEqual(["Report"]);
    expect(await tagNames(core)).not.toContain("Budget");
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
    });
    const document = await add(core, "Report.txt", "A quarterly report.");
    await waitForTagging(core, [document.id]);

    expect((await core.getLibrary()).settings.automatic).toBe(true);
    expect(await tagNamesOf(core, document.id)).toEqual(["Report"]);
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
});
