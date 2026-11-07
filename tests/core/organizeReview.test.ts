import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { type Core, DATABASE_FILE, type OrganizeReview } from "../../src/core";
import {
  createOrganizeReviewStore,
  type OrganizeReviewProposal,
  type OrganizeReviewRun,
  type TagsProposal,
} from "../../src/core/organizeReview";
import { openDatabase } from "../../src/core/storage";
import { createTempDataFolder, manualClock, nextEvent, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";

const DAY = 24 * 60 * 60 * 1000;

type Clock = ReturnType<typeof manualClock>;

/**
 * Writes proposals as a run will (#1569): nothing in the app proposes yet, so the test stands in
 * for the run, on the data folder's database beside the running core.
 */
function propose(
  dataDir: string,
  clock: Clock,
  run: OrganizeReviewRun,
  proposals: OrganizeReviewProposal[],
): number {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    return createOrganizeReviewStore(db, () => clock.now().toISOString()).propose(run, proposals);
  } finally {
    db.close();
  }
}

function proposeTags(
  dataDir: string,
  clock: Clock,
  run: OrganizeReviewRun,
  proposals: TagsProposal[],
): number {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    return createOrganizeReviewStore(db, () => clock.now().toISOString()).proposeTags(
      run,
      proposals,
    );
  } finally {
    db.close();
  }
}

