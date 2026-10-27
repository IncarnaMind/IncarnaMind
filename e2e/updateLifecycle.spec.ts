import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isRecord } from "../src/core/errors";
import { heldByAnotherCopy } from "../src/main/instanceLock";
import { refuseWrites } from "../tests/helpers/failingStorage";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  newMind,
  removeDataFolder,
} from "./app";
import {
  copiesWith,
  freePort,
  inCopyWindow,
  killCopies,
  mainExecutable,
  prepareLifecycleApps,
  startLifecycleCopy,
  windowsOf,
} from "./lifecycle";
import { holdOwnerFile } from "./ownerFileHolder";

type Scenario =
  | "pending"
  | "pending-install"
  | "pending-error"
  | "installing"
  | "post-install"
  | "target-crash"
  | "auto-quit-error"
  | "unreadable-record"
  | "base-error"
  | "squirrel-error";
interface Entry {
  kind: string;
  pid: number;
  first?: boolean;
  executable?: string;
  packaged?: boolean;
  dataHeld?: boolean;
  visibleWindows?: number;
  visible?: boolean;
  nativePrepared?: boolean;
  debugPort?: string;
  readyPrompts?: number;
  installRequests?: number;
  version?: string;
  title?: string;
  content?: string;
  url?: string;
  added?: number;
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  isSilent?: boolean;
  isForceRunAfter?: boolean;
  windowId?: number;
  args?: string[];
  options?: { message?: string; detail?: string; buttons?: string[]; args?: string[] };
}

const SAVED = "Saved before the update · 更新前保存的文字。";
const PENDING_EDIT = " Extra typing while native preparation waits.";
let data: string;
let home: string;
let tag: string;
let apps: Awaited<ReturnType<typeof prepareLifecycleApps>>;
let diagnosticPorts: number[] = [];

test.beforeEach(async () => {
  diagnosticPorts = [];
  data = await createDataFolder();
  home = await mkdtemp(join(tmpdir(), "incarnamind-update-lifecycle-"));
  tag = `--incarnamind-smoke-copy=${randomUUID()}`;
  apps = await prepareLifecycleApps(home);
});

test.afterEach(async () => {
  try {
    if (test.info().status !== test.info().expectedStatus && diagnosticPorts.length)
      await attachDevToolsFailure();
    const events = join(home, "events.jsonl");
    if (existsSync(events))
      await test
        .info()
        .attach("update-lifecycle", { path: events, contentType: "application/jsonl" });
    for (const [name, path] of [
      ["main-log", join(data, "logs", "incarnamind.log")],
      ["instance-state", join(data, "instance-info.json")],
      ["update-handoff", join(data, "instance-update.json")],
      ["owner-file-holder", join(home, "owner-file-holder.jsonl")],
    ] as const)
      if (existsSync(path)) await test.info().attach(name, { path, contentType: "text/plain" });
  } finally {
    await expect.poll(() => killCopies(tag), { timeout: 30_000 }).toEqual([]);
    await removeDataFolder(data);
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function attachDevToolsFailure() {
  const diagnostics = await Promise.all(
    diagnosticPorts.map(async (port) => {
      let status: number | undefined;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1_000),
          redirect: "manual",
        });
        status = response.status;
        const targets: unknown = await response.json();
        return {
          port,
          status,
          targetCount: Array.isArray(targets) ? targets.length : null,
          targets: Array.isArray(targets)
            ? targets.slice(0, 20).map((target: unknown) => {
                if (!isRecord(target)) return { type: typeof target };
                let url: string | undefined;
                if (typeof target.url === "string") {
                  const parsed = URL.parse(target.url);
                  if (parsed && ["file:", "http:", "https:"].includes(parsed.protocol)) {
                    parsed.username = "";
                    parsed.password = "";
                    parsed.search = "";
                    parsed.hash = "";
                    url = parsed.toString().slice(0, 512);
                  }
                }
                return {
                  type: typeof target.type === "string" ? target.type.slice(0, 64) : undefined,
                  url,
                };
              })
            : null,
        };
      } catch (error) {
        return {
          port,
          status,
          error: {
            name: error instanceof Error ? error.name : typeof error,
            causeCode:
              error instanceof Error &&
              isRecord(error.cause) &&
              typeof error.cause.code === "string"
                ? error.cause.code.slice(0, 64)
                : undefined,
          },
        };
      }
    }),
  );
  await test.info().attach("devtools-failure", {
    body: JSON.stringify(diagnostics, null, 2),
    contentType: "application/json",
  });
  const path = join(home, "early-successor.stderr.log");
  if (existsSync(path)) {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, 32_768));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
      await test.info().attach("early-successor-stderr", {
        body: buffer
          .subarray(0, bytesRead)
          .toString("utf8")
          .replace(/\bwss?:\/\/[^\s"'<>]+/g, "<websocket>"),
        contentType: "text/plain",
      });
    } finally {
      await file.close();
    }
  }
}

