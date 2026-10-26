import { join } from "node:path";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  type DocumentBatch,
  type DocumentGroupAssignment,
  InvalidInputError,
  NotFoundError,
} from "../../src/core";
import { METADATA_VERSION, PROCESSING_VERSION } from "../../src/core/documents/processing";
import { isRecord } from "../../src/core/errors";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, sha256, writeSourceFile } from "../helpers/documents";

type Rule = (name: string, choices: string[]) => { groupId: string; tags?: string[] };

/** The name of the Document Organize was asked about. */
const nameIn = (prompt: LanguageModelV4Prompt): string => {
  const data = prompt
    .flatMap((message) =>
      message.role !== "user"
        ? []
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    )
    .join("");
  const parsed: unknown = JSON.parse(data);
  const document = isRecord(parsed) && isRecord(parsed.document) ? parsed.document : {};
  return typeof document.name === "string" ? document.name : "";
};

/** A classifier whose choice of Folder and Tags the test sets, recording what it was offered. */
function sorter() {
  const offered: string[][] = [];
  let rule: Rule = (_name, choices) => ({ groupId: choices[0] ?? "__unsorted__" });
  let hold: Promise<void> | null = null;
  let answered = 0;
  let tagFailure: Error | null = null;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const schema =
        options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined;
      const choices =
        (schema as { properties?: { groupId?: { enum: string[] } } } | undefined)?.properties
          ?.groupId?.enum ?? [];
      if (choices.length === 0) {
        // The tagger's request: no Folder to choose.
        if (tagFailure) throw tagFailure;
        return {
          content: [{ type: "text", text: JSON.stringify({ tags: [] }) }],
          finishReason: { unified: "stop", raw: undefined },
          warnings: [],
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        };
      }
      offered.push(choices);
      if (hold) await hold;
      const { groupId, tags = [] } = rule(nameIn(options.prompt), choices);
      answered++;
      return {
        content: [{ type: "text", text: JSON.stringify({ groupId, tags }) }],
        finishReason: { unified: "stop", raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
  });
  return {
    model,
    offered,
    sort: (next: Rule) => {
      rule = next;
    },
    answered: () => answered,
    hold: (next: Promise<void> | null) => {
      hold = next;
    },
    failTags: (error: Error | null) => {
      tagFailure = error;
    },
  };
}

/** Finance and Thesis, and Organize set up as the User would, keeping its default. */
async function setUp(dataDir?: string) {
  const fake = sorter();
  const folder = dataDir ?? (await createTempDataFolder());
  const core = startCore(folder, { createChatModel: () => fake.model });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
  const finance = await core.createLibraryGroup({
    name: "Finance",
    description: "Bills, budgets and statements",
  });
  const thesis = await core.createLibraryGroup({
    name: "Thesis",
    description: "Research for my thesis",
  });
  const classifier = {
    kind: "chat" as const,
    choice: { providerId: provider.id, modelId: "small-classifier" },
  };
  await core.saveLibrarySettings({
    classifier,
    automatic: (await core.getLibrary()).settings.automatic,
  });
  // Invoices in Finance, the rest in Thesis, among the Folders offered.
  fake.sort((name, choices) => {
    const wanted = name.startsWith("Invoice") ? finance.id : thesis.id;
    return { groupId: choices.includes(wanted) ? wanted : (choices[0] ?? "__unsorted__") };
  });
  return {
    core,
    dataDir: folder,
    fake,
    finance,
    thesis,
    classifier,
    sources: await createSourceFolder(),
  };
}

/** Every "documents.batch" event from now on. */
function batchesOf(core: Core) {
  const seen: DocumentBatch[] = [];
  core.on("documents.batch", (batch) => seen.push(batch));
  return {
    of: (id: string) => seen.filter((each) => each.id === id),
    /** Resolves with the batch once it is as wanted. */
    until: (id: string, wanted: (batch: DocumentBatch) => boolean) =>
      vi.waitFor(
        () => {
          const latest = seen.filter((each) => each.id === id).at(-1);
          if (!latest || !wanted(latest)) throw new Error(`Batch now: ${JSON.stringify(latest)}`);
          return latest;
        },
        { timeout: 15_000 },
      ),
  };
}

