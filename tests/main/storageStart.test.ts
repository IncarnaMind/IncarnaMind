import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { type Database, migrate, migrations, openDatabase } from "../../src/core/storage";
import { migrateOffThread } from "../../src/main/storageStart";
import { createTempDataFolder } from "../helpers/core";

const quiet = { info() {}, warn() {}, error() {} };

function appliedVersions(dataDir: string): number[] {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    return db
      .all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")
      .map((row) => row.version);
  } finally {
    db.close();
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("migrateOffThread", () => {
  it("migrates a fresh data folder on a worker and reports progress", async () => {
    const dataDir = await createTempDataFolder();
    let progressed = 0;
    await expect(migrateOffThread(dataDir, quiet, () => progressed++)).resolves.toBe("migrated");
    expect(appliedVersions(dataDir)).toEqual(migrations.map((migration) => migration.version));
    expect(progressed).toBeGreaterThan(0);
  });

  it("starts no worker when the file records every migration", async () => {
    const dataDir = await createTempDataFolder();
    await migrateOffThread(dataDir, quiet, () => undefined);
    let progressed = 0;
    await expect(migrateOffThread(dataDir, quiet, () => progressed++)).resolves.toBe("current");
    expect(progressed).toBe(0);
  });

  it("applies only what an older version left pending", async () => {
    const dataDir = await createTempDataFolder();
    const older = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(older, migrations.slice(0, -1));
    older.close();
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).resolves.toBe("migrated");
    expect(appliedVersions(dataDir).at(-1)).toBe(migrations.at(-1)?.version);
  });

  it("leaves a newer version's data to the core, which refuses it", async () => {
    const dataDir = await createTempDataFolder();
    const newer = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(newer, [...migrations, { version: 10_000, description: "Newer", sql: "SELECT 1" }]);
    newer.close();
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).resolves.toBe("current");
  });

  it("keeps the main thread running while the migrations wait for the database", async () => {
    const dataDir = await createTempDataFolder();
    const older = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(older, migrations.slice(0, 1));
    older.close();
    const holder: Database = openDatabase(join(dataDir, DATABASE_FILE));
    holder.exec("BEGIN IMMEDIATE");
    let settled = false;
    const migrating = migrateOffThread(dataDir, quiet, () => undefined).finally(() => {
      settled = true;
    });
    // Run on this thread while the write lock is held: a migration on this thread would be stuck
    // inside the call above until SQLite gave up waiting.
    for (let index = 0; index < 5; index++) await turn();
    expect(settled).toBe(false);
    holder.exec("COMMIT");
    holder.close();
    await expect(migrating).resolves.toBe("migrated");
    expect(appliedVersions(dataDir)).toEqual(migrations.map((migration) => migration.version));
  });

  it("rejects, leaving the problem to the core, when the database can't be opened", async () => {
    const dataDir = await createTempDataFolder();
    mkdirSync(join(dataDir, DATABASE_FILE));
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).rejects.toThrow();
  });

  it("rejects a file that isn't a database and leaves it as it was", async () => {
    const dataDir = await createTempDataFolder();
    writeFileSync(join(dataDir, DATABASE_FILE), "not a database, and long enough to have a header");
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).rejects.toThrow();
  });
});
