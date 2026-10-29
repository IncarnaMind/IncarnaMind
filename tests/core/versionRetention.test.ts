import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Core,
  DATABASE_FILE,
  InvalidInputError,
  RETENTION_KINDS,
  type RetentionKind,
} from "../../src/core";
import { openDatabase } from "../../src/core/storage";
import {
  createTempDataFolder,
  manualClock,
  nextEvent,
  queryDatabase,
  startCore,
} from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkAndProcess,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { buildPdf } from "../helpers/pdf";

/*
 * Features other than Citations (check results, saved pages, unfinished
 * Tasks, Checkpoints) retain the versions of Documents they still need. A
 * retained version keeps its text as a quoted one does, and goes at the next
 * start once its last owner releases it.
 */

/** A note's first version, and the next one, rewritten. */
const notes = (name: string) => ({
  v1: `# ${name}\n\nSpring tides happen at new moon and at full moon.\n`,
  v2: `# ${name}\n\nSpring tides follow the new and the full moon.\n`,
});

const SECTION = { kind: "section", heading: "Tides" } as const;

/** The Units stored and not deleted, by Document and version: "<document>:<hash>" → count. */
const unitsByVersion = (dataDir: string) =>
  Object.fromEntries(
    queryDatabase<{ document_id: string; content_hash: string; units: number }>(
      dataDir,
      `SELECT document_id, content_hash, count(*) AS units FROM document_pages
       WHERE deleted_at IS NULL GROUP BY document_id, content_hash`,
    ).map((row) => [`${row.document_id}:${row.content_hash}`, row.units]),
  );

/** Rewrites a file added on its own, and waits for its new version to be processed. */
async function changeFile(core: Core, documentId: string, path: string, contents: string) {
  await writeFile(path, contents);
  await core.reconcileDocuments();
  const [processed] = await waitForProcessing(core, [documentId]);
  expect(processed?.contentHash).toBe(sha256(contents));
}

/** A note added on its own and processed, at its first version. */
async function addNote(core: Core, folder: string, name: string) {
  const text = notes(name);
  const path = await writeSourceFile(folder, `${name}.md`, text.v1);
  const [document] = await addAndProcess(core, [path]);
  if (!document) throw new Error("Nothing was added.");
  return { ...document, v1: sha256(text.v1), v2: sha256(text.v2), text };
}

/** Takes a Document back to what an older pipeline left, so the next start processes it again. */
function processedByOlderPipeline(dataDir: string, documentId: string) {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("UPDATE documents SET processing_version = 1 WHERE id = ?", [documentId]);
  } finally {
    db.close();
  }
}