const assignmentOf = async (core: Core, documentId: string) =>
  (await core.getLibrary()).assignments.find((each) => each.documentId === documentId);

const documentOf = async (core: Core, documentId: string) =>
  (await core.listDocuments()).find((each) => each.id === documentId);

const rateLimited = () =>
  new APICallError({
    message: "Rate limit reached for requests",
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after": "45" },
    isRetryable: true,
  });

/** Adds files named as given, and waits until Organize has sorted them. */
async function addAndSort(core: Core, sources: string, names: string[]) {
  const batches = batchesOf(core);
  const { batchId, documents } = await core.addDocuments(
    await Promise.all(
      names.map((name) => writeSourceFile(sources, `${name}.txt`, `${name}: a few words.`)),
    ),
  );
  await batches.until(batchId, (batch) => !batch.adding && batch.sorted === names.length);
  return documents;
}

describe("Organize suggests a Folder and waits for the User", () => {
  test("adding 12 Documents reports the batch as each is read and sorted, with counts per Suggested Folder", async () => {
    const { core, finance, thesis, sources } = await setUp();
    const paths = await Promise.all([
      ...Array.from({ length: 8 }, (_, at) =>
        writeSourceFile(sources, `Invoice ${at + 1}.txt`, `Invoice ${at + 1}: GBP ${at + 1}00.`),
      ),
      ...Array.from({ length: 4 }, (_, at) =>
        writeSourceFile(sources, `Chapter ${at + 1}.txt`, `Chapter ${at + 1}: urban heat.`),
      ),
    ]);
    const batches = batchesOf(core);

    const { batchId, documents } = await core.addDocuments(paths);
    const last = await batches.until(
      batchId,
      (batch) => !batch.adding && batch.read === 12 && batch.sorted === 12,
    );

    expect(last).toEqual({
      id: batchId,
      groupId: null,
      documentIds: documents.map((each) => each.id),
      adding: false,
      read: 12,
      sorted: 12,
      suggested: [
        { groupId: finance.id, count: 8 },
        { groupId: thesis.id, count: 4 },
      ],
    });
    const reports = batches.of(batchId);
    expect(reports[0]).toMatchObject({ adding: true, read: 0, sorted: 0 });
    for (const [at, report] of reports.entries()) {
      const before = reports[at - 1];
      if (!before) continue;
      expect(report.documentIds.length).toBeGreaterThanOrEqual(before.documentIds.length);
      expect(report.read).toBeGreaterThanOrEqual(before.read);
      expect(report.sorted).toBeGreaterThanOrEqual(before.sorted);
    }
    // Listed in their Suggested Folders, marked as suggestions.
    const { assignments } = await core.getLibrary();
    expect(assignments).toHaveLength(12);
    for (const assignment of assignments) {
      expect(assignment).toMatchObject({ source: "automatic", suggested: true });
    }
  });

  test("accepting makes Suggested Folders the User's choices, which a later Organize leaves alone", async () => {
    const { core, fake, finance, thesis, sources } = await setUp();
    const [invoice, other, chapter] = await addAndSort(core, sources, [
      "Invoice 1",
      "Invoice 2",
      "Chapter 1",
    ]);
    if (!invoice || !other || !chapter) throw new Error("Not added.");
    const assigned: DocumentGroupAssignment[][] = [];
    core.on("library.assignments", (list) => assigned.push(list));

    const changes = await core.acceptAssignments([invoice.id, chapter.id, invoice.id]);

    expect(changes).toEqual([
      {
        before: expect.objectContaining({
          documentId: invoice.id,
          groupId: finance.id,
          source: "automatic",
          suggested: true,
        }),
        after: expect.objectContaining({
          documentId: invoice.id,
          groupId: finance.id,
          source: "user",
          suggested: false,
        }),
      },
      {
        before: expect.objectContaining({ documentId: chapter.id, suggested: true }),
        after: expect.objectContaining({
          documentId: chapter.id,
          groupId: thesis.id,
          source: "user",
          suggested: false,
        }),
      },
    ]);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toHaveLength(2);
    expect(assigned[0]).toEqual(expect.arrayContaining(changes.map((each) => each.after)));
    expect(await core.acceptAssignments([invoice.id])).toEqual([]);

    // Organize now finds no Folder for anything: only the suggestion left waiting changes.
    fake.sort(() => ({ groupId: "__unsorted__" }));
    await core.classifyDocuments([invoice.id, other.id, chapter.id]);
    await vi.waitFor(async () => {
      const { assignments } = await core.getLibrary();
      expect(assignments.map((each) => each.status)).toEqual([
        "classified",
        "classified",
        "classified",
      ]);
    });
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: finance.id,
      source: "user",
    });
    expect(await assignmentOf(core, chapter.id)).toMatchObject({
      groupId: thesis.id,
      source: "user",
    });
    expect(await assignmentOf(core, other.id)).toMatchObject({
      groupId: null,
      source: "automatic",
      suggested: false,
    });
  });

  test("rejecting leaves the Document Not in a Folder, and Organize doesn't suggest that Folder for it again", async () => {
    const { core, fake, finance, thesis, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");

    const changes = await core.rejectAssignments([invoice.id]);

    expect(changes).toEqual([
      {
        before: expect.objectContaining({ groupId: finance.id, suggested: true }),
        after: expect.objectContaining({ groupId: null, source: "automatic", suggested: false }),
      },
    ]);
    expect(await assignmentOf(core, invoice.id)).toEqual(changes[0]?.after);
    expect(await core.rejectAssignments([invoice.id])).toEqual([]);

    await core.classifyDocuments([invoice.id]);
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, invoice.id)).toMatchObject({ status: "classified" }),
    );
    expect(fake.offered.at(-1)).not.toContain(finance.id);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: thesis.id,
      suggested: true,
    });
    // Only for that Document: another invoice is still suggested Finance.
    const [next] = await addAndSort(core, sources, ["Invoice 2"]);
    expect(await assignmentOf(core, next?.id ?? "")).toMatchObject({
      groupId: finance.id,
      suggested: true,
    });
  });

  test("a run that fails after a Suggested Folder, turned down, is finished: not one Organize couldn't sort", async () => {
    const { core, fake, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");

    fake.sort(() => {
      throw new Error("The model stopped answering");
    });
    await core.classifyDocuments([invoice.id]);
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, invoice.id)).toMatchObject({ status: "failed" }),
    );
    expect(await assignmentOf(core, invoice.id)).toMatchObject({ suggested: true });

    const [change] = await core.rejectAssignments([invoice.id]);
    expect(change?.after).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
      error: null,
    });
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
      error: null,
    });
  });

  test("rejecting while a re-run is classifying settles the Document and its tagging, through Undo and Redo", async () => {
    const { core, fake, finance, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");
    const documentNow = async () =>
      (await core.listDocuments()).find((each) => each.id === invoice.id);
    let release = () => {};
    fake.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    await core.classifyDocuments([invoice.id]);
    // The run has reached the model and waits there, as one under way when the User turns it down.
    await vi.waitFor(async () => {
      expect(fake.offered.length).toBeGreaterThan(1);
      expect(await assignmentOf(core, invoice.id)).toMatchObject({ status: "classifying" });
      expect((await documentNow())?.tagging).toBe("tagging");
    });

    const [change] = await core.rejectAssignments([invoice.id]);
    expect(change?.after).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
      error: null,
    });
    expect((await documentNow())?.tagging).toBe("tagged");

    // The held run comes back stale: it leaves both rows as the Reject settled them.
    release();
    await vi.waitFor(() => expect(fake.answered()).toBe(2));
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
      error: null,
    });
    expect((await documentNow())?.tagging).toBe("tagged");

    // Undo puts the Suggested Folder back; it is classified again and waits.
    if (!change) throw new Error("Not rejected.");
    const { documentId: _id, ...before } = change.before;
    await core.restoreAssignment(invoice.id, before);
    await vi.waitFor(async () => {
      expect(await assignmentOf(core, invoice.id)).toMatchObject({
        groupId: finance.id,
        suggested: true,
        status: "classified",
      });
      expect((await documentNow())?.tagging).toBe("tagged");
    });

    // Redo turns it down again: the assignment and the Document settle together.
    await core.rejectAssignments([invoice.id]);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
    });
    expect((await documentNow())?.tagging).toBe("tagged");
    fake.hold(null);
  });

  test("turning down a failed re-run with automatic Organize off settles the Document's tagging, and Undo brings its failure back", async () => {
    const { core, classifier, fake, finance, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");
    await core.saveLibrarySettings({ classifier, automatic: false });
    fake.sort(() => {
      throw new Error("The model stopped answering");
    });
    await core.classifyDocuments([invoice.id]);
    await vi.waitFor(async () => {
      expect(await assignmentOf(core, invoice.id)).toMatchObject({ status: "failed" });
      expect((await documentOf(core, invoice.id))?.tagging).toBe("failed");
    });

    const [change] = await core.rejectAssignments([invoice.id]);

    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
      error: null,
    });
    // Organize held it before the Reject: the failed run may not come back as a tagging failure.
    expect((await documentOf(core, invoice.id))?.tagging).toBe("tagged");

    // Undo brings the failed run back, and the Document's failure with its reason too.
    if (!change) throw new Error("Not rejected.");
    const { documentId: _id, ...before } = change.before;
    await core.restoreAssignment(invoice.id, before);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: finance.id,
      suggested: true,
      status: "failed",
      error: { message: "The model stopped answering" },
    });
    const undone = await documentOf(core, invoice.id);
    expect(undone?.tagging).toBe("failed");
    expect(undone?.taggingError).toMatchObject({ message: "The model stopped answering" });

    // Redo turns it down again: the assignment and the Document settle together.
    await core.rejectAssignments([invoice.id]);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: null,
      suggested: false,
      status: "classified",
      error: null,
    });
    const redone = await documentOf(core, invoice.id);
    expect(redone?.tagging).toBe("tagged");
    expect(redone?.taggingError).toBeNull();
  });

  test("turning down a suggestion leaves a retag the User asked for to the tagger", async () => {
    const { core, classifier, fake, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");
    await core.saveLibrarySettings({ classifier, automatic: false });
    fake.failTags(rateLimited());
    await core.retagDocuments([invoice.id]);
    await vi.waitFor(async () => {
      expect((await documentOf(core, invoice.id))?.tagging).toBe("waiting-for-provider");
      expect((await documentOf(core, invoice.id))?.taggingError?.kind).toBe("rate-limit");
    });

    await core.rejectAssignments([invoice.id]);

    // Organize didn't hold the tagging: the tagger's rate-limited run stays, and still runs.
    expect((await documentOf(core, invoice.id))?.tagging).toBe("waiting-for-provider");
    expect((await documentOf(core, invoice.id))?.taggingError?.kind).toBe("rate-limit");
    fake.failTags(null);
    await core.retagDocuments([invoice.id]);
    await vi.waitFor(async () => {
      expect((await documentOf(core, invoice.id))?.tagging).toBe("tagged");
    });
  });

  test("putting a rejected Suggested Folder back offers that Folder to Organize again, and rejecting it once more turns it down again", async () => {
    const { core, fake, finance, thesis, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");
    const [rejected] = await core.rejectAssignments([invoice.id]);
    if (!rejected) throw new Error("Not rejected.");

    const { documentId: _id, ...before } = rejected.before;
    await core.restoreAssignment(invoice.id, before);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: finance.id,
      suggested: true,
    });
    await core.classifyDocuments([invoice.id]);
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, invoice.id)).toMatchObject({ status: "classified" }),
    );
    expect(fake.offered.at(-1)).toContain(finance.id);

    await core.rejectAssignments([invoice.id]);
    await core.classifyDocuments([invoice.id]);
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, invoice.id)).toMatchObject({
        groupId: thesis.id,
        suggested: true,
      }),
    );
    expect(fake.offered.at(-1)).not.toContain(finance.id);
  });

  test("accepting or rejecting leaves a Document the User moved meanwhile as they put it", async () => {
    const { core, finance, thesis, sources } = await setUp();
    const [invoice, other] = await addAndSort(core, sources, ["Invoice 1", "Invoice 2"]);
    if (!invoice || !other) throw new Error("Not added.");
    await core.moveToFolder({ documentIds: [invoice.id], folderId: thesis.id });

    expect(await core.acceptAssignments([invoice.id])).toEqual([]);
    expect(await core.rejectAssignments([invoice.id])).toEqual([]);
    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: thesis.id,
      source: "user",
    });
    expect(await core.acceptAssignments([invoice.id, other.id])).toHaveLength(1);
    expect(await assignmentOf(core, other.id)).toMatchObject({ groupId: finance.id });
  });

  test("moving a Document out of its Suggested Folder makes the new place the User's choice", async () => {
    const { core, thesis, sources } = await setUp();
    const [invoice, other] = await addAndSort(core, sources, ["Invoice 1", "Invoice 2"]);
    if (!invoice || !other) throw new Error("Not added.");

    await core.moveToFolder({ documentIds: [invoice.id], folderId: thesis.id });
    await core.moveToFolder({ documentIds: [other.id], folderId: null });

    expect(await assignmentOf(core, invoice.id)).toMatchObject({
      groupId: thesis.id,
      source: "user",
      suggested: false,
    });
    expect(await assignmentOf(core, other.id)).toMatchObject({
      groupId: null,
      source: "user",
      suggested: false,
    });
  });

  test("accepting or rejecting changes nothing if any Document is unknown", async () => {
    const { core, finance, sources } = await setUp();
    const [invoice] = await addAndSort(core, sources, ["Invoice 1"]);
    if (!invoice) throw new Error("Not added.");
    const waiting = await assignmentOf(core, invoice.id);

    await expect(core.acceptAssignments([invoice.id, "no-such-document"])).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.rejectAssignments([invoice.id, "no-such-document"])).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.acceptAssignments(invoice.id as unknown as string[])).rejects.toThrow(
      InvalidInputError,
    );
    expect(await assignmentOf(core, invoice.id)).toEqual(waiting);
    expect(waiting).toMatchObject({ groupId: finance.id, suggested: true });
  });

  test("Documents added to a Folder are filed there as the User's choice, with only their Tags suggested", async () => {
    const { core, fake, finance, thesis, sources } = await setUp();
    const urgent = await core.createTag({ name: "Urgent", description: "Needs doing soon" });
    fake.sort(() => ({ groupId: finance.id, tags: [urgent.id] }));
    const paths = await Promise.all([
      writeSourceFile(sources, "Invoice 1.txt", "Invoice 1: GBP 100."),
      writeSourceFile(sources, "Chapter 1.txt", "Chapter 1: urban heat."),
      writeSourceFile(sources, "Blank.txt", "  \n"),
    ]);
    const assigned: DocumentGroupAssignment[] = [];
    core.on("library.assignments", (list) => assigned.push(...list));
    const batches = batchesOf(core);

    const { batchId, documents } = await core.addDocuments(paths, { groupId: thesis.id });

    const filed = documents.map((each) =>
      expect.objectContaining({
        documentId: each.id,
        groupId: thesis.id,
        source: "user",
        suggested: false,
      }),
    );
    // The snapshot lists assignments in no set order.
    const allFiled = async () => {
      const { assignments } = await core.getLibrary();
      expect(assignments).toHaveLength(filed.length);
      expect(assignments).toEqual(expect.arrayContaining(filed));
    };
    await allFiled();
    const last = await batches.until(batchId, (batch) => !batch.adding && batch.sorted === 3);
    expect(last).toMatchObject({ groupId: thesis.id, read: 3, suggested: [] });
    await allFiled();
    expect(assigned.every((each) => each.groupId === thesis.id && !each.suggested)).toBe(true);
    const tagsOf = Object.fromEntries(
      (await core.listDocuments()).map((each) => [each.name, each.tags.map((tag) => tag.tagId)]),
    );
    expect(tagsOf).toEqual({
      "Invoice 1": [urgent.id],
      "Chapter 1": [urgent.id],
      Blank: [],
    });
  });

  test("a folder linked onto a Folder files the Documents its first scan adds there", async () => {
    const { core, thesis, sources } = await setUp();
    await writeSourceFile(sources, "Notes/Chapter 1.txt", "Chapter 1: urban heat.");
    await writeSourceFile(sources, "Notes/Chapter 2.txt", "Chapter 2: field data.");
    const batches = batchesOf(core);

    const linked = await core.addLinkedFolder(join(sources, "Notes"), { groupId: thesis.id });

    const last = await batches.until(
      linked.batchId,
      (batch) => !batch.adding && batch.sorted === 2,
    );
    expect(last).toMatchObject({ groupId: thesis.id, read: 2, suggested: [] });
    expect((await core.getLibrary()).assignments).toEqual(
      last.documentIds.map((documentId) =>
        expect.objectContaining({ documentId, groupId: thesis.id, source: "user" }),
      ),
    );
  });

  test("a first scan paused before it ends still files what it finds once resumed", async () => {
    const { core, thesis, sources } = await setUp();
    await writeSourceFile(sources, "Notes/Chapter 1.txt", "Chapter 1: urban heat.");
    await writeSourceFile(sources, "Notes/Chapter 2.txt", "Chapter 2: field data.");
    const batches = batchesOf(core);

    const linked = await core.addLinkedFolder(join(sources, "Notes"), { groupId: thesis.id });
    await core.setLinkedFolderPaused(linked.id, true);
    await core.setLinkedFolderPaused(linked.id, false);

    const last = await batches.until(
      linked.batchId,
      (batch) => !batch.adding && batch.sorted === 2,
    );
    expect((await core.getLibrary()).assignments).toEqual(
      last.documentIds.map((documentId) =>
        expect.objectContaining({ documentId, groupId: thesis.id, source: "user" }),
      ),
    );
  });

  test("a folder inside one already linked, while it scans, files nothing into the Folder", async () => {
    const { core, thesis, sources } = await setUp();
    await writeSourceFile(sources, "Notes/Chapter 1.txt", "Chapter 1: urban heat.");
    const batches = batchesOf(core);
    const outer = await core.addLinkedFolder(join(sources, "Notes"));
    await batches.until(outer.batchId, (batch) => !batch.adding && batch.sorted === 1);
    // A later scan of it, with a new file to find.
    await core.setLinkedFolderPaused(outer.id, true);
    await writeSourceFile(sources, "Notes/Inner/Chapter 2.txt", "Chapter 2: field data.");
    await core.setLinkedFolderPaused(outer.id, false);

    const inner = await core.addLinkedFolder(join(sources, "Notes", "Inner"), {
      groupId: thesis.id,
    });

    expect(inner.id).toBe(outer.id);
    expect(await batches.until(inner.batchId, (batch) => !batch.adding)).toMatchObject({
      documentIds: [],
    });
    await vi.waitFor(async () => {
      const { assignments } = await core.getLibrary();
      expect(assignments).toHaveLength(2);
      for (const assignment of assignments) {
        expect(assignment).toMatchObject({
          groupId: thesis.id,
          source: "automatic",
          suggested: true,
          status: "classified",
        });
      }
    });
  });

  test("adding to a Folder that doesn't exist adds nothing", async () => {
    const { core, sources } = await setUp();
    const path = await writeSourceFile(sources, "Invoice 1.txt", "Invoice 1: GBP 100.");

    await expect(core.addDocuments([path], { groupId: "no-such-folder" })).rejects.toThrow(
      NotFoundError,
    );
    await expect(core.addLinkedFolder(sources, { groupId: "no-such-folder" })).rejects.toThrow(
      NotFoundError,
    );
    expect(await core.listDocuments()).toEqual([]);
    expect(await core.listLinkedFolders()).toEqual([]);
  });

  test("automatic Organize is on, waits until the User lets it use a model, and stays off once turned off", async () => {
    const fake = sorter();
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const core = startCore(dataDir, { createChatModel: () => fake.model });
    expect((await core.getLibrary()).settings).toEqual({
      classifier: { kind: "automatic" },
      automatic: true,
      organizeWith: null,
      taggingStopped: [],
    });
    await core.createLibraryGroup({ name: "Thesis", description: "Research for my thesis" });
    const add = async (on: Core, name: string) => {
      const [document] = await addAndProcess(on, [
        await writeSourceFile(sources, `${name}.txt`, `${name}: urban heat.`),
      ]);
      if (!document) throw new Error("Not added.");
      return document;
    };

    // No model at all: Automatic has none to organize with, so the Document waits.
    const early = await add(core, "Chapter 1");
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, early.id)).toMatchObject({ status: "waiting" }),
    );
    // A chat model on this computer: Automatic tags with it, but Organize waits for "Use Ollama".
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const later = await add(core, "Chapter 2");
    await vi.waitFor(async () =>
      expect(await assignmentOf(core, later.id)).toMatchObject({ status: "waiting" }),
    );
    const { automatic: offered } = await core.getTaggingModels();
    if (!offered) throw new Error("Automatic picked nothing.");
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      organizeWith: offered.classifier,
    });
    for (const document of [early, later]) {
      await vi.waitFor(async () =>
        expect(await assignmentOf(core, document.id)).toMatchObject({
          status: "classified",
          suggested: true,
        }),
      );
    }

    const classifier = {
      kind: "chat" as const,
      choice: { providerId: provider.id, modelId: "small-classifier" },
    };
    await core.saveLibrarySettings({ classifier, automatic: false });
    core.close();
    const reopened = startCore(dataDir, { createChatModel: () => fake.model });
    // Automatic, then the model again, each saved as the settings show it.
    for (const next of [{ kind: "automatic" as const }, classifier]) {
      const { automatic } = (await reopened.getLibrary()).settings;
      await reopened.saveLibrarySettings({ classifier: next, automatic });
    }
    expect((await reopened.getLibrary()).settings).toEqual({
      classifier,
      automatic: false,
      organizeWith: offered.classifier,
      taggingStopped: [],
    });
    const third = await add(reopened, "Chapter 3");
    expect(await assignmentOf(reopened, third.id)).toBeUndefined();
  });
});

