import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { APICallError } from "ai";
import { describe, expect, test } from "vitest";
import {
  type Core,
  type CoreAdapters,
  DATABASE_FILE,
  type Document,
  InvalidInputError,
  NotFoundError,
  type SaveChatProviderInput,
  type TestChatConnectionInput,
} from "../../src/core";
import { approximateTokens } from "../../src/core/documents/passages";
import { openDatabase } from "../../src/core/storage";
import {
  EXCERPT_END,
  EXCERPT_START,
  EXCERPT_TOKENS,
  excerptFromPassages,
} from "../../src/core/tags/classify";
import {
  createTempDataFolder,
  nextEvent,
  queryDatabase,
  startCore,
  tickingClock,
  turnOnAutomaticTagging,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  documentAt,
  linkAndProcess,
  writeSourceFile,
} from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { taggingModel, tagNamed, tagNamesOf, waitForTagging } from "../helpers/tags";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PRESETS_EN = ["Book", "Contract", "Invoice", "Notes", "Paper", "Report", "Slides"];
const PRESETS_ZH = ["书籍", "合同", "幻灯片", "发票", "报告", "笔记", "论文"];

const PAPER_TEXT = `Attention Is All You Need

Abstract. The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose a new simple network architecture, the Transformer,
based solely on attention mechanisms.`;

const OPENAI: SaveChatProviderInput & TestChatConnectionInput = {
  kind: "openai",
  apiKey: "sk-test-openai",
  modelId: "gpt-5.4-mini",
};
const OPENAI_SERVICE = { id: "https://api.openai.com", name: "OpenAI" };
const AT = "2026-09-01T09:00:00.000Z";
const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };

const names = (items: readonly { name: string }[]) => items.map((item) => item.name);
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

/** A core whose chat models all answer tagging requests with `chosen`. */
async function startTagging(
  chosen: string[] = [],
  dataDir?: string,
  overrides: Partial<CoreAdapters> = {},
) {
  const tagging = taggingModel(chosen);
  const models = scriptedModels(tagging.model);
  const core = startCore(dataDir ?? (await createTempDataFolder()), {
    createChatModel: models.createChatModel,
    ...overrides,
  });
  return { core, tagging, models };
}

/** Adds one text Document and waits until it is processed (ready). */
async function addDocument(core: Core, name: string, text: string): Promise<Document> {
  const sources = await createTempDataFolder();
  const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

/** Re-tags the Documents and waits until they are tagged again. */
async function retag(core: Core, documentIds: string[]): Promise<void> {
  await core.retagDocuments(documentIds);
  await waitForTagging(core, documentIds);
}

describe("Preset Tags", () => {
  test("the first run creates the preset Tags, in English on an English system", async () => {
    const core = startCore(await createTempDataFolder(), {
      now: () => new Date("2026-10-06T12:00:00Z"),
    });

    const tags = await core.listTags();

    expect(names(tags)).toEqual(PRESETS_EN);
    for (const tag of tags) {
      expect(tag).toEqual({
        id: expect.stringMatching(UUID_V4),
        name: tag.name,
        description: expect.stringMatching(/\w{4,}.*\./),
        preset: true,
        colour: expect.any(String),
        createdAt: "2026-10-06T12:00:00.000Z",
        updatedAt: "2026-10-06T12:00:00.000Z",
      });
    }
    expect((await tagNamed(core, "Paper")).description).toMatch(/research or academic paper/);
  });

  test("on a Chinese system they are created in Chinese", async () => {
    const core = startCore(await createTempDataFolder(), {
      systemLanguages: () => ["zh-Hans-CN", "en-US"],
    });

    const tags = await core.listTags();

    expect(names(tags).sort()).toEqual([...PRESETS_ZH].sort());
    expect(tags.find((tag) => tag.name === "论文")?.description).toMatch(/学术论文/);
    expect(tags.every((tag) => tag.preset)).toBe(true);
  });

  test("they keep the language they were created in, and aren't created again once deleted", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    await first.updateSettings({ user: { language: "zh-CN" } });
    expect(names(await first.listTags())).toEqual(PRESETS_EN);
    for (const tag of await first.listTags()) await first.deleteTag(tag.id);
    first.close();

    const second = startCore(dataDir, { systemLanguages: () => ["zh-CN"] });

    expect(await second.listTags()).toEqual([]);
  });
});

