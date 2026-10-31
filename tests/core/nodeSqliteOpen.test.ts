import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/core/storage";
import { openNodeSqlite } from "../../src/core/storage/node-sqlite";
import { recordingLog } from "../helpers/log";

const sqlite = vi.hoisted(() => ({
  open: vi.fn<(file: string) => void>(),
  exec: vi.fn<(sql: string) => void>(),
  close: vi.fn<() => void>(),
  get: vi.fn<(...params: unknown[]) => unknown>(),
  all: vi.fn<(...params: unknown[]) => unknown[]>(),
  run: vi.fn<(...params: unknown[]) => void>(),
  bigInts: vi.fn<(enabled: boolean) => void>(),
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    isOpen = true;
    constructor(file: string) {
      sqlite.open(file);
    }
    exec(sql: string) {
      sqlite.exec(sql);
    }
    prepare() {
      return {
        setReadBigInts: sqlite.bigInts,
        get: sqlite.get,
        all: sqlite.all,
        run: sqlite.run,
      };
    }
    close() {
      this.isOpen = false;
      sqlite.close();
    }
  },
}));

const WAL = "PRAGMA journal_mode = WAL";
const pragmas = [
  WAL,
  "PRAGMA synchronous = FULL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
];
const platform = Object.getOwnPropertyDescriptor(process, "platform");
let now: number;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

function sqliteError(errcode: number) {
  return Object.assign(new Error(`SQLite error ${errcode}`), { code: "ERR_SQLITE_ERROR", errcode });
}

const failed = (attempt: number, elapsedMs: number, errcode?: number) => ({
  level: "warn",
  event: "storage.walOpen.failed",
  fields: { attempt, elapsedMs, errcode },
});

function thrownBy(open: () => unknown): unknown {
  try {
    open();
  } catch (error) {
    return error;
  }
  throw new Error("The database operation unexpectedly succeeded.");
}

beforeEach(() => {
  vi.resetAllMocks();
  setPlatform("win32");
  now = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    if (timeout === undefined || !Number.isFinite(timeout))
      throw new Error("The WAL retry must use a bounded wait.");
    now += timeout;
    return "timed-out";
  });
  sqlite.all.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (!platform) throw new Error("The test could not restore the native platform.");
  Object.defineProperty(process, "platform", platform);
});

test("the storage entry returns an adapter with the existing ordered startup pragmas", () => {
  expect(openDatabase).toBe(openNodeSqlite);
  const { log, entries } = recordingLog();
  const db = openDatabase("saved.db", log);
  expect(entries).toEqual([]);
  expect(sqlite.open).toHaveBeenCalledExactlyOnceWith("saved.db");
  expect(sqlite.exec.mock.calls.map(([sql]) => sql)).toEqual(pragmas);
  expect(Atomics.wait).not.toHaveBeenCalled();
  sqlite.get.mockReturnValue({ title: "Saved" });
  expect(db.get("SELECT title FROM minds WHERE id = ?", ["mind-1"])).toEqual({ title: "Saved" });
  db.run("UPDATE minds SET title = ?", ["Kept"]);
  expect(sqlite.run).toHaveBeenCalledExactlyOnceWith("Kept");
  expect(sqlite.bigInts).toHaveBeenCalledExactlyOnceWith(true);
  db.close();
  db.close();
  expect(sqlite.close).toHaveBeenCalledTimes(1);
});

test("Windows retries its first WAL error 1546 after 250 ms on the same connection", () => {
  const error = sqliteError(1546);
  const attempts: number[] = [];
  sqlite.exec.mockImplementation((sql) => {
    if (sql !== WAL) return;
    attempts.push(now);
    if (attempts.length === 1) throw error;
  });
  const { log, entries } = recordingLog();
  const db = openDatabase("saved.db", log);
  expect(attempts).toEqual([1_000, 1_250]);
  expect(entries).toEqual([
    failed(1, 0, 1546),
    { level: "info", event: "storage.walOpen.recovered", fields: { attempts: 2, elapsedMs: 250 } },
  ]);
  expect(sqlite.open).toHaveBeenCalledTimes(1);
  expect(sqlite.exec.mock.calls.map(([sql]) => sql)).toEqual([WAL, ...pragmas]);
  db.close();
});