async function entries(): Promise<Entry[]> {
  const file = join(home, "events.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
}

const signal = (name: string) => writeFile(join(home, name), "");
const has = async (kind: string) => (await entries()).some((entry) => entry.kind === kind);

function start(
  scenario: Scenario,
  first: boolean,
  port: number,
  nextPort: number,
  generation: "old" | "updated" | "old-with-hint" = "old",
  options: {
    language?: "en" | "zh-CN";
    repairAction?: "download" | "quit";
    ownerRenameProbe?: boolean;
    args?: readonly string[];
  } = {},
): ChildProcess {
  const versionEnv = { ...apps.env };
  if (generation === "updated") {
    if (versionEnv.INCARNAMIND_TEST_UPDATED_APP_DIR) {
      versionEnv.INCARNAMIND_TEST_APP_DIR = versionEnv.INCARNAMIND_TEST_UPDATED_APP_DIR;
      versionEnv.INCARNAMIND_TEST_UPDATE_APP = versionEnv.INCARNAMIND_TEST_UPDATED_APP_DIR;
    }
    if (versionEnv.INCARNAMIND_PACKAGED_UPDATED_APP)
      versionEnv.INCARNAMIND_PACKAGED_APP = versionEnv.INCARNAMIND_PACKAGED_UPDATED_APP;
  }
  return startLifecycleCopy(
    data,
    home,
    [
      tag,
      `--remote-debugging-port=${port}`,
      "-r",
      join(__dirname, "updateFailure.cjs"),
      ...(generation === "old-with-hint" ? ["--updated"] : []),
      ...(options.args ?? []),
    ],
    {
      ...versionEnv,
      INCARNAMIND_TEST_HOOKS: "0",
      INCARNAMIND_TEST_UPDATE_FOLDER: home,
      INCARNAMIND_TEST_UPDATE_APP:
        versionEnv.INCARNAMIND_TEST_UPDATE_APP ?? resolve(__dirname, ".."),
      INCARNAMIND_TEST_UPDATE_FIRST: first ? "1" : "0",
      INCARNAMIND_TEST_UPDATE_SCENARIO: scenario,
      INCARNAMIND_TEST_UPDATE_NEXT_PORT: String(nextPort),
      INCARNAMIND_TEST_UPDATE_LANGUAGE: options.language ?? "en",
      INCARNAMIND_TEST_UPDATE_REPAIR_ACTION: options.repairAction ?? "quit",
      ...(options.ownerRenameProbe && { INCARNAMIND_TEST_OWNER_RENAME_LOG: "1" }),
      APPIMAGE: process.platform === "linux" ? mainExecutable() : "",
      ...(generation === "old-with-hint" && { APPIMAGE_SILENT_INSTALL: "true" }),
    },
  );
}

async function readyOwner() {
  const owner = JSON.parse(await readFile(join(data, "instance-info.json"), "utf8")) as {
    pid: number;
  };
  return (await entries()).findLast((entry) => entry.kind === "ready" && entry.pid === owner.pid);
}

async function expectRepair(
  copy: ChildProcess,
  port: number,
  language: "en" | "zh-CN",
  targetVersion?: string,
  download = false,
) {
  await expect.poll(() => copy.exitCode, { timeout: 30_000 }).toBe(0);
  expect(await windowsOf(port)).toBe(0);
  const recorded = (await entries()).filter((entry) => entry.pid === copy.pid);
  const problem = recorded.filter((entry) => entry.kind === "startup-problem");
  const detail =
    language === "en"
      ? `${targetVersion ? `The update to ${targetVersion}` : "The update"} may not have finished. This copy is ${apps.oldVersion}, so it won’t open your data folder. Download and install the latest version, then open IncarnaMind again.`
      : `${targetVersion ? `更新到 ${targetVersion} ` : "更新"}可能没有完成。当前版本是 ${apps.oldVersion}，所以不会打开你的数据文件夹。下载并安装最新版本后，再打开 IncarnaMind。`;
  expect(problem).toEqual([
    expect.objectContaining({
      dataHeld: false,
      visibleWindows: 0,
      options: expect.objectContaining({
        message: language === "en" ? "IncarnaMind needs the latest version" : "需要安装最新版本",
        detail,
        buttons:
          language === "en" ? ["Download the latest version", "Quit"] : ["下载最新版本", "退出"],
      }),
    }),
  ]);
  expect(recorded.filter((entry) => entry.kind === "window-created" || entry.dataHeld)).toEqual([]);
  expect(recorded.filter((entry) => entry.kind === "external-open")).toEqual(
    download
      ? [expect.objectContaining({ url: "https://github.com/IncarnaMind/IncarnaMind/releases" })]
      : [],
  );
  expect(
    heldByAnotherCopy(data, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(false);
}

async function quit(copy: ChildProcess) {
  await signal(`quit-${copy.pid}`);
  await expect.poll(() => copy.exitCode, { timeout: 30_000 }).toBe(0);
}

async function expectPendingWindow(copy: ChildProcess, port: number, language: "en" | "zh-CN") {
  await expectOneSavedWindow([port]);
  await expect
    .poll(async () =>
      (await entries()).some((entry) => entry.pid === copy.pid && entry.kind === "pending-update"),
    )
    .toBe(true);
  const recorded = (await entries()).filter((entry) => entry.pid === copy.pid);
  expect(recorded.filter((entry) => entry.kind === "pending-update")).toEqual([
    expect.objectContaining({
      dataHeld: true,
      visibleWindows: 1,
      options: expect.objectContaining({
        message:
          language === "en"
            ? "The update will finish the next time you quit IncarnaMind."
            : "下次退出 IncarnaMind 时将完成更新。",
      }),
    }),
  ]);
  expect(recorded.filter((entry) => entry.kind === "startup-problem")).toEqual([]);
  expect(recorded.filter((entry) => entry.kind === "external-open")).toEqual([]);
  expect(copy.exitCode).toBeNull();
  expect(await readyOwner()).toMatchObject({
    pid: copy.pid,
    version: apps.oldVersion,
    dataHeld: true,
  });
}

async function saveTyping(window: Page, language: "en" | "zh-CN") {
  await dismissChatSetup(window);
  await (await coreOf(window)).evaluate(
    (api, value) => api.updateSettings({ user: { language: value } }),
    language,
  );
  await newMind(window);
  await window.keyboard.insertText(SAVED);
  await expect(frontMind(window).locator(".mind-editor")).toContainText(SAVED);
  await expect
    .poll(() => coreOf(window).then((core) => core.evaluate((api) => api.saveChangesAgain())))
    .toBeNull();
}

async function expectOneSavedWindow(ports: number[], text = SAVED) {
  await expect
    .poll(
      async () => ({
        copies: copiesWith(tag).length,
        windows: (await Promise.all(ports.map(windowsOf))).reduce((sum, count) => sum + count, 0),
      }),
      { timeout: 60_000 },
    )
    .toEqual({ copies: 1, windows: 1 });
  const counts = await Promise.all(ports.map(windowsOf));
  const index = counts.indexOf(1);
  await inCopyWindow(ports[index], async (window) => {
    await window.getByRole("treeitem", { name: /^Saved before the update/ }).click();
    await expect(frontMind(window).locator(".mind-editor")).toContainText(text);
    expect(await (await coreOf(window)).evaluate((api) => api.saveChangesAgain())).toBeNull();
  });
  await expect
    .poll(async () => {
      const visible = new Map<string, boolean>();
      for (const entry of await entries()) {
        if (entry.kind === "window-visibility")
          visible.set(`${entry.pid}:${entry.windowId}`, entry.visible === true);
        else if (entry.kind === "window-closed")
          visible.set(`${entry.pid}:${entry.windowId}`, false);
      }
      return [...visible.values()].filter(Boolean).length;
    })
    .toBe(1);
  expect(
    heldByAnotherCopy(data, (what, error) => {
      throw new Error(what, { cause: error });
    }),
  ).toBe(true);
}

async function expectPreparationHeld() {
  await expect.poll(() => has("wrapper-ready")).toBe(true);
  await signal("check-preparation");
  await expect.poll(() => has("preparation-checkpoint")).toBe(true);
  expect((await entries()).find((entry) => entry.kind === "preparation-checkpoint")).toMatchObject({
    nativePrepared: false,
    readyPrompts: 0,
    installRequests: 0,
  });
}

async function finishInstallWithoutSuccessor(
  port: number,
  nextPort: number,
  language: "en" | "zh-CN" = "en",
) {
  const old = start("post-install", true, port, nextPort, "old", { language });
  await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
  await inCopyWindow(port, (window) => saveTyping(window, language));
  expect(await readyOwner()).toMatchObject({ version: apps.oldVersion, dataHeld: true });
  await signal("begin");
  await expect.poll(() => has("install-quit-held")).toBe(true);
  await signal("finish-install");
  await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
  const file = join(data, "instance-update.json");
  const text = await readFile(file, "utf8");
  const handoff: unknown = JSON.parse(text);
  expect(handoff).toMatchObject({
    status: "installing",
    fromVersion: apps.oldVersion,
    targetVersion: apps.updatedVersion,
  });
  return { file, text };
}

test("pending native preparation offers no Restart and keeps the quit guard before a Dock reopen", async () => {
  test.skip(
    process.platform !== "darwin",
    "Squirrel and Dock activation are macOS lifecycle events",
  );
  test.setTimeout(120_000);
  const port = await freePort();
  const old = start("pending", true, port, port);
  await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
  await inCopyWindow(port, (window) => saveTyping(window, "en"));
  await signal("begin");
  await expectPreparationHeld();
  let restoreWrites: (() => void) | undefined;
  try {
    restoreWrites = refuseWrites(data);
    await inCopyWindow(port, async (window) => {
      await frontMind(window).locator(".mind-editor").press("ControlOrMeta+End");
      await window.keyboard.insertText(PENDING_EDIT);
      await expect(frontMind(window).locator(".mind-editor")).toContainText(SAVED + PENDING_EDIT);
      await expect
        .poll(() => coreOf(window).then((core) => core.evaluate((api) => api.saveChangesAgain())))
        .not.toBeNull();
    });
    await signal("ordinary-quit");
    await expect.poll(() => has("unsaved-question")).toBe(true);
    expect(old.exitCode).toBeNull();
    expect((await entries()).filter((entry) => entry.kind === "relaunch")).toEqual([]);
    restoreWrites();
    restoreWrites = undefined;
    await inCopyWindow(port, async (window) => {
      await expect(frontMind(window).locator(".mind-editor")).toContainText(SAVED + PENDING_EDIT);
      await expect
        .poll(() => coreOf(window).then((core) => core.evaluate((api) => api.saveChangesAgain())))
        .toBeNull();
    });
    await signal("ordinary-quit-again");
    await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
    const recorded = await entries();
    expect(recorded.filter((entry) => entry.kind === "activate-during-quit")).toHaveLength(2);
    expect(recorded.filter((entry) => entry.kind === "relaunch")).toHaveLength(1);
    expect(recorded.filter((entry) => entry.kind === "startup-problem")).toEqual([]);
    await expectOneSavedWindow([port], SAVED + PENDING_EDIT);
  } finally {
    restoreWrites?.();
  }
});

test("native preparation finishing offers Restart once and then installs the update", async () => {
  test.skip(process.platform !== "darwin", "Squirrel native preparation is a macOS lifecycle");
  test.setTimeout(120_000);
  const port = await freePort();
  const nextPort = await freePort();
  const old = start("pending-install", true, port, nextPort);
  await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
  await inCopyWindow(port, (window) => saveTyping(window, "en"));
  await signal("begin");
  await expectPreparationHeld();
  await signal("prepare-native");
  await expect.poll(() => has("install-quit-held")).toBe(true);
  const recorded = await entries();
  expect(recorded.filter((entry) => entry.kind === "ready-prompt")).toEqual([
    expect.objectContaining({ nativePrepared: true }),
  ]);
  expect(recorded.findIndex((entry) => entry.kind === "native-prepared")).toBeLessThan(
    recorded.findIndex((entry) => entry.kind === "ready-prompt"),
  );
  await signal("finish-install");
  await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
  await expectOneSavedWindow([port, nextPort]);
  await expect.poll(() => windowsOf(nextPort)).toBe(1);
  expect(await readyOwner()).toMatchObject({ version: apps.updatedVersion, dataHeld: true });
});

test("a native preparation error leaves the current window usable without committing a quit", async () => {
  test.skip(process.platform !== "darwin", "Squirrel native preparation is a macOS lifecycle");
  test.setTimeout(120_000);
  const port = await freePort();
  const old = start("pending-error", true, port, port);
  await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
  await inCopyWindow(port, (window) => saveTyping(window, "en"));
  await signal("begin");
  await expectPreparationHeld();
  await signal("fail-native-preparation");
  await expect
    .poll(() => readFile(join(data, "logs", "incarnamind.log"), "utf8"))
    .toContain("The local native preparation fixture failed.");
  expect(old.exitCode).toBeNull();
  expect((await entries()).filter((entry) => entry.kind === "ready-prompt")).toEqual([]);
  expect((await entries()).filter((entry) => entry.kind === "install-requested")).toEqual([]);
  expect((await entries()).filter((entry) => entry.kind === "problem")).toEqual([]);
  expect((await entries()).filter((entry) => entry.kind === "relaunch")).toEqual([]);
  await expectOneSavedWindow([port]);
});

test("an installing update refuses an unrelated start and keeps its own replacement", async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const nextPort = await freePort();
  const contenderPort = await freePort();
  diagnosticPorts = [...new Set([port, nextPort, contenderPort])];
  const old = start("installing", true, port, nextPort);
  await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
  await inCopyWindow(port, (window) => saveTyping(window, "en"));
  await signal("begin");
  await expect.poll(() => has("install-quit-held")).toBe(true);
  const contender = start("installing", false, contenderPort, nextPort);
  await expect.poll(() => contender.exitCode, { timeout: 30_000 }).toBe(0);
  expect(await windowsOf(contenderPort)).toBe(0);
  expect((await entries()).filter((entry) => entry.kind === "startup-problem")).toEqual([]);
  expect(old.exitCode).toBeNull();
  if (process.platform === "linux") {
    await expect
      .poll(async () =>
        (await entries()).some(
          (entry) => !entry.first && entry.args?.includes(`--remote-debugging-port=${nextPort}`),
        ),
      )
      .toBe(true);
    expect(await windowsOf(nextPort)).toBe(0);
  }
  await signal("finish-install");
  await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
  await expectOneSavedWindow([port, nextPort, contenderPort]);
  await expect.poll(() => windowsOf(nextPort)).toBe(1);
  expect(await readyOwner()).toMatchObject({ version: apps.updatedVersion, dataHeld: true });
  expect((await entries()).filter((entry) => entry.kind === "problem")).toEqual([]);
});

test("a pending update keeps saved data usable in one old copy until the target is ready", async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const nextPort = await freePort();
  const oldPort = await freePort();
  const hintedPort = await freePort();
  const wrongIdPort = await freePort();
  const handoff = await finishInstallWithoutSuccessor(port, nextPort);
  for (const contender of [
    { generation: "old", port: oldPort, args: [] },
    { generation: "old-with-hint", port: hintedPort, args: [] },
    { generation: "old", port: wrongIdPort, args: [`--update-recovery=${randomUUID()}`] },
  ] as const) {
    const copy = start("post-install", false, contender.port, nextPort, contender.generation, {
      args: contender.args,
    });
    await expectPendingWindow(copy, contender.port, "en");
    expect(await readFile(handoff.file, "utf8")).toBe(handoff.text);
    await quit(copy);
    expect(await readFile(handoff.file, "utf8")).toBe(handoff.text);
  }
  const updated = start("post-install", false, nextPort, nextPort, "updated");
  await expectOneSavedWindow([port, oldPort, hintedPort, wrongIdPort, nextPort]);
  expect(updated.exitCode).toBeNull();
  expect(await readyOwner()).toMatchObject({ version: apps.updatedVersion, dataHeld: true });
  await expect.poll(() => existsSync(handoff.file)).toBe(false);
});

test("a target killed before its first usable window leaves the handoff for a later target", async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const targetPort = await freePort();
  const oldPort = await freePort();
  const nextPort = await freePort();
  const handoff = await finishInstallWithoutSuccessor(port, targetPort, "zh-CN");
  const target = start("target-crash", false, targetPort, nextPort, "updated");
  await expect
    .poll(() => target.exitCode !== null || target.signalCode !== null, { timeout: 30_000 })
    .toBe(true);
  expect(target.exitCode === 0 && target.signalCode === null).toBe(false);
  expect((await entries()).filter((entry) => entry.kind === "target-before-ready-crash")).toEqual([
    expect.objectContaining({
      pid: target.pid,
      version: apps.updatedVersion,
      dataHeld: true,
      visibleWindows: 0,
    }),
  ]);
  expect((await entries()).filter((entry) => entry.pid === target.pid && entry.visible)).toEqual(
    [],
  );
  expect(await readFile(handoff.file, "utf8")).toBe(handoff.text);
  const old = start("post-install", false, oldPort, nextPort, "old", { language: "zh-CN" });
  await expectPendingWindow(old, oldPort, "zh-CN");
  expect(await readFile(handoff.file, "utf8")).toBe(handoff.text);
  await quit(old);
  start("post-install", false, nextPort, nextPort, "updated");
  await expectOneSavedWindow([port, targetPort, oldPort, nextPort]);
  expect(await readyOwner()).toMatchObject({ version: apps.updatedVersion, dataHeld: true });
  await expect.poll(() => existsSync(handoff.file)).toBe(false);
});