describe("Versions retained by features other than Citations", { timeout: 30_000 }, () => {
  test("the existing collector keeps source text for a kind an older app does not understand", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const core = startCore(dataDir);
    const note = await addNote(core, folder, "Figure inputs / 数字来源");
    core.retention.retain("note-figure", "future-note", [
      { documentId: note.id, contentHash: note.v1, pageFrom: 1, pageTo: 1 },
    ]);
    await changeFile(core, note.id, note.path, note.text.v2);
    core.close();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("UPDATE retained_versions SET kind = ? WHERE owner_id = ?", [
        "newer-note-figure",
        "future-note",
      ]);
    } finally {
      db.close();
    }
    const older = startCore(dataDir);
    expect(unitsByVersion(dataDir)).toEqual({
      [`${note.id}:${note.v1}`]: 1,
      [`${note.id}:${note.v2}`]: 1,
    });
    older.close();
    const writer = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      const at = new Date().toISOString();
      writer.run("UPDATE retained_versions SET deleted_at = ?, updated_at = ? WHERE owner_id = ?", [
        at,
        at,
        "future-note",
      ]);
    } finally {
      writer.close();
    }
    startCore(dataDir);
    expect(unitsByVersion(dataDir)).toEqual({ [`${note.id}:${note.v2}`]: 1 });
  });

  test("a version retained by each kind survives restarts, and goes at the next start once released", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const core = startCore(dataDir);
    const retained = new Map<RetentionKind, Awaited<ReturnType<typeof addNote>>>();
    for (const kind of RETENTION_KINDS) {
      const note = await addNote(core, folder, `Notes for ${kind}`);
      core.retention.retain(kind, `${kind}-owner`, [
        { documentId: note.id, contentHash: note.v1, pageFrom: 1, pageTo: 1, location: SECTION },
      ]);
      retained.set(kind, note);
      await changeFile(core, note.id, note.path, note.text.v2);
    }
    // A Document changed with nothing retaining its first version, for comparison.
    const plain = await addNote(core, folder, "Plain notes");
    await changeFile(core, plain.id, plain.path, plain.text.v2);
    core.close();

    let current = startCore(dataDir);
    let units = unitsByVersion(dataDir);
    for (const note of retained.values()) {
      expect(units[`${note.id}:${note.v1}`]).toBe(1);
      expect(units[`${note.id}:${note.v2}`]).toBe(1);
    }
    expect(units[`${plain.id}:${plain.v1}`]).toBeUndefined();
    expect(units[`${plain.id}:${plain.v2}`]).toBe(1);

    // Released one kind at a time: each goes at the next start, the others stay.
    const released: RetentionKind[] = [];
    for (const kind of RETENTION_KINDS) {
      current.retention.release(kind, `${kind}-owner`);
      expect(current.retention.retainedBy(kind, `${kind}-owner`)).toEqual([]);
      released.push(kind);
      current.close();
      current = startCore(dataDir);
      units = unitsByVersion(dataDir);
      for (const [each, note] of retained) {
        expect(units[`${note.id}:${note.v1}`]).toBe(released.includes(each) ? undefined : 1);
        expect(units[`${note.id}:${note.v2}`]).toBe(1);
      }
    }
    // Search and the Documents were never affected: the current versions are what they hold.
    expect(await current.searchPassages("happen", { mode: "keyword" })).toEqual([]);
    expect(await current.searchPassages("follow", { mode: "keyword" })).toHaveLength(
      RETENTION_KINDS.length + 1,
    );
  });

  test("an owner's versions are replaced when it retains others, and a version stays until its last owner releases it", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const core = startCore(dataDir);
    const note = await addNote(core, folder, "Tides");
    const v1 = { documentId: note.id, contentHash: note.v1 };
    core.retention.retain("check-result", "result-1", [v1]);
    core.retention.retain("task", "task-1", [v1, v1]);
    await changeFile(core, note.id, note.path, note.text.v2);

    // The check is run again against the new version: its evidence is replaced.
    const v2 = { documentId: note.id, contentHash: note.v2, pageFrom: 1, pageTo: 1 };
    core.retention.retain("check-result", "result-1", [{ ...v2, location: SECTION }]);
    expect(core.retention.retainedBy("check-result", "result-1")).toEqual([
      { ...v2, location: SECTION },
    ]);
    // Retained twice by one owner, it is one version all the same.
    expect(core.retention.retainedBy("task", "task-1")).toEqual([
      { ...v1, pageFrom: null, pageTo: null, location: null },
    ]);
    core.close();

    // The Task still retains version 1.
    const second = startCore(dataDir);
    expect(unitsByVersion(dataDir)).toEqual({
      [`${note.id}:${note.v1}`]: 1,
      [`${note.id}:${note.v2}`]: 1,
    });
    // Its last owner done, it goes at the next start; the check result's version is current.
    second.retention.retain("task", "task-1", []);
    second.close();

    const third = startCore(dataDir);
    expect(unitsByVersion(dataDir)).toEqual({ [`${note.id}:${note.v2}`]: 1 });
    // Retaining what is already retained changes nothing.
    third.retention.retain("check-result", "result-1", [{ ...v2, location: SECTION }]);
    const rows = queryDatabase<{ deleted_at: string | null }>(
      dataDir,
      "SELECT deleted_at FROM retained_versions WHERE owner_id = 'result-1' ORDER BY rowid",
    );
    expect(rows.map((row) => row.deleted_at === null)).toEqual([false, true]);
  });

  test("the Units retained stay when their Linked folder is unlinked, and go at a start once released", async () => {
    const dataDir = await createTempDataFolder();
    const library = await createSourceFolder();
    await writeSourceFile(
      library,
      "Tides.pdf",
      buildPdf([
        { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
        { lines: ["Spring and neap tides", "Spring tides happen at new and full moon."] },
        { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
      ]),
    );
    const core = startCore(dataDir);
    const [tides] = await linkAndProcess(core, library);
    if (!tides) throw new Error("Nothing was linked.");
    core.retention.retain("saved-page", "page-image-1", [
      {
        documentId: tides.id,
        contentHash: tides.contentHash,
        pageFrom: 2,
        pageTo: 2,
        location: { kind: "page", from: 2, to: 2 },
      },
    ]);
    const linked = (await core.listLinkedFolders())[0];
    if (!linked) throw new Error("Nothing was linked.");

    const changed = nextEvent(core, "keptCitationTexts.changed");
    await core.removeLinkedFolder(linked.id);
    const kept = [{ documentId: tides.id, contentHash: tides.contentHash, units: [2] }];
    expect(await changed).toEqual(kept);
    expect(await core.listDocuments()).toEqual([]);
    core.close();

    // Still retained: kept across a start.
    const second = startCore(dataDir);
    expect(await second.listKeptCitationTexts()).toEqual(kept);
    second.retention.release("saved-page", "page-image-1");
    second.close();

    const third = startCore(dataDir);
    expect(await third.listKeptCitationTexts()).toEqual([]);
    expect(unitsByVersion(dataDir)).toEqual({});
  });

  test("processing a Document again leaves the versions retained of it", async () => {
    const dataDir = await createTempDataFolder();
    const folder = await createSourceFolder();
    const core = startCore(dataDir);
    const note = await addNote(core, folder, "Tides");
    core.retention.retain("checkpoint", "checkpoint-1", [
      { documentId: note.id, contentHash: note.v1, pageFrom: 1, pageTo: 1, location: SECTION },
    ]);
    core.close();

    // Version 1 is processed again while it is current.
    processedByOlderPipeline(dataDir, note.id);
    const second = startCore(dataDir);
    await waitForProcessing(second, [note.id]);
    await changeFile(second, note.id, note.path, note.text.v2);
    second.close();

    // Then version 2 is processed again, after version 1 became an old one.
    processedByOlderPipeline(dataDir, note.id);
    const third = startCore(dataDir);
    const [processed] = await waitForProcessing(third, [note.id]);
    expect(processed).toMatchObject({ status: "ready", contentHash: note.v2 });
    third.close();

    startCore(dataDir);
    expect(unitsByVersion(dataDir)).toEqual({
      [`${note.id}:${note.v1}`]: 1,
      [`${note.id}:${note.v2}`]: 1,
    });
  });

  test("a release is kept for a later sync, then forgotten after 30 days", async () => {
    const dataDir = await createTempDataFolder();
    const clock = manualClock();
    const core = startCore(dataDir, { now: clock.now });
    core.retention.retain("task", "task-1", [{ documentId: "document-1", contentHash: "abc" }]);
    const [row] = queryDatabase<Record<string, string | null>>(
      dataDir,
      "SELECT id, created_at, updated_at, deleted_at FROM retained_versions",
    );
    // Ready to sync: a random UUID and ISO 8601 UTC times.
    expect(row).toEqual({
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      created_at: "2026-10-06T09:00:00.000Z",
      updated_at: "2026-10-06T09:00:00.000Z",
      deleted_at: null,
    });
    clock.advance(60_000);
    core.retention.release("task", "task-1");
    core.close();
    const released = () =>
      queryDatabase<{ deleted_at: string }>(dataDir, "SELECT deleted_at FROM retained_versions");

    const day = 24 * 60 * 60 * 1000;
    clock.advance(29 * day);
    startCore(dataDir, { now: clock.now }).close();
    expect(released()).toEqual([{ deleted_at: "2026-10-06T09:01:00.000Z" }]);

    clock.advance(2 * day);
    startCore(dataDir, { now: clock.now }).close();
    expect(released()).toEqual([]);
  });

  test("a Location a newer version wrote stays when the same version is retained again", async () => {
    const dataDir = await createTempDataFolder();
    startCore(dataDir).close();
    // As a later sync might bring it: a Location of a kind this version doesn't know.
    const newer = JSON.stringify({ kind: "area", page: 3, box: [0.1, 0.2, 0.5, 0.4] });
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `INSERT INTO retained_versions (id, kind, owner_id, document_id, content_hash,
           page_from, page_to, location, created_at, updated_at)
         VALUES ('a8d3c6f0-5b1e-4c2a-9f7d-0e4b2a6c8d10', 'check-result', 'result-1',
           'document-1', 'abc', 3, 3, ?, '2026-10-06T09:00:00.000Z', '2026-10-06T09:00:00.000Z')`,
        [newer],
      );
    } finally {
      db.close();
    }
    const core = startCore(dataDir);
    const version = { documentId: "document-1", contentHash: "abc", pageFrom: 3, pageTo: 3 };
    // Read here, it has no Location; retained again as read, its row is left as it is.
    expect(core.retention.retainedBy("check-result", "result-1")).toEqual([
      { ...version, location: null },
    ]);
    core.retention.retain("check-result", "result-1", [version]);
    expect(queryDatabase(dataDir, "SELECT location, deleted_at FROM retained_versions")).toEqual([
      { location: newer, deleted_at: null },
    ]);
  });

  test("what isn't a retained version is refused", async () => {
    const core = startCore(await createTempDataFolder());
    const version = { documentId: "document-1", contentHash: "abc" };
    const refused = [
      () => core.retention.retain("note" as RetentionKind, "owner", [version]),
      () => core.retention.retain("task", "", [version]),
      () => core.retention.retain("task", "owner", [{ ...version, documentId: "" }]),
      () => core.retention.retain("task", "owner", [{ ...version, pageFrom: 2, pageTo: 1 }]),
      () => core.retention.retain("task", "owner", [{ ...version, pageFrom: 2 }]),
      () =>
        core.retention.retain("task", "owner", [
          { ...version, location: { kind: "chapter" } as never },
        ]),
    ];
    for (const retain of refused) expect(retain).toThrow(InvalidInputError);
    expect(core.retention.retainedBy("task", "owner")).toEqual([]);
  });
});
