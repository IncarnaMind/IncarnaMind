/**
 * Migration 125 (#205): a Tag records whether the User made it or changed its
 * name, colour or description. Tags made before it have no record of where they
 * came from: one whose updated_at moved was edited or restored by the User; a
 * preset is not theirs, nor is one automatic tagging linked the moment it made
 * it, nor Research's; every other one is taken as theirs.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, startCore } from "../helpers/core";

const AT = "2026-10-01T09:00:00.000Z";

describe("Migration 125: a Tag says whether the User made or changed it", () => {
  test("an existing preset is not the User's, and an existing other Tag is", async () => {
    const dataDir = await createTempDataFolder();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(
      db,
      migrations.filter((each) => each.version <= 124),
    );
    const book = randomUUID();
    const drafts = randomUUID();
    const tagged = randomUUID();
    const english = randomUUID();
    const chinese = randomUUID();
    const edited = randomUUID();
    const milk = randomUUID();
    const LATER = "2026-10-02T09:00:00.000Z";
    db.run(
      `INSERT INTO tags (id, name, description, preset, colour, created_at, updated_at)
       VALUES (?, 'Book', 'A book.', 'book', 'orange', ?, ?),
              (?, 'Drafts', 'Notes in progress.', NULL, 'teal', ?, ?),
              (?, 'Tagged', 'Made while tagging.', NULL, 'green', ?, ?),
              (?, 'Tagged again', 'Made while tagging.', NULL, 'green', ?, ?),
              (?, 'From Research on “Tea”', 'From Research on “Tea”', NULL, 'blue', ?, ?),
              (?, 'From Research on “Milk”', 'From Research on “Milk”', NULL, 'blue', ?, ?),
              (?, '来自研究“茶”', '来自研究“茶”', NULL, 'red', ?, ?)`,
      [
        book,
        AT,
        AT,
        drafts,
        AT,
        AT,
        tagged,
        AT,
        AT,
        edited,
        AT,
        LATER,
        english,
        AT,
        AT,
        milk,
        AT,
        LATER,
        chinese,
        AT,
        AT,
      ],
    );
    // Automatic tagging links the Tag the moment it makes it; the User's link comes later.
    db.run(
      `INSERT INTO document_tags
         (id, document_id, tag_id, source, confidence, needs_review, created_at, updated_at)
       VALUES (?, ?, ?, 'automatic', NULL, 0, ?, ?),
              (?, ?, ?, 'automatic', NULL, 0, ?, ?),
              (?, ?, ?, 'user', NULL, 0, ?, ?)`,
      [
        randomUUID(),
        randomUUID(),
        tagged,
        AT,
        AT,
        randomUUID(),
        randomUUID(),
        edited,
        AT,
        AT,
        randomUUID(),
        randomUUID(),
        drafts,
        LATER,
        LATER,
      ],
    );
    db.close();

    const core = startCore(dataDir);

    const byName = Object.fromEntries(
      (await core.listTags()).map((tag) => [tag.name, tag.madeByUser]),
    );
    expect(byName).toEqual({
      Book: false,
      Drafts: true,
      "From Research on “Milk”": true,
      "From Research on “Tea”": false,
      Tagged: false,
      "Tagged again": true,
      "来自研究“茶”": false,
    });
  });
});
