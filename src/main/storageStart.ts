import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_FILE } from "../core";
import type { Logger } from "../core/adapters";
import { isRecord } from "../core/errors";
import { migrations } from "../core/storage";
import type { MigrationMessage } from "./migrationWorker";
import startMigrationWorker from "./migrationWorker?nodeWorker";

const LATEST = migrations.at(-1)?.version ?? 0;

/** The worker's view of the thread: its messages, why it failed, and when it has ended. */
export interface MigrationThread {
  on(event: "message", listener: (message: MigrationMessage) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
}

/**
 * The database is held by another process, and the worker already waited out SQLite's busy
 * timeout, or on Windows its retries for a mapped `-shm` (#2067): the start says so now rather
 * than waiting the same time again in the core.
 */
export class DatabaseHeldError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "DatabaseHeldError";
  }
}

const SQLITE_BUSY = 5;
const SQLITE_IOERR_TRUNCATE = 1546;

const waitedOutALock = (error: Error): boolean => {
  const errcode = isRecord(error) && typeof error.errcode === "number" ? error.errcode : null;
  return (
    errcode !== null && ((errcode & 0xff) === SQLITE_BUSY || errcode === SQLITE_IOERR_TRUNCATE)
  );
};

/**
 * Brings the content database in `dataDir` up to date on a worker thread, so a first start's
 * migrations, or an update's, leave the main thread free for the window (#2104). Resolves with
 * `current` without starting a worker when the file's header already records every migration.
 * `progressed` hears that migrations are being applied. It settles only once the thread has
 * ended, so its connection is gone. It rejects with `DatabaseHeldError` when another process held
 * the file for the whole wait; with any other failure the core migrates on the main thread as
 * before, and reports a real problem there.
 */
export function migrateOffThread(
  dataDir: string,
  log: Logger,
  progressed: () => void,
  start: (options: { name: string; workerData: { file: string } }) => MigrationThread = (options) =>
    startMigrationWorker(options),
): Promise<"current" | "migrated"> {
  const file = join(dataDir, DATABASE_FILE);
  if (recordsEveryMigration(file)) {
    log.info("storage.schemaCurrent");
    return Promise.resolve("current");
  }
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let applied = 0;
    let failure: Error | undefined;
    // A first start applies every migration in well under a second; one progress step per turn
    // of the event loop keeps that to a few writes of the instance file rather than one each.
    let reporting = false;
    const worker = start({ name: "incarnamind-migrations", workerData: { file } });
    worker.on("message", (message) => {
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
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      if (failure) {
        reject(waitedOutALock(failure) ? new DatabaseHeldError(failure) : failure);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(`The migration worker stopped with code ${code} after ${applied} migrations.`),
        );
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
