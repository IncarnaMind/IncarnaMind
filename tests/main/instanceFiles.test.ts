import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { writeJson } from "../../src/main/instanceFiles";

const fsControl = vi.hoisted(() => ({
  actual: undefined as unknown as typeof import("node:fs").renameSync,
  rename: vi.fn<typeof import("node:fs").renameSync>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsControl.actual = actual.renameSync;
  return { ...actual, renameSync: fsControl.rename };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform");
let folder: string;
let file: string;
let now: number;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value });
}

function refusal(code: string) {
  return Object.assign(new Error(`rename refused: ${code}`), { code });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fsControl.rename.mockImplementation((from, to) => fsControl.actual(from, to));
  setPlatform("win32");
  now = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    if (timeout === undefined || !Number.isFinite(timeout))
      throw new Error("The rename retry must use a bounded wait.");
    now += timeout;
    return "timed-out";
  });
  folder = await mkdtemp(join(tmpdir(), "incarnamind-instance-files-"));
  file = join(folder, "instance-info.json");
  await writeFile(file, JSON.stringify({ pid: "old" }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (!platform) throw new Error("The test could not restore the native platform.");
  Object.defineProperty(process, "platform", platform);
  await rm(folder, { recursive: true, force: true });
});

test("Windows retries a transient EPERM and atomically publishes the new value", async () => {
  const attempts: number[] = [];
  fsControl.rename.mockImplementation((from, to) => {
    attempts.push(now);
    if (attempts.length === 1) throw refusal("EPERM");
    fsControl.actual(from, to);
  });

  writeJson(file, { pid: 1836, text: "已恢复" });

  expect(attempts).toEqual([1_000, 1_250]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ pid: 1836, text: "已恢复" });
  expect((await readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a persistent Windows EPERM stops at five seconds without a call at the deadline", async () => {
  const error = refusal("EPERM");
  const attempts: number[] = [];
  fsControl.rename.mockImplementation(() => {
    attempts.push(now);
    throw error;
  });

  expect(() => writeJson(file, { pid: 1836 })).toThrow(error);

  expect(attempts).toHaveLength(20);
  expect(attempts.at(-1)).toBe(5_750);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ pid: "old" });
  expect((await readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("a non-EPERM rename error is not retried", async () => {
  const error = refusal("EACCES");
  fsControl.rename.mockImplementation(() => {
    throw error;
  });

  expect(() => writeJson(file, { pid: 1836 })).toThrow(error);

  expect(fsControl.rename).toHaveBeenCalledTimes(1);
  expect(Atomics.wait).not.toHaveBeenCalled();
  expect((await readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("non-Windows keeps the single-rename behavior for EPERM", async () => {
  setPlatform("linux");
  const error = refusal("EPERM");
  fsControl.rename.mockImplementation(() => {
    throw error;
  });

  expect(() => writeJson(file, { pid: 1836 })).toThrow(error);

  expect(fsControl.rename).toHaveBeenCalledTimes(1);
  expect(Atomics.wait).not.toHaveBeenCalled();
  expect((await readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