describe("Managing Tags", () => {
  test("creating a Tag returns it with a random UUID and trimmed text, and pushes the list", async () => {
    const core = startCore(await createTempDataFolder(), {
      now: () => new Date("2026-10-06T12:00:00Z"),
    });
    const changed = nextEvent(core, "tags.changed");

    const tag = await core.createTag({
      name: "  Quarterly  ",
      description: "  Covers one quarter of a year. ",
    });

    expect(tag).toEqual({
      id: expect.stringMatching(UUID_V4),
      name: "Quarterly",
      description: "Covers one quarter of a year.",
      preset: false,
      // The one colour no preset has.
      colour: "teal",
      createdAt: "2026-10-06T12:00:00.000Z",
      updatedAt: "2026-10-06T12:00:00.000Z",
    });
    expect(await changed).toEqual(await core.listTags());
    expect(names(await core.listTags())).toEqual([
      "Book",
      "Contract",
      "Invoice",
      "Notes",
      "Paper",
      "Quarterly",
      "Report",
      "Slides",
    ]);
    expect(await core.createTag({ name: "receipts" })).toMatchObject({ description: "" });
    // Name order ignores case.
    expect(names(await core.listTags()).indexOf("receipts")).toBe(6);
  });

  test("a Tag needs a name, and a name no other Tag has (ignoring case)", async () => {
    const core = startCore(await createTempDataFolder());

    await expect(core.createTag({ name: "   " })).rejects.toThrow(InvalidInputError);
    await expect(core.createTag({ name: "paper" })).rejects.toThrow(/already a Tag named “Paper”/);
    await expect(core.createTag({ name: 42 } as never)).rejects.toThrow(InvalidInputError);
    await expect(core.createTag({ name: "x".repeat(101) })).rejects.toThrow(InvalidInputError);
    await expect(core.createTag({ name: "Fine", description: 5 } as never)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.createTag("Paper" as never)).rejects.toThrow(InvalidInputError);
    expect(names(await core.listTags())).toEqual(PRESETS_EN);
  });

  test("editing a Tag changes its name or description, keeps it a preset, and moves its updatedAt", async () => {
    const core = startCore(await createTempDataFolder(), { now: tickingClock() });
    const paper = await tagNamed(core, "Paper");
    const changed = nextEvent(core, "tags.changed");

    const edited = await core.updateTag(paper.id, { description: "  Peer-reviewed only. " });

    expect(edited).toEqual({
      ...paper,
      description: "Peer-reviewed only.",
      updatedAt: edited.updatedAt,
    });
    expect(edited.updatedAt > paper.updatedAt).toBe(true);
    expect((await changed).find((tag) => tag.id === paper.id)).toEqual(edited);
    expect(await core.updateTag(paper.id, { name: "Research paper" })).toMatchObject({
      name: "Research paper",
      description: "Peer-reviewed only.",
      preset: true,
    });
    // Its own name in other case is fine; another Tag's name isn't.
    expect(await core.updateTag(paper.id, { name: "RESEARCH PAPER" })).toMatchObject({
      name: "RESEARCH PAPER",
    });
    await expect(core.updateTag(paper.id, { name: "report" })).rejects.toThrow(InvalidInputError);
    await expect(core.updateTag(paper.id, { name: " " })).rejects.toThrow(InvalidInputError);
    await expect(core.updateTag(paper.id, { colour: "crimson" } as never)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(core.updateTag(randomUUID(), { name: "Lost" })).rejects.toThrow(NotFoundError);
    expect((await tagNamed(core, "RESEARCH PAPER")).description).toBe("Peer-reviewed only.");
  });

  test("deleting a Tag is soft, takes it off every Document, and frees its name", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const paper = await tagNamed(core, "Paper");
    await core.addDocumentTag(document.id, paper.id);
    const tagsChanged = nextEvent(core, "tags.changed");
    const tagged = nextEvent(core, "documents.tagged");

    await core.deleteTag(paper.id);

    expect(ids(await tagsChanged)).not.toContain(paper.id);
    expect(await tagged).toEqual([expect.objectContaining({ id: document.id, tags: [] })]);
    expect(names(await core.listTags())).not.toContain("Paper");
    expect((await core.listDocuments())[0]?.tags).toEqual([]);
    expect(
      queryDatabase(dataDir, "SELECT deleted_at IS NOT NULL AS deleted FROM tags WHERE id = ?", [
        paper.id,
      ]),
    ).toEqual([{ deleted: 1 }]);
    expect(
      queryDatabase(
        dataDir,
        "SELECT deleted_at IS NOT NULL AS deleted FROM document_tags WHERE tag_id = ?",
        [paper.id],
      ),
    ).toEqual([{ deleted: 1 }]);
    await expect(core.deleteTag(paper.id)).rejects.toThrow(NotFoundError);
    await expect(core.updateTag(paper.id, { name: "Back" })).rejects.toThrow(NotFoundError);
    await expect(core.addDocumentTag(document.id, paper.id)).rejects.toThrow(NotFoundError);
    expect(await core.createTag({ name: "Paper" })).toMatchObject({ preset: false });
  });
});

