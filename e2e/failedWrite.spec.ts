import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { part, unzip } from "../tests/helpers/docx";
import { refuseWrites } from "../tests/helpers/failingStorage";
import {
  createDataFolder,
  forceQuit,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

import { startAnotherCopy } from "./secondCopy";

/*
 * Typing after a change storage refused (#1119), as a person meets it: the
 * window says what happened and what to do while the changes wait in memory,
 * Try again stores them, Save a copy… writes the Mind elsewhere, quitting asks
 * first, and a crash is said on the next start. In English and Chinese.
 */

let dataDir: string;
let elsewhere: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  elsewhere = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(elsewhere);
});

const failWrites = () => refuseWrites(dataDir);

async function start(language: "en" | "zh-CN") {
  const { app, window } = await launchApp(dataDir);
  await setLanguage(window, language);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await nameMind(window, "Notes");
  const editor = window.getByTestId("mind-editor");
  await window.keyboard.type("BASE");
  await expect(editor).toHaveText("BASE");
  return { app, window, editor };
}

const notice = (window: Page) => window.getByTestId("unsaved-notice");

for (const [language, line] of [
  [
    "en",
    "Couldn’t save your recent changes: the disk is full. Keep IncarnaMind open · Try again · Save a copy…",
  ],
  ["zh-CN", "最近的改动没能保存：磁盘已满。请先不要关闭 IncarnaMind · 重试 · 另存一份…"],
] as const) {
  test(`typing after a refused save is said, kept, and saved with Try again (${language})`, async () => {
    const { app, window, editor } = await start(language);

    const restore = failWrites();
    await window.keyboard.type(" LOST");
    await expect(notice(window).getByTestId("unsaved-notice-line")).toHaveText(line);
    await expect(window.getByTestId("error-notice")).toHaveCount(0);
    restore();
    await notice(window).getByTestId("unsaved-try-again").click();
    await expect(notice(window)).toHaveCount(0);
    await editor.focus();
    await window.keyboard.press("End");
    await window.keyboard.type(" AFTER");
    await expect(editor).toHaveText("BASE LOST AFTER");
    await app.close();

    const second = await launchApp(dataDir);
    await second.window.getByTestId("mind-list-item").filter({ hasText: "Notes" }).click();
    await expect(second.window.getByTestId("mind-editor")).toHaveText("BASE LOST AFTER");
  });
}

/** Answers the system's message boxes with `responses` in turn, and keeps what each asked. */
async function answerSheets(app: ElectronApplication, responses: readonly number[]) {
  await app.evaluate(({ dialog }, answers) => {
    const asked: unknown[] = [];
    (globalThis as { sheetsAsked?: unknown[] }).sheetsAsked = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      asked.push(args.at(-1));
      return { response: answers[asked.length - 1] ?? 2, checkboxChecked: false };
    }) as unknown as typeof dialog.showMessageBox;
  }, responses);
}

const sheetsAsked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { sheetsAsked?: unknown[] }).sheetsAsked ?? []);

/** From now on the system's save dialog answers `path`. */
async function chooseSavePath(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: chosen,
    })) as unknown as typeof dialog.showSaveDialog;
  }, path);
}

test("quitting while changes wait asks first, and Keep open keeps them", async () => {
  const { app, window, editor } = await start("en");
  const restore = failWrites();
  await window.keyboard.type(" LOST");
  await expect(notice(window)).toBeVisible();
  await answerSheets(app, [2]);

  await app.evaluate(({ app: electron }) => electron.quit());

  await expect.poll(async () => (await sheetsAsked(app)).length).toBe(1);
  const [asked] = await sheetsAsked(app);
  expect(asked).toMatchObject({
    message: expect.stringMatching(/^\d+ changes aren’t saved$/),
    buttons: ["Save a copy…", "Quit anyway", "Keep open"],
    defaultId: 2,
    cancelId: 2,
  });
  await expect(editor).toHaveText("BASE LOST");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
  const again = await startAnotherCopy(app);
  try {
    await expect.poll(() => again.exitCode, { timeout: 30_000 }).toBe(0);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((each) => each.isVisible()),
        ),
      )
      .toEqual([true]);
    await expect(editor).toHaveText("BASE LOST");
  } finally {
    restore();
    if (again.exitCode === null && again.signalCode === null) {
      const gone = once(again, "exit");
      again.kill("SIGKILL");
      await gone;
    }
  }
  await notice(window).getByTestId("unsaved-try-again").click();
  await expect(notice(window)).toHaveCount(0);
});

