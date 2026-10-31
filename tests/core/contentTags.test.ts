/**
 * Tags named from what the Documents say (#2308): the chat model chooses the Tags that exist
 * where they fit and names new ones where none does. A new Tag is made once and found again by
 * its name however it is written; the User's own decisions, and the Tags they deleted, stay
 * theirs; a Document gets at most three. And choosing a cloud model for Tags turns tagging on.
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

  test("a Chinese Document is offered only the Tags in Chinese, and gets one of its own", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    await core.createTag({ name: "NDA", description: "A non-disclosure agreement." });
    tagging.choose(["Kitchen renovation"]);
    tagging.name((request) =>
      request.text.includes("橱柜")
        ? [{ name: "厨房装修", description: "厨房翻新的预算、报价和笔记。" }]
        : [{ name: "Kitchen renovation", description: "The kitchen remodel." }],
    );

    const quote = await add(core, "Cabinet quote.txt", "Quote for 14 shaker cabinets: 6,000.");
    await waitForTagging(core, [quote.id]);
    const budget = await add(
      core,
      "厨房装修预算.txt",
      "橱柜 45,000 元，台面 24,000 元，瓷砖 6,000 元，合计 75,000 元。",
    );
    await waitForTagging(core, [budget.id]);
    const offered = tagging.requests.at(-1)?.names;
    const tiles = await add(core, "Tile notes.txt", "Notes on the tiles for the kitchen.");
    await waitForTagging(core, [tiles.id]);

    expect(await tagNamesOf(core, budget.id)).toEqual(["厨房装修"]);
    expect(offered).toContain("NDA");
    expect(offered).not.toContain("Kitchen renovation");
    expect(offered).not.toContain("Invoice");
    expect(await tagNamesOf(core, tiles.id)).toEqual(["Kitchen renovation"]);
    expect(tagging.requests.at(-1)?.names).toContain("Kitchen renovation");
    expect(tagging.requests.at(-1)?.names).not.toContain("厨房装修");
    expect(await tagNames(core)).toContain("Kitchen renovation");
  });

  test("an order is not an Invoice, chosen or named, while a VAT invoice and a receipt are", async () => {
    const tagging = taggingModel(["发票"]);
    const models = scriptedModels(tagging.model);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: models.createChatModel,
      systemLanguages: () => ["zh-CN"],
    });
    await core.saveChatProvider(LOCAL);
    tagging.name((request) =>
      request.text.includes("麻辣香锅")
        ? [
            { name: "外卖订单", description: "外卖平台的点餐记录。" },
            { name: "发票", description: "账单。" },
          ]
        : [],
    );

    const order = await add(
      core,
      "外卖订单.txt",
      "麻辣香锅外卖。订单号 6021 8833。宫保鸡丁 1 份 32 元，米饭 2 份 4 元，配送费 3 元。实付 39 元，已用微信支付。",
    );
    const vat = await add(
      core,
      "打印机维修.txt",
      "增值税电子普通发票。发票号码 0442 1187。购买方：周宁。项目：打印机维修，金额 194.17 元，税额 5.83 元，价税合计 200.00 元。",
    );
    const receipt = await add(
      core,
      "停车费.txt",
      "城东停车场 收据。车牌 浙A·3K921。停车 3 小时，合计 15 元。现金已收。",
    );
    await waitForTagging(core, [order.id, vat.id, receipt.id]);

    expect(await tagNamesOf(core, order.id)).toEqual(["外卖订单"]);
    expect(await tagNamesOf(core, vat.id)).toEqual(["发票"]);
    expect(await tagNamesOf(core, receipt.id)).toEqual(["发票"]);
  });

  test("an order whose only Tag was Invoice gets another from a second request, which doesn't offer Invoice", async () => {
    const { core, tagging } = await start();
    await core.saveChatProvider(LOCAL);
    tagging.choose((request) => (request.names.includes("Invoice") ? ["Invoice"] : []));
    tagging.name((request) =>
      request.names.includes("Invoice")
        ? []
        : [{ name: "Takeaway orders", description: "Food ordered for delivery." }],
    );

    const order = await add(
      core,
      "Golden Wok order.txt",
      "Golden Wok takeaway. Order 6021. Kung pao chicken 1 x 12.00, rice 2 x 2.00, delivery 3.00. Paid 19.00 by card.",
    );
    await waitForTagging(core, [order.id]);
    const [first, second, ...more] = tagging.requests;
    const vat = await add(
      core,
      "Printer repair.txt",
      "VAT invoice 0442-1187. Buyer: Zhou Ning. Printer repair 194.17, VAT 5.83, total 200.00.",
    );
    await waitForTagging(core, [vat.id]);

    expect(await tagNamesOf(core, order.id)).toEqual(["Takeaway orders"]);
    expect(more).toEqual([]);
    expect(first?.names).toContain("Invoice");
    expect(first?.text).not.toContain("not a bill or a receipt");
    expect(second?.names).not.toContain("Invoice");
    expect(second?.text).toContain("not a bill or a receipt");
    expect(await tagNamesOf(core, vat.id)).toEqual(["Invoice"]);
    expect(tagging.requests).toHaveLength(3);
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
