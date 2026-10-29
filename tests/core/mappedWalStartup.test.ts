import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAPPED_WAL_RETRY_MS } from "../../src/core/storage/node-sqlite";
import { startupDialog } from "../../src/main/startupError";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { type LogEntry, recordingLog } from "../helpers/log";

const WAL = "PRAGMA journal_mode = WAL";
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const nativeExec = DatabaseSync.prototype.exec;

function restorePlatform() {
  if (!platform) throw new Error("The test could not restore the native platform.");
  Object.defineProperty(process, "platform", platform);
}

/**
 * The start runs as on Windows while another process maps the database's `-shm` file: its first
 * `failures` WAL opens fail as SQLite does then (#2067). Windows lasts only until the WAL opens, so
 * the rest of the core starts on this computer's platform.
 */
function mapSharedMemory(failures: number) {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  let left = failures;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql === WAL && left > 0) {
      left -= 1;
      throw Object.assign(new Error("disk I/O error"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 1546,
        errstr: "disk I/O error",
      });
    }
    if (sql === WAL) restorePlatform();
    nativeExec.call(this, sql);
  });
}

/** The WAL open's log entries; the time each gives is at least what the retry waited until then. */
function walEntries(entries: LogEntry[]) {
  const logged = entries.filter((entry) => entry.event.startsWith("storage.walOpen."));
  return logged.map(({ level, event, fields }) => {
    const { elapsedMs, ...rest } = fields ?? {};
    if (typeof elapsedMs !== "number") throw new Error(`${event} gave no elapsed time.`);
    return { level, event, fields: rest, waitedMs: Math.floor(elapsedMs / 250) * 250 };
  });
}

beforeEach(() => {
  let waitedMs = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + waitedMs);
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    if (timeout === undefined || !Number.isFinite(timeout))
      throw new Error("The WAL retry must use a bounded wait.");
    waitedMs += timeout;
    return "timed-out";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  restorePlatform();
});

test("a Windows start goes on once another process stops mapping the database's shared memory, and its log says how long it waited", async () => {
  const dataDir = await createTempDataFolder();
  mapSharedMemory(3);
  const { log, entries } = recordingLog();

  const core = startCore(dataDir, { log });

  expect(process.platform).toBe(platform?.value);
  const mind = await core.createMind({ title: "Saved after the wait" });
  expect((await core.listMinds()).map((each) => each.id)).toContain(mind.id);
  expect(queryDatabase<{ journal_mode: string }>(dataDir, "PRAGMA journal_mode")).toEqual([
    { journal_mode: "wal" },
  ]);
  const failed = (attempt: number) => ({
    level: "warn",
    event: "storage.walOpen.failed",
    fields: { attempt, errcode: 1546 },
    waitedMs: (attempt - 1) * 250,
  });
  expect(walEntries(entries)).toEqual([
    failed(1),
    failed(2),
    failed(3),
    {
      level: "info",
      event: "storage.walOpen.recovered",
      fields: { attempts: 4 },
      waitedMs: 750,
    },
  ]);
});

test("a Windows start the mapping never lets go of shows the plain startup problem, and the next start opens the same data", async () => {
  const dataDir = await createTempDataFolder();
  const first = startCore(dataDir);
  const mind = await first.createMind({ title: "Saved before the crash" });
  first.close();
  mapSharedMemory(Number.POSITIVE_INFINITY);
  const { log, entries } = recordingLog();

  let failure: unknown;
  try {
    startCore(dataDir, { log });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 1546 });
  const logged = walEntries(entries);
  expect(logged).toHaveLength(MAPPED_WAL_RETRY_MS / 250 + 1);
  expect(logged.at(-2)).toMatchObject({ fields: { attempt: 20, errcode: 1546 } });
  expect(logged.at(-1)).toEqual({
    level: "warn",
    event: "storage.walOpen.gaveUp",
    fields: { attempts: 20 },
    waitedMs: MAPPED_WAL_RETRY_MS,
  });
  expect(startupDialog(failure, "en")).toMatchObject({
    title: "IncarnaMind couldn’t start",
    detail:
      "Your data folder couldn’t be opened. Close this message, then open IncarnaMind again.\n\ndisk I/O error",
  });
  expect(startupDialog(failure, "zh-CN")).toMatchObject({
    title: "IncarnaMind 无法启动",
    detail: "无法打开你的数据文件夹。请关闭此提示，然后重新打开 IncarnaMind。\n\ndisk I/O error",
  });

  vi.mocked(DatabaseSync.prototype.exec).mockRestore();
  restorePlatform();
  const next = startCore(dataDir);
  expect((await next.listMinds()).map((each) => each.id)).toContain(mind.id);
});
