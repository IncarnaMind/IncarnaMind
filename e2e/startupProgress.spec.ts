import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { isRecord } from "../src/core/errors";
import { heldByAnotherCopy } from "../src/main/instanceLock";
import { coreOf, createDataFolder, dismissChatSetup, removeDataFolder } from "./app";
import {
  copiesWith,
  freePort,
  inCopyWindow,
  killCopies,
  recordProcessSnapshot,
  startLifecycleCopy,
  windowsOf,
} from "./lifecycle";

let data: string;
let home: string;
let tag: string;
let port: number;
const SLOW_FIXTURE_OBSERVATION_MS = 30_000;

test.beforeEach(async () => {
  data = await createDataFolder();
  home = await mkdtemp(join(tmpdir(), "incarnamind-startup-"));
  tag = `--startup-progress-${randomUUID()}`;
  port = await freePort();
  await recordProcessSnapshot(home, { data });
});
test.afterEach(() => teardownStartup());

async function collectStartupDiagnostics(): Promise<void> {
  const pids = copiesWith(tag, true);
  const path = test.info().outputPath("startup-events.json");
  await writeFile(path, JSON.stringify(await events(), null, 2));
  await test.info().attach("startup-events", { path, contentType: "application/json" });
  const state = test.info().outputPath("startup-state.json");
  await writeFile(
    state,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        port,
        owner: (await ownerState()) ?? null,
        pids,
      },
      null,
      2,
    ),
  );
  await test.info().attach("startup-state", { path: state, contentType: "application/json" });
}

async function teardownStartup(diagnostics = collectStartupDiagnostics): Promise<void> {
  const failures: unknown[] = [];
  try {
    await diagnostics();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      killCopies(tag);
      await expect.poll(() => copiesWith(tag, true)).toEqual([]);
    } catch (error) {
      failures.push(error);
    }
    try {
      await removeDataFolder(data);
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Startup diagnostics or cleanup failed.");
}

async function events(): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(join(home, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value)) throw new Error("The startup fixture recorded an invalid event.");
        return value;
      });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function start(
  mode = "ready",
  extraPreloads: string[] = [],
  language = "en",
  debugPort = port,
): ChildProcess {
  return startLifecycleCopy(
    data,
    home,
    [
      tag,
      `--remote-debugging-port=${debugPort}`,
      ...extraPreloads.flatMap((file) => ["-r", join(__dirname, file)]),
      "-r",
      join(__dirname, "startupProgress.cjs"),
    ],
    {
      INCARNAMIND_TEST_STARTUP_DIR: home,
      INCARNAMIND_TEST_STARTUP_MODE: mode,
      INCARNAMIND_TEST_STARTUP_LANGUAGE: language,
      INCARNAMIND_FAKE_CHAT: "1",
    },
  );
}

async function done(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  expect(child.exitCode).toBe(0);
}

function visibleCount(recorded: Record<string, unknown>[], pid: number): number {
  const windows = new Map<number, boolean>();
  for (const event of recorded) {
    if (event.pid !== pid || typeof event.windowId !== "number") continue;
    if (event.kind === "window-closed") windows.set(event.windowId, false);
    else if (event.kind === "window-visibility" && typeof event.visible === "boolean")
      windows.set(event.windowId, event.visible);
  }
  return [...windows.values()].filter(Boolean).length;
}

async function ownerState(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(data, "instance-info.json"), "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ownerPid(): Promise<number> {
  const owner = await ownerState();
  if (!isRecord(owner) || typeof owner.pid !== "number")
    throw new Error("The startup fixture has no owner process.");
  return owner.pid;
}

