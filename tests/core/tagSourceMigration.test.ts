/**
 * Migration 124 (#205): a Tag records whether the User made it or changed its
 * name, colour or description. Tags made before it have no record of where they
 * came from, so a preset is not the User's and every other one is taken as theirs.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, startCore } from "../helpers/core";

const AT = "2026-10-01T09:00:00.000Z";

describe("Migration 124: a Tag says whether the User made or changed it", () => {
  test("an existing preset is not the User's, and an existing other Tag is", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 123),
    );
    db.run(
      `INSERT INTO tags (id, name, description, preset, colour, created_at, updated_at)
       VALUES (?, 'Book', 'A book.', 'book', 'orange', ?, ?),
              (?, 'Drafts', 'Notes in progress.', NULL, 'teal', ?, ?)`,
      [randomUUID(), AT, AT, randomUUID(), AT, AT],
    );
    db.close();

    const core = startCore(dataDir);

    expect(await core.listTags()).toMatchObject([
      { name: "Book", preset: true, madeByUser: false },
      { name: "Drafts", preset: false, madeByUser: true },
    ]);
  });
});
