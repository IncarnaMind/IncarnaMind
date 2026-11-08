/**
 * Every Tag the AI proposes waits in the Review until the User confirms it (#2339): tagging new
 * Documents in the background, the User's Re-tag and Organize's run. A kind is kept as the kind
 * and shown in the interface's language; a request is sent the kinds and the User's own Tags
 * only; a new topic is proposed only when 3 Documents of a run share it. Through the core's public
 * interface, with scripted models.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, SaveChatProviderInput } from "../../src/core";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { proposedTagNamesOf, taggingModel, tagNamesOf, waitForTagging } from "../helpers/tags";

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};
const DAY = 24 * 60 * 60 * 1000;

async function start(chosen: readonly string[] = ["Report"]) {
  const tagging = taggingModel(chosen);
  const clock = manualClock();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(tagging.model).createChatModel,
    now: clock.now,
  });
  await core.saveChatProvider(LOCAL);
  const sources = await createSourceFolder();
  const add = async (name: string, text: string): Promise<Document> => {
    const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
    if (!document) throw new Error(`Nothing was added for ${name}.`);
    return document;
  };
  return { core, tagging, clock, add };
}

const confirmAll = async (core: Core) => {
  const review = await core.getOrganizeReview();
  return core.confirmOrganizeReview(review.items.map((item) => item.id));
};

describe("Tags wait in the Review (#2339)", () => {
  test("a new Document's kind waits in the Review, on no Document until Confirm, and Undo takes it off", async () => {
    const { core, add } = await start(["Report"]);
    const report = await add("Q1.txt", "Quarterly report on sales by region.");
    await waitForTagging(core, [report.id]);

    expect(await tagNamesOf(core, report.id)).toEqual([]);
    expect(await proposedTagNamesOf(core, report.id)).toEqual(["Report"]);
    const review = await core.getOrganizeReview();
    expect(review.items[0]?.placement).toEqual({ kind: "unchanged" });

    const confirmation = await confirmAll(core);
    expect(await tagNamesOf(core, report.id)).toEqual(["Report"]);
    expect((await core.getOrganizeReview()).items).toEqual([]);

    if (!confirmation) throw new Error("Nothing was confirmed.");
    await core.undoOrganizeReviewConfirmation(confirmation.id);
    expect(await tagNamesOf(core, report.id)).toEqual([]);
    expect(await proposedTagNamesOf(core, report.id)).toEqual(["Report"]);
  });

  test("a kind's Tag is the kind: one Tag in either language, renamed when the language changes", async () => {
    const { core, add } = await start(["Meeting notes"]);
    const english = await add("Sync.txt", "Weekly sync. Present: Ana, Ben. Decided: ship Friday.");
    const chinese = await add("周会.txt", "周会记录。参会：张三、李四。决定：周五发布。");
    await waitForTagging(core, [english.id, chinese.id]);
    const seeded = (await core.listTags()).find((tag) => tag.kind === "meeting-notes");
    const waiting = (await core.getOrganizeReview()).items.flatMap((item) => item.tags);
    expect(waiting.map((tag) => [tag.kind, tag.tagId, tag.name])).toEqual([
      ["meeting-notes", seeded?.id, "Meeting notes"],
      ["meeting-notes", seeded?.id, "Meeting notes"],
    ]);

    await confirmAll(core);
    const made = (await core.listTags()).filter((tag) => tag.kind === "meeting-notes");
    expect(made.map((tag) => tag.name)).toEqual(["Meeting notes"]);
    expect(await tagNamesOf(core, chinese.id)).toEqual(["Meeting notes"]);

    await core.updateSettings({ user: { language: "zh-CN" } });
    expect(await tagNamesOf(core, english.id)).toEqual(["会议记录"]);
    expect((await core.listTags()).find((tag) => tag.kind === "meeting-notes")?.name).toBe(
      "会议记录",
    );
  });

  test("a kind's Tag the User renamed keeps their name in every language", async () => {
    const { core, add } = await start(["Contract"]);
    const lease = await add("Lease.txt", "Lease agreement for the Harbour Street office.");
    await waitForTagging(core, [lease.id]);
    await confirmAll(core);
    const contract = (await core.listTags()).find((tag) => tag.kind === "contract");
    if (!contract) throw new Error("No Contract Tag.");

    await core.updateTag(contract.id, { name: "Agreements" });
    await core.updateSettings({ user: { language: "zh-CN" } });

    expect((await core.listTags()).find((tag) => tag.id === contract.id)).toMatchObject({
      name: "Agreements",
      kind: "contract",
    });
  });

  test("a request is sent the kinds and the User's own Tags it may get, never every Tag made so far", async () => {
    const { core, tagging, add } = await start([]);
    const kitchen = await core.createTag({ name: "Kitchen renovation", description: "" });
    const quote = await add("Quote.txt", "Countertop quote for the kitchen renovation.");
    const race = await add("Race.txt", "Marathon training plan, week six.");
    await waitForTagging(core, [quote.id, race.id]);

    const sent = tagging.requests.map((request) => request.names);
    // Every kind, by its English name, and the User's Tag only where the Document is about it.
    expect(sent[0]).toContain("Contract");
    expect(sent[0]).toContain(kitchen.name);
    expect(sent[1]).toContain("Contract");
    expect(sent[1]).not.toContain(kitchen.name);
    // The preset Tags go as kinds, never as Tags of their own.
    for (const names of sent) expect(names.filter((name) => name === "Paper")).toHaveLength(1);
  });

  test("a kind whose Tag the User deleted isn't sent while it waits in Recently deleted", async () => {
    const { core, tagging, add } = await start([]);
    const invoice = (await core.listTags()).find((tag) => tag.kind === "invoice");
    if (!invoice) throw new Error("No Invoice Tag.");
    await core.deleteTag(invoice.id);
    const bill = await add("Bill.txt", "Invoice 4471 for pilot boat services.");
    await waitForTagging(core, [bill.id]);

    expect(tagging.requests.at(-1)?.names).toContain("Contract");
    expect(tagging.requests.at(-1)?.names).not.toContain("Invoice");
  });

  test("the background never names a new topic Tag for one Document", async () => {
    const { core, tagging, add } = await start(["Report"]);
    tagging.name([{ name: "Kitchen renovation", description: "The kitchen." }]);
    const quote = await add("Quote.txt", "Countertop quote for the kitchen renovation.");
    await waitForTagging(core, [quote.id]);

    expect(await proposedTagNamesOf(core, quote.id)).toEqual(["Report"]);
  });

  test("a Tag the User took off in the Review isn't proposed again for 30 days", async () => {
    const { core, clock, add } = await start(["Report"]);
    const report = await add("Q1.txt", "Quarterly report on sales by region.");
    await waitForTagging(core, [report.id]);
    const [item] = (await core.getOrganizeReview()).items;
    const [tag] = item?.tags ?? [];
    if (!item || !tag) throw new Error("Nothing waits.");
    await core.editOrganizeReview({ kind: "removeTag", itemId: item.id, tagRowId: tag.id });
    await confirmAll(core);
    expect(await tagNamesOf(core, report.id)).toEqual([]);

    expect(await core.tagDocuments({ documentIds: [report.id] })).toMatchObject({
      status: "done",
    });
    expect(await proposedTagNamesOf(core, report.id)).toEqual([]);

    clock.advance(31 * DAY);
    await core.tagDocuments({ documentIds: [report.id] });
    expect(await proposedTagNamesOf(core, report.id)).toEqual(["Report"]);
  });

  test("the User's own Tags stand: one they took off a Document is never proposed for it", async () => {
    const { core, add } = await start(["Report"]);
    const report = await add("Q1.txt", "Quarterly report on sales by region.");
    await waitForTagging(core, [report.id]);
    await confirmAll(core);
    const [link] = (await core.listDocuments()).find((each) => each.id === report.id)?.tags ?? [];
    if (!link) throw new Error("No Tag.");
    await core.removeDocumentTag(report.id, link.tagId);

    await core.tagDocuments({ documentIds: [report.id] });

    expect(await proposedTagNamesOf(core, report.id)).toEqual([]);
    expect(await tagNamesOf(core, report.id)).toEqual([]);
  });
});

describe("Re-tag is a run whose Tags wait in the Review (#2339)", () => {
  test("it proposes only what the Document doesn't carry, never takes one off, and leaves out what gets nothing", async () => {
    const { core, tagging, add } = await start(["Report"]);
    const report = await add("Q1.txt", "Quarterly report on sales by region.");
    const note = await add("Garden.txt", "Plant tomatoes along the south fence.");
    await waitForTagging(core, [report.id, note.id]);
    await confirmAll(core);
    tagging.choose((request) => (request.text.includes("tomatoes") ? [] : ["Report", "Paper"]));

    expect(await core.tagDocuments()).toMatchObject({ status: "done", documents: 2 });

    // The kind it has stays; one kind a Document, so nothing new for the report.
    expect(await tagNamesOf(core, report.id)).toEqual(["Report"]);
    const review = await core.getOrganizeReview();
    const left = review.items.find((item) => item.documentId === note.id);
    expect(left?.placement).toEqual({ kind: "leftOut", leftOut: { reason: "noTag" } });
  });

  test("a new topic is proposed where 3 Documents of the run share it, and at most 3 a run", async () => {
    const { core, tagging, add } = await start([]);
    const topics = ["Kitchen", "Marathon", "Garden", "Wedding"];
    const documents: Document[] = [];
    for (const topic of topics)
      for (const at of [1, 2, 3])
        documents.push(await add(`${topic} ${at}.txt`, `${topic} notes, part ${at}.`));
    documents.push(await add("Lone.txt", "Lone notes on a boat."));
    await waitForTagging(
      core,
      documents.map((each) => each.id),
    );
    tagging.name((request) => {
      const named = [...topics, "Lone"].find((topic) => request.text.includes(`${topic} notes`));
      return named ? [{ name: `${named} plans`, description: `${named}.` }] : [];
    });

    await core.tagDocuments();

    const review = await core.getOrganizeReview();
    const names = new Set(review.items.flatMap((item) => item.tags.map((tag) => tag.name)));
    expect(names.size).toBe(3);
    for (const name of names) {
      expect(["Kitchen plans", "Marathon plans", "Garden plans", "Wedding plans"]).toContain(name);
      expect(
        review.items.filter((item) => item.tags.some((tag) => tag.name === name)),
      ).toHaveLength(3);
    }
  });

  test("Stop keeps nothing", async () => {
    const { core, tagging, add } = await start(["Report"]);
    const report = await add("Q1.txt", "Quarterly report on sales by region.");
    await waitForTagging(core, [report.id]);
    const before = await core.getOrganizeReview();
    tagging.hold();

    const run = core.tagDocuments({ documentIds: [report.id] });
    await tagging.requested(2);
    await core.stopOrganizeLibrary();
    tagging.release();

    expect(await run).toMatchObject({ status: "stopped" });
    expect(await core.getOrganizeReview()).toEqual(before);
  });
});

const userText = (options: LanguageModelV4CallOptions) =>
  options.prompt
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("\n");

/** A model that plans one new Folder for every Document and tags each a Report, counting the tag requests. */
/**
 * Plans every Document into one new Folder, "Leases", or into none (`folders: false`), and tags
 * each with `kindOf` its name.
 */
