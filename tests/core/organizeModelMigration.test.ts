/**
 * The upgrade for #2835: Organize keeps no model of its own. A model it kept while the Library's
 * choice was Automatic becomes that choice, the one model for Organize and Tags; a choice the User
 * made already stays; nothing else in the record changes. Found by what it does, not its number,
 * which is set when it merges.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder, startCore } from "../helpers/core";

const AT = "2026-11-01T09:00:00.000Z";

type Database = ReturnType<typeof openDatabase>;

const upgrade = migrations.find((each) => each.description.startsWith("Organize keeps no model"));

const kept = { kind: "chat", choice: { providerId: "p1", modelId: "claude-haiku-5-5" } };
const chosen = { kind: "decision", host: "openrouter", modelId: "decider-v1.2" };

/** A database as the version before the upgrade left it, holding `library`, then upgraded. */
async function upgraded(library: unknown) {
  if (!upgrade) throw new Error("The upgrade isn't in the list.");
  const dataDir = await createTempDataFolder();
  const db = openDatabase(join(dataDir, "test.db"));
  migrate(
    db,
    migrations.filter((each) => each.version < upgrade.version),
  );
  if (library !== undefined) {
    db.run(
      "INSERT INTO device_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["s1", "library", JSON.stringify(library), AT, AT],
    );
  }
  migrate(db);
  return db;
}

const stored = (db: Database) => {
  const row = db.get<{ value: string }>(
    "SELECT value FROM device_settings WHERE key = 'library' AND deleted_at IS NULL",
  );
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
};

describe("Organize's kept model becomes the choice for Organize and Tags (#2835)", () => {
  test("under Automatic, the kept model becomes the choice, and the rest of the record stays", async () => {
    const before = {
      classifier: { kind: "automatic" },
      automatic: true,
      organizeWith: kept,
      automaticSince: { "https://api.anthropic.com": AT },
      automaticSinceSeq: { "https://api.anthropic.com": 4 },
      taggingStopped: ["f1", null],
    };
    const db = await upgraded(before);

    const { organizeWith: _gone, ...rest } = before;
    expect(stored(db)).toEqual({ ...rest, classifier: kept });
  });

  test.each([
    ["Automatic stored as null", null],
    ["Automatic left out", undefined],
  ])("%s reads as Automatic, so the kept model becomes the choice", async (_name, classifier) => {
    const db = await upgraded({ classifier, automatic: false, organizeWith: kept });

    expect(stored(db)).toEqual({ classifier: kept, automatic: false });
  });

  test("a model the User chose stays chosen, and the kept one goes", async () => {
    const db = await upgraded({ classifier: chosen, organizeWith: kept, taggingStopped: [] });

    expect(stored(db)).toEqual({ classifier: chosen, taggingStopped: [] });
  });

  test("with no kept model, the record is as it was", async () => {
    const automatic = { classifier: { kind: "automatic" }, organizeWith: null, automatic: true };
    expect(stored(await upgraded(automatic))).toEqual({
      classifier: { kind: "automatic" },
      automatic: true,
    });
    expect(stored(await upgraded({ classifier: chosen, automatic: false }))).toEqual({
      classifier: chosen,
      automatic: false,
    });
  });

  test("a record that isn't JSON, or no record, is left alone", async () => {
    expect(stored(await upgraded(undefined))).toBeNull();
    const db = await upgraded({ classifier: { kind: "automatic" } });
    db.run("UPDATE device_settings SET value = 'not json' WHERE key = 'library'");
    migrate(db);
    expect(
      db.get<{ value: string }>("SELECT value FROM device_settings WHERE key = 'library'")?.value,
    ).toBe("not json");
  });

  test("the Library reads the upgraded record as the one choice, with nothing kept for Organize", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    core.close();
    const choice = { kind: "chat", choice: { providerId: provider.id, modelId: "local-model" } };
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run("DELETE FROM device_settings WHERE key = 'library'");
      db.run(
        "INSERT INTO device_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [
          "s2",
          "library",
          JSON.stringify({ classifier: { kind: "automatic" }, organizeWith: choice }),
          AT,
          AT,
        ],
      );
      if (!upgrade) throw new Error("The upgrade isn't in the list.");
      db.run("DELETE FROM schema_migrations WHERE version = ?", [upgrade.version]);
    } finally {
      db.close();
    }

    const reopened = startCore(dataDir);
    expect((await reopened.getLibrary()).settings).toMatchObject({
      classifier: choice,
      organizeWith: null,
    });
    reopened.close();
  });
});
