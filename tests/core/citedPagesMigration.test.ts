/**
 * Migration 113 (#2161): a cited page whose drawing failed used to be taken away, and nothing
 * tried it again. Each such page waits again, the newest of its Location, unless one of that
 * Location waits or is saved already, so the next start tries it if a Citation still points at it.
 */
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { CapturePage } from "../../src/core";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { askAndFinish, citationsIn, citingModel, setUpWithDocuments } from "../helpers/citations";
import { PNG, savedPage } from "../helpers/citedPages";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";

const AT = "2026-10-20T09:00:00.000Z";
const GONE = "2026-10-21T09:00:00.000Z";
const SPRING = "Spring tides happen at new moon and at full moon.";

type Database = ReturnType<typeof openDatabase>;

/** A cited page of one Location: `place` tells Locations apart, `saved` gives it a picture. */
function page(
  db: Database,
  id: string,
  { place = "a", saved = false, gone = true }: { place?: string; saved?: boolean; gone?: boolean },
) {
  db.run(
    `INSERT INTO cited_pages (id, document_id, content_hash, page_from, page_to, area, image_type,
       width, height, created_at, updated_at, deleted_at)
     VALUES (?, 'd1', ?, 1, 1, '{"kind":"section"}', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `hash-${place}`,
      saved ? "image/png" : null,
      saved ? 10 : null,
      saved ? 10 : null,
      AT,
      gone ? GONE : AT,
      gone ? GONE : null,
    ],
  );
}

/** A database as version 112 left it, with the pages `setup` put in, migrated, for `check` to read. */
async function migrated(setup: (db: Database) => void, check: (db: Database) => void) {
  const db = openDatabase(join(await createTempDataFolder(), "test.db"));
  try {
    migrate(
      db,
      migrations.filter((each) => each.version <= 112),
    );
    setup(db);
    migrate(db);
    check(db);
  } finally {
    db.close();
  }
}

const waitingAgain = (db: Database) =>
  db.all<{ id: string; tries: number }>(
    "SELECT id, tries FROM cited_pages WHERE deleted_at IS NULL AND image_type IS NULL ORDER BY id",
  );

test("a page a failed drawing took away waits again, once for its Location, with that failure counted", async () => {
  await migrated(
    (db) => {
      page(db, "p1", {});
      page(db, "p2", {});
    },
    (db) => {
      expect(waitingAgain(db)).toEqual([{ id: "p2", tries: 1 }]);
      const revived = db.get<{ updated_at: string }>(
        "SELECT updated_at FROM cited_pages WHERE id = 'p2'",
      );
      expect(revived?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect((revived?.updated_at ?? "") > GONE).toBe(true);
    },
  );
});

test("a Location with a page saved or waiting keeps it, and a page that went once saved stays gone", async () => {
  await migrated(
    (db) => {
      page(db, "saved", { place: "a", saved: true, gone: false });
      page(db, "failed-a", { place: "a" });
      page(db, "waiting", { place: "b", gone: false });
      page(db, "failed-b", { place: "b" });
      page(db, "collected", { place: "c", saved: true });
    },
    (db) => {
      expect(waitingAgain(db)).toEqual([{ id: "waiting", tries: 0 }]);
      expect(
        db.all<{ id: string }>("SELECT id FROM cited_pages WHERE deleted_at IS NULL ORDER BY id"),
      ).toEqual([{ id: "saved" }, { id: "waiting" }]);
    },
  );
});

test("a Citation whose page a failed drawing took away gets its page at the next start", async () => {
  let fails = true;
  const capturePage: CapturePage = async (request) => {
    if (fails) throw new Error("UnknownVizError");
    return {
      data: PNG,
      type: "image/png",
      width: 1,
      height: 1,
      text: [{ text: request.document.name, box: { x: 0, y: 0, width: 1, height: 1 } }],
    };
  };
  const model = citingModel({
    query: "spring tides",
    records: (passages) => [
      { marker: 1, passage: passages[0]?.id ?? "none", location: "§ Tides", quote: SPRING },
    ],
    answer: "Spring tides come at new and full moon [^1].",
  });
  const { core, client, mind, dataDir } = await setUpWithDocuments(
    model,
    [{ name: "Notes.md", contents: `# Tides\n\n${SPRING}\n` }],
    { capturePage },
  );
  const { answerId } = await askAndFinish(core, client, mind.id, "When are spring tides?");
  const [citation] = citationsIn(client, answerId);
  if (!citation) throw new Error("Nothing was cited.");
  await vi.waitFor(() =>
    expect(queryDatabase(dataDir, "SELECT tries FROM cited_pages")).toEqual([{ tries: 1 }]),
  );
  core.close();

  // The data folder as a version before 113 left it: the page taken away, and no count.
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("UPDATE cited_pages SET deleted_at = ?", [GONE]);
    db.exec("ALTER TABLE cited_pages DROP COLUMN tries");
    db.run("DELETE FROM schema_migrations WHERE version = 113");
  } finally {
    db.close();
  }

  fails = false;
  const again = startCore(dataDir, { capturePage });
  expect(await savedPage(again, citation)).toMatchObject({ type: "image/png", width: 1 });
  expect(queryDatabase(dataDir, "SELECT 1 FROM cited_pages WHERE deleted_at IS NULL")).toHaveLength(
    1,
  );
});
