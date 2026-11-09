/**
 * Migration 140 (#2339): a preset Tag of a kind becomes that kind's Tag, shown in the interface's
 * language unless the User changed it; a Tag tagging made under a kind's name is merged into it;
 * the User's own Tags stay as they are; and an uncertain Tag waits in the Review instead of on
 * its Document. Through the core's public interface once migrated.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";
import { taggingModel, tagNamesOf, waitForTagging } from "../helpers/tags";

const AT = "2026-11-01T09:00:00.000Z";

describe("Migration 140: kinds and uncertain Tags", () => {
  test("each kind of existing Tag becomes what the design says", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    const id = () => randomUUID();
    const tag = {
      report: id(),
      contract: id(),
      notes: id(),
      reports: id(),
      chineseReport: id(),
      kitchen: id(),
      mine: id(),
    };
    const doc = { lease: id(), q1: id(), q2: id(), quote: id() };
    const tags: [string, string, string, string | null, number][] = [
      // id, name, description, preset, made_by_user
      [
        tag.report,
        "Report",
        "A report of findings, analysis or progress, such as a business, technical, financial or government report.",
        "report",
        0,
      ],
      [tag.contract, "Client files", "Signed agreements.", "contract", 1],
      [tag.notes, "Notes", "Informal notes.", "notes", 0],
      [tag.reports, "Reports", "Made by tagging.", null, 0],
      [tag.chineseReport, "报告", "由打标签生成。", null, 0],
      [tag.kitchen, "Kitchen renovation", "Made by tagging.", null, 0],
      [tag.mine, "Report Q3", "The User's own.", null, 1],
    ];
    for (const [tagId, name, description, preset, mine] of tags)
      db.run(
        `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'blue', ?, ?)`,
        [tagId, name, description, preset, mine, AT, AT],
      );
    for (const [docId, name] of [
      [doc.lease, "Lease"],
      [doc.q1, "Q1 report"],
      [doc.q2, "Q2 report"],
      [doc.quote, "Kitchen quote"],
    ] as const)
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, tagging_status, created_at, updated_at)
         VALUES (?, ?, ?, 'markdown', 10, 'ready', 'tagged', ?, ?)`,
        [docId, `hash-${name}`, name, AT, AT],
      );
    const links: [string, string, string, number][] = [
      // document, Tag, source, needs_review
      [doc.lease, tag.contract, "automatic", 0],
      [doc.q1, tag.reports, "automatic", 0],
      [doc.q1, tag.report, "user", 0],
      [doc.q2, tag.chineseReport, "automatic", 0],
      [doc.q2, tag.mine, "user", 0],
      [doc.quote, tag.kitchen, "automatic", 1],
    ];
    for (const [documentId, tagId, source, review] of links)
      db.run(
        `INSERT INTO document_tags (id, document_id, tag_id, source, needs_review, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), documentId, tagId, source, review, AT, AT],
      );
    db.close();

    const core = startCore(dataDir);
    const listed = await core.listTags();
    const named = (tagId: string) => listed.find((each) => each.id === tagId);

    // A preset no one changed is its kind, named in the interface's language.
    expect(named(tag.report)).toMatchObject({ kind: "report", name: "Report" });
    // One the User renamed stays an ordinary Tag of theirs: it is given no kind's Documents.
    expect(named(tag.contract)).toMatchObject({ kind: null, name: "Client files" });
    // Notes is no kind: it stays a Tag as it was.
    expect(named(tag.notes)).toMatchObject({ kind: null, name: "Notes" });
    // Tags tagging made under a kind's name are merged into it, and wait in no Recently deleted.
    expect(named(tag.reports)).toBeUndefined();
    expect(named(tag.chineseReport)).toBeUndefined();
    expect((await core.listDeleted()).filter((each) => each.kind === "tag")).toEqual([]);
    expect(await tagNamesOf(core, doc.q1)).toEqual(["Report"]);
    expect(await tagNamesOf(core, doc.q2)).toEqual(["Report", "Report Q3"]);
    // The User's own Tag stays.
    expect(named(tag.mine)).toMatchObject({ kind: null, name: "Report Q3", madeByUser: true });
    expect(await tagNamesOf(core, doc.lease)).toEqual(["Client files"]);
    // An uncertain Tag is off its Document and waits in the Review.
    expect(await tagNamesOf(core, doc.quote)).toEqual([]);
    const review = await core.getOrganizeReview();
    expect(review.items.map((item) => [item.documentId, item.placement, item.origin])).toEqual([
      [doc.quote, { kind: "unchanged" }, "migrated"],
    ]);
    expect(review.items[0]?.tags.map((each) => each.name)).toEqual(["Kitchen renovation"]);

    await core.updateSettings({ user: { language: "zh-CN" } });
    expect((await core.listTags()).find((each) => each.id === tag.report)?.name).toBe("报告");
    expect((await core.listTags()).find((each) => each.id === tag.contract)?.name).toBe(
      "Client files",
    );
  });

  // protects=two Tags merged into one kind on one Document leave one link to it, the User's where one is theirs, and a kind's Tag the User took off a Document stays off; fails_when=the migration stops on two links to the kind (and the app can't start), or tagging's link puts back what the User took off; no_claim=which Tags count as a kind's.
  test("two merged into one kind leave one link, and one the User took off stays off", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    const id = () => randomUUID();
    const tag = { report: id(), reports: id(), chineseReport: id() };
    for (const [tagId, name, description, preset, at] of [
      [
        tag.report,
        "Report",
        "A report of findings, analysis or progress, such as a business, technical, financial or government report.",
        "report",
        AT,
      ],
      [tag.reports, "Reports", "", null, AT],
      [tag.chineseReport, "报告", "", null, "2026-11-02T09:00:00.000Z"],
    ] as const)
      db.run(
        `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'blue', ?, ?)`,
        [tagId, name, description, preset, at, at],
      );
    const doc = { both: id(), mine: id(), off: id() };
    for (const [docId, name] of [
      [doc.both, "Q1 report"],
      [doc.mine, "Q2 report"],
      [doc.off, "Q3 report"],
    ] as const)
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, tagging_status, created_at, updated_at)
         VALUES (?, ?, ?, 'markdown', 10, 'ready', 'tagged', ?, ?)`,
        [docId, `hash-${name}`, name, AT, AT],
      );
    const links: [string, string, string, string | null, string][] = [
      // document, Tag, source, deleted_at, created_at
      [doc.both, tag.reports, "automatic", null, "2026-11-03T09:00:00.000Z"],
      [doc.both, tag.chineseReport, "automatic", null, "2026-11-02T09:00:00.000Z"],
      [doc.mine, tag.reports, "automatic", null, AT],
      [doc.mine, tag.chineseReport, "user", null, "2026-11-04T09:00:00.000Z"],
      [doc.off, tag.report, "user", "2026-11-05T09:00:00.000Z", AT],
      [doc.off, tag.reports, "automatic", null, AT],
    ];
    for (const [documentId, tagId, source, deletedAt, at] of links)
      db.run(
        `INSERT INTO document_tags (id, document_id, tag_id, source, needs_review, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        [randomUUID(), documentId, tagId, source, at, at, deletedAt],
      );
    db.close();

    const core = startCore(dataDir);
    const linksOf = async (documentId: string) =>
      (await core.listDocuments())
        .find((each) => each.id === documentId)
        ?.tags.map((link) => [link.tagId, link.source]);

    expect(await linksOf(doc.both)).toEqual([[tag.report, "automatic"]]);
    expect(await linksOf(doc.mine)).toEqual([[tag.report, "user"]]);
    expect(await linksOf(doc.off)).toEqual([]);
    expect((await core.listTags()).filter((each) => each.kind === "report")).toHaveLength(1);
  });

  // protects=the User's own Tag under any of a kind's names, a plural or another word for it, in either language, is that kind's Tag before tagging's, which merges into it; fails_when=the User's "Contracts" is passed over while tagging's "agreements" becomes the kind; no_claim=the kinds' words.
  test("the User's own Tag under any of a kind's names is the kind's Tag: Contracts, 信件", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    const id = () => randomUUID();
    const tag = { contracts: id(), agreements: id(), letters: id() };
    for (const [tagId, name, byUser, at] of [
      [tag.agreements, "agreements", 0, AT],
      [tag.contracts, "Contracts", 1, "2026-11-02T09:00:00.000Z"],
      [tag.letters, "信件", 1, AT],
    ] as const)
      db.run(
        `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
         VALUES (?, ?, '', NULL, ?, 'green', ?, ?)`,
        [tagId, name, byUser, at, at],
      );
    db.close();

    const listed = await startCore(dataDir).listTags();

    expect(listed.find((each) => each.id === tag.contracts)).toMatchObject({
      kind: "contract",
      name: "Contracts",
    });
    expect(listed.find((each) => each.id === tag.letters)).toMatchObject({
      kind: "letter",
      name: "信件",
    });
    expect(listed.find((each) => each.id === tag.agreements)).toBeUndefined();
  });

  /**
   * A Library from before the kinds, so no kind but those of its presets has a Tag: one Tag of
   * the User's, Kitchen, keeps it from being seeded as a new one is.
   */
  async function updated(chosen: readonly string[]) {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    db.run(
      `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
       VALUES (?, 'Kitchen', '', NULL, 1, 'green', ?, ?)`,
      [randomUUID(), AT, AT],
    );
    db.close();
    const tagging = taggingModel(chosen);
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(tagging.model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createSourceFolder();
    const add = async (name: string, text: string) => {
      const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, text)]);
      if (!document) throw new Error(`Nothing was added for ${name}.`);
      await waitForTagging(core, [document.id]);
      return document;
    };
    const confirm = async () => {
      const review = await core.getOrganizeReview();
      const confirmation = await core.confirmOrganizeReview(review.items.map((item) => item.id));
      if (!confirmation) throw new Error("Nothing was confirmed.");
      return confirmation.id;
    };
    return { core, tagging, add, confirm };
  }

  // protects=a kind with no Tag yet goes, on Confirm, to the User's own Tag of its name, so the Library never holds two "Letter" Tags; its Undo gives that Tag back as it was, and Redo takes it again; fails_when=Confirm makes a second Tag of the User's name, or the Undo leaves their Tag a kind's; no_claim=which kind the model picks.
  test("Confirm uses the User's own Tag named as a kind with no Tag, and its Undo gives it back", async () => {
    const { core, add, confirm } = await updated(["Letter"]);
    const letter = await core.createTag({ name: "Letter", description: "Letters I keep." });
    const document = await add("To the council.txt", "Dear councillor, I write about the bins.");
    const review = await core.getOrganizeReview();
    expect(review.items.flatMap((item) => item.tags.map((tag) => tag.name))).toEqual(["Letter"]);

    const confirmed = await confirm();
    const named = (await core.listTags()).filter((tag) => tag.name === "Letter");
    expect(named).toEqual([
      expect.objectContaining({ id: letter.id, kind: "letter", description: "Letters I keep." }),
    ]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Letter"]);

    await core.undoOrganizeReviewConfirmation(confirmed);
    expect((await core.listTags()).find((tag) => tag.id === letter.id)).toMatchObject({
      kind: null,
      name: "Letter",
    });
    expect(await tagNamesOf(core, document.id)).toEqual([]);

    await core.redoOrganizeReviewConfirmation(confirmed);
    expect((await core.listTags()).filter((tag) => tag.name === "Letter")).toEqual([
      expect.objectContaining({ id: letter.id, kind: "letter" }),
    ]);
  });

  // protects=the Undo of a Confirm that made a kind's Tag takes it away without the User having deleted the kind, so the kind is still proposed and Redo makes it again; fails_when=the Undo leaves the kind's Tag in Recently deleted, and the kind is no longer offered; no_claim=the kind's words.
  test("the Undo of a Confirm that made a kind's Tag leaves the kind proposed", async () => {
    const { core, tagging, add, confirm } = await updated(["Letter"]);
    await add("To the council.txt", "Dear councillor, I write about the bins.");
    const confirmed = await confirm();
    expect((await core.listTags()).filter((tag) => tag.kind === "letter")).toHaveLength(1);

    await core.undoOrganizeReviewConfirmation(confirmed);
    expect((await core.listTags()).filter((tag) => tag.kind === "letter")).toEqual([]);
    expect((await core.listDeleted()).filter((each) => each.kind === "tag")).toEqual([]);

    const asked = tagging.requests.length;
    await add("To the school.txt", "Dear head teacher, I write about the trip.");
    expect(tagging.requests.slice(asked).flatMap((request) => request.names)).toContain("Letter");
    await core.redoOrganizeReviewConfirmation(confirmed);
    expect((await core.listTags()).filter((tag) => tag.kind === "letter")).toEqual([
      expect.objectContaining({ name: "Letter" }),
    ]);
  });

  // protects=a Document deleted before the update comes back from Recently deleted with one link to each kind's Tag, its tagging's included, and none to a merged Tag; fails_when=its restore fails on two links to one kind's Tag, or brings back a link to a merged Tag; no_claim=which Tags count as a kind's.
  test("a Document deleted before the update comes back with one link to the kind's Tag", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    const id = () => randomUUID();
    const tag = { report: id(), reports: id(), chineseReport: id() };
    for (const [tagId, name, description, preset] of [
      [
        tag.report,
        "Report",
        "A report of findings, analysis or progress, such as a business, technical, financial or government report.",
        "report",
      ],
      [tag.reports, "Reports", "", null],
      [tag.chineseReport, "报告", "", null],
    ] as const)
      db.run(
        `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'blue', ?, ?)`,
        [tagId, name, description, preset, AT, AT],
      );
    const deletedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const doc = { mine: id(), tagged: id() };
    for (const [docId, name] of [
      [doc.mine, "Q1 report"],
      [doc.tagged, "Q2 report"],
    ] as const)
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, tagging_status, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, 'markdown', 10, 'ready', 'tagged', ?, ?, ?)`,
        [docId, `hash-${name}`, name, AT, deletedAt, deletedAt],
      );
    for (const [documentId, tagId, source] of [
      [doc.mine, tag.reports, "user"],
      [doc.mine, tag.chineseReport, "user"],
      [doc.tagged, tag.reports, "automatic"],
    ] as const)
      db.run(
        `INSERT INTO document_tags (id, document_id, tag_id, source, needs_review, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
        [randomUUID(), documentId, tagId, source, AT, deletedAt, deletedAt],
      );
    db.close();

    const core = startCore(dataDir);
    await core.restore([
      { kind: "document", id: doc.mine },
      { kind: "document", id: doc.tagged },
    ]);

    const linksOf = async (documentId: string) =>
      (await core.listDocuments())
        .find((each) => each.id === documentId)
        ?.tags.map((link) => [link.tagId, link.source]);
    expect(await linksOf(doc.mine)).toEqual([[tag.report, "user"]]);
    expect(await linksOf(doc.tagged)).toEqual([[tag.report, "automatic"]]);
  });

  // protects=the User's own Tag named as a kind becomes that kind's Tag, keeping their words, and what tagging made under the kind's name merges into it, so the Library never shows two Tags of that name; fails_when=tagging's Tag becomes the kind's and the User's stays beside it; no_claim=the kinds' words.
  test("the User's own Tag named as a kind is the kind's Tag, and tagging's merges into it", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    const mine = randomUUID();
    const made = randomUUID();
    for (const [tagId, name, description, byUser, at] of [
      [made, "letters", "Made by tagging.", 0, AT],
      [mine, "Letter", "Letters I keep.", 1, "2026-11-02T09:00:00.000Z"],
    ] as const)
      db.run(
        `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 'green', ?, ?)`,
        [tagId, name, description, byUser, at, at],
      );
    db.close();

    const core = startCore(dataDir);
    const listed = await core.listTags();

    expect(listed.filter((each) => each.kind === "letter")).toEqual([
      expect.objectContaining({ id: mine, name: "Letter", description: "Letters I keep." }),
    ]);
    expect(listed.find((each) => each.id === made)).toBeUndefined();
  });
});