for (const kind of ["corrupt", "unreadable"] as const) {
  test(`a ${kind} update record leaves normal startup and its one saved-data owner intact`, async () => {
    test.setTimeout(120_000);
    const firstPort = await freePort();
    const first = start("post-install", false, firstPort, firstPort);
    await expect.poll(() => windowsOf(firstPort), { timeout: 60_000 }).toBe(1);
    await inCopyWindow(firstPort, (window) => saveTyping(window, "en"));
    await quit(first);
    const file = join(data, "instance-update.json");
    const malformed = "{broken";
    await writeFile(file, malformed);
    const port = await freePort();
    const scenario = kind === "corrupt" ? "post-install" : "unreadable-record";
    const owner = start(scenario, false, port, port);
    await expectOneSavedWindow([firstPort, port]);
    const contenderPort = await freePort();
    const contender = start(scenario, false, contenderPort, port);
    await expect.poll(() => contender.exitCode, { timeout: 30_000 }).toBe(0);
    expect(await windowsOf(contenderPort)).toBe(0);
    expect(copiesWith(tag)).toEqual([owner.pid]);
    await expectOneSavedWindow([port, contenderPort]);
    expect((await entries()).filter((entry) => entry.kind === "startup-problem")).toEqual([]);
    expect((await entries()).filter((entry) => entry.kind === "pending-update")).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(malformed);
    expect(await readFile(join(data, "logs", "incarnamind.log"), "utf8")).toContain(
      kind === "corrupt" ? "app.updateHandoffInvalid" : "app.updateHandoffReadFailed",
    );
  });
}