test("persistent Windows error 1546 stops at five seconds without a call at the deadline", () => {
  const error = sqliteError(1546);
  const attempts: number[] = [];
  sqlite.exec.mockImplementation(() => {
    attempts.push(now);
    throw error;
  });
  const { log, entries } = recordingLog();
  expect(thrownBy(() => openDatabase("saved.db", log))).toBe(error);
  expect(attempts).toHaveLength(20);
  expect(attempts[0]).toBe(1_000);
  expect(attempts.at(-1)).toBe(5_750);
  expect(attempts.every((at) => at < 6_000)).toBe(true);
  expect(now).toBe(6_000);
  expect(entries).toEqual([
    ...attempts.map((at, index) => failed(index + 1, at - 1_000, 1546)),
    { level: "warn", event: "storage.walOpen.gaveUp", fields: { attempts: 20, elapsedMs: 5_000 } },
  ]);
});

test("the five-second window starts after the first failure and preserves the last native error", () => {
  const errors: Error[] = [];
  const attempts: number[] = [];
  sqlite.exec.mockImplementation(() => {
    attempts.push(now);
    const error = sqliteError(1546);
    errors.push(error);
    if (errors.length === 1) now += 800;
    throw error;
  });
  const failure = thrownBy(() => openDatabase("saved.db"));
  expect(failure).toBe(errors.at(-1));
  expect(failure).not.toBe(errors[0]);
  expect(attempts).toHaveLength(20);
  expect(attempts[1]).toBe(2_050);
  expect(attempts.at(-1)).toBe(6_550);
  expect(now).toBe(6_800);
});

test.each([5, 10, 266, 522])("Windows does not retry first WAL error code %s", (code) => {
  const error = sqliteError(code);
  sqlite.exec.mockImplementation(() => {
    throw error;
  });
  const { log, entries } = recordingLog();
  expect(thrownBy(() => openDatabase("saved.db", log))).toBe(error);
  expect(sqlite.exec).toHaveBeenCalledExactlyOnceWith(WAL);
  expect(Atomics.wait).not.toHaveBeenCalled();
  expect(entries).toEqual([failed(1, 0, code)]);
});

test("Windows does not retry an unclassified first WAL error", () => {
  const error = new Error("The database could not be opened.");
  sqlite.exec.mockImplementation(() => {
    throw error;
  });
  expect(thrownBy(() => openDatabase("saved.db"))).toBe(error);
  expect(sqlite.exec).toHaveBeenCalledExactlyOnceWith(WAL);
  expect(Atomics.wait).not.toHaveBeenCalled();
});

test("an error with 1546 outside the native SQLite error contract is not retried", () => {
  const error = Object.assign(new Error("An unrelated failure."), { errcode: 1546 });
  sqlite.exec.mockImplementation(() => {
    throw error;
  });
  expect(thrownBy(() => openDatabase("saved.db"))).toBe(error);
  expect(sqlite.exec).toHaveBeenCalledExactlyOnceWith(WAL);
  expect(Atomics.wait).not.toHaveBeenCalled();
});

test("a database constructor failure is not retried", () => {
  const error = sqliteError(1546);
  sqlite.open.mockImplementation(() => {
    throw error;
  });
  expect(thrownBy(() => openDatabase("saved.db"))).toBe(error);
  expect(sqlite.open).toHaveBeenCalledTimes(1);
  expect(sqlite.exec).not.toHaveBeenCalled();
  expect(Atomics.wait).not.toHaveBeenCalled();
});

test("a changed native error after 1546 escapes immediately without another wait", () => {
  const first = sqliteError(1546);
  const changed = sqliteError(10);
  sqlite.exec.mockImplementationOnce(() => {
    throw first;
  });
  sqlite.exec.mockImplementation(() => {
    throw changed;
  });
  const { log, entries } = recordingLog();
  expect(thrownBy(() => openDatabase("saved.db", log))).toBe(changed);
  expect(sqlite.exec).toHaveBeenCalledTimes(2);
  expect(Atomics.wait).toHaveBeenCalledTimes(1);
  expect(now).toBe(1_250);
  expect(entries).toEqual([failed(1, 0, 1546), failed(2, 250, 10)]);
});