function planAndTag({
  folders = true,
  kindOf = (_name: string) => "contract",
}: {
  folders?: boolean;
  kindOf?: (name: string) => string;
} = {}) {
  let tagRequests = 0;
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
      const data = JSON.parse(userText(call)) as { documents: { ref: string; name: string }[] };
      if (schema?.properties?.folders)
        return reply({
          folders: folders ? [{ key: "N1", name: "Leases", description: "Leases" }] : [],
          documents: data.documents.map((doc) => ({
            ref: doc.ref,
            folder: folders ? "N1" : "none",
          })),
        });
      if (schema?.properties?.placements)
        return reply({
          placements: data.documents.map((doc) => ({ ref: doc.ref, folder: "none" })),
        });
      tagRequests++;
      return reply({
        tagged: data.documents.map((doc) => ({
          ref: doc.ref,
          kind: kindOf(doc.name),
          tags: [],
          topic: { name: "", description: "" },
        })),
      });
    },
  });
  return { model, requests: () => tagRequests };
}

describe("With no Folder existing or proposed (#2339)", () => {
  /** Five unrelated Documents, no Folders, and a plan that proposes none. */
  async function apart(kindOf: (name: string) => string) {
    const scripted = planAndTag({ folders: false, kindOf });
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(scripted.model).createChatModel,
    });
    const provider = await core.saveChatProvider(ANTHROPIC);
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: ANTHROPIC.modelId },
      },
      automatic: false,
    });
    const route = await core.getTaggingRoute("classification");
    if (route.where !== "cloud") throw new Error("Expected Organize to send to a service.");
    await core.allowDataFlow("classification", route.service.id);
    await core.allowDataFlow("tagging", route.service.id);
    const sources = await createSourceFolder();
    const documents = await addAndProcess(core, [
      await writeSourceFile(sources, "Lease.txt", "Lease of the Harbour Street office."),
      await writeSourceFile(sources, "Marathon.txt", "Week six of marathon training."),
      await writeSourceFile(sources, "Tomatoes.txt", "Tomatoes and beans in the garden."),
      await writeSourceFile(sources, "Violin.txt", "Scales to practise on the violin."),
      await writeSourceFile(sources, "Bread.txt", "A sourdough loaf, proved overnight."),
    ]);
    return { core, documents };
  }

  test("a Document left out is too few like it for a Folder, and the Tags proposed wait alone", async () => {
    const { core, documents } = await apart((name) => (name === "Lease" ? "contract" : "none"));

    expect(await core.organizeLibrary()).toMatchObject({ status: "done", documents: 5 });

    const review = await core.getOrganizeReview();
    expect(review.folders).toEqual([]);
    const lease = documents.find((each) => each.name === "Lease");
    const leaseItem = review.items.find((item) => item.documentId === lease?.id);
    expect(leaseItem?.placement).toEqual({ kind: "unchanged" });
    expect(leaseItem?.tags.map((tag) => tag.name)).toEqual(["Contract"]);
    const left = review.items.filter((item) => item.documentId !== lease?.id);
    expect(left.map((item) => item.placement)).toEqual(
      Array(4).fill({ kind: "leftOut", leftOut: { reason: "tooFew" } }),
    );
    expect(review.count).toBe(1);
  });

  test("a run that proposes nothing, no Folder and no Tag, writes nothing to the Review", async () => {
    const { core } = await apart(() => "none");

    expect(await core.organizeLibrary()).toMatchObject({
      status: "done",
      documents: 5,
      proposed: 0,
    });

    expect((await core.getOrganizeReview()).items).toEqual([]);
  });

  test("a Re-tag that proposes no Tag writes nothing to the Review", async () => {
    const { core, documents } = await apart(() => "none");

    expect(
      await core.tagDocuments({ documentIds: documents.map((each) => each.id) }),
    ).toMatchObject({ status: "done", documents: 5, proposed: 0 });

    expect((await core.getOrganizeReview()).items).toEqual([]);
  });
});

