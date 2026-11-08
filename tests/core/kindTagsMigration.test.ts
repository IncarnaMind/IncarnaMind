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
      [tag.report, "Report", "A report of findings.", "report", 0],
      [tag.contract, "Agreements", "Signed agreements.", "contract", 1],
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
    // One the User changed keeps their words, and is its kind.
    expect(named(tag.contract)).toMatchObject({ kind: "contract", name: "Agreements" });
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
    expect(await tagNamesOf(core, doc.lease)).toEqual(["Agreements"]);
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
      "Agreements",
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
    for (const [tagId, name, preset, at] of [
      [tag.report, "Report", "report", AT],
      [tag.reports, "Reports", null, AT],
      [tag.chineseReport, "报告", null, "2026-11-02T09:00:00.000Z"],
    ] as const)
      db.run(
        `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
         VALUES (?, ?, '', ?, 0, 'blue', ?, ?)`,
        [tagId, name, preset, at, at],
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

  // protects=in a Library from before the kinds, a kind that has no Tag yet is the User's own Tag of its name on Confirm, so the Library never holds two "Letter" Tags; fails_when=Confirm makes a second Tag named as the User's; no_claim=which kind the model picks.
  test("Confirm uses the User's own Tag named as a kind that has no Tag yet", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 139),
    );
    const letter = randomUUID();
    db.run(
      `INSERT INTO tags (id, name, description, preset, made_by_user, colour, created_at, updated_at)
       VALUES (?, 'Letter', 'Letters I keep.', NULL, 1, 'green', ?, ?)`,
      [letter, AT, AT],
    );
    db.close();
    const tagging = taggingModel(["Letter"]);
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(tagging.model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "To the council.txt",
        "Dear councillor, I write about the bins.",
      ),
    ]);
    if (!document) throw new Error("Nothing was added.");
    await waitForTagging(core, [document.id]);
    const review = await core.getOrganizeReview();
    expect(review.items.flatMap((item) => item.tags.map((tag) => tag.name))).toEqual(["Letter"]);

    await core.confirmOrganizeReview(review.items.map((item) => item.id));

    const named = (await core.listTags()).filter((tag) => tag.name === "Letter");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ id: letter, kind: "letter", description: "Letters I keep." });
    expect(await tagNamesOf(core, document.id)).toEqual(["Letter"]);
  });
});
