/**
 * Migration 112 (#2161): a cited page whose drawing failed used to be taken away, and nothing
 * tried it again. Each such page waits again, the newest of its Location, unless one of that
 * Location waits or is saved already, so the next start tries it if a Citation still points at it.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder } from "../helpers/core";

const AT = "2026-10-20T09:00:00.000Z";
const GONE = "2026-10-21T09:00:00.000Z";

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

/** A database as version 111 left it, then migrated, with the pages the test put in first. */
async function migrated(setup: (db: Database) => void) {
  const db = openDatabase(join(await createTempDataFolder(), "test.db"));
  migrate(
    db,
    migrations.filter((each) => each.version <= 111),
  );
  setup(db);
  migrate(db);
  return db;
}

const waitingAgain = (db: Database) =>
  db.all<{ id: string; tries: number }>(
    "SELECT id, tries FROM cited_pages WHERE deleted_at IS NULL AND image_type IS NULL ORDER BY id",
  );

test("a page a failed drawing took away waits again, once for its Location, with that failure counted", async () => {
  const db = await migrated((each) => {
    page(each, "p1", {});
    page(each, "p2", {});
  });

  expect(waitingAgain(db)).toEqual([{ id: "p2", tries: 1 }]);
  const revived = db.get<{ updated_at: string }>(
    "SELECT updated_at FROM cited_pages WHERE id = 'p2'",
  );
  expect(revived?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect((revived?.updated_at ?? "") > GONE).toBe(true);
});

test("a Location with a page saved or waiting keeps it, and a page that went once saved stays gone", async () => {
  const db = await migrated((each) => {
    page(each, "saved", { place: "a", saved: true, gone: false });
    page(each, "failed-a", { place: "a" });
    page(each, "waiting", { place: "b", gone: false });
    page(each, "failed-b", { place: "b" });
    page(each, "collected", { place: "c", saved: true });
  });

  expect(waitingAgain(db)).toEqual([{ id: "waiting", tries: 0 }]);
  expect(
    db.all<{ id: string }>("SELECT id FROM cited_pages WHERE deleted_at IS NULL ORDER BY id"),
  ).toEqual([{ id: "saved" }, { id: "waiting" }]);
});
