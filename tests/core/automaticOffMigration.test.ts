/**
 * Migration 103 (#1617): the Library setting "automatic" was saved as true by every save of the
 * Tagging setting, so it can't tell the User's choice from the old default. It is forgotten, so the
 * switch follows the model (on for one on this computer, off for a cloud model); only a false stays.
 * Where Documents were being tagged by themselves, the Library decides at its first start whether to
 * say it went off: the migration only leaves the question "pending".
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder } from "../helpers/core";

const AT = "2026-10-01T09:00:00.000Z";

type Database = ReturnType<typeof openDatabase>;

/** A row with every column the table needs filled, from `values`, else a plain placeholder. */
function insert(db: Database, table: string, values: Record<string, string | number>) {
  const columns = db.all<{ name: string; type: string; notnull: number; dflt_value: unknown }>(
    `PRAGMA table_info(${table})`,
  );
  const row: Record<string, string | number> = {};
  for (const column of columns) {
    const given = values[column.name];
    if (given !== undefined) row[column.name] = given;
    else if (column.notnull === 1 && column.dflt_value === null) {
      row[column.name] = column.type.toUpperCase() === "INTEGER" ? 0 : AT;
    }
  }
  const names = Object.keys(row);
  db.run(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    names.map((name) => row[name] as string | number),
  );
}

/** A database as version 102 left it, then migrated, with what the test put in first. */
async function migrated(setup: (db: Database) => void) {
  const db = openDatabase(join(await createTempDataFolder(), "test.db"));
  migrate(
    db,
    migrations.filter((each) => each.version <= 102),
  );
  setup(db);
  migrate(db);
  return db;
}

const aDocument = (db: Database) => insert(db, "documents", { id: "d1", name: "Report" });
const library = (db: Database, value: unknown) =>
  insert(db, "device_settings", { id: "s1", key: "library", value: JSON.stringify(value) });

const savedLibrary = (db: Database) => {
  const row = db.get<{ value: string }>(
    "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
  );
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
};
const notice = (db: Database) =>
  db.get<{ id: string; value: string }>(
    "SELECT id, value FROM device_settings WHERE key = 'libraryAutomaticOffNotice' AND deleted_at IS NULL",
  );

describe("Migration 103: tagging and sorting by themselves follow the model", () => {
  test("a true saved by the old default is forgotten, and the Library is left to decide whether to say it went off", async () => {
    const db = await migrated((each) => {
      aDocument(each);
      library(each, { classifier: { kind: "automatic" }, automatic: true, taggingStopped: [] });
    });

    expect(savedLibrary(db)).toEqual({ classifier: { kind: "automatic" }, taggingStopped: [] });
    expect(notice(db)?.value).toBe('"pending"');
  });

  test("a Library that never saved the setting is left to decide too, and its row has a UUID for an id", async () => {
    const db = await migrated(aDocument);

    expect(savedLibrary(db)).toBeNull();
    expect(notice(db)?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("a false the User saved stays, and the Library has nothing to decide", async () => {
    const db = await migrated((each) => {
      aDocument(each);
      library(each, { classifier: { kind: "automatic" }, automatic: false });
    });

    expect(savedLibrary(db)).toEqual({ classifier: { kind: "automatic" }, automatic: false });
    expect(notice(db)).toBeUndefined();
  });

  test("with no Documents there is nothing to say", async () => {
    const db = await migrated((each) =>
      library(each, { classifier: { kind: "automatic" }, automatic: true }),
    );

    expect(savedLibrary(db)).toEqual({ classifier: { kind: "automatic" } });
    expect(notice(db)).toBeUndefined();
  });
});
