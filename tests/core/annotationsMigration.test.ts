/**
 * Migration 133 (#327): a Document keeps its highlights and notes, in a table
 * ready to sync, with the words of each in the keyword index; a soft delete
 * takes them out of the index.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder } from "../helpers/core";

const AT = "2026-11-03T09:00:00.000Z";

describe("Migration 133: a Document's highlights and notes", () => {
  test("a database from before it gains the table, its index and its triggers", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((migration) => migration.version <= 126),
    );
    expect(
      db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_annotations'"),
    ).toBeUndefined();

    migrate(db);

    expect(
      db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_annotations'"),
    ).toBeTruthy();
    expect(
      db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'annotation_text_fts'"),
    ).toBeTruthy();

    db.run(
      `INSERT INTO document_annotations
         (id, document_id, content_hash, passage_id, source, colour, quote, note, page_from,
          page_to, location, check_state, check_reason, anchor, author, missing, created_at,
          updated_at)
       VALUES (?, ?, NULL, NULL, 'user', 'yellow', ?, NULL, NULL, NULL, NULL, 'found', NULL, NULL,
         NULL, 0, ?, ?)`,
      ["00000000-0000-4000-8000-000000000001", "doc", "Neap tides are the smallest.", AT, AT],
    );
    const seq = db.get<{ seq: number }>("SELECT seq FROM document_annotations")?.seq;
    expect(seq).toBeDefined();
    db.run("INSERT INTO annotation_text_fts (rowid, text) VALUES (?, ?)", [
      BigInt(seq ?? 0),
      "neap tides smallest",
    ]);
    expect(
      db.get("SELECT 1 FROM annotation_text_fts WHERE annotation_text_fts MATCH 'tides'"),
    ).toBeTruthy();

    db.run("UPDATE document_annotations SET deleted_at = ? WHERE id = ?", [
      AT,
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(
      db.get("SELECT 1 FROM annotation_text_fts WHERE annotation_text_fts MATCH 'tides'"),
    ).toBeUndefined();
    db.close();
  });

  test("its rows are ready to sync: a UUID id, ISO 8601 UTC times and a soft delete", () => {
    const columns = migrations
      .filter((migration) => migration.version === 133)
      .flatMap((migration) => [
        ...migration.sql.matchAll(/\b(id|created_at|updated_at|deleted_at)\b/g),
      ])
      .map((match) => match[1]);
    expect(new Set(columns)).toEqual(new Set(["id", "created_at", "updated_at", "deleted_at"]));
    const sql = migrations.find((migration) => migration.version === 133)?.sql ?? "";
    expect(sql).toContain("id TEXT NOT NULL UNIQUE");
    expect(sql).toContain("deleted_at TEXT");
  });
});
