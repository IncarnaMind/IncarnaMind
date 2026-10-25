import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DataFromNewerVersionError } from "../../src/core/errors";
import { migrate, openDatabase } from "../../src/core/storage";
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
      headerKey: null,
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
});