describe("Tags the User sets", { timeout: 30_000 }, () => {
  test("the User adds and removes Tags on a Document, and each change is pushed", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const paper = await tagNamed(core, "Paper");
    const book = await tagNamed(core, "Book");

    const added = nextEvent(core, "documents.tagged");
    const withPaper = await core.addDocumentTag(document.id, paper.id);
    await core.addDocumentTag(document.id, book.id);

    const userTag = (tagId: string) => ({
      tagId,
      source: "user",
      confidence: null,
      needsReview: false,
    });
    expect(withPaper.tags).toEqual([userTag(paper.id)]);
    expect(await added).toEqual([withPaper]);
    // In Tag name order.
    expect((await core.listDocuments())[0]?.tags).toEqual([userTag(book.id), userTag(paper.id)]);
    // Adding it again changes nothing.
    expect((await core.addDocumentTag(document.id, paper.id)).tags).toHaveLength(2);

    const removed = nextEvent(core, "documents.tagged");
    const withoutPaper = await core.removeDocumentTag(document.id, paper.id);
    expect(withoutPaper.tags).toEqual([userTag(book.id)]);
    expect(await removed).toEqual([withoutPaper]);
    // The removal is kept, as a deleted link of the User's.
    expect(
      queryDatabase(
        dataDir,
        "SELECT source, deleted_at IS NOT NULL AS deleted FROM document_tags WHERE tag_id = ?",
        [paper.id],
      ),
    ).toEqual([{ source: "user", deleted: 1 }]);

    await expect(core.addDocumentTag(randomUUID(), paper.id)).rejects.toThrow(NotFoundError);
    await expect(core.addDocumentTag(document.id, randomUUID())).rejects.toThrow(NotFoundError);
    await expect(core.removeDocumentTag(document.id, "")).rejects.toThrow(InvalidInputError);
  });

  test("deleting a Document takes its Tags off with it", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await core.addDocumentTag(document.id, (await tagNamed(core, "Paper")).id);

    await core.deleteDocument(document.id);

    expect(
      queryDatabase(dataDir, "SELECT deleted_at IS NOT NULL AS deleted FROM document_tags"),
    ).toEqual([{ deleted: 1 }]);
    await expect(
      core.addDocumentTag(document.id, (await tagNamed(core, "Book")).id),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("Automatic tagging", { timeout: 30_000 }, () => {
  test("once a Document is embedded, the chat model chooses its Tags from the list, by structured output", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    let consentAsked = false;
    core.on("consent.requested", () => {
      consentAsked = true;
    });
    await core.saveChatProvider(LOCAL);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [tagged] = await waitForTagging(core, [document.id]);

    const paper = await tagNamed(core, "Paper");
    expect(tagged).toMatchObject({ status: "ready", tagging: "tagged", taggingError: null });
    expect(tagged?.tags).toEqual([
      { tagId: paper.id, source: "automatic", confidence: null, needsReview: false },
    ]);
    // A local model needs no consent.
    expect(consentAsked).toBe(false);
    // One request: the Tags' names and descriptions, and the Document's excerpt.
    expect(tagging.requests).toHaveLength(1);
    const [request] = tagging.requests;
    expect(request?.json).toBe(true);
    expect(request?.names.sort()).toEqual([...PRESETS_EN].sort());
    expect(request?.text).toContain(`- Paper: ${paper.description}`);
    expect(request?.text).toContain(`- Invoice: ${(await tagNamed(core, "Invoice")).description}`);
    expect(request?.text).toContain("Name: Attention");
    expect(request?.text).toContain("The dominant sequence transduction models");
  });

  test("tagging never holds up a Document: it is searchable once embedded, and its tagging shows apart", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    tagging.hold();
    await core.saveChatProvider(LOCAL);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await tagging.requested();

    expect((await core.listDocuments())[0]).toMatchObject({
      status: "ready",
      tagging: "tagging",
      tags: [],
    });
    expect(await core.searchPassages("transduction")).toEqual([
      expect.objectContaining({ documentId: document.id }),
    ]);
    tagging.release();
    const [tagged] = await waitForTagging(core, [document.id]);
    expect(tagged).toMatchObject({ status: "ready", tags: [expect.anything()] });
  });

  test("the model gets a bounded excerpt: the beginning of the Document, without repeats", async () => {
    const { core, tagging } = await startTagging(["Book"]);
    await core.saveChatProvider(LOCAL);
    const chapters = Array.from(
      { length: 60 },
      (_, index) =>
        `Chapter ${index + 1}. ${"The river kept its course through the valley, and nobody asked why. ".repeat(6)}`,
    ).join("\n\n");

    const document = await addDocument(core, "Novel.txt", chapters);
    await waitForTagging(core, [document.id]);

    const text = tagging.requests[0]?.text ?? "";
    // The instructions name the markers too: the excerpt is between the last ones.
    const excerpt = text.slice(text.lastIndexOf(EXCERPT_START), text.lastIndexOf(EXCERPT_END));
    expect(excerpt).toContain("Chapter 1.");
    expect(excerpt).not.toContain("Chapter 60.");
    expect(approximateTokens(excerpt)).toBeLessThan(EXCERPT_TOKENS + 50);
    // Passages overlap; the excerpt doesn't repeat what they share.
    expect(excerpt.split("Chapter 2.").length).toBeLessThanOrEqual(2);
  });

  test("an excerpt joins overlapping Passages without repeating them", () => {
    expect(
      excerptFromPassages([
        "Alpha beta gamma delta epsilon zeta",
        "gamma delta epsilon zeta eta theta",
        "Iota kappa",
      ]),
    ).toBe("Alpha beta gamma delta epsilon zeta eta theta\n\nIota kappa");
    // Cut at about the token budget: one token per CJK character.
    expect(excerptFromPassages(["一二三四五", "六七八"], 6)).toBe("一二三四五 …");
  });

  test("with no chat model, Documents wait, and are tagged by themselves once one is set up", async () => {
    const { core, tagging } = await startTagging(["Paper"]);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);

    // The "ready" event already says it waits.
    expect(document).toMatchObject({
      status: "ready",
      tagging: "waiting-for-provider",
      tags: [],
    });
    expect(tagging.requests).toEqual([]);

    await core.saveChatProvider(LOCAL);
    const [tagged] = await waitForTagging(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
    expect(tagged?.tagging).toBe("tagged");
  });

  test("when no Tag fits, the model has been asked and the Document is tagged with none", async () => {
    const { core, tagging } = await startTagging([]);
    await core.saveChatProvider(LOCAL);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [tagged] = await waitForTagging(core, [document.id]);

    expect(tagged).toMatchObject({ tagging: "tagged", tags: [] });
    expect(tagging.requests).toHaveLength(1);
  });

  test("with no Tags to choose from, no model is asked and the Document is checked once a Tag exists", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    await core.saveChatProvider(LOCAL);
    for (const tag of await core.listTags()) await core.deleteTag(tag.id);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    const [waiting] = await waitForTagging(
      core,
      [document.id],
      (each) => each.tagging === "no-tags",
    );

    expect(waiting).toMatchObject({ status: "ready", tags: [] });
    expect(tagging.requests).toEqual([]);

    await core.createTag({ name: "Paper", description: "A research paper." });
    const [tagged] = await waitForTagging(core, [document.id]);

    expect(tagged?.tagging).toBe("tagged");
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
    expect(tagging.requests).toHaveLength(1);
  });

  test("while Organize files new Documents by itself, a Document the tagger checked with no Tags is checked once a Tag exists", async () => {
    const { core } = await startTagging(["Paper"]);
    const provider = await core.saveChatProvider(LOCAL);
    const classifier = {
      kind: "chat",
      choice: { providerId: provider.id, modelId: "local-model" },
    } as const;
    await core.saveLibrarySettings({ classifier, automatic: true });
    for (const tag of await core.listTags()) await core.deleteTag(tag.id);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id], (each) => each.tagging === "no-tags");

    // With a Folder, Organize files new Documents by itself and takes them over.
    await core.createLibraryGroup({ name: "Papers", description: "Research papers" });
    await core.createTag({ name: "Paper", description: "A research paper." });
    const [tagged] = await waitForTagging(core, [document.id]);

    expect(tagged?.tagging).toBe("tagged");
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test("a Document still waiting for a Tag when the app quits is checked at the next start, if a Tag exists by then", async () => {
    const dataDir = await createTempDataFolder();
    const first = await startTagging(["Paper"], dataDir);
    await first.core.saveChatProvider(LOCAL);
    for (const tag of await first.core.listTags()) await first.core.deleteTag(tag.id);
    const document = await addDocument(first.core, "Attention.md", PAPER_TEXT);
    await waitForTagging(first.core, [document.id], (each) => each.tagging === "no-tags");
    first.core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `INSERT INTO tags (id, name, description, preset, colour, created_at, updated_at)
         VALUES (?, 'Paper', 'A research paper.', NULL, 'teal', ?, ?)`,
        [randomUUID(), AT, AT],
      );
    } finally {
      db.close();
    }

    const second = await startTagging(["Paper"], dataDir);
    const [tagged] = await waitForTagging(second.core, [document.id]);

    expect(tagged?.tagging).toBe("tagged");
    expect(await tagNamesOf(second.core, document.id)).toEqual(["Paper"]);
  });

  test("removing the chat model sends Documents not yet tagged back to waiting", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    tagging.fail(new Error("The model is down."));
    const provider = await core.saveChatProvider(LOCAL);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id], (each) => each.tagging === "failed");

    await core.deleteChatProvider(provider.id);

    await waitForTagging(core, [document.id], (each) => each.tagging === "waiting-for-provider");
  });

  test("a provider failure marks tagging failed, and a re-tag tries again", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    tagging.fail(
      new APICallError({
        message: "Internal server error",
        url: "http://127.0.0.1:11434/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 500,
        isRetryable: false,
      }),
    );
    await core.saveChatProvider(LOCAL);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);

    const [failed] = await waitForTagging(core, [document.id], (each) => each.tagging === "failed");
    expect(failed?.taggingError).toEqual({ kind: "provider", message: "Internal server error" });
    expect(failed?.status).toBe("ready");

    tagging.fail(null);
    await retag(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test("back online, the Documents that couldn't reach the model are tagged again, once however many windows say so", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    const failure = (statusCode?: number) =>
      new APICallError({
        message: statusCode ? "The model does not exist" : "fetch failed",
        url: "http://127.0.0.1:11434/v1/chat/completions",
        requestBodyValues: {},
        ...(statusCode && { statusCode }),
        isRetryable: false,
      });
    await core.saveChatProvider(LOCAL);
    tagging.fail(failure());
    const offline = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [offline.id], (each) => each.tagging === "failed");
    tagging.fail(failure(404));
    const unknownModel = await addDocument(core, "Unknown.md", PAPER_TEXT);
    const [unknown] = await waitForTagging(
      core,
      [unknownModel.id],
      (each) => each.tagging === "failed",
    );
    expect(unknown?.taggingError?.kind).toBe("model");
    const before = tagging.requests.length;

    tagging.fail(null);
    await Promise.all([core.backOnline(), core.backOnline()]);
    await waitForTagging(core, [offline.id]);

    expect(tagging.requests).toHaveLength(before + 1);
    expect(await tagNamesOf(core, offline.id)).toEqual(["Paper"]);
    expect((await core.listDocuments()).find((each) => each.id === unknownModel.id)?.tagging).toBe(
      "failed",
    );
  });
});