describe("Organize's run proposes its Tags before its Review opens (#2339)", () => {
  async function organizing(tagging: "allowed" | "taken back" | "never") {
    const scripted = planAndTag();
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(scripted.model).createChatModel,
    });
    const provider = await core.saveChatProvider(ANTHROPIC);
    await core.saveLibrarySettings({
      classifier: {
        kind: "chat",
        choice: { providerId: provider.id, modelId: ANTHROPIC.modelId },
      },
      automatic: false,
    });
    const route = await core.getTaggingRoute("classification");
    if (route.where !== "cloud") throw new Error("Expected Organize to send to a service.");
    await core.allowDataFlow("classification", route.service.id);
    if (tagging !== "never") await core.allowDataFlow("tagging", route.service.id);
    if (tagging === "taken back") await core.revokeConsent("tagging", route.service.id);
    const sources = await createSourceFolder();
    const leases = await addAndProcess(core, [
      await writeSourceFile(sources, "Lease 1.txt", "First lease, of unit one."),
      await writeSourceFile(sources, "Lease 2.txt", "Second lease, of unit two."),
      await writeSourceFile(sources, "Lease 3.txt", "Third lease, of unit three."),
    ]);
    return { core, leases, requests: scripted.requests };
  }

  test("with tagging allowed, its Review holds each Document's Folder and kind as it returns, in one tag request", async () => {
    const { core, leases, requests } = await organizing("allowed");

    expect(await core.organizeLibrary()).toMatchObject({ status: "done", documents: 3 });

    const review = await core.getOrganizeReview();
    for (const lease of leases) {
      const item = review.items.find((each) => each.documentId === lease.id);
      expect(item?.placement.kind).toBe("newFolder");
      expect(item?.tags.map((tag) => tag.name)).toEqual(["Contract"]);
      expect(await tagNamesOf(core, lease.id)).toEqual([]);
    }
    expect(requests()).toBe(1);
  });

  test.each([
    ["taken back", "taken back"],
    ["never allowed", "never"],
  ] as const)(
    "with tagging %s for the service, it proposes Folders and no Tags",
    async (_, tagging) => {
      const { core, leases, requests } = await organizing(tagging);

      expect(await core.organizeLibrary()).toMatchObject({ status: "done", documents: 3 });

      const review = await core.getOrganizeReview();
      expect(review.items).toHaveLength(3);
      for (const item of review.items) {
        expect(item.placement.kind).toBe("newFolder");
        expect(item.tags).toEqual([]);
      }
      expect(requests()).toBe(0);
      await vi.waitFor(async () => {
        for (const lease of leases) expect(await tagNamesOf(core, lease.id)).toEqual([]);
      });
    },
  );
});
