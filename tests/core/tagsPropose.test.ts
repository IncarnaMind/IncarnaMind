/**
 * Every Tag the AI proposes waits in the Review until the User confirms it (#2339): tagging new
 * Documents in the background, the User's Re-tag and Organize's run. A kind is kept as the kind
 * and shown in the interface's language; a request is sent the kinds and the User's own Tags
 * only; a new topic is proposed only when 3 Documents of a run share it. Through the core's public
 * interface, with scripted models.
 */
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core, Document, SaveChatProviderInput } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModel, scriptedModels } from "../helpers/models";
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

/** A provider's reply to a request that isn't streamed, carrying `value` as JSON. */
const reply = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  finishReason: { unified: "stop" as const, raw: undefined },
  warnings: [],
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
});

/**
 * A core on a cloud model with Organize and tagging allowed, and nothing tagged in the
 * background, with these Documents added.
 */
async function cloudCore(model: MockLanguageModelV4, files: readonly [string, string][]) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
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
  const documents = await addAndProcess(
    core,
    await Promise.all(files.map(([name, text]) => writeSourceFile(sources, name, text))),
  );
  return { core, documents };
}

/**
 * Plans every Document into one new Folder, "Leases", or into none (`folders: false`), and tags
 * each with `kindOf` its name, counting the tag requests. The plan's reply waits for `planHeld`,
 * and with `planRefused` it is a refused key.
 */
function planAndTag({
  folders = true,
  kindOf = (_name: string) => "contract",
  planHeld = Promise.resolve(),
  planRefused = false,
  tagsRefused = false,
}: {
  folders?: boolean;
  kindOf?: (name: string) => string;
  planHeld?: Promise<void>;
  planRefused?: boolean;
  tagsRefused?: boolean;
} = {}) {
  let tagRequests = 0;
  const isPlan = (call: LanguageModelV4CallOptions) =>
    call.responseFormat?.type === "json" &&
    (call.responseFormat.schema as { properties?: Record<string, unknown> } | undefined)?.properties
      ?.folders !== undefined;
  /** What it answers a request that isn't streamed: a plan, placements or Tags. */
  const answer = (call: LanguageModelV4CallOptions): unknown => {
    const schema = (
      call.responseFormat?.type === "json" ? call.responseFormat.schema : undefined
    ) as { properties?: Record<string, unknown> } | undefined;
    let data: { documents?: { ref: string; name: string }[] };
    try {
      data = JSON.parse(userText(call)) as typeof data;
    } catch {
      return { tags: [] };
    }
    const documents = data.documents ?? [];
    if (isPlan(call))
      return {
        folders: folders ? [{ key: "N1", name: "Leases", description: "Leases" }] : [],
        documents: documents.map((doc) => ({ ref: doc.ref, folder: folders ? "N1" : "none" })),
      };
    if (schema?.properties?.placements)
      return { placements: documents.map((doc) => ({ ref: doc.ref, folder: "none" })) };
    tagRequests++;
    return {
      tagged: documents.map((doc) => ({
        ref: doc.ref,
        kind: kindOf(doc.name),
        tags: [],
        topic: { name: "", description: "" },
      })),
    };
  };
  const refused = () =>
    new APICallError({
      message: "Invalid API key.",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    });
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      const schema = (
        call.responseFormat?.type === "json" ? call.responseFormat.schema : undefined
      ) as { properties?: Record<string, unknown> } | undefined;
      if (tagsRefused && schema?.properties?.tagged) throw refused();
      if (isPlan(call)) {
        await planHeld;
        if (planRefused) throw refused();
      }
      return reply(answer(call));
    },
  });
  return { model, answer, requests: () => tagRequests };
}

