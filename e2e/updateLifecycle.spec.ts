import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { heldByAnotherCopy } from "../src/main/instanceLock";
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
  startLifecycleCopy,
  windowsOf,
} from "./lifecycle";

type Scenario = "pending" | "installing" | "base-error" | "squirrel-error";
interface Entry {
  kind: string;
  pid: number;
  first?: boolean;
  executable?: string;
  packaged?: boolean;
  dataHeld?: boolean;
  visibleWindows?: number;
  visible?: boolean;
  windowId?: number;
  args?: string[];
  options?: { message?: string; detail?: string; buttons?: string[]; args?: string[] };
}

const SAVED = "Saved before the update · 更新前保存的文字。";
let data: string;
let home: string;
let tag: string;

test.beforeEach(async () => {
  data = await createDataFolder();
  home = await mkdtemp(join(tmpdir(), "incarnamind-update-lifecycle-"));
  tag = `--incarnamind-smoke-copy=${randomUUID()}`;
});

test.afterEach(async () => {
  try {
    const events = join(home, "events.jsonl");
    if (existsSync(events))
      await test
        .info()
        .attach("update-lifecycle", { path: events, contentType: "application/jsonl" });
    for (const [name, path] of [
      ["main-log", join(data, "logs", "incarnamind.log")],
      ["instance-state", join(data, "instance-info.json")],
    ] as const)
      if (existsSync(path)) await test.info().attach(name, { path, contentType: "text/plain" });
  } finally {
    await expect.poll(() => killCopies(tag), { timeout: 30_000 }).toEqual([]);
    await removeDataFolder(data);
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

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

function start(scenario: Scenario, first: boolean, port: number, nextPort: number): ChildProcess {
  return startLifecycleCopy(
    data,
    home,
    [tag, `--remote-debugging-port=${port}`, "-r", join(__dirname, "updateFailure.cjs")],
    {
      INCARNAMIND_TEST_HOOKS: "0",
      INCARNAMIND_TEST_UPDATE_FOLDER: home,
      INCARNAMIND_TEST_UPDATE_APP: resolve(__dirname, ".."),
      INCARNAMIND_TEST_UPDATE_FIRST: first ? "1" : "0",
      INCARNAMIND_TEST_UPDATE_SCENARIO: scenario,
      INCARNAMIND_TEST_UPDATE_NEXT_PORT: String(nextPort),
      APPIMAGE: process.platform === "linux" ? mainExecutable() : "",
    },
  );
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

async function expectOneSavedWindow(ports: number[]) {
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
    await expect(frontMind(window).locator(".mind-editor")).toContainText(SAVED);
    expect(await (await coreOf(window)).evaluate((api) => api.saveChangesAgain())).toBeNull();
  });
  await expect
    .poll(async () => {
      const visible = new Map<string, boolean>();
      for (const entry of await entries()) {
        if (entry.kind === "window-visibility")
          visible.set(`${entry.pid}:${entry.windowId}`, entry.visible === true);
        else if (["window-shown", "window-hidden", "window-closed"].includes(entry.kind))
          visible.set(`${entry.pid}:${entry.windowId}`, entry.kind === "window-shown");
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

test("a pending Squirrel restart preserves a Dock reopen during an ordinary quit", async () => {
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
  await expect.poll(() => has("install-requested")).toBe(true);
  expect(await has("native-install-begun")).toBe(false);
  await signal("ordinary-quit");
  await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
  const recorded = await entries();
  expect(recorded.filter((entry) => entry.kind === "activate-during-quit")).toHaveLength(1);
  expect(recorded.filter((entry) => entry.kind === "relaunch")).toHaveLength(1);
  expect(recorded.filter((entry) => entry.kind === "startup-problem")).toEqual([]);
  await expectOneSavedWindow([port]);
});

test("an installing update refuses an unrelated start and keeps its own replacement", async () => {
  test.setTimeout(120_000);
  const port = await freePort();
  const nextPort = await freePort();
  const contenderPort = await freePort();
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
  expect((await entries()).filter((entry) => entry.kind === "problem")).toEqual([]);
});

for (const scenario of ["base-error", "squirrel-error"] as const) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`${scenario}: a failed install protects typing while a second start arrives (${language})`, async () => {
      test.skip(
        scenario === "squirrel-error" && process.platform !== "darwin",
        "Squirrel closes macOS windows before reporting an install error",
      );
      test.setTimeout(120_000);
      const port = await freePort();
      const secondPort = await freePort();
      const old = start(scenario, true, port, port);
      await expect.poll(() => windowsOf(port), { timeout: 60_000 }).toBe(1);
      await inCopyWindow(port, (window) => saveTyping(window, language));
      await signal("begin");
      await expect.poll(() => has("install-requested")).toBe(true);
      const beforeFailure = await entries();
      expect(beforeFailure.some((entry) => entry.kind === "before-quit")).toBe(false);
      if (scenario === "base-error") expect(await windowsOf(port)).toBe(1);
      else await expect.poll(() => has("windows-closed")).toBe(true);
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
      await signal("dismiss-problem");
      await expect.poll(() => old.exitCode, { timeout: 30_000 }).toBe(0);
      await expectOneSavedWindow([port, secondPort]);
      const recorded = await entries();
      expect(recorded.filter((entry) => entry.kind === "relaunch")).toHaveLength(1);
      expect(recorded.filter((entry) => entry.kind === "startup-problem")).toEqual([]);
      expect(recorded.filter((entry) => entry.kind === "problem")).toHaveLength(1);
      if (process.env.INCARNAMIND_PACKAGED_APP) {
        expect(
          recorded
            .filter((entry) => entry.kind === "start")
            .every((entry) => entry.packaged && entry.executable === mainExecutable()),
        ).toBe(true);
      }
    });
  }
}
