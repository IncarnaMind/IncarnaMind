import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_FILE } from "../core";
import type { Logger } from "../core/adapters";
import { migrations } from "../core/storage";
import type { MigrationMessage } from "./migrationWorker";
import startMigrationWorker from "./migrationWorker?nodeWorker";

const LATEST = migrations.at(-1)?.version ?? 0;

/**
 * Brings the content database in `dataDir` up to date on a worker thread, so a first start's
 * migrations, or an update's, leave the main thread free for the window (#2104). Resolves with
 * `current` without starting a worker when the file's header already records every migration.
 * `progressed` hears that migrations are being applied. Rejects when the worker fails: the core
 * then migrates on the main thread as before, and reports a real problem there.
 */
export function migrateOffThread(
  dataDir: string,
  log: Logger,
  progressed: () => void,
): Promise<"current" | "migrated"> {
  const file = join(dataDir, DATABASE_FILE);
  if (recordsEveryMigration(file)) return Promise.resolve("current");
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let applied = 0;
    // A first start applies every migration in well under a second; one progress step per turn
    // of the event loop keeps that to a few writes of the instance file rather than one each.
    let reporting = false;
    const worker = startMigrationWorker({ name: "incarnamind-migrations", workerData: { file } });
    worker.on("message", (message: MigrationMessage) => {
      if (message.kind === "log") {
        log[message.level](message.event, message.fields);
        return;
      }
      applied += 1;
      if (reporting) return;
      reporting = true;
      setImmediate(() => {
        reporting = false;
        progressed();
      });
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`The migration worker stopped with code ${code}.`));
        return;
      }
      log.info("storage.migratedOffThread", {
        applied,
        elapsedMs: Math.round(performance.now() - started),
      });
      resolve("migrated");
    });
  });
}

/**
 * Whether the database file's header (`user_version`, at byte 60) is at the latest migration
 * or past it, read without opening SQLite. After a crash the newest header can still be in the
 * write-ahead log, so this reads it as older and the worker runs to find nothing to do.
 */
function recordsEveryMigration(file: string): boolean {
  let handle: number;
  try {
    handle = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(64);
    if (readSync(handle, header, 0, header.length, 0) < header.length) return false;
    if (header.toString("latin1", 0, 16) !== "SQLite format 3\u0000") return false;
    return header.readUInt32BE(60) >= LATEST;
  } catch {
    return false;
  } finally {
    closeSync(handle);
  }
}