test("quitting counts what waits in a deleted Mind, with no copy offered", async () => {
  const { app, window } = await start("en");
  const restore = failWrites();
  await window.keyboard.type(" LOST");
  await expect(notice(window)).toBeVisible();
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = (await core.listMinds()).find((each) => each.title === "Notes");
    if (mind) await core.deleteMind(mind.id);
  });
  await expect(notice(window).getByTestId("unsaved-save-copy")).toHaveCount(0);
  await answerSheets(app, [1]);

  await app.evaluate(({ app: electron }) => electron.quit());

  await expect.poll(async () => (await sheetsAsked(app)).length).toBe(1);
  const [asked] = await sheetsAsked(app);
  expect(asked).toMatchObject({
    message: expect.stringMatching(/^\d+ changes aren’t saved$/),
    buttons: ["Quit anyway", "Keep open"],
    defaultId: 1,
    cancelId: 1,
  });
  restore();
  await notice(window).getByTestId("unsaved-try-again").click();
  await expect(notice(window)).toHaveCount(0);
});

test("Save a copy… writes the Mind as a Word file where the User chooses, though every write fails", async () => {
  const { app, window } = await start("en");
  const restore = refuseWrites(dataDir, { every: true });
  await window.keyboard.type(" LOST");
  await expect(notice(window)).toBeVisible();
  const copy = join(elsewhere, "Notes.docx");
  await chooseSavePath(app, copy);

  await notice(window).getByTestId("unsaved-save-copy").click();

  await expect
    .poll(async () => (await readFile(copy).catch(() => null))?.byteLength ?? 0)
    .not.toBe(0);
  expect(part(unzip(await readFile(copy)), "word/document.xml")).toContain("BASE LOST");
  restore();
  await notice(window).getByTestId("unsaved-try-again").click();
  await expect(notice(window)).toHaveCount(0);
});

for (const [language, why] of [
  [
    "en",
    /^The copy couldn’t be saved\. That file or folder isn’t there any more\.\n\nDetails: .*ENOENT/,
  ],
  ["zh-CN", /^副本没能保存。这个文件或文件夹已不存在。\n\n详情：.*ENOENT/],
] as const) {
  test(`quitting, a copy that can't be saved keeps IncarnaMind open and asks again, saying why (${language})`, async () => {
    const { app, window, editor } = await start(language);
    const restore = failWrites();
    await window.keyboard.type(" LOST");
    await expect(notice(window)).toBeVisible();
    await chooseSavePath(app, join(elsewhere, "missing folder", "Notes.docx"));
    await answerSheets(app, [0, 2]);

    await app.evaluate(({ app: electron }) => electron.quit());

    await expect.poll(async () => (await sheetsAsked(app)).length).toBe(2);
    const [, again] = await sheetsAsked(app);
    expect(again).toMatchObject({ detail: expect.stringMatching(why), defaultId: 2, cancelId: 2 });
    await expect(editor).toHaveText("BASE LOST");
    restore();
    await notice(window).getByTestId("unsaved-try-again").click();
    await expect(notice(window)).toHaveCount(0);
  });
}

test("after a crash while changes wait, the next start says how many were lost", async () => {
  const { app, window } = await start("en");
  const restore = failWrites();
  await window.keyboard.type(" LOST");
  await expect(notice(window)).toBeVisible();

  await forceQuit(app);
  restore();
  const second = await launchApp(dataDir);

  await expect(second.window.getByTestId("unsaved-lost")).toHaveText(
    /^\d+ changes made before IncarnaMind closed couldn’t be saved/,
  );
});
