/**
 * The upgrade for #2835: Organize keeps no model of its own. The model it kept while the Library's
 * choice was Automatic is dropped, and the choice stays as it was, so Tags keep the model and the
 * switch they had; nothing else in the record changes. Found by what it does, not its number,
 * which is set when it merges.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import type { SaveChatProviderInput } from "../../src/core/api";
import { migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createMemoryKeychain, createTempDataFolder, startCore } from "../helpers/core";

const AT = "2026-11-01T09:00:00.000Z";

type Database = ReturnType<typeof openDatabase>;

const upgrade = migrations.find((each) => each.description.startsWith("Organize keeps no model"));

const kept = { kind: "chat", choice: { providerId: "p1", modelId: "claude-haiku-5-5" } };
const chosen = { kind: "decision", host: "openrouter", modelId: "decider-v1.2" };

const ANTHROPIC: SaveChatProviderInput = {
  kind: "anthropic",
  apiKey: "sk-ant-test",
  modelId: "claude-haiku-5-5",
};

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

/** Puts `library` back as the version before the upgrade stored it, for the upgrade to run again. */
function storeBeforeUpgrade(dataDir: string, library: unknown): void {
  if (!upgrade) throw new Error("The upgrade isn't in the list.");
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    db.run("DELETE FROM device_settings WHERE key = 'library'");
    db.run(
      "INSERT INTO device_settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["s2", "library", JSON.stringify(library), AT, AT],
    );
    db.run("DELETE FROM schema_migrations WHERE version = ?", [upgrade.version]);
  } finally {
    db.close();
  }
}

describe("Organize's kept model is dropped, and the Library's choice stays (#2835)", () => {
  test("under Automatic, the kept model goes and everything else stays", async () => {
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
    expect(stored(db)).toEqual(rest);
  });

  test.each([
    ["Automatic stored as null", null],
    ["Automatic left out", undefined],
  ])("%s stays Automatic, with the kept model gone", async (_name, classifier) => {
    const db = await upgraded({ classifier, automatic: false, organizeWith: kept });

    expect(stored(db)).toEqual(
      classifier === null ? { classifier: null, automatic: false } : { automatic: false },
    );
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

  // protects=Tags use the model and read the switch they had before the upgrade, through the public interface, with Local mode on and a kept cloud model, and with a kept model whose provider is gone; fails_when=the upgrade moves Tags to the kept model, pauses or fails them, or turns the switch; no_claim=which model Automatic picks.
  test.each([
    ["Local mode on, with a kept cloud model", true],
    ["a kept model whose provider was removed", false],
  ])("%s: Tags keep their model and their switch", async (_name, localMode) => {
    const dataDir = await createTempDataFolder();
    const keychain = createMemoryKeychain();
    const core = startCore(dataDir, { keychain });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const anthropic = await core.saveChatProvider({ ...ANTHROPIC, keepDefault: true });
    if (localMode) await core.setLocalOnly(true);
    else await core.deleteChatProvider(anthropic.id);
    const keptCloud = {
      kind: "chat",
      choice: { providerId: anthropic.id, modelId: ANTHROPIC.modelId },
    };
    const library = { classifier: { kind: "automatic" }, automatic: true };
    // What Tags used and how the switch read, with the record the old version kept for Tags.
    storeBeforeUpgrade(dataDir, library);
    core.close();
    const plain = startCore(dataDir, { keychain });
    const routeBefore = await plain.getTaggingRoute("tagging");
    const switchBefore = (await plain.getLibrary()).settings.automatic;
    plain.close();

    storeBeforeUpgrade(dataDir, { ...library, organizeWith: keptCloud });
    const reopened = startCore(dataDir, { keychain });
    expect(await reopened.getTaggingRoute("tagging")).toEqual(routeBefore);
    expect((await reopened.getLibrary()).settings.automatic).toBe(switchBefore);
    expect((await reopened.getLibrary()).settings).toMatchObject({
      classifier: { kind: "automatic" },
      organizeWith: null,
    });
    if (localMode) expect(routeBefore).not.toEqual({ where: "cloud", service: expect.anything() });
    reopened.close();
  });
});