for (const scenario of ["base-error", "squirrel-error"] as const) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`${scenario}: a failed install protects typing while a second start arrives (${language})`, async () => {
      test.skip(
        scenario === "squirrel-error" && process.platform !== "darwin",
        "Squirrel closes macOS windows before reporting an install error",
      );
      test.setTimeout(120_000);
      const port = await freePort();
      const beforeErrorPort = await freePort();
      const secondPort = await freePort();
      const old = start(scenario, true, port, port, "old", {
        language,
        ownerRenameProbe: process.platform === "win32",
      });
      await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
      await inCopyWindow(port, (window) => saveTyping(window, language));
      await signal("begin");
      await expect.poll(() => has("install-requested")).toBe(true);
      const beforeFailure = await entries();
      expect(beforeFailure.some((entry) => entry.kind === "before-quit")).toBe(false);
      if (scenario === "base-error") expect(await windowsOf(port)).toBe(1);
      else await expect.poll(() => has("windows-closed")).toBe(true);
      const beforeError = start(scenario, false, beforeErrorPort, port);
      await expect.poll(() => beforeError.exitCode, { timeout: 30_000 }).toBe(0);
      expect(await windowsOf(beforeErrorPort)).toBe(0);
      expect((await entries()).some((entry) => entry.kind === "before-quit")).toBe(false);
      await signal("fail");
      await expect.poll(() => has("problem")).toBe(true);
      const shown = (await entries()).filter((entry) => entry.kind === "problem");
      expect(shown).toEqual([
        expect.objectContaining({
          pid: old.pid,
          dataHeld: true,
          visibleWindows: 0,
          options: expect.objectContaining({
            message: language === "en" ? "The update couldn’t be installed" : "未能安装更新",
            detail:
              language === "en"
                ? "IncarnaMind will reopen when you close this message. You can install the update later."
                : "关闭此提示后，IncarnaMind 会重新打开。之后可以再安装更新。",
            buttons: [language === "en" ? "Reopen IncarnaMind" : "重新打开 IncarnaMind"],
          }),
        }),
      ]);
      const second = start(scenario, false, secondPort, port);
      await expect
        .poll(async () =>
          (await entries()).some((entry) => entry.kind === "start" && entry.pid === second.pid),
        )
        .toBe(true);
      expect(
        (await entries()).filter(
          (entry) => entry.kind === "window-created" && entry.pid === second.pid,
        ),
      ).toEqual([]);
      const holder =
        process.platform === "win32"
          ? await holdOwnerFile(
              join(data, "instance-info.json"),
              join(home, "owner-file-holder.jsonl"),
            )
          : undefined;
      try {
        await signal("dismiss-problem");
        await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
        if (holder) {
          await expect
            .poll(
              async () => (await entries()).some((entry) => entry.kind === "owner-rename-refused"),
              { timeout: 30_000 },
            )
            .toBe(true);
          await holder.release();
        }
        await expectOneSavedWindow([port, beforeErrorPort, secondPort]);
        const recorded = await entries();
        expect(recorded.filter((entry) => entry.kind === "relaunch")).toHaveLength(1);
        expect(recorded.filter((entry) => entry.kind === "startup-problem")).toEqual([]);
        expect(recorded.filter((entry) => entry.kind === "problem")).toHaveLength(1);
        const recoveryArgs = recorded.find((entry) => entry.kind === "relaunch")?.options?.args;
        if (!recoveryArgs?.length)
          throw new Error("The failed install did not name its recovery start.");
        const owner = await readyOwner();
        expect(owner).toMatchObject({ version: apps.oldVersion, dataHeld: true });
        expect(
          recorded.find((entry) => entry.kind === "start" && entry.pid === owner?.pid)?.args,
        ).toEqual(expect.arrayContaining(recoveryArgs));
        if (process.env.INCARNAMIND_PACKAGED_APP) {
          const executable = mainExecutable();
          expect(
            recorded
              .filter((entry) => entry.kind === "start")
              .every(
                (entry) =>
                  entry.packaged &&
                  (process.platform === "win32"
                    ? entry.executable?.toLowerCase() === executable.toLowerCase()
                    : entry.executable === executable),
              ),
          ).toBe(true);
        }
        if (holder) {
          const lastRefusal = recorded.findLastIndex(
            (entry) => entry.kind === "owner-rename-refused",
          );
          expect(lastRefusal).toBeGreaterThanOrEqual(0);
          expect(
            recorded.some(
              (entry, index) =>
                index > lastRefusal && entry.kind === "owner-rename" && entry.pid === owner?.pid,
            ),
          ).toBe(true);
          const evidence = (await readFile(join(home, "owner-file-holder.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map(
              (line) => JSON.parse(line) as { event: string; pid: number; deleteShared?: boolean },
            );
          expect(evidence).toEqual([
            expect.objectContaining({ event: "holding", pid: holder.pid, deleteShared: false }),
            expect.objectContaining({ event: "released", pid: holder.pid }),
          ]);
        }
      } finally {
        await holder?.release();
      }
    });
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a failed automatic install keeps an accepted reopen and recovers saved typing (${language})`, async () => {
    test.setTimeout(120_000);
    const port = await freePort();
    const nextPort = await freePort();
    const old = start("auto-quit-error", true, port, nextPort, "old", { language });
    await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
    await inCopyWindow(port, (window) => saveTyping(window, language));
    await signal("begin");
    await expect.poll(() => has("ready-prompt")).toBe(true);
    expect((await entries()).filter((entry) => entry.kind === "auto-quit-listener")).toEqual([
      expect.objectContaining({ added: 1, autoDownload: true, autoInstallOnAppQuit: true }),
    ]);
    expect((await entries()).filter((entry) => entry.kind === "install-requested")).toEqual([]);
    await signal("ordinary-quit-reopen");
    await expect.poll(() => has("problem")).toBe(true);
    const beforeDismiss = await entries();
    expect(beforeDismiss.filter((entry) => entry.kind === "activate-during-quit")).toHaveLength(1);
    expect(beforeDismiss.filter((entry) => entry.kind === "auto-install-on-quit")).toEqual([
      expect.objectContaining({
        pid: old.pid,
        isSilent: true,
        isForceRunAfter: false,
        autoDownload: true,
        autoInstallOnAppQuit: true,
        dataHeld: true,
      }),
    ]);
    expect(beforeDismiss.findIndex((entry) => entry.kind === "activate-during-quit")).toBeLessThan(
      beforeDismiss.findIndex((entry) => entry.kind === "auto-install-on-quit"),
    );
    expect(beforeDismiss.filter((entry) => entry.kind === "problem")).toEqual([
      expect.objectContaining({
        pid: old.pid,
        dataHeld: true,
        visibleWindows: 0,
        options: expect.objectContaining({
          message: language === "en" ? "The update couldn’t be installed" : "未能安装更新",
          buttons: [language === "en" ? "Reopen IncarnaMind" : "重新打开 IncarnaMind"],
        }),
      }),
    ]);
    const handoff: unknown = JSON.parse(await readFile(join(data, "instance-update.json"), "utf8"));
    expect(handoff).toMatchObject({
      status: "failed",
      reopens: true,
      fromVersion: apps.oldVersion,
      targetVersion: apps.updatedVersion,
    });
    if (!isRecord(handoff) || typeof handoff.id !== "string")
      throw new Error("The failed install did not retain its recovery identity.");
    await signal("dismiss-problem");
    await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
    await expectOneSavedWindow([port, nextPort]);
    const owner = await readyOwner();
    expect(owner).toMatchObject({ version: apps.oldVersion, dataHeld: true });
    const recorded = await entries();
    expect(
      recorded.find((entry) => entry.kind === "start" && entry.pid === owner?.pid)?.args,
    ).toContain(`--update-recovery=${handoff.id}`);
    expect(recorded.filter((entry) => entry.kind === "problem")).toHaveLength(1);
    expect(recorded.filter((entry) => entry.kind === "startup-problem")).toEqual([]);
    expect(recorded.filter((entry) => entry.kind === "install-requested")).toEqual([]);
  });

  test(`a failed automatic install finishes quitting without a relaunch and repairs a later start (${language})`, async () => {
    test.setTimeout(120_000);
    const port = await freePort();
    const nextPort = await freePort();
    const old = start("auto-quit-error", true, port, nextPort, "old", { language });
    await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
    await inCopyWindow(port, (window) => saveTyping(window, language));
    await signal("begin");
    await expect.poll(() => has("ready-prompt")).toBe(true);
    expect((await entries()).filter((entry) => entry.kind === "auto-quit-listener")).toEqual([
      expect.objectContaining({ added: 1, autoDownload: true, autoInstallOnAppQuit: true }),
    ]);
    expect((await entries()).filter((entry) => entry.kind === "wrapper-downloaded")).toEqual([
      expect.objectContaining({
        version: apps.updatedVersion,
        autoDownload: true,
        autoInstallOnAppQuit: true,
      }),
    ]);
    expect((await entries()).filter((entry) => entry.kind === "install-requested")).toEqual([]);
    await quit(old);
    const recorded = await entries();
    expect(recorded.filter((entry) => entry.kind === "auto-install-on-quit")).toEqual([
      expect.objectContaining({
        pid: old.pid,
        isSilent: true,
        isForceRunAfter: false,
        autoDownload: true,
        autoInstallOnAppQuit: true,
        dataHeld: true,
      }),
    ]);
    expect(recorded.filter((entry) => entry.kind === "auto-install-failed")).toEqual([
      expect.objectContaining({ pid: old.pid, autoDownload: true, autoInstallOnAppQuit: true }),
    ]);
    expect(recorded.findIndex((entry) => entry.kind === "wrapper-downloaded")).toBeLessThan(
      recorded.findIndex((entry) => entry.kind === "auto-quit-listener"),
    );
    expect(recorded.findIndex((entry) => entry.kind === "quit")).toBeLessThan(
      recorded.findIndex((entry) => entry.kind === "auto-install-on-quit"),
    );
    expect(recorded.filter((entry) => entry.kind === "install-requested")).toEqual([]);
    expect(recorded.filter((entry) => entry.kind === "relaunch")).toEqual([]);
    expect(
      recorded.filter((entry) => entry.kind === "problem" || entry.kind === "startup-problem"),
    ).toEqual([]);
    expect(await readFile(join(data, "logs", "incarnamind.log"), "utf8")).toContain(
      "app.updateInstallFailed",
    );
    const file = join(data, "instance-update.json");
    const failed = await readFile(file, "utf8");
    const handoff: unknown = JSON.parse(failed);
    expect(handoff).toMatchObject({
      status: "failed",
      reopens: false,
      fromVersion: apps.oldVersion,
      targetVersion: apps.updatedVersion,
    });
    for (const [index, args] of [[], [`--update-recovery=${randomUUID()}`]].entries()) {
      const manualPort = await freePort();
      const manual = start("post-install", false, manualPort, nextPort, "old", {
        language,
        args,
        repairAction: index === 0 ? "download" : "quit",
      });
      await expectRepair(manual, manualPort, language, apps.updatedVersion, index === 0);
      expect(await readFile(file, "utf8")).toBe(failed);
    }
    start("post-install", false, nextPort, nextPort, "updated", { language });
    await expectOneSavedWindow([port, nextPort]);
    expect(await readyOwner()).toMatchObject({ version: apps.updatedVersion, dataHeld: true });
    await expect.poll(() => existsSync(file)).toBe(false);
    expect((await entries()).filter((entry) => entry.kind === "pending-update")).toEqual([]);
  });
}