describe("Consent for automatic tagging (ADR-0022)", { timeout: 30_000 }, () => {
  /** Counts the consent requests from now on: tagging, background work, never makes one. */
  const countRequests = (core: Core) => {
    const requests: string[] = [];
    core.on("consent.requested", (request) => requests.push(request.flow.id));
    return requests;
  };

  test("choosing a cloud model's provider sends nothing to tag; turning tagging on allows it, and Tags start without a dialog", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    const requests = countRequests(core);
    await core.saveChatProvider(OPENAI);

    const before = await addDocument(core, "Invoice.txt", "Invoice 42. Amount due: 120 EUR.");
    expect(before.tagging).toBe("off");
    expect(tagging.requests).toEqual([]);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "tagging" }),
        consent: "not-asked",
      }),
    );

    await turnOnAutomaticTagging(core);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);

    expect(requests).toEqual([]);
    expect(tagging.requests).toHaveLength(1);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
    // The Document that came in while it was off isn't tagged by turning it on.
    expect((await core.listDocuments()).find((each) => each.id === before.id)?.tagging).toBe("off");
    expect(await core.listDataFlows()).toContainEqual({
      flow: { id: "tagging", service: OPENAI_SERVICE, sends: ["tags", "document-excerpts"] },
      consent: "accepted",
      decidedAt: expect.any(String),
      chosen: true,
    });
  });

  test("before any model is chosen, a new Document's tagging waits, and nothing asks", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    const requests = countRequests(core);

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);

    expect(document.tagging).toBe("waiting-for-provider");
    expect(requests).toEqual([]);
    expect(tagging.requests).toEqual([]);
  });

  test("for a provider chosen before, tagging never asks: Documents wait until the User allows it", async () => {
    const { core, tagging, models } = await startTagging(["Paper"]);
    await core.saveChatProvider(OPENAI);
    await turnOnAutomaticTagging(core);
    // As turning it on left it before ADR-0022: tagging never asked.
    await core.revokeConsent("tagging", OPENAI_SERVICE.id);
    const requests = countRequests(core);
    const specsBefore = models.specs.length;

    const first = await addDocument(core, "Attention.md", PAPER_TEXT);
    const second = await addDocument(core, "Invoice.txt", "Invoice 42. Amount due: 120 EUR.");

    expect([first.tagging, second.tagging]).toEqual([
      "waiting-for-provider",
      "waiting-for-provider",
    ]);
    expect(requests).toEqual([]);
    expect(tagging.requests).toEqual([]);
    expect(models.specs).toHaveLength(specsBefore);
    // Questions can still be asked: the chat flow is its own.
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });

    // Allowed in Settings › Privacy: both Documents go on.
    await core.allowDataFlow("tagging", OPENAI_SERVICE.id);
    await waitForTagging(core, [first.id, second.id]);
    expect(tagging.requests).toHaveLength(2);
    expect(requests).toEqual([]);
  });

  test("revoking Tags stops tagging alone", async () => {
    const { core, tagging } = await startTagging(["Paper"]);
    await core.saveChatProvider(OPENAI);
    await turnOnAutomaticTagging(core);
    const first = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [first.id]);
    const requests = countRequests(core);

    await core.revokeConsent("tagging", OPENAI_SERVICE.id);
    const second = await addDocument(core, "Invoice.txt", "Invoice 42. Amount due: 120 EUR.");

    expect(second.tagging).toBe("waiting-for-provider");
    expect(tagging.requests).toHaveLength(1);
    expect(requests).toEqual([]);
    // Every other flow to the provider stays allowed.
    expect(await core.getChatReadiness()).toMatchObject({ ready: true, consent: "accepted" });
    const others = (await core.listDataFlows()).filter((each) => each.flow.id !== "tagging");
    expect(others.map((each) => [each.flow.id, each.consent])).toEqual([
      ["chat", "accepted"],
      ["suggestions", "accepted"],
      ["edits", "accepted"],
      ["checks", "accepted"],
      ["document-check", "not-asked"],
    ]);
  });

  test("a declined tagging flow sends nothing, until choosing the model again replaces the decline", async () => {
    const dataDir = await createTempDataFolder();
    const { core, tagging } = await startTagging(["Paper"], dataDir);
    const provider = await core.saveChatProvider(OPENAI);
    await turnOnAutomaticTagging(core);
    await core.revokeConsent("tagging", OPENAI_SERVICE.id);
    // Declined in the dialog tagging asked before ADR-0022.
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `INSERT INTO data_flow_consents
           (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
         VALUES (?, 'tagging', ?, ?, 'declined', '[]', ?, ?)`,
        [randomUUID(), OPENAI_SERVICE.id, OPENAI_SERVICE.name, AT, AT],
      );
    } finally {
      db.close();
    }

    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    expect(document.tagging).toBe("waiting-for-provider");
    expect(tagging.requests).toEqual([]);

    // Choosing the model again in Settings › Tagging: a new choice, where the line names Document text for Tags.
    await core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: OPENAI.modelId } },
      automatic: true,
    });
    await waitForTagging(core, [document.id]);
    expect(tagging.requests).toHaveLength(1);
    expect(await core.listDataFlows()).toContainEqual(
      expect.objectContaining({
        flow: expect.objectContaining({ id: "tagging" }),
        consent: "accepted",
        chosen: true,
      }),
    );
  });
});

