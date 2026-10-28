import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isRecord } from "../errors";
import type { Database, SqlValue } from "./database";

/** How long a start keeps trying WAL shared memory another process maps, on Windows (#2067). */
export const MAPPED_WAL_RETRY_MS = 5_000;

/**
 * The `node:sqlite` adapter for the storage port. `node:sqlite` ships with
 * Electron's Node (24), so it needs no native module build.
 */
export function openNodeSqlite(file: string): Database {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !isRecord(error) ||
      error.code !== "ERR_SQLITE_ERROR" ||
      error.errcode !== 1546
    )
      throw error;
    // SQLite cannot truncate mapped SHM on Windows (#2067, upstream 7c103a0b7d).
    // Remove this bounded workaround when the released runtime contains that fix.
    const deadline = performance.now() + MAPPED_WAL_RETRY_MS;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let failure = error;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw failure;
      Atomics.wait(pause, 0, 0, Math.min(250, remaining));
      if (performance.now() >= deadline) throw failure;
      try {
        db.exec("PRAGMA journal_mode = WAL");
      } catch (next) {
        if (!isRecord(next) || next.code !== "ERR_SQLITE_ERROR" || next.errcode !== 1546)
          throw next;
        failure = next;
        continue;
      }
      if (performance.now() >= deadline) throw failure;
      break;
    }
  }
  // Each commit is on disk before it returns: a Task's journal must survive a force-quit (#126).
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const reads = new Map<string, StatementSync>();
  const writes = new Map<string, StatementSync>();
  const prepare = (sql: string, cache: Map<string, StatementSync>): StatementSync => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      // run() reports the connection's last row id, which a contentless FTS5 delete can leave at
      // its tombstone page's, past 2^53. Node 26 throws reading that as a number, after the write
      // is done (#1289).
      if (cache === writes) statement.setReadBigInts(true);
      cache.set(sql, statement);
    }
    return statement;
  };
  let transactionDepth = 0;

  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params: readonly SqlValue[] = []) {
      prepare(sql, writes).run(...params);
    },
    get<Row>(sql: string, params: readonly SqlValue[] = []) {
      return prepare(sql, reads).get(...params) as Row | undefined;
    },
    all<Row>(sql: string, params: readonly SqlValue[] = []) {
      return prepare(sql, reads).all(...params) as Row[];
    },
    transaction(fn) {
      if (transactionDepth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      transactionDepth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        transactionDepth--;
      }
    },
    close() {
      if (!db.isOpen) return;
      reads.clear();
      writes.clear();
      db.close();
    },
  };
}