async function ownerWindow(): Promise<void> {
  await expect.poll(() => windowsOf(port)).toBe(1);
  const pid = await ownerPid();
  await expect.poll(async () => visibleCount(await events(), pid)).toBe(1);
  expect(
    heldByAnotherCopy(data, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
  await inCopyWindow(port, async (window) => {
    await dismissChatSetup(window);
    expect(await window.getByTestId("plus-menu").isVisible()).toBe(true);
    const native = (await events()).findLast(
      (event) => event.kind === "window" && event.pid === pid,
    );
    if (!native || !isRecord(native.bounds))
      throw new Error("The startup fixture recorded no native window bounds.");
    const viewport = await window.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    expect(viewport.width).toBe(native.bounds.width);
    expect(viewport.height).toBeGreaterThan(0);
    expect(viewport.height).toBeLessThanOrEqual(Number(native.bounds.height));
  });
  if (process.env.INCARNAMIND_PACKAGED_APP) {
    const starts = (await events()).filter((event) => event.kind === "start");
    expect(starts.length).toBeGreaterThan(0);
    for (const event of starts) {
      expect(event.packaged).toBe(true);
      expect(String(event.appPath).replaceAll("\\", "/").toLowerCase()).toMatch(
        /\/resources\/app\.asar$/,
      );
    }
  }
}

test("failed startup diagnostics still clean the owned process and temporary folders", async () => {
  const owner = start();
  try {
    await ownerWindow();
    expect(copiesWith(tag, true)).toContain(owner.pid);
    await writeFile(join(home, "events.jsonl"), '{"kind":"malformed-diagnostic",\n');
    let originalError: unknown;
    let reportedError: unknown;
    try {
      await teardownStartup(async () => {
        try {
          await collectStartupDiagnostics();
        } catch (error) {
          originalError = error;
          throw error;
        }
      });
    } catch (error) {
      reportedError = error;
    }
    const state = {
      ownerPid: owner.pid,
      pids: copiesWith(tag, true),
      dataExists: existsSync(data),
      homeExists: existsSync(home),
      error:
        reportedError instanceof Error
          ? { name: reportedError.name, message: reportedError.message }
          : null,
      originalErrorPreserved: reportedError === originalError,
    };
    const path = test.info().outputPath("malformed-diagnostic-cleanup.json");
    await writeFile(path, JSON.stringify(state, null, 2));
    await test
      .info()
      .attach("malformed-diagnostic-cleanup", { path, contentType: "application/json" });
    expect(reportedError).toBeInstanceOf(SyntaxError);
    expect(reportedError).toBe(originalError);
    expect(state.pids).toEqual([]);
    expect(state.dataExists).toBe(false);
    expect(state.homeExists).toBe(false);
  } finally {
    await teardownStartup(async () => undefined);
  }
});

test("a lost request-watch event still brings the existing window forward", async () => {
  test.setTimeout(60_000);
  const owner = start("ready", ["instanceWatch.cjs"]);
  await ownerWindow();
  await writeFile(join(home, "hide"), "");
  await expect
    .poll(async () =>
      (await events()).some((event) => event.kind === "hidden" && event.pid === owner.pid),
    )
    .toBe(true);
  const next = start("ready", [], "en", await freePort());
  await done(next);
  expect(copiesWith(tag)).toEqual([owner.pid]);
  expect((await events()).filter((event) => event.kind === "problem")).toEqual([]);
  expect(await readFile(join(data, "logs/incarnamind.log"), "utf8")).toContain("app.secondLaunch");
  await ownerWindow();
  const recorded = await events();
  const hiddenAt = recorded.findLastIndex(
    (event) => event.kind === "hidden" && event.pid === owner.pid,
  );
  expect(recorded.slice(hiddenAt + 1)).toContainEqual(
    expect.objectContaining({
      kind: "window-visibility",
      pid: owner.pid,
      visible: true,
    }),
  );
});

test("a slow first startup keeps the next start waiting until the same owner is ready", async () => {
  test.setTimeout(90_000);
  const owner = start("slow");
  await expect.poll(ownerState).toMatchObject({ pid: owner.pid, phase: "starting" });
  const next = start("ready", [], "en", await freePort());
  await expect
    .poll(
      async () =>
        (await events()).some((event) => event.pid === owner.pid && event.kind === "delay-elapsed"),
      { timeout: SLOW_FIXTURE_OBSERVATION_MS },
    )
    .toBe(true);
  expect((await events()).filter((event) => event.kind === "problem")).toEqual([]);
  expect(
    (await readdir(join(data, "instance-requests"))).some((name) => name.endsWith(".request.json")),
  ).toBe(true);
  await writeFile(join(home, "continue"), "");
  await done(next);
  await ownerWindow();
  expect(copiesWith(tag)).toEqual([owner.pid]);
});

test("a killed copy leaves a slow fresh launch alone and keeps its saved text", async () => {
  test.setTimeout(90_000);
  const first = start();
  await ownerWindow();
  await inCopyWindow(port, async (window) => {
    await (await coreOf(window)).evaluate((api) => api.createMind({ title: "Kept after a crash" }));
  });
  const exited = once(first, "exit");
  first.kill("SIGKILL");
  await exited;
  port = await freePort();
  const next = start("slow");
  await expect
    .poll(
      async () =>
        (await events()).some((event) => event.pid === next.pid && event.kind === "delay-elapsed"),
      { timeout: SLOW_FIXTURE_OBSERVATION_MS },
    )
    .toBe(true);
  expect(next.exitCode).toBeNull();
  expect(copiesWith(tag)).toEqual([next.pid]);
  expect((await events()).filter((event) => event.kind === "problem")).toEqual([]);
  await writeFile(join(home, "continue"), "");
  await ownerWindow();
  await inCopyWindow(port, async (window) => {
    expect(await (await coreOf(window)).evaluate((api) => api.listMinds())).toMatchObject([
      { title: "Kept after a crash" },
    ]);
  });
  expect(await readFile(join(data, "logs/incarnamind.log"), "utf8")).not.toContain(
    "app.startStalled",
  );
});

for (const language of ["en", "zh-CN"]) {
  test(`a fresh initial launch reaches its native page (${language})`, async () => {
    test.setTimeout(90_000);
    const child = start("quitting", [], language);
    try {
      await ownerWindow();
      expect((await events()).filter((event) => event.kind === "problem")).toEqual([]);
    } catch (error) {
      const observation: Record<string, unknown> = {
        failedAt: new Date().toISOString(),
        error: String(error),
      };
      try {
        await expect
          .poll(
            async () =>
              child.exitCode !== null ||
              child.signalCode !== null ||
              (await events()).some(
                (event) => event.kind === "window-main-yield" || event.kind === "problem",
              ),
            { timeout: 60_000 },
          )
          .toBe(true);
        observation.reachedReturn = true;
      } catch (observationError) {
        observation.observationError = String(observationError);
      }
      observation.observedAt = new Date().toISOString();
      observation.owner = await ownerState();
      observation.exitCode = child.exitCode;
      observation.signalCode = child.signalCode;
      const path = test.info().outputPath("initial-page-failure-observation.json");
      await writeFile(path, JSON.stringify(observation, null, 2));
      await test.info().attach("initial-page-failure-observation", {
        path,
        contentType: "application/json",
      });
      throw error;
    }
  });

  test(`a content database that cannot open gives the next step and releases its folder (${language})`, async () => {
    await mkdir(join(data, "incarnamind.db"));
    const child = start("ready", [], language);
    await done(child);
    const recorded = await events();
    const problems = recorded.filter((event) => event.kind === "problem");
    expect(problems).toHaveLength(1);
    const problem = problems[0];
    expect(problem).toMatchObject({
      pid: child.pid,
      title: language === "en" ? "IncarnaMind couldn’t start" : "IncarnaMind 无法启动",
      visibleWindows: 0,
    });
    const prefix =
      language === "en"
        ? "Your data folder couldn’t be opened. Close this message, then open IncarnaMind again.\n\n"
        : "无法打开你的数据文件夹。请关闭此提示，然后重新打开 IncarnaMind。\n\n";
    if (typeof problem?.content !== "string")
      throw new Error("The startup problem has no native error detail.");
    expect(problem.content.startsWith(prefix)).toBe(true);
    expect(problem.content.slice(prefix.length).trim()).not.toBe("");
    expect(
      recorded.filter((event) => event.kind === "window-visibility" && event.visible === true),
    ).toEqual([]);
    expect(copiesWith(tag, true)).toEqual([]);
    expect(
      heldByAnotherCopy(data, (what, error) => {
        throw new Error(what, { cause: error });
      }),
    ).toBe(false);
  });

  test(`a starting copy without progress gives a starting problem (${language})`, async () => {
    test.setTimeout(90_000);
    const owner = start("slow", [], language);
    await expect.poll(ownerState).toMatchObject({ pid: owner.pid, phase: "starting", progress: 0 });
    const next = start("ready", [], language, await freePort());
    await done(next);
    const problems = (await events()).filter((event) => event.kind === "problem");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      pid: next.pid,
      visibleWindows: 0,
      content:
        language === "en"
          ? "Another copy hasn’t finished starting. Wait a moment, then open IncarnaMind again."
          : "另一个副本尚未完成启动。请稍候，再重新打开 IncarnaMind。",
    });
    expect(owner.exitCode).toBeNull();
    expect(copiesWith(tag)).toEqual([owner.pid]);
    expect(await windowsOf(port)).toBe(0);
    expect(await ownerState()).toMatchObject({ pid: owner.pid, phase: "starting", progress: 0 });
    expect(
      heldByAnotherCopy(data, (what, error) => {
        throw new Error(what, { cause: error });
      }),
    ).toBe(true);
  });

  test(`a quitting copy that stops exiting gives a quitting problem (${language})`, async () => {
    test.setTimeout(90_000);
    start("quitting", [], language);
    await ownerWindow();
    await writeFile(join(home, "quit"), "");
    await expect
      .poll(async () => (await events()).some((event) => event.kind === "quitting-blocked"))
      .toBe(true);
    const next = start("ready", [], language, await freePort());
    await done(next);
    const problems = (await events()).filter((event) => event.kind === "problem");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      visibleWindows: 0,
      content:
        language === "en"
          ? "Another copy hasn’t finished closing. Wait for it to quit, then open IncarnaMind again."
          : "另一个副本尚未退出。请等待它退出，再重新打开 IncarnaMind。",
    });
    expect(
      heldByAnotherCopy(data, (what, error) => {
        throw new Error(what, { cause: error });
      }),
    ).toBe(true);
  });
}