test.each(["darwin", "linux"] as const)("%s never retries first WAL error 1546", (host) => {
  setPlatform(host);
  const error = sqliteError(1546);
  sqlite.exec.mockImplementation(() => {
    throw error;
  });
  const { log, entries } = recordingLog();
  expect(thrownBy(() => openDatabase("saved.db", log))).toBe(error);
  expect(sqlite.exec).toHaveBeenCalledExactlyOnceWith(WAL);
  expect(Atomics.wait).not.toHaveBeenCalled();
  expect(entries).toEqual([failed(1, 0, 1546)]);
});

test("a later initialization pragma failing with 1546 is never retried", () => {
  const error = sqliteError(1546);
  sqlite.exec.mockImplementation((sql) => {
    if (sql === "PRAGMA synchronous = FULL") throw error;
  });
  expect(thrownBy(() => openDatabase("saved.db"))).toBe(error);
  expect(sqlite.exec.mock.calls.map(([sql]) => sql)).toEqual([WAL, "PRAGMA synchronous = FULL"]);
  expect(Atomics.wait).not.toHaveBeenCalled();
});

test.each([WAL, "UPDATE minds SET title = 'Kept'"])(
  "adapter exec never retries a later error 1546 from %s",
  (sql) => {
    const db = openDatabase("saved.db");
    const error = sqliteError(1546);
    sqlite.exec.mockClear();
    sqlite.exec.mockImplementation(() => {
      throw error;
    });
    expect(thrownBy(() => db.exec(sql))).toBe(error);
    expect(sqlite.exec).toHaveBeenCalledExactlyOnceWith(sql);
    expect(Atomics.wait).not.toHaveBeenCalled();
    db.close();
  },
);

test.each([5_000, 5_500])(
  "a retry wait that resumes %s ms after failure cannot start another native call",
  (elapsed) => {
    const error = sqliteError(1546);
    sqlite.exec.mockImplementation(() => {
      throw error;
    });
    vi.mocked(Atomics.wait).mockImplementation(() => {
      now += elapsed;
      return "timed-out";
    });
    expect(thrownBy(() => openDatabase("saved.db"))).toBe(error);
    expect(Atomics.wait).toHaveBeenCalledTimes(1);
    expect(sqlite.exec).toHaveBeenCalledExactlyOnceWith(WAL);
  },
);

test.each([6_000, 6_001])(
  "a successful retry that returns at monotonic %s is outside the five-second budget",
  (finishedAt) => {
    const error = sqliteError(1546);
    sqlite.exec.mockImplementationOnce(() => {
      throw error;
    });
    sqlite.exec.mockImplementation(() => {
      now = finishedAt;
    });
    const { log, entries } = recordingLog();
    expect(thrownBy(() => openDatabase("saved.db", log))).toBe(error);
    expect(sqlite.exec.mock.calls.map(([sql]) => sql)).toEqual([WAL, WAL]);
    expect(Atomics.wait).toHaveBeenCalledTimes(1);
    expect(entries.at(-1)).toEqual({
      level: "warn",
      event: "storage.walOpen.gaveUp",
      fields: { attempts: 2, elapsedMs: finishedAt - 1_000 },
    });
  },
);

test.each([
  ["a WAL error it doesn't retry", (sql: string) => sql === WAL, sqliteError(26)],
  ["Windows error 1546 that outlasts the retries", (sql: string) => sql === WAL, sqliteError(1546)],
  ["a later pragma", (sql: string) => sql === "PRAGMA foreign_keys = ON", sqliteError(1)],
])(
  "a setup that fails on %s closes its connection before it throws (#2067)",
  (_case, fails, error) => {
    sqlite.exec.mockImplementation((sql) => {
      if (fails(sql)) throw error;
    });
    expect(thrownBy(() => openDatabase("saved.db"))).toBe(error);
    expect(sqlite.close).toHaveBeenCalledTimes(1);
  },
);