describe("Migration 36", () => {
  test("keeps every assignment made before it as it was, none of them a suggestion", async () => {
    const dataDir = await createTempDataFolder();
    const sources = await createSourceFolder();
    const at = "2026-10-01T09:00:00.000Z";
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      migrate(
        db,
        migrations.filter((migration) => migration.version < 36),
      );
      db.run(
        "INSERT INTO library_groups (id, name, description, created_at, updated_at) VALUES ('finance', 'Finance', 'Bills', ?, ?)",
        [at, at],
      );
      for (const [id, groupId, source] of [
        ["automatic", "finance", "automatic"],
        ["chosen", "finance", "user"],
        ["unsorted", null, "user"],
      ] as const) {
        const text = `The ${id} Document.`;
        const path = await writeSourceFile(sources, `${id}.txt`, text);
        db.run(
          `INSERT INTO documents (id, content_hash, name, kind, size, status, path, file_status,
             processing_version, metadata_version, created_at, updated_at)
           VALUES (?, ?, ?, 'text', ?, 'ready', ?, 'available', ?, ?, ?, ?)`,
          [
            id,
            sha256(text),
            id,
            Buffer.byteLength(text),
            path,
            BigInt(PROCESSING_VERSION),
            BigInt(METADATA_VERSION),
            at,
            at,
          ],
        );
        db.run(
          `INSERT INTO document_groups (id, document_id, group_id, source, status, content_hash,
             request_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'classified', ?, ?, ?, ?)`,
          [`assignment-${id}`, id, groupId, source, sha256(text), `request-${id}`, at, at],
        );
      }
    } finally {
      db.close();
    }

    const core = startCore(dataDir);

    expect((await core.getLibrary()).assignments).toEqual([
      expect.objectContaining({
        documentId: "automatic",
        groupId: "finance",
        source: "automatic",
        suggested: false,
      }),
      expect.objectContaining({
        documentId: "chosen",
        groupId: "finance",
        source: "user",
        suggested: false,
      }),
      expect.objectContaining({
        documentId: "unsorted",
        groupId: null,
        source: "user",
        suggested: false,
      }),
    ]);
    expect(await core.acceptAssignments(["automatic", "chosen", "unsorted"])).toEqual([]);
  });
});
