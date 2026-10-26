import { existsSync, mkdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;
const SQLITE_NOTADB = 26;

// The folder staying busy with no copy holding it for this long means one has stopped between its
// two locks, or something else holds `instance.lock`. Starting then could put two cores on one
// database, so the app doesn't start.
const GIVE_UP_AFTER_MS = 10_000;

export interface InstanceLock {
  held: boolean;
  /** The folder stayed busy until the deadline: nothing should start, and the User is told. */
  timedOut: boolean;
  release(): void;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const code = (error: unknown) => ((error as { errcode?: number }).errcode ?? 0) % 256;

const NOT_HELD: InstanceLock = { held: false, timedOut: false, release: () => undefined };

function takeExclusively(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// A read takes only a shared lock: a refusal means the file is held exclusively, by a copy that has the folder.
function isHeld(file: string): boolean {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return false;
  } catch (error) {
    if (code(error) === SQLITE_BUSY) return true;
    throw error;
  } finally {
    db.close();
  }
}

/** Whether another copy holds the folder at this moment: running, or quitting and about to let go. */
export function heldByAnotherCopy(
  folder: string,
  report: (what: string, error: unknown) => void,
): boolean {
  const ownerFile = join(folder, "instance.owner");
  if (!existsSync(ownerFile)) return false;
  try {
    return isHeld(ownerFile);
  } catch (error) {
    // `lockInstance` empties a file that isn't a database: no copy holds it.
    if (code(error) !== SQLITE_NOTADB) report("app.instanceLockFailed", error);
    return false;
  }
}

/**
 * Takes the data folder for this copy of the app, for as long as it runs: `instance.lock`, a
 * SQLite database opened in exclusive mode inside an exclusive transaction. The operating system
 * lets the lock go when the process ends, however it ends, so there is nothing stale to clean up.
 * Electron's single-instance lock isn't enough: two copies asking in the same millisecond can both
 * get it, and two cores then migrate one database (#1352).
 *
 * The copy that holds `instance.lock` also takes `instance.owner`, and nothing else does. A copy
 * that finds `instance.lock` busy lets go of everything it holds and reads `instance.owner`: held,
 * a copy really has the folder and this one gives up; free, the busy lock was another copy's try,
 * which lets go in a moment, so this one asks again. That way exactly one of two copies holds the
 * folder, however the two are scheduled. A file that isn't a database is emptied in place and
 * asked for again. `report` gets a failure that isn't one of these; the app then starts, as it did
 * without the lock.
 *
 * `holderMayBeLeaving`: this copy got Electron's lock from one that held the folder a moment ago,
 * and may still be ending (#1448), so it waits until the deadline and reports a busy folder.
 */
export function lockInstance(
  folder: string,
  report: (what: string, error: unknown) => void,
  { giveUpAfterMs = GIVE_UP_AFTER_MS, holderMayBeLeaving = false } = {},
): InstanceLock {
  const lockFile = join(folder, "instance.lock");
  const ownerFile = join(folder, "instance.owner");
  const give = performance.now() + giveUpAfterMs;
  const held: DatabaseSync[] = [];
  let emptyings = 0;
  const emptied = (error: unknown, file: string) => {
    if (code(error) !== SQLITE_NOTADB) return false;
    // Emptying that doesn't make it a database is a failure to report, not a loop.
    if (++emptyings > 6) throw error;
    truncateSync(file, 0);
    return true;
  };
  try {
    mkdirSync(folder, { recursive: true });
    for (;;) {
      let file = lockFile;
      try {
        held.push(takeExclusively(lockFile));
        file = ownerFile;
        held.push(takeExclusively(ownerFile));
        return holding(held, report);
      } catch (error) {
        for (const db of held.splice(0)) db.close();
        if (emptied(error, file)) continue;
        if (code(error) !== SQLITE_BUSY) throw error;
      }
      try {
        if (!holderMayBeLeaving && isHeld(ownerFile)) return NOT_HELD;
      } catch (error) {
        if (!emptied(error, ownerFile)) throw error;
        continue;
      }
      if (performance.now() >= give)
        return { held: false, timedOut: true, release: () => undefined };
      sleep(1 + Math.random() * 5);
    }
  } catch (error) {
    for (const db of held.splice(0)) db.close();
    report("app.instanceLockFailed", error);
    return { held: true, timedOut: false, release: () => undefined };
  }
}

function holding(
  databases: DatabaseSync[],
  report: (what: string, error: unknown) => void,
): InstanceLock {
  let open = true;
  return {
    held: true,
    timedOut: false,
    release() {
      if (!open) return;
      open = false;
      for (const db of databases) {
        try {
          db.close();
        } catch (error) {
          report("app.instanceLockReleaseFailed", error);
        }
      }
    },
  };
}
