import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Logger } from "../adapters";
import { isRecord } from "../errors";
import type { Database, SqlValue } from "./database";

/**
 * The `node:sqlite` adapter for the storage port. `node:sqlite` ships with
 * Electron's Node (24), so it needs no native module build.
 */
export function openNodeSqlite(file: string, log?: Logger): Database {
  const measured = <T>(operation: string, sql: string, call: () => T): T => {
    if (!log) return call();
    const at = performance.now();
    let ok = false;
    try {
      const value = call();
      ok = true;
      return value;
    } finally {
      const ms = performance.now() - at;
      log?.info("diagnostic.native", { operation, sql, at, ms, ok });
    }
  };
  const db = measured("open", "DatabaseSync", () => new DatabaseSync(file));
  const exec = (sql: string) => measured("exec", sql, () => db.exec(sql));
  try {
    exec("PRAGMA journal_mode = WAL");
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
    const deadline = performance.now() + 5_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let failure = error;
    for (;;) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw failure;
      Atomics.wait(pause, 0, 0, Math.min(250, remaining));
      if (performance.now() >= deadline) throw failure;
      try {
        exec("PRAGMA journal_mode = WAL");
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
  exec("PRAGMA synchronous = FULL");
  exec("PRAGMA foreign_keys = ON");
  exec("PRAGMA busy_timeout = 5000");

  const reads = new Map<string, StatementSync>();
  const writes = new Map<string, StatementSync>();
  const prepare = (sql: string, cache: Map<string, StatementSync>): StatementSync => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = measured("prepare", sql, () => db.prepare(sql));
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
      exec(sql);
    },
    run(sql, params: readonly SqlValue[] = []) {
      const statement = prepare(sql, writes);
      measured("run", sql, () => statement.run(...params));
    },
    get<Row>(sql: string, params: readonly SqlValue[] = []) {
      const statement = prepare(sql, reads);
      return measured("get", sql, () => statement.get(...params)) as Row | undefined;
    },
    all<Row>(sql: string, params: readonly SqlValue[] = []) {
      const statement = prepare(sql, reads);
      return measured("all", sql, () => statement.all(...params)) as Row[];
    },
    transaction(fn) {
      if (transactionDepth > 0) return fn();
      exec("BEGIN IMMEDIATE");
      transactionDepth++;
      try {
        const result = fn();
        exec("COMMIT");
        return result;
      } catch (error) {
        exec("ROLLBACK");
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
