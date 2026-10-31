import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_FILE } from "../../src/core";
import { DataFromNewerVersionError } from "../../src/core/errors";
import { type Database, migrate, migrations, openDatabase } from "../../src/core/storage";
import type { MigrationMessage } from "../../src/main/migrationWorker";
import { DatabaseHeldError, migrateOffThread } from "../../src/main/storageStart";
import { createTempDataFolder, startCore } from "../helpers/core";

const quiet = { info() {}, warn() {}, error() {} };

function applied(dataDir: string): { version: number; applied_at: string }[] {
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  try {
    return db.all("SELECT version, applied_at FROM schema_migrations ORDER BY version");
  } finally {
    db.close();
  }
}

const versions = (dataDir: string) => applied(dataDir).map((row) => row.version);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A thread the test ends by hand, to see when the start settles. */
class FakeThread extends EventEmitter {
  message(message: MigrationMessage) {
    this.emit("message", message);
  }
}

function startedWith(dataDir: string, thread: FakeThread) {
  let settled = false;
  const promise = migrateOffThread(
    dataDir,
    quiet,
    () => undefined,
    () => thread,
  );
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { promise, settled: () => settled };
}

describe("migrateOffThread", () => {
  it("migrates a fresh data folder on a worker, up to 119, and reports progress", async () => {
    const dataDir = await createTempDataFolder();
    let progressed = 0;
    await expect(migrateOffThread(dataDir, quiet, () => progressed++)).resolves.toBe("migrated");
    expect(versions(dataDir)).toEqual(migrations.map((migration) => migration.version));
    expect(versions(dataDir).at(-1)).toBe(119);
    expect(progressed).toBeGreaterThan(0);
  });

  it("starts no worker when the file records every migration", async () => {
    const dataDir = await createTempDataFolder();
    await migrateOffThread(dataDir, quiet, () => undefined);
    let progressed = 0;
    let started = 0;
    const result = migrateOffThread(
      dataDir,
      quiet,
      () => progressed++,
      () => {
        started++;
        return new FakeThread();
      },
    );
    await expect(result).resolves.toBe("current");
    expect(started).toBe(0);
    expect(progressed).toBe(0);
  });

  it("applies only the migration an older version left pending", async () => {
    const dataDir = await createTempDataFolder();
    const older = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(older, migrations.slice(0, -1));
    older.close();
    const before = applied(dataDir);
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).resolves.toBe("migrated");
    const after = applied(dataDir);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((row) => row.version)).toEqual([119]);
  });

  it("leaves a newer version's data to the core, which refuses it", async () => {
    const dataDir = await createTempDataFolder();
    const newer = openDatabase(join(dataDir, DATABASE_FILE));
    migrate(newer, [...migrations, { version: 10_000, description: "Newer", sql: "SELECT 1" }]);
    newer.close();
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).resolves.toBe("current");
    expect(() => startCore(dataDir)).toThrow(DataFromNewerVersionError);
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
    expect(versions(dataDir).at(-1)).toBe(119);
  });

  it("rejects with SQLite's words when the database can't be opened", async () => {
    const dataDir = await createTempDataFolder();
    mkdirSync(join(dataDir, DATABASE_FILE));
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).rejects.toThrow(
      "unable to open database file",
    );
  });

  it("rejects a file that isn't a database and leaves its bytes as they were", async () => {
    const dataDir = await createTempDataFolder();
    const file = join(dataDir, DATABASE_FILE);
    const bytes = Buffer.from(
      "not a database, and long enough to have a header of sixty-four bytes",
    );
    writeFileSync(file, bytes);
    await expect(migrateOffThread(dataDir, quiet, () => undefined)).rejects.toThrow(
      "file is not a database",
    );
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  describe("settles only once the thread has ended", () => {
    it("after a failure, waits for the exit, then rejects with that failure", async () => {
      const dataDir = await createTempDataFolder();
      const thread = new FakeThread();
      const start = startedWith(dataDir, thread);
      const failure = Object.assign(new Error("disk I/O error"), { errcode: 10 });
      thread.emit("error", failure);
      for (let index = 0; index < 5; index++) await turn();
      expect(start.settled()).toBe(false);
      thread.emit("exit", 1);
      await expect(start.promise).rejects.toBe(failure);
    });

    it("a thread ended halfway through the migrations rejects once it has exited", async () => {
      const dataDir = await createTempDataFolder();
      const thread = new FakeThread();
      const start = startedWith(dataDir, thread);
      thread.message({ kind: "applied", version: 1 });
      thread.message({ kind: "applied", version: 2 });
      await turn();
      expect(start.settled()).toBe(false);
      thread.emit("exit", 1);
      await expect(start.promise).rejects.toThrow(
        "The migration worker stopped with code 1 after 2 migrations.",
      );
    });

    it.each([
      ["SQLITE_BUSY", 5],
      ["SQLITE_BUSY_SNAPSHOT", 517],
      ["a mapped -shm on Windows (#2067)", 1546],
    ])(
      "a lock the worker waited out (%s) is a DatabaseHeldError, said once",
      async (_name, errcode) => {
        const dataDir = await createTempDataFolder();
        const thread = new FakeThread();
        const start = startedWith(dataDir, thread);
        thread.emit("error", Object.assign(new Error("database is locked"), { errcode }));
        thread.emit("exit", 1);
        const error = await start.promise.catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(DatabaseHeldError);
        expect(error).toHaveProperty("message", "database is locked");
      },
    );

    it("any other failure stays the core's to report", async () => {
      const dataDir = await createTempDataFolder();
      const thread = new FakeThread();
      const start = startedWith(dataDir, thread);
      thread.emit("error", Object.assign(new Error("file is not a database"), { errcode: 26 }));
      thread.emit("exit", 1);
      const error = await start.promise.catch((reason: unknown) => reason);
      expect(error).not.toBeInstanceOf(DatabaseHeldError);
      expect(error).toHaveProperty("message", "file is not a database");
    });
  });
});