describe("With no Folder existing or proposed (#2339)", () => {
  /**
   * Five unrelated Documents, no Folders, and a plan that proposes none. With `assistant`, the
   * assistant runs Organize when asked.
   */
  async function apart(
    kindOf: (name: string) => string,
    {
      planHeld,
      planRefused,
      tagsRefused,
      folders = false,
      assistant = false,
    }: {
      planHeld?: Promise<void>;
      planRefused?: boolean;
      tagsRefused?: boolean;
      folders?: boolean;
      assistant?: boolean;
    } = {},
  ) {
    const scripted = planAndTag({ folders, kindOf, planHeld, planRefused, tagsRefused });
    const model = assistant
      ? scriptedModel(
          (call) =>
            call.results.some((each) => each.tool === "run_command")
              ? { text: "Done." }
              : { calls: [{ tool: "run_command", input: { command: "documents.organize" } }] },
          { generate: ({ options }) => ({ text: JSON.stringify(scripted.answer(options)) }) },
        )
      : scripted.model;
    const { core, documents } = await cloudCore(model, [
      ["Lease.txt", "Lease of the Harbour Street office."],
      ["Marathon.txt", "Week six of marathon training."],
      ["Tomatoes.txt", "Tomatoes and beans in the garden."],
      ["Violin.txt", "Scales to practise on the violin."],
      ["Bread.txt", "A sourdough loaf, proved overnight."],
    ]);
    return { core, documents, scripted };
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

  /** Each Document's tagging, by its name. */
  const taggingOf = async (core: Core) =>
    Object.fromEntries((await core.listDocuments()).map((each) => [each.name, each.tagging]));

  /** Settles once the run's Tags are answered and all that follows from them has run. */
  const tagsAnswered = (core: Core, requests: () => number) =>
    new Promise<void>((resolve) => {
      const off = core.on("organize.progress", () => {
        if (requests() === 0) return;
        off();
        setImmediate(resolve);
      });
    });

  // protects=Stop keeps nothing: a run stopped while its plan waits, its Tags already answered, marks no Document tagged, so tagging in the background still proposes theirs; fails_when=those Documents read tagged with nothing of theirs in the Review; no_claim=what a run that isn't stopped proposes.
  test("stopped while its plan waits, it marks no Document tagged, and a run after it does", async () => {
    let release: () => void = () => undefined;
    const planHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, scripted } = await apart(() => "contract", { planHeld });
    const before = await taggingOf(core);
    expect(Object.values(before)).toHaveLength(5);
    expect(Object.values(before)).not.toContain("tagged");

    const answered = tagsAnswered(core, scripted.requests);
    const run = core.organizeLibrary();
    await answered;
    await core.stopOrganizeLibrary();
    release();

    expect(await run).toMatchObject({ status: "stopped" });
    expect(await taggingOf(core)).toEqual(before);
    expect((await core.getOrganizeReview()).items).toEqual([]);

    expect(await core.organizeLibrary()).toMatchObject({ status: "done" });
    expect(Object.values(await taggingOf(core))).toEqual(Array(5).fill("tagged"));
  });

  // protects=a plan that fails ends the run with nothing kept: its Documents aren't marked tagged though their Tags were answered, so tagging in the background still proposes them; fails_when=a failed run leaves its Documents tagged with nothing in the Review; no_claim=the words the failure shows.
  test("a plan that fails marks no Document tagged", async () => {
    let release: () => void = () => undefined;
    const planHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { core, scripted } = await apart(() => "contract", { planHeld, planRefused: true });
    const before = await taggingOf(core);
    expect(Object.values(before)).toHaveLength(5);
    expect(Object.values(before)).not.toContain("tagged");

    const answered = tagsAnswered(core, scripted.requests);
    const run = core.organizeLibrary();
    await answered;
    release();

    await expect(run).rejects.toThrow();
    expect(await taggingOf(core)).toEqual(before);
    expect((await core.getOrganizeReview()).items).toEqual([]);
  });

  // protects=a tagging step that fails inside Organize reaches the User in the run's result, its Folders still proposed and its Documents left untagged for the next run; fails_when=the failure is only logged, or its Documents read tagged with no Tags waiting; no_claim=the words the line shows.
  test("a tagging step that fails says so, proposes the Folders, and marks no Document tagged", async () => {
    const { core } = await apart(() => "contract", { folders: true, tagsRefused: true });
    const before = await taggingOf(core);
    expect(Object.values(before)).not.toContain("tagged");

    const result = await core.organizeLibrary();

    expect(result).toMatchObject({ status: "done", taggingFailed: "Invalid API key." });
    expect(await taggingOf(core)).toEqual(before);
    const review = await core.getOrganizeReview();
    expect(review.folders.map((folder) => folder.name)).toEqual(["Leases"]);
    expect(review.items.flatMap((item) => item.tags)).toEqual([]);
  });

  // protects=the assistant's Organize that proposes Tags and no Folder has an Undo that takes its Tags back out of the Review; fails_when=its Undo is missing and the Tags stay; no_claim=the reply's words.
  test("from the assistant, an Organize that proposes only Tags is taken back by its Undo", async () => {
    const { core } = await apart((name) => (name === "Lease" ? "contract" : "none"), {
      assistant: true,
    });
    core.on("approval.requested", (request) => {
      void core.respondToApproval(request.requestId, "allow-once");
    });
    const mind = await core.createMind({ title: "Tides" });

    const answer = await askAssistant(core, { text: "Sort my Documents.", mindId: mind.id });
    const run = answer.toolCalls.find((call) => call.command)?.command?.run;
    if (!run) throw new Error("No command ran.");
    const review = await core.getOrganizeReview();
    expect(review.folders).toEqual([]);
    expect(review.items.flatMap((item) => item.tags.map((tag) => tag.name))).toEqual(["Contract"]);

    await core.undoCommands(run);
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

describe("A tagging run that meets a refused key (#2339)", () => {
  // protects=a refused key ends a Re-tag: the requests already out finish, and no further batch is sent to the service that refused it; fails_when=the other workers go on sending batches after the refusal; no_claim=the words the failure shows.
  test("the requests already sent finish, and no other is sent", async () => {
    let sent = 0;
    let answered = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doGenerate: async (call) => {
        sent++;
        if (sent === 1)
          throw new APICallError({
            message: "Invalid API key.",
            url: "https://api.anthropic.com/v1/messages",
            requestBodyValues: {},
            statusCode: 401,
            isRetryable: false,
          });
        await held;
        const data = JSON.parse(userText(call)) as { documents: { ref: string }[] };
        answered++;
        return reply({
          tagged: data.documents.map((doc) => ({
            ref: doc.ref,
            kind: "report",
            tags: [],
            topic: { name: "", description: "" },
          })),
        });
      },
    });
    // 31 Documents are 4 requests of 10, 3 sent at once.
    const files = Array.from(
      { length: 31 },
      (_, at) =>
        [`Report ${at + 1}.txt`, `Quarterly report ${at + 1} on sales.`] as [string, string],
    );
    const { core, documents } = await cloudCore(model, files);

    await expect(
      core.tagDocuments({ documentIds: documents.map((each) => each.id) }),
    ).rejects.toThrow();
    expect(sent).toBe(3);
    release();
    await vi.waitFor(() => expect(answered).toBe(2));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toBe(3);
  });
});