/** A Library with three Documents, the Folder "Contracts" and the preset Tags. */
async function setUp(
  options: { dataDir?: string; core?: (dataDir: string, clock: Clock) => Core } = {},
) {
  const clock = manualClock("2026-11-07T09:00:00.000Z");
  const dataDir = options.dataDir ?? (await createTempDataFolder());
  const core = options.core?.(dataDir, clock) ?? startCore(dataDir, { now: clock.now });
  const sources = await createSourceFolder();
  const [lease, invoice, minutes] = await addAndProcess(
    core,
    await Promise.all(
      ["Lease.txt", "Invoice 0042.txt", "Board minutes.txt"].map((name) =>
        writeSourceFile(sources, name, `${name}: a few words about it.`),
      ),
    ),
  );
  if (!lease || !invoice || !minutes) throw new Error("Three Documents were added.");
  const contracts = await core.createLibraryGroup({
    name: "Contracts",
    description: "Signed agreements",
  });
  const invoiceTag = (await core.listTags()).find((tag) => tag.name === "Invoice");
  if (!invoiceTag) throw new Error("The preset Invoice Tag is there.");
  return { core, dataDir, clock, sources, lease, invoice, minutes, contracts, invoiceTag };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Organize from the Library: Lease into Contracts, the invoice into a new Finance, the minutes left out. */
function proposeFirstSort(setup: Setup, run: OrganizeReviewRun = { origin: "library" }) {
  return propose(setup.dataDir, setup.clock, run, [
    {
      documentId: setup.lease.id,
      contentHash: setup.lease.contentHash,
      placement: { kind: "folder", folderId: setup.contracts.id },
      tags: [{ name: "Property", description: "Buildings and land" }],
    },
    {
      documentId: setup.invoice.id,
      contentHash: setup.invoice.contentHash,
      placement: { kind: "newFolder", name: "Finance", description: "Bills and statements" },
      tags: [{ tagId: setup.invoiceTag.id }],
    },
    {
      documentId: setup.minutes.id,
      contentHash: setup.minutes.contentHash,
      placement: { kind: "leftOut", leftOut: { reason: "doesntFit" } },
      tags: [],
    },
  ]);
}

const rowOf = (review: OrganizeReview, documentId: string) => {
  const row = review.items.find((item) => item.documentId === documentId);
  if (!row) throw new Error(`No row waits for ${documentId}.`);
  return row;
};

/** What the User would see of the Suggestions, ids of rows aside. */
const shown = (review: OrganizeReview) => ({
  count: review.count,
  folders: review.folders.map((folder) => folder.name),
  items: review.items.map(({ documentId, placement, ticked, tags }) => ({
    documentId,
    placement:
      placement.kind === "newFolder"
        ? {
            kind: "newFolder",
            name: review.folders.find((folder) => folder.id === placement.newFolderId)?.name,
          }
        : placement,
    ticked,
    tags: tags.map((tag) => tag.name),
  })),
});

const assignmentOf = async (core: Core, documentId: string) =>
  (await core.getLibrary()).assignments.find((each) => each.documentId === documentId);

const tagsOn = async (core: Core, documentId: string) => {
  const document = (await core.listDocuments()).find((each) => each.id === documentId);
  const names = new Map((await core.listTags()).map((tag) => [tag.id, tag.name]));
  return (document?.tags ?? []).map((tag) => ({ name: names.get(tag.tagId), source: tag.source }));
};

describe("Suggestions wait until the User confirms them", () => {
  test("a run's proposals wait, and nothing reaches the Library before Confirm", async () => {
    const setup = await setUp();
    const { core, lease, invoice, minutes, contracts } = setup;

    expect(proposeFirstSort(setup)).toBe(3);

    const review = await core.getOrganizeReview();
    expect(shown(review)).toEqual({
      count: 2,
      folders: ["Finance"],
      items: [
        {
          documentId: lease.id,
          placement: { kind: "folder", folderId: contracts.id },
          ticked: true,
          tags: ["Property"],
        },
        {
          documentId: invoice.id,
          placement: { kind: "newFolder", name: "Finance" },
          ticked: true,
          tags: ["Invoice"],
        },
        {
          documentId: minutes.id,
          placement: { kind: "leftOut", leftOut: { reason: "doesntFit" } },
          ticked: true,
          tags: [],
        },
      ],
    });
    const library = await core.getLibrary();
    expect(library.reviewCount).toBe(2);
    expect(library.groups.map((group) => group.name)).toEqual(["Contracts"]);
    expect(library.assignments.filter((each) => each.groupId !== null)).toEqual([]);
    expect((await core.listTags()).some((tag) => tag.name === "Property")).toBe(false);
    expect(await tagsOn(core, invoice.id)).toEqual([]);
  });

  test("each edit is one step that its restore takes back, and restoring the other way does it again", async () => {
    const setup = await setUp();
    const { core, lease, invoice, minutes, contracts, invoiceTag } = setup;
    proposeFirstSort(setup);
    const start = await core.getOrganizeReview();
    const finance = start.folders[0];
    if (!finance) throw new Error("Finance is proposed.");
    const leaseRow = rowOf(start, lease.id);
    const invoiceRow = rowOf(start, invoice.id);
    const property = leaseRow.tags[0];
    if (!property) throw new Error("Property is proposed.");

    const edits = [
      {
        edit: { kind: "tick" as const, itemIds: [leaseRow.id], ticked: false },
        check: (review: OrganizeReview) => expect(rowOf(review, lease.id).ticked).toBe(false),
      },
      {
        edit: {
          kind: "move" as const,
          itemIds: [leaseRow.id],
          to: { kind: "newFolder" as const, newFolderId: finance.id },
        },
        check: (review: OrganizeReview) =>
          expect(rowOf(review, lease.id).placement).toEqual({
            kind: "newFolder",
            newFolderId: finance.id,
          }),
      },
      {
        edit: { kind: "move" as const, itemIds: [invoiceRow.id], to: { kind: "leftOut" as const } },
        check: (review: OrganizeReview) =>
          expect(rowOf(review, invoice.id).placement).toEqual({ kind: "leftOut", leftOut: null }),
      },
      {
        edit: {
          kind: "move" as const,
          itemIds: [rowOf(start, minutes.id).id],
          to: { kind: "folder" as const, folderId: contracts.id },
        },
        check: (review: OrganizeReview) =>
          expect(rowOf(review, minutes.id).placement).toEqual({
            kind: "folder",
            folderId: contracts.id,
          }),
      },
      {
        edit: {
          kind: "addTag" as const,
          itemId: leaseRow.id,
          tag: { name: "Landlord", description: "Who owns the place" },
        },
        check: (review: OrganizeReview) =>
          expect(rowOf(review, lease.id).tags.map((tag) => tag.name)).toEqual([
            "Property",
            "Landlord",
          ]),
      },
      {
        edit: { kind: "addTag" as const, itemId: invoiceRow.id, tag: { tagId: invoiceTag.id } },
        check: (review: OrganizeReview) =>
          expect(rowOf(review, invoice.id).tags.map((tag) => tag.name)).toEqual(["Invoice"]),
        nothing: true,
      },
      {
        edit: { kind: "removeTag" as const, itemId: leaseRow.id, tagRowId: property.id },
        check: (review: OrganizeReview) => expect(rowOf(review, lease.id).tags).toEqual([]),
      },
      {
        edit: { kind: "renameFolder" as const, newFolderId: finance.id, name: "Money" },
        check: (review: OrganizeReview) =>
          expect(review.folders.map((folder) => folder.name)).toEqual(["Money"]),
      },
      {
        edit: {
          kind: "mergeFolder" as const,
          newFolderId: finance.id,
          into: { kind: "folder" as const, folderId: contracts.id },
        },
        check: (review: OrganizeReview) => {
          expect(review.folders).toEqual([]);
          expect(rowOf(review, invoice.id).placement).toEqual({
            kind: "folder",
            folderId: contracts.id,
          });
        },
      },
    ];

    for (const { edit, check, nothing } of edits) {
      const said = nextEvent(core, "organizeReview.changed");
      const change = await core.editOrganizeReview(edit);
      if (nothing) {
        expect(change).toEqual({ before: [], after: [] });
        continue;
      }
      await said;
      check(await core.getOrganizeReview());
      expect(await core.restoreOrganizeReview(change.before, change.after)).not.toBeNull();
      expect(shown(await core.getOrganizeReview())).toEqual(shown(start));
      expect(await core.restoreOrganizeReview(change.after, change.before)).not.toBeNull();
      check(await core.getOrganizeReview());
      await core.restoreOrganizeReview(change.before, change.after);
    }
    expect(shown(await core.getOrganizeReview())).toEqual(shown(start));
    // Nothing reached the Library on the way.
    expect((await core.getLibrary()).assignments.filter((each) => each.groupId !== null)).toEqual(
      [],
    );
  });

  test("a restore leaves a row changed since as it is", async () => {
    const setup = await setUp();
    const { core, lease } = setup;
    proposeFirstSort(setup);
    const row = rowOf(await core.getOrganizeReview(), lease.id);

    const untick = await core.editOrganizeReview({
      kind: "tick",
      itemIds: [row.id],
      ticked: false,
    });
    await core.editOrganizeReview({ kind: "move", itemIds: [row.id], to: { kind: "leftOut" } });

    expect(await core.restoreOrganizeReview(untick.before, untick.after)).toBeNull();
    expect(rowOf(await core.getOrganizeReview(), lease.id)).toMatchObject({
      ticked: false,
      placement: { kind: "leftOut", leftOut: null },
    });
  });
});

describe("What the User turns down isn't proposed again for 30 days", () => {
  test("an unticked row's Folder and Tags, and a Tag taken off", async () => {
    const setup = await setUp();
    const { core, clock, lease, invoice, minutes } = setup;
    proposeFirstSort(setup);
    const review = await core.getOrganizeReview();
    const invoiceRow = rowOf(review, invoice.id);
    const invoiceTag = invoiceRow.tags[0];
    if (!invoiceTag) throw new Error("Invoice is proposed.");
    await core.editOrganizeReview({
      kind: "tick",
      itemIds: [rowOf(review, lease.id).id],
      ticked: false,
    });
    await core.editOrganizeReview({
      kind: "removeTag",
      itemId: invoiceRow.id,
      tagRowId: invoiceTag.id,
    });
    await core.discardOrganizeReview(review.items.map((item) => item.id));

    // The lease, its Folder and Tag both turned down, isn't proposed at all.
    expect(proposeFirstSort(setup)).toBe(2);
    expect(shown(await core.getOrganizeReview()).items).toEqual([
      {
        documentId: invoice.id,
        placement: { kind: "newFolder", name: "Finance" },
        ticked: true,
        tags: [],
      },
      {
        documentId: minutes.id,
        placement: { kind: "leftOut", leftOut: { reason: "doesntFit" } },
        ticked: true,
        tags: [],
      },
    ]);
    await core.discardOrganizeReview((await core.getOrganizeReview()).items.map((item) => item.id));

    clock.advance(29 * DAY);
    proposeFirstSort(setup);
    expect(rowOf(await core.getOrganizeReview(), invoice.id).tags).toEqual([]);
    expect(
      (await core.getOrganizeReview()).items.some((item) => item.documentId === lease.id),
    ).toBe(false);
    await core.discardOrganizeReview((await core.getOrganizeReview()).items.map((item) => item.id));

    clock.advance(2 * DAY);
    proposeFirstSort(setup);
    const later = await core.getOrganizeReview();
    expect(rowOf(later, lease.id).tags.map((tag) => tag.name)).toEqual(["Property"]);
    expect(rowOf(later, invoice.id).tags.map((tag) => tag.name)).toEqual(["Invoice"]);
  });

  test("ticking a row again takes its decline back", async () => {
    const setup = await setUp();
    const { core, lease } = setup;
    proposeFirstSort(setup);
    const row = rowOf(await core.getOrganizeReview(), lease.id);
    await core.editOrganizeReview({ kind: "tick", itemIds: [row.id], ticked: false });
    await core.editOrganizeReview({ kind: "tick", itemIds: [row.id], ticked: true });
    await core.discardOrganizeReview([row.id]);

    proposeFirstSort(setup);
    expect(rowOf(await core.getOrganizeReview(), lease.id).tags.map((tag) => tag.name)).toEqual([
      "Property",
    ]);
  });
});

describe("The User's own choices stand", () => {
  test("a Document the User filed is proposed a move only by a run they start on its Folder", async () => {
    const setup = await setUp();
    const { core, dataDir, clock, lease, contracts } = setup;
    await core.moveToFolder({
      folderId: contracts.id,
      documentIds: [lease.id],
      mindIds: [],
      conversationIds: [],
    });
    const leases: OrganizeReviewProposal = {
      documentId: lease.id,
      contentHash: lease.contentHash,
      placement: { kind: "newFolder", name: "Leases", description: "Rented places" },
      tags: [],
    };

    expect(propose(dataDir, clock, { origin: "background" }, [leases])).toBe(0);
    expect(propose(dataDir, clock, { origin: "library" }, [leases])).toBe(0);
    expect((await core.getOrganizeReview()).items).toEqual([]);

    expect(propose(dataDir, clock, { origin: "folder", folderId: contracts.id }, [leases])).toBe(1);
    expect(shown(await core.getOrganizeReview()).items).toEqual([
      {
        documentId: lease.id,
        placement: { kind: "newFolder", name: "Leases" },
        ticked: true,
        tags: [],
      },
    ]);
    expect(await assignmentOf(core, lease.id)).toMatchObject({
      groupId: contracts.id,
      source: "user",
    });
  });

  test("a Tag the User added or took off is never proposed", async () => {
    const setup = await setUp();
    const { core, dataDir, clock, invoice, invoiceTag } = setup;
    const report = (await core.listTags()).find((tag) => tag.name === "Report");
    if (!report) throw new Error("The preset Report Tag is there.");
    await core.addDocumentTag(invoice.id, invoiceTag.id);
    await core.removeDocumentTag(invoice.id, report.id);

    proposeTags(dataDir, clock, { origin: "background" }, [
      {
        documentId: invoice.id,
        contentHash: invoice.contentHash,
        tags: [
          { tagId: invoiceTag.id },
          { tagId: report.id },
          { name: "Receipts", description: "Proof of payment" },
        ],
      },
    ]);
    expect(shown(await core.getOrganizeReview()).items).toEqual([
      {
        documentId: invoice.id,
        placement: { kind: "unchanged" },
        ticked: true,
        tags: ["Receipts"],
      },
    ]);
  });

  test("a background run never writes over a row the User edited, nor one still current", async () => {
    const setup = await setUp();
    const { core, lease, invoice, contracts } = setup;
    proposeFirstSort(setup);
    const before = await core.getOrganizeReview();
    await core.editOrganizeReview({
      kind: "move",
      itemIds: [rowOf(before, invoice.id).id],
      to: { kind: "folder", folderId: contracts.id },
    });
    const edited = await core.getOrganizeReview();

    expect(proposeFirstSort(setup, { origin: "background" })).toBe(0);
    expect(await core.getOrganizeReview()).toEqual(edited);

    // A run the User starts replaces what they haven't edited, and leaves the rest.
    expect(proposeFirstSort(setup, { origin: "library" })).toBe(2);
    const after = await core.getOrganizeReview();
    expect(rowOf(after, invoice.id)).toEqual(rowOf(edited, invoice.id));
    expect(rowOf(after, lease.id).id).not.toBe(rowOf(edited, lease.id).id);
  });
});

describe("Confirm makes it the User's, in one step with one Undo", () => {
  test("Confirm makes the Folders, files and tags; Undo takes back what is still as it left it", async () => {
    const setup = await setUp();
    const { core, sources, lease, invoice, minutes, contracts } = setup;
    propose(setup.dataDir, setup.clock, { origin: "library" }, [
      {
        documentId: lease.id,
        contentHash: lease.contentHash,
        placement: { kind: "newFolder", name: "Leases", description: "Rented places" },
        tags: [{ name: "Property", description: "Buildings and land" }],
      },
      {
        documentId: invoice.id,
        contentHash: invoice.contentHash,
        placement: { kind: "newFolder", name: "Finance", description: "Bills and statements" },
        tags: [{ tagId: setup.invoiceTag.id }],
      },
      {
        documentId: minutes.id,
        contentHash: minutes.contentHash,
        placement: { kind: "folder", folderId: contracts.id },
        tags: [],
      },
    ]);
    const review = await core.getOrganizeReview();

    const said = nextEvent(core, "organizeReview.changed");
    const confirmed = await core.confirmOrganizeReview(review.items.map((item) => item.id));
    expect(await said).toEqual({ count: 0 });
    if (!confirmed) throw new Error("It confirmed.");
    expect(new Set(confirmed.documentIds)).toEqual(new Set([lease.id, invoice.id, minutes.id]));
    expect(confirmed.folderIds).toHaveLength(2);
    expect(confirmed.tagIds).toHaveLength(1);

    const library = await core.getLibrary();
    const folderNamed = (name: string) => library.groups.find((group) => group.name === name);
    const leases = folderNamed("Leases");
    const finance = folderNamed("Finance");
    if (!leases || !finance) throw new Error("Confirm made Leases and Finance.");
    expect(library.reviewCount).toBe(0);
    for (const [documentId, groupId] of [
      [lease.id, leases.id],
      [invoice.id, finance.id],
      [minutes.id, contracts.id],
    ] as const) {
      expect(await assignmentOf(core, documentId)).toMatchObject({
        groupId,
        source: "user",
        suggested: false,
      });
    }
    expect(await tagsOn(core, lease.id)).toEqual([{ name: "Property", source: "user" }]);
    expect(await tagsOn(core, invoice.id)).toEqual([{ name: "Invoice", source: "user" }]);
    expect((await core.listTags()).find((tag) => tag.name === "Property")?.madeByUser).toBe(true);
    expect((await core.getOrganizeReview()).items).toEqual([]);

    // Since then the User put another Document into Finance, and moved the minutes.
    const [notes] = await addAndProcess(core, [
      await writeSourceFile(sources, "Budget notes.txt", "Budget notes: a few words."),
    ]);
    if (!notes) throw new Error("Notes were added.");
    await core.moveToFolder({
      folderId: finance.id,
      documentIds: [notes.id],
      mindIds: [],
      conversationIds: [],
    });
    await core.assignDocumentGroup(minutes.id, null);

    await core.undoOrganizeReviewConfirmation(confirmed.id);

    const undone = await core.getLibrary();
    expect(undone.groups.map((group) => group.name)).toEqual(["Contracts", "Finance"]);
    expect((await core.listDeleted()).map((item) => item.name)).toEqual(
      expect.arrayContaining(["Leases", "Property"]),
    );
    expect((await assignmentOf(core, lease.id))?.groupId ?? null).toBeNull();
    expect((await assignmentOf(core, invoice.id))?.groupId ?? null).toBeNull();
    expect(await assignmentOf(core, minutes.id)).toMatchObject({ groupId: null, source: "user" });
    expect(await assignmentOf(core, notes.id)).toMatchObject({ groupId: finance.id });
    expect(await tagsOn(core, lease.id)).toEqual([]);
    expect(await tagsOn(core, invoice.id)).toEqual([]);
    expect(shown(await core.getOrganizeReview())).toEqual({
      count: 3,
      folders: ["Leases"],
      items: [
        {
          documentId: lease.id,
          placement: { kind: "newFolder", name: "Leases" },
          ticked: true,
          tags: ["Property"],
        },
        // Finance stayed, as Budget notes went into it: the invoice waits to go into it.
        {
          documentId: invoice.id,
          placement: { kind: "folder", folderId: finance.id },
          ticked: true,
          tags: ["Invoice"],
        },
        {
          documentId: minutes.id,
          placement: { kind: "folder", folderId: contracts.id },
          ticked: true,
          tags: [],
        },
      ],
    });

    const again = await core.redoOrganizeReviewConfirmation(confirmed.id);
    expect(again?.id).toBe(confirmed.id);
    const redone = await core.getLibrary();
    expect(redone.groups.find((group) => group.name === "Leases")?.id).toBe(leases.id);
    expect(await assignmentOf(core, lease.id)).toMatchObject({
      groupId: leases.id,
      source: "user",
    });
    expect(await assignmentOf(core, minutes.id)).toMatchObject({ groupId: contracts.id });
    expect(await tagsOn(core, lease.id)).toEqual([{ name: "Property", source: "user" }]);
    expect((await core.listDeleted()).map((item) => item.name)).not.toContain("Leases");
    expect(redone.reviewCount).toBe(0);
  });

  test("a left-out row's Tags wait: Confirm adds those of the rows it files, and none of a left-out one", async () => {
    const setup = await setUp();
    const { core, dataDir, clock, lease, minutes, contracts, invoiceTag } = setup;
    propose(dataDir, clock, { origin: "library" }, [
      {
        documentId: lease.id,
        contentHash: lease.contentHash,
        placement: { kind: "folder", folderId: contracts.id },
        tags: [{ tagId: invoiceTag.id }],
      },
      {
        documentId: minutes.id,
        contentHash: minutes.contentHash,
        placement: { kind: "leftOut", leftOut: { reason: "doesntFit" } },
        tags: [{ tagId: invoiceTag.id }],
      },
    ]);

    await core.confirmOrganizeReview((await core.getOrganizeReview()).items.map((item) => item.id));

    expect(await tagsOn(core, lease.id)).toEqual([{ name: "Invoice", source: "user" }]);
    expect(await tagsOn(core, minutes.id)).toEqual([]);
    expect((await assignmentOf(core, minutes.id))?.groupId ?? null).toBeNull();
  });

  test("an unticked row closes with nothing done, and a row added since keeps waiting", async () => {
    const setup = await setUp();
    const { core, dataDir, clock, lease, invoice, minutes } = setup;
    proposeFirstSort(setup);
    const seen = await core.getOrganizeReview();
    await core.editOrganizeReview({
      kind: "tick",
      itemIds: [rowOf(seen, invoice.id).id],
      ticked: false,
    });
    const later = minutes.id;
    await core.discardOrganizeReview([rowOf(seen, later).id]);
    propose(dataDir, clock, { origin: "background" }, [
      {
        documentId: later,
        contentHash: minutes.contentHash,
        placement: { kind: "newFolder", name: "Board", description: "Board papers" },
        tags: [],
      },
    ]);

    await core.confirmOrganizeReview([rowOf(seen, lease.id).id, rowOf(seen, invoice.id).id]);

    expect((await core.getLibrary()).groups.map((group) => group.name)).toEqual(["Contracts"]);
    expect((await assignmentOf(core, invoice.id))?.groupId ?? null).toBeNull();
    expect(await tagsOn(core, invoice.id)).toEqual([]);
    expect(shown(await core.getOrganizeReview()).items).toEqual([
      {
        documentId: later,
        placement: { kind: "newFolder", name: "Board" },
        ticked: true,
        tags: [],
      },
    ]);
  });
});

describe("Discard sets the Suggestions aside, with Undo", () => {
  test("Discard and its restore", async () => {
    const setup = await setUp();
    const { core, dataDir, clock, invoice } = setup;
    proposeFirstSort(setup);
    const start = await core.getOrganizeReview();

    const discardId = await core.discardOrganizeReview(start.items.map((item) => item.id));
    if (!discardId) throw new Error("It discarded.");
    expect(await core.getOrganizeReview()).toEqual({ items: [], folders: [], count: 0 });
    expect((await core.getLibrary()).reviewCount).toBe(0);

    // A run since proposed the invoice again: that row stays, the discarded one doesn't double it.
    propose(dataDir, clock, { origin: "library" }, [
      {
        documentId: invoice.id,
        contentHash: invoice.contentHash,
        placement: { kind: "unchanged" },
        tags: [{ name: "Receipts", description: "Proof of payment" }],
      },
    ]);
    await core.restoreDiscardedOrganizeReview(discardId);

    const back = await core.getOrganizeReview();
    expect(back.items.map((item) => item.documentId).sort()).toEqual(
      start.items.map((item) => item.documentId).sort(),
    );
    expect(rowOf(back, invoice.id).tags.map((tag) => tag.name)).toEqual(["Receipts"]);
  });
});

test("Suggestions and the User's changes to them are kept across a restart", async () => {
  const setup = await setUp();
  const { core, dataDir, lease } = setup;
  proposeFirstSort(setup);
  const row = rowOf(await core.getOrganizeReview(), lease.id);
  await core.editOrganizeReview({ kind: "tick", itemIds: [row.id], ticked: false });
  const before = await core.getOrganizeReview();
  core.close();

  const again = startCore(dataDir, { now: setup.clock.now });
  expect(await again.getOrganizeReview()).toEqual(before);
  expect((await again.getLibrary()).reviewCount).toBe(before.count);
  const confirmed = await again.confirmOrganizeReview(before.items.map((item) => item.id));
  expect(confirmed?.documentIds.length).toBe(1);
});

test("editing, confirming and discarding send nothing anywhere and ask no model", async () => {
  const requests = vi.fn();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      requests();
      throw new Error("Nothing here asks a model.");
    },
  });
  const made = vi.fn(() => model);
  const fetched = vi.spyOn(globalThis, "fetch");
  const setup = await setUp({
    core: (dataDir, clock) => startCore(dataDir, { now: clock.now, createChatModel: made }),
  });
  const { core, lease, invoice } = setup;
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
  await core.saveLibrarySettings({
    classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "main-model" } },
    automatic: false,
  });
  proposeFirstSort(setup);
  made.mockClear();
  fetched.mockClear();

  const review = await core.getOrganizeReview();
  const leaseRow = rowOf(review, lease.id);
  await core.editOrganizeReview({
    kind: "addTag",
    itemId: leaseRow.id,
    tag: { name: "Landlord", description: "Who owns the place" },
  });
  await core.editOrganizeReview({
    kind: "tick",
    itemIds: [rowOf(review, invoice.id).id],
    ticked: false,
  });
  const confirmed = await core.confirmOrganizeReview(review.items.map((item) => item.id));
  if (!confirmed) throw new Error("It confirmed.");
  await core.undoOrganizeReviewConfirmation(confirmed.id);
  await core.redoOrganizeReviewConfirmation(confirmed.id);
  await core.undoOrganizeReviewConfirmation(confirmed.id);
  const discarded = await core.discardOrganizeReview(review.items.map((item) => item.id));
  if (discarded) await core.restoreDiscardedOrganizeReview(discarded);
  await new Promise((resolve) => setImmediate(resolve));

  expect(made).not.toHaveBeenCalled();
  expect(requests).not.toHaveBeenCalled();
  expect(fetched).not.toHaveBeenCalled();
  fetched.mockRestore();
});
