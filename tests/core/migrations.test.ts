import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DataFromNewerVersionError } from "../../src/core/errors";
import { type Database, migrate, openDatabase } from "../../src/core/storage";
import { migrations } from "../../src/core/storage/migrations";
import { createTempDataFolder } from "../helpers/core";

const userVersion = (db: ReturnType<typeof openDatabase>) =>
  db.get<{ user_version: number }>("PRAGMA user_version")?.user_version;

describe("Migrations", () => {
  test("existing remote Connectors keep their OAuth configuration when header metadata is introduced", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "connectors.db"));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 106),
    );
    const config = { url: "https://synthetic.example.test/mcp", clientId: "registered-app" };
    db.run(
      "INSERT INTO connectors (id, name, transport, config, enabled, created_at, updated_at) VALUES (?, ?, 'http', ?, 1, ?, ?)",
      [
        "00000000-0000-4000-8000-000000000001",
        "Tides",
        JSON.stringify(config),
        "2026-10-25T12:00:00.000Z",
        "2026-10-25T12:00:00.000Z",
      ],
    );
    migrate(db);
    const stored = db.get<{ config: string }>("SELECT config FROM connectors");
    expect(JSON.parse(stored?.config ?? "null")).toEqual({
      ...config,
      connection: "http",
      headers: [],
    });
    db.close();
  });

  test("version numbers may skip numbers reserved by work in progress", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));

    migrate(db, [
      { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" },
      { version: 4, description: "four", sql: "CREATE TABLE four (id TEXT) STRICT;" },
    ]);

    expect(userVersion(db)).toBe(4);
    db.close();
  });

  test("versions out of order are refused before anything runs", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));

    expect(() =>
      migrate(db, [
        { version: 4, description: "four", sql: "CREATE TABLE four (id TEXT) STRICT;" },
        { version: 2, description: "two", sql: "CREATE TABLE two (id TEXT) STRICT;" },
      ]),
    ).toThrow(/must increase/);
    expect(userVersion(db)).toBe(0);
    db.close();
  });

  test("a Document read by this pipeline starts with its keyword rows current (#2185)", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 114),
    );
    const at = "2026-10-29T09:00:00.000Z";
    for (const [id, version] of [
      ["00000000-0000-4000-8000-000000000001", 15],
      ["00000000-0000-4000-8000-000000000002", 14],
    ] as const) {
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, processing_version,
           created_at, updated_at)
         VALUES (?, ?, 'Notes.md', 'markdown', 1, 'ready', ?, ?, ?)`,
        [id, `hash-${version}`, BigInt(version), at, at],
      );
    }

    migrate(db);

    // The rows of a Document at 15 were written by this pipeline or by the rewrite that made
    // them; the others' are rewritten once, as before.
    expect(
      db.all<{ id: string; keywords_version: number }>(
        "SELECT id, keywords_version FROM documents ORDER BY id",
      ),
    ).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", keywords_version: 15 },
      { id: "00000000-0000-4000-8000-000000000002", keywords_version: 0 },
    ]);
    db.close();
  });

  test("a Meeting recorded before keeps its Transcript Document, found where IncarnaMind keeps it (#1253)", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 118),
    );
    const at = "2026-10-29T09:00:00.000Z";
    const mind = "00000000-0000-4000-8000-000000000001";
    const transcribed = "00000000-0000-4000-8000-000000000002";
    const silent = "00000000-0000-4000-8000-000000000003";
    const document = "00000000-0000-4000-8000-000000000004";
    const older = "00000000-0000-4000-8000-000000000005";
    const added = "00000000-0000-4000-8000-000000000006";
    db.run("INSERT INTO minds (id, created_at, updated_at) VALUES (?, ?, ?)", [mind, at, at]);
    for (const id of [transcribed, silent]) {
      db.run(
        `INSERT INTO meetings (id, mind_id, status, created_at, updated_at)
         VALUES (?, ?, 'stopped', ?, ?)`,
        [id, mind, at, at],
      );
    }
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, path, source_kind,
         relative_path, created_at, updated_at)
       VALUES (?, 'hash', 'Transcript · Weekly call', 'transcript', 1, 'ready', ?, 'data-folder',
         ?, ?, ?)`,
      [document, `/data/Transcripts/${transcribed}.vtt`, `Transcripts/${transcribed}.vtt`, at, at],
    );
    // An older Document of the same file, and a .vtt the User added of a name like it, aren't it.
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, path, source_kind,
         relative_path, created_at, updated_at, deleted_at)
       VALUES (?, 'old', 'Transcript', 'transcript', 1, 'ready', ?, 'data-folder', ?, ?, ?, ?)`,
      [
        older,
        `/data/Transcripts/${transcribed}.vtt`,
        `Transcripts/${transcribed}.vtt`,
        "2026-10-28T09:00:00.000Z",
        "2026-10-28T09:00:00.000Z",
        at,
      ],
    );
    db.run(
      `INSERT INTO documents (id, content_hash, name, kind, size, status, path, source_kind,
         created_at, updated_at)
       VALUES (?, 'mine', 'Weekly call.vtt', 'transcript', 1, 'ready', ?, 'file', ?, ?)`,
      [added, `/Users/me/Transcripts/${silent}.vtt`, at, at],
    );

    migrate(db);

    expect(
      db.all<{ id: string; transcript_document_id: string | null; purged_at: string | null }>(
        "SELECT id, transcript_document_id, purged_at FROM meetings ORDER BY id",
      ),
    ).toEqual([
      { id: transcribed, transcript_document_id: document, purged_at: null },
      { id: silent, transcript_document_id: null, purged_at: null },
    ]);
    db.close();
  });

  test("a migration with a lower number that lands later still runs", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    const one = { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" };
    const six = { version: 6, description: "six", sql: "CREATE TABLE six (id TEXT) STRICT;" };
    const five = { version: 5, description: "five", sql: "CREATE TABLE five (id TEXT) STRICT;" };

    migrate(db, [one, six]);
    migrate(db, [one, five, six]);

    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'five'")).toBeDefined();
    expect(userVersion(db)).toBe(6);
    db.close();
  });

  test("a database with a migration this version doesn't know is refused", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    const one = { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" };
    const two = { version: 2, description: "two", sql: "CREATE TABLE two (id TEXT) STRICT;" };

    migrate(db, [one, two]);

    expect(() => migrate(db, [one])).toThrow(DataFromNewerVersionError);
    db.close();
  });

  test("a newer database names its newest migration and is left untouched", async () => {
    const file = join(await createTempDataFolder(), "test.db");
    const db = openDatabase(file);
    const one = { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" };
    const two = { version: 2, description: "two", sql: "CREATE TABLE two (id TEXT) STRICT;" };
    const three = { version: 3, description: "three", sql: "CREATE TABLE three (id TEXT) STRICT;" };
    migrate(db, [one, two, three]);
    db.close();
    const before = createHash("sha256").update(readFileSync(file)).digest("hex");

    const reopened = openDatabase(file);
    let caught: unknown;
    try {
      migrate(reopened, [one]);
    } catch (error) {
      caught = error;
    }
    reopened.close();

    expect(caught).toBeInstanceOf(DataFromNewerVersionError);
    expect((caught as DataFromNewerVersionError).newestVersion).toBe(3);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before);
  });

  test("a database from before migrations were recorded keeps what it applied", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    db.exec("CREATE TABLE one (id TEXT) STRICT; PRAGMA user_version = 1;");

    migrate(db, [
      { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" },
      { version: 2, description: "two", sql: "CREATE TABLE two (id TEXT) STRICT;" },
    ]);

    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'two'")).toBeDefined();
    expect(userVersion(db)).toBe(2);
    db.close();
  });

  test("a fresh database reaches the latest version", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));

    migrate(db);

    expect(userVersion(db)).toBe(migrations.at(-1)?.version);
    expect(db.all("SELECT version FROM schema_migrations")).toHaveLength(migrations.length);
    db.close();
  });

  test("all pending migrations share one transaction", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    const one = { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" };
    const two = { version: 2, description: "two", sql: "CREATE TABLE two (id TEXT) STRICT;" };
    const three = { version: 3, description: "three", sql: "CREATE TABLE three (id TEXT) STRICT;" };
    migrate(db, [one]);
    let transactions = 0;
    const storage = {
      ...db,
      transaction<T>(fn: () => T): T {
        transactions++;
        return db.transaction(fn);
      },
    };

    migrate(storage, [one, two, three]);

    expect(transactions).toBe(1);
    expect(userVersion(db)).toBe(3);
    db.close();
  });

  test("an up-to-date database starts no transaction and writes nothing", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    const one = { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" };
    migrate(db, [one]);
    let transactions = 0;
    let writes = 0;
    const storage: Database = {
      ...db,
      exec(sql) {
        writes++;
        db.exec(sql);
      },
      run(sql, params) {
        writes++;
        db.run(sql, params);
      },
      transaction<T>(fn: () => T): T {
        transactions++;
        return db.transaction(fn);
      },
    };

    migrate(storage, [one]);

    expect({ transactions, writes }).toEqual({ transactions: 0, writes: 0 });
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  test("a later migration's failure leaves the earlier version and no partial schema", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    const one = { version: 1, description: "one", sql: "CREATE TABLE one (id TEXT) STRICT;" };
    const two = { version: 2, description: "two", sql: "CREATE TABLE two (id TEXT) STRICT;" };
    const broken = {
      version: 3,
      description: "broken",
      sql: "CREATE TABLE three (id TEXT) STRICT; INSERT INTO missing_table VALUES (1);",
    };
    const four = { version: 4, description: "four", sql: "CREATE TABLE four (id TEXT) STRICT;" };
    migrate(db, [one]);

    expect(() => migrate(db, [one, two, broken, four])).toThrow();

    expect(userVersion(db)).toBe(1);
    expect(
      db
        .all<{ version: number }>("SELECT version FROM schema_migrations")
        .map((row) => row.version),
    ).toEqual([1]);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'two'")).toBeUndefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'three'")).toBeUndefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'four'")).toBeUndefined();
    db.close();
  });

  test("a pre-wall Question backfills its Note or Conversation Folder", async () => {
    const db = openDatabase(join(await createTempDataFolder(), "test.db"));
    migrate(
      db,
      migrations.filter((migration) => migration.version < 115),
    );
    const at = "2026-10-01T00:00:00.000Z";
    db.run(
      "INSERT INTO minds (id, title, auto_title, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["mind-a", "A", "A", "folder-a", at, at],
    );
    db.run(
      "INSERT INTO conversations (seq, id, title, auto_title, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [1, "conv-a", "", "", "folder-b", at, at],
    );
    db.run(
      "INSERT INTO conversation_messages (seq, id, conversation_id, position, kind, text, asked_from_mind_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [1, "q1", "conv-a", 1, "question", "First", "mind-a", at, at],
    );
    db.run(
      "INSERT INTO conversation_messages (seq, id, conversation_id, position, kind, text, asked_from_mind_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [2, "q2", "conv-a", 2, "question", "Second", null, at, at],
    );
    db.run(
      "INSERT INTO minds (id, title, auto_title, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["mind-b", "B", "B", null, at, at],
    );
    db.run(
      "INSERT INTO conversations (seq, id, title, auto_title, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [2, "conv-c", "", "", null, at, at],
    );
    db.run(
      "INSERT INTO conversation_messages (seq, id, conversation_id, position, kind, text, asked_from_mind_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [3, "q3", "conv-c", 1, "question", "Third", "mind-b", at, at],
    );
    db.run(
      "INSERT INTO conversation_messages (seq, id, conversation_id, position, kind, text, asked_from_mind_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [4, "q4", "conv-c", 2, "question", "Fourth", null, at, at],
    );

    migrate(db);

    expect(
      db.all<{ id: string; folder_asked_in: string | null }>(
        "SELECT id, folder_asked_in FROM conversation_messages ORDER BY seq",
      ),
    ).toEqual([
      { id: "q1", folder_asked_in: "folder-a" },
      { id: "q2", folder_asked_in: "folder-b" },
      { id: "q3", folder_asked_in: "" },
      { id: "q4", folder_asked_in: "" },
    ]);
    db.close();
  });
});