describe("Re-tagging", { timeout: 30_000 }, () => {
  test("Tags the User added or removed are never changed automatically", async () => {
    const { core, tagging } = await startTagging(["Paper", "Report"]);
    await core.saveChatProvider(LOCAL);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper", "Report"]);
    const [paper, report, book] = await Promise.all(
      ["Paper", "Report", "Book"].map((name) => tagNamed(core, name)),
    );
    if (!paper || !report || !book) throw new Error("A preset is missing.");

    // The User takes an automatic Tag off, adds one, and keeps one automatic tagging chose.
    await core.removeDocumentTag(document.id, report.id);
    await core.addDocumentTag(document.id, book.id);
    await core.addDocumentTag(document.id, paper.id);

    // The same choices don't bring the removed Tag back.
    await retag(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Book", "Paper"]);
    // Choosing nothing doesn't take the User's Tags away.
    tagging.choose([]);
    await retag(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Book", "Paper"]);
    // Choosing everything adds only Tags the User hasn't decided on.
    tagging.choose(["Book", "Notes", "Paper", "Report"]);
    await retag(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Book", "Notes", "Paper"]);
    const [current] = await core.listDocuments();
    expect(current?.tags.map((link) => link.source)).toEqual(["user", "automatic", "user"]);
    expect(tagging.requests).toHaveLength(4);
  });

  test("re-tagging recomputes only the automatic Tags, e.g. after a Tag's description changes", async () => {
    const { core, tagging } = await startTagging();
    tagging.choose((request) =>
      request.text.includes("anything about attention") ? ["Paper"] : ["Notes"],
    );
    await core.saveChatProvider(LOCAL);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    await core.addDocumentTag(document.id, (await tagNamed(core, "Book")).id);
    expect(await tagNamesOf(core, document.id)).toEqual(["Book", "Notes"]);
    const paper = await tagNamed(core, "Paper");

    await core.updateTag(paper.id, { description: "Papers, and anything about attention." });
    // Editing a Tag doesn't re-tag by itself.
    expect(tagging.requests).toHaveLength(1);
    await core.retagDocuments();
    await waitForTagging(core, [document.id]);

    expect(await tagNamesOf(core, document.id)).toEqual(["Book", "Paper"]);
    expect(tagging.requests[1]?.text).toContain("- Paper: Papers, and anything about attention.");
  });

  test("re-tagging one Document leaves the others alone; re-tagging all does them all", async () => {
    const { core, tagging } = await startTagging(["Notes"]);
    await core.saveChatProvider(LOCAL);
    const first = await addDocument(core, "First.txt", "Notes from the first meeting.");
    const second = await addDocument(core, "Second.txt", "Notes from the second meeting.");
    await waitForTagging(core, [first.id, second.id]);
    expect(tagging.requests).toHaveLength(2);

    await retag(core, [second.id]);
    expect(tagging.requests).toHaveLength(3);
    expect(tagging.requests[2]?.text).toContain("Name: Second");

    const pending = nextEvent(core, "documents.tagged");
    await core.retagDocuments();
    expect((await pending).map((document) => document.tagging)).toEqual(["pending", "pending"]);
    await waitForTagging(core, [first.id, second.id]);
    expect(tagging.requests).toHaveLength(5);

    await expect(core.retagDocuments([randomUUID()])).rejects.toThrow(NotFoundError);
    await expect(core.retagDocuments("all" as never)).rejects.toThrow(InvalidInputError);
  });
});

describe("Tagging many Documents at once", { timeout: 30_000 }, () => {
  test("the User adds a Tag to several Documents, or takes it off, in one change pushed once", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const a = await addDocument(core, "A.txt", "Notes about A, kept for later.");
    const b = await addDocument(core, "B.txt", "Notes about B, kept for later.");
    const c = await addDocument(core, "C.txt", "Notes about C, kept for later.");
    const paper = await tagNamed(core, "Paper");
    await core.addDocumentTag(b.id, paper.id);

    const pushed: Document[][] = [];
    const stop = core.on("documents.tagged", (documents) => pushed.push(documents));
    const added = await core.addTagToDocuments([a.id, b.id, c.id], paper.id);
    // Each Document comes back; only those that changed are pushed, in one event.
    expect(ids(added)).toEqual([a.id, b.id, c.id]);
    expect(added.every((document) => document.tags.some((link) => link.tagId === paper.id))).toBe(
      true,
    );
    expect(pushed.map(ids)).toEqual([[a.id, c.id]]);
    expect(
      (await core.listDocuments()).map((document) => document.tags.map((link) => link.source)),
    ).toEqual([["user"], ["user"], ["user"]]);

    pushed.length = 0;
    const removed = await core.removeTagFromDocuments([a.id, b.id], paper.id);
    expect(removed.map((document) => document.tags)).toEqual([[], []]);
    expect(pushed.map(ids)).toEqual([[a.id, b.id]]);
    // The removals are the User's: kept as deleted links, so automatic tagging leaves them off.
    const links = queryDatabase(
      dataDir,
      "SELECT document_id AS id, source, deleted_at IS NOT NULL AS deleted FROM document_tags WHERE tag_id = ?",
      [paper.id],
    );
    expect(links).toHaveLength(3);
    expect(links).toEqual(
      expect.arrayContaining([
        { id: a.id, source: "user", deleted: 1 },
        { id: b.id, source: "user", deleted: 1 },
        { id: c.id, source: "user", deleted: 0 },
      ]),
    );
    stop();

    // Nothing changes when one id is wrong.
    await expect(core.addTagToDocuments([a.id, randomUUID()], paper.id)).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.addTagToDocuments([a.id], randomUUID())).rejects.toThrow(NotFoundError);
    await expect(core.addTagToDocuments("nope" as unknown as string[], paper.id)).rejects.toThrow(
      InvalidInputError,
    );
    expect(ids(await core.listDocuments({ tagId: paper.id }))).toEqual([c.id]);
  });

  test("adding a Tag automatic tagging applied makes it the User's, as confirming it does", async () => {
    const { core } = await startTagging(["Paper"]);
    await core.saveChatProvider(LOCAL);
    const document = await addDocument(core, "Attention.md", PAPER_TEXT);
    await waitForTagging(core, [document.id]);
    const paper = await tagNamed(core, "Paper");
    expect((await core.listDocuments())[0]?.tags[0]?.source).toBe("automatic");
    const [confirmed] = await core.addTagToDocuments([document.id], paper.id);
    expect(confirmed?.tags).toEqual([
      { tagId: paper.id, source: "user", confidence: null, needsReview: false },
    ]);
  });
});

describe("Merging Tags", { timeout: 30_000 }, () => {
  test("merging moves every Document to the other Tag, keeps who chose it, and deletes the merged Tag", async () => {
    const { core, tagging } = await startTagging();
    // Automatic tagging applies Report to the paper only.
    tagging.choose((request) => (request.text.includes("Attention") ? ["Report"] : []));
    await core.saveChatProvider(LOCAL);
    const auto = await addDocument(core, "Auto.md", PAPER_TEXT);
    const user = await addDocument(core, "User.txt", "Notes about the user, kept for later.");
    const both = await addDocument(core, "Both.txt", "Notes about both, kept for later.");
    const removed = await addDocument(core, "Removed.txt", "Notes about removal, kept.");
    await waitForTagging(core, [auto.id, user.id, both.id, removed.id]);
    const report = await tagNamed(core, "Report");
    const findings = await core.createTag({ name: "Findings", description: "Results written up" });
    await core.addDocumentTag(removed.id, report.id);
    await core.addDocumentTag(user.id, findings.id);
    await core.addDocumentTag(both.id, findings.id);
    await core.addDocumentTag(both.id, report.id);
    // The User took Report off this one: after the merge, Findings stays off it too.
    await core.removeDocumentTag(removed.id, report.id);

    const tagsChanged = nextEvent(core, "tags.changed");
    const tagged = nextEvent(core, "documents.tagged");
    const merged = await core.mergeTags(report.id, findings.id);

    expect(merged.tag).toMatchObject({ id: findings.id, name: "Findings" });
    expect(ids(await tagsChanged)).not.toContain(report.id);
    expect(ids(await tagged).sort()).toEqual([auto.id, both.id].sort());
    const tagsOf = async (id: string) =>
      (await core.listDocuments())
        .find((document) => document.id === id)
        ?.tags.map((link) => [link.tagId, link.source]);
    // An automatic link stays automatic; the User's stay the User's; one link per Document.
    expect(await tagsOf(auto.id)).toEqual([[findings.id, "automatic"]]);
    expect(await tagsOf(user.id)).toEqual([[findings.id, "user"]]);
    expect(await tagsOf(both.id)).toEqual([[findings.id, "user"]]);
    expect(await tagsOf(removed.id)).toEqual([]);
    expect(names(await core.listTags())).not.toContain("Report");

    // A removal the User made carries over: re-tagging doesn't put Findings on that one.
    tagging.choose(["Findings"]);
    await retag(core, [removed.id]);
    expect(await tagsOf(removed.id)).toEqual([]);

    await expect(core.mergeTags(findings.id, findings.id)).rejects.toThrow(InvalidInputError);
    await expect(core.mergeTags(report.id, findings.id)).rejects.toThrow(NotFoundError);
  });
});

describe("Filtering by Tag", { timeout: 30_000 }, () => {
  test("listDocuments filters by Tag, and by Tag and Folder together", async () => {
    const core = startCore(await createTempDataFolder());
    // A and B in a Linked folder, Projects/A.txt and Projects/Nested/B.txt; C added on its own.
    const library = await createSourceFolder();
    await writeSourceFile(library, "Projects/A.txt", "Notes about A, kept for later.");
    await writeSourceFile(library, "Projects/Nested/B.txt", "Notes about B, kept for later.");
    const linked = await linkAndProcess(core, library);
    const a = documentAt(linked, join(library, "Projects/A.txt"));
    const b = documentAt(linked, join(library, "Projects/Nested/B.txt"));
    const c = await addDocument(core, "C.txt", "Notes about C, kept for later.");
    const folders = await core.listFolders();
    const projects = folders.find((folder) => folder.relativePath === "Projects");
    if (!projects) throw new Error("No Projects Folder.");
    const paper = await tagNamed(core, "Paper");
    const book = await tagNamed(core, "Book");
    for (const document of [a, b, c]) await core.addDocumentTag(document.id, paper.id);
    await core.addDocumentTag(b.id, book.id);
    const sorted = (documents: Document[]) => ids(documents).sort();

    expect(sorted(await core.listDocuments({ tagId: paper.id }))).toEqual(
      [a.id, b.id, c.id].sort(),
    );
    expect(ids(await core.listDocuments({ tagId: book.id }))).toEqual([b.id]);
    expect(ids(await core.listDocuments({ folderId: projects.id, tagId: paper.id }))).toEqual([
      a.id,
    ]);
    expect(
      sorted(
        await core.listDocuments({
          folderId: projects.id,
          includeSubfolders: true,
          tagId: paper.id,
        }),
      ),
    ).toEqual([a.id, b.id].sort());
    expect(await core.listDocuments({ folderId: projects.id, tagId: book.id })).toEqual([]);

    // Removing a Tag takes the Document out of the filter.
    await core.removeDocumentTag(c.id, paper.id);
    expect(sorted(await core.listDocuments({ tagId: paper.id }))).toEqual([a.id, b.id].sort());

    await expect(core.listDocuments({ tagId: "" })).rejects.toThrow(InvalidInputError);
    await expect(core.listDocuments({ tagId: randomUUID() })).rejects.toThrow(NotFoundError);
  });
});

describe("Restarting", { timeout: 30_000 }, () => {
  test("Tags, the Tags on Documents and the User's removals survive a restart", async () => {
    const dataDir = await createTempDataFolder();
    const first = await startTagging(["Paper", "Report"], dataDir);
    await first.core.saveChatProvider(LOCAL);
    const document = await addDocument(first.core, "Attention.md", PAPER_TEXT);
    await waitForTagging(first.core, [document.id]);
    await first.core.removeDocumentTag(document.id, (await tagNamed(first.core, "Report")).id);
    await first.core.addDocumentTag(document.id, (await tagNamed(first.core, "Book")).id);
    await first.core.createTag({ name: "Quarterly", description: "One quarter of a year." });
    await first.core.updateTag((await tagNamed(first.core, "Paper")).id, {
      description: "Edited.",
    });
    await first.core.deleteTag((await tagNamed(first.core, "Slides")).id);
    const tags = await first.core.listTags();
    const documents = await first.core.listDocuments();
    first.core.close();

    const second = await startTagging(["Paper", "Report"], dataDir);

    expect(await second.core.listTags()).toEqual(tags);
    expect(await second.core.listDocuments()).toEqual(documents);
    expect(await tagNamesOf(second.core, document.id)).toEqual(["Book", "Paper"]);
    // The removal is remembered: re-tagging after the restart leaves Report off.
    await retag(second.core, [document.id]);
    expect(await tagNamesOf(second.core, document.id)).toEqual(["Book", "Paper"]);
    expect(second.tagging.requests).toHaveLength(1);
  });

  test("Documents waiting for a chat model still wait after a restart, then go on", async () => {
    const dataDir = await createTempDataFolder();
    const first = await startTagging(["Paper"], dataDir);
    const document = await addDocument(first.core, "Attention.md", PAPER_TEXT);
    expect(document.tagging).toBe("waiting-for-provider");
    first.core.close();

    const second = await startTagging(["Paper"], dataDir);
    expect((await second.core.listDocuments())[0]?.tagging).toBe("waiting-for-provider");
    await second.core.saveChatProvider(LOCAL);
    await waitForTagging(second.core, [document.id]);
    expect(await tagNamesOf(second.core, document.id)).toEqual(["Paper"]);
  });

  test("tagging a quit interrupted starts again at the next launch", async () => {
    const dataDir = await createTempDataFolder();
    const first = await startTagging(["Paper"], dataDir);
    first.tagging.hold();
    await first.core.saveChatProvider(LOCAL);
    const document = await addDocument(first.core, "Attention.md", PAPER_TEXT);
    await first.tagging.requested();
    first.core.close();
    first.tagging.release();
    expect(queryDatabase(dataDir, "SELECT tagging_status FROM documents")).toEqual([
      { tagging_status: "tagging" },
    ]);

    const second = await startTagging(["Paper"], dataDir);
    await waitForTagging(second.core, [document.id]);
    expect(await tagNamesOf(second.core, document.id)).toEqual(["Paper"]);
  });
});
