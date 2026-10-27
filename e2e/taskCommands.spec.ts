import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  motionSettled,
  newMind,
  notificationsShown,
  pointAndClick,
  recordNotifications,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startScriptedTask,
  useLocalChatModel,
} from "./app";

/*
 * Tasks from the keyboard (#1255): Pause, Resume and Stop in ⌘K while a Task
 * runs or is paused, Stop on ⌘. (Ctrl+. elsewhere) in Stop's tooltip, Stop on
 * a Task's row in the Tasks chip's popover, "Show Tasks" always offered (saying
 * "No Tasks right now." when there is nothing to show), Research… with no Note
 * open planning with "Write into: New note", Plan kept on a finished Task, and
 * the General page's switch for Task notifications. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const SUPPLIERS: Record<string, string> = {
  "Corvane Agreement.txt":
    "Corvane Agreement.\nTermination notice: 90 days.\nLiability cap: 12 months of fees.\n",
  "Halvard MSA.txt":
    "Halvard MSA.\nTermination notice: 6 months.\nLiability cap: twice the annual fees.\n",
  "Lumeric Order Form.txt":
    "Lumeric Order Form.\nTermination notice: 30 days.\nGoverning law: New York.\n",
};

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const tasksOf = (window: Page) =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listTasks(),
  );

const mindIdOf = async (window: Page, name: string): Promise<string> => {
  let id = "";
  await expect
    .poll(async () => {
      id = await window.evaluate(
        async (wanted) =>
          (
            await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMinds()
          ).find((mind) => (mind.title || mind.autoTitle) === wanted)?.id ?? "",
        name,
      );
      return id;
    })
    .not.toBe("");
  return id;
};

/** Starts a comparison of the three suppliers' Documents on two Questions the scripted model fills slowly. */
async function startSlowComparison(window: Page, sources: string): Promise<void> {
  const paths: string[] = [];
  for (const [name, text] of Object.entries(SUPPLIERS)) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  await addDocuments(window, paths);
  await newMind(window);
  await window.keyboard.type("Shortlist");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/compare");
  await expect(window.getByTestId("slash-item-compare")).toBeVisible();
  await window.keyboard.press("Enter");
  const sheet = window.getByTestId("compare-sheet");
  await expect(sheet.getByTestId("compare-sheet-question").first()).toBeFocused();
  // "slowly": the scripted model takes its time over each cell, so the Task is still running.
  await window.keyboard.type("Termination notice, slowly");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Liability cap, slowly");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(window.getByTestId("comparison-table")).toBeVisible();
}

/** The unfinished Task's id, as the core lists it. */
async function runningTaskId(window: Page): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      id = (await tasksOf(window)).find((task) => task.finishedAt === null)?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

/** Waits for the Task's status: paused or stopped, as the keyboard left it. */
const taskStatus = (window: Page, taskId: string) =>
  expect.poll(async () => (await tasksOf(window)).find((task) => task.id === taskId)?.status, {
    timeout: 30_000,
  });

/** Opens ⌘K, types `>words`, and says whether the command is listed; `list: false` says it isn't. */
async function paletteLists(window: Page, id: string, words: string, list = true): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(`>${words}`);
  const item = window.locator(`[data-key="command:${id}"]`);
  if (list) await expect(item).toBeVisible();
  else await expect(item).toHaveCount(0);
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("palette")).toBeHidden();
}

test("Pause, Resume and Stop are in ⌘K while a Task runs or is paused, with pinyin in Chinese, and ⌘. stops the Task in focus", async () => {
  test.setTimeout(150_000);
  const mod = process.platform === "darwin" ? "⌘." : "Ctrl+.";
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  await startSlowComparison(window, sources);
  const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
  await expect(progress).toHaveAttribute("data-status", "running");

  // Running, it takes Pause and Stop (not Resume): ⌘K lists them, and ⌘. is Stop's.
  await paletteLists(window, "task.pause", "pause task");
  await paletteLists(window, "task.resume", "resume task", false);
  await paletteLists(window, "task.stop", "stop task");
  await expect(progress.getByTestId("task-progress-stop")).toHaveAttribute(
    "title",
    `Stop (${mod})`,
  );
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "Pause",
    "Stop",
  ]);

  // Pause from ⌘K: its thread says paused, the chip hides, and Resume takes Pause's place.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(">pause task");
  await window.keyboard.press("Enter");
  await expect(progress).toHaveAttribute("data-status", "paused");
  await expect(window.getByTestId("tasks-chip")).toHaveCount(0);
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "Resume",
    "Stop",
  ]);
  await paletteLists(window, "task.resume", "resume task");
  await paletteLists(window, "task.pause", "pause task", false);

  // Resume from ⌘K: it runs again and the chip comes back.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(">resume task");
  await window.keyboard.press("Enter");
  await expect(progress).toHaveAttribute("data-status", "running");
  await expect(window.getByTestId("tasks-chip")).toHaveText("1 running");

  // Chinese: 暂停任务/继续任务/停止任务, found by their pinyin too.
  await setLanguage(window, "zh-CN");
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "暂停",
    "停止",
  ]);
  await expect(progress.getByTestId("task-progress-stop")).toHaveAttribute(
    "title",
    `停止 (${mod})`,
  );
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(">zanting renwu");
  await expect(window.locator('[data-key="command:task.pause"]')).toContainText("暂停任务");
  await motionSettled(window);
  await screenshot(window, "task-pause-command-zh-1440");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("palette")).toBeHidden();
  await paletteLists(window, "task.stop", "tingzhi renwu");
  await setLanguage(window, "en");

  // ⌘. with the caret in the composer stops the Task in focus.
  const taskId = await runningTaskId(window);
  await window.getByTestId("composer-input").focus();
  await window.keyboard.press("ControlOrMeta+Period");
  await taskStatus(window, taskId).toBe("stopped");
  await expect(progress).toHaveAttribute("data-status", "stopped");
  await expect(window.getByTestId("tasks-chip")).toHaveCount(0);

  // With nothing running, Show Tasks still opens the list: the stopped Task is in Recent.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(">show tasks");
  await window.keyboard.press("Enter");
  const popover = window.getByTestId("tasks-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByTestId("tasks-popover-row")).toContainText("Shortlist");
  await expect(popover.getByTestId("tasks-popover-stop")).toHaveCount(0);
  await motionSettled(window);
  await screenshot(window, "tasks-recent-en-1440");
  await window.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await app.close();
});

test("a Task's row in the chip's popover stops it, by keyboard, and Show Tasks says when there is nothing to show", async () => {
  test.setTimeout(120_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);

  // Nothing to show: Show Tasks opens the popover anyway, and says so.
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(">show tasks");
  await window.keyboard.press("Enter");
  const empty = window.getByTestId("tasks-popover");
  await expect(empty).toBeVisible();
  await expect(empty.getByTestId("tasks-popover-empty")).toHaveText("No Tasks right now.");
  await expect(window.getByTestId("tasks-chip")).toHaveCount(0);
  await motionSettled(window);
  const emptyBox = await empty.boundingBox();
  expect(emptyBox && emptyBox.x >= 0 && emptyBox.y >= 0).toBe(true);
  await screenshot(window, "tasks-empty-en-1440");
  await window.keyboard.press("Escape");
  await expect(empty).toBeHidden();

  // In Chinese: Show Tasks is 显示任务, found by pinyin, and says there is nothing in Chinese.
  await setLanguage(window, "zh-CN");
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type(">xianshi renwu");
  await expect(window.locator('[data-key="command:tasks.show"]')).toContainText("显示任务");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("tasks-popover-empty")).toHaveText("现在没有任务。");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("tasks-popover")).toBeHidden();
  await setLanguage(window, "en");

  await startSlowComparison(window, sources);
  const taskId = await runningTaskId(window);
  const chip = window.getByTestId("tasks-chip");
  await expect(chip).toHaveText("1 running");

  // Its row offers Stop beside it, and the arrow keys reach it.
  await chip.focus();
  await window.keyboard.press("Enter");
  const popover = window.getByTestId("tasks-popover");
  await expect(popover.getByTestId("tasks-popover-row")).toBeFocused();
  await window.keyboard.press("ArrowDown");
  const stop = popover.getByTestId("tasks-popover-stop");
  await expect(stop).toBeFocused();
  await expect(stop).toHaveText("Stop");
  await motionSettled(window);
  await screenshot(window, "tasks-popover-stop-en-1440");

  // At 900px, in Chinese too: the popover and its Stop stay in the window.
  await window.keyboard.press("Escape");
  await setWindowSize(app, window, 900, 640);
  await setLanguage(window, "zh-CN");
  await chip.focus();
  await window.keyboard.press("Enter");
  const narrow = window.getByTestId("tasks-popover");
  await expect(narrow.getByTestId("tasks-popover-stop")).toHaveText("停止");
  await expect(narrow.getByTestId("tasks-popover-stop")).toBeInViewport();
  await motionSettled(window);
  const narrowBox = await narrow.boundingBox();
  expect(narrowBox && narrowBox.width <= 900 && narrowBox.x >= 0).toBe(true);
  await screenshot(window, "tasks-popover-stop-zh-900");
  await setLanguage(window, "en");
  await window.keyboard.press("Escape");
  await expect(narrow).toBeHidden();

  // Back at 1440, Stop ends it from its row.
  await setWindowSize(app, window, 1440, 860);
  await chip.focus();
  await window.keyboard.press("Enter");
  const again = window.getByTestId("tasks-popover");
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("Enter");
  await taskStatus(window, taskId).toBe("stopped");
  await expect(chip).toHaveCount(0);
  await expect(again).toBeHidden();
  await app.close();
});

test("the General page's Task notifications switch is on by default; off, a needing Task says nothing and still lists", async () => {
  test.setTimeout(120_000);
  const folder = await createDataFolder();
  try {
    const { app, window } = await launchApp(dataDir, { scriptedTasks: true });
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 860);
    await recordNotifications(app);
    await newMind(window);
    await window.keyboard.type("Credit memo");
    await window.keyboard.press("ControlOrMeta+t");
    // Typed once the new tab's text has the focus, or the first keys land in the last Note.
    await enterContent(window);
    await window.keyboard.type("Notes");
    const memo = await mindIdOf(window, "Credit memo");

    // Settings › General: the switch is there, on, in English and Chinese.
    await window.keyboard.press("ControlOrMeta+,");
    const settings = window.getByTestId("settings");
    await expect(settings).toBeVisible();
    const toggle = window.getByTestId("task-notification-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(settings).toContainText("Notifications");
    await expect(settings).toContainText("Task notifications");
    await screenshot(window, "settings-task-notifications-en-1440");
    await setLanguage(window, "zh-CN");
    await expect(settings).toContainText("任务通知");
    await setLanguage(window, "en");
    await pointAndClick(window, toggle);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await window.keyboard.press("Escape");
    await expect(settings).toBeHidden();

    // Its Note off screen, the Task needs the User: no notification, and nothing else changes.
    const taskId = await startScriptedTask(app, memo, { folder, files: ["a.txt", "b.txt"] });
    const chip = window.getByTestId("tasks-chip");
    await expect(chip).toHaveText("1 needs you");
    expect(await notificationsShown(app)).toEqual([]);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type(">show tasks");
    await window.keyboard.press("Enter");
    const popover = window.getByTestId("tasks-popover");
    await expect(popover.getByTestId("tasks-popover-row")).toContainText(
      "Credit memo · Waiting for your approval",
    );
    await expect(popover.getByTestId("tasks-popover-stop")).toHaveText("Stop");
    const needs = (await tasksOf(window)).find((task) => task.id === taskId);
    expect(needs?.finishedAt).toBeNull();
    expect(needs?.ask).not.toBeNull();
    await app.close();
  } finally {
    await removeDataFolder(folder);
  }
});

test("Research… with no Note open plans with Write into: New note, Start makes that Note the Task's, and its Done Task still offers Plan", async () => {
  test.setTimeout(150_000);
  const topic = "how tea reached Europe";
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const source = join(sources, "Tea trade.txt");
  await writeFile(source, "Tea trade.\nDutch traders shipped tea to Amsterdam in 1610.\n");
  await addDocuments(window, [source]);

  // A Note open, then closed: Research… is in ⌘K with no Note in focus.
  await newMind(window);
  await window.keyboard.type("Scratch");
  await window.keyboard.press("ControlOrMeta+w");
  await expect(window.getByTestId("mind-tab")).toHaveCount(0);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(">research");
  await expect(window.locator('[data-key="command:research.start"]')).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await expect(window.getByTestId("composer-research")).toBeVisible();
  await window.keyboard.type(topic);
  await window.keyboard.press("Enter");

  // Its plan opens above the composer, writing into a new Note, as the card already offers.
  const card = window.getByTestId("research-plan");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("research-plan-step")).toHaveCount(3);
  await expect(card.getByTestId("research-plan-write-into")).toHaveText("New note");
  await expect(card.getByTestId("research-plan-write-step")).toHaveText(
    "Write a cited draft into a new note",
  );
  await motionSettled(window);
  await screenshot(window, "research-no-note-en-1440");
  // At 900px, in Chinese, the plan and its buttons stay in the window.
  await setWindowSize(app, window, 900, 640);
  await setLanguage(window, "zh-CN");
  await expect(card.getByTestId("research-plan-write-into")).toHaveText("新建笔记");
  await expect(card.getByTestId("research-plan-write-step")).toHaveText(
    "把带引用的草稿写进新的笔记",
  );
  await expect(card).toBeInViewport();
  // The card scrolls in a short column: every control is in reach, and none leaves the window.
  const writeInto = card.getByTestId("research-plan-write-into");
  await writeInto.scrollIntoViewIfNeeded();
  await expect(writeInto).toBeInViewport();
  await motionSettled(window);
  await screenshot(window, "research-no-note-zh-900");
  await card.getByTestId("research-plan-start").scrollIntoViewIfNeeded();
  await expect(card.getByTestId("research-plan-start")).toBeInViewport();
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1600, 900);

  // Start: a new Note is made for it, and its progress shows in its thread.
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(card).toHaveCount(0);
  const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
  await expect(progress).toContainText("Research");
  await expect(progress).toHaveAttribute("data-status", "done", { timeout: 90_000 });

  // Done, its Plan stays: the steps it ran, each done.
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "Plan",
    "Review",
    "Details",
  ]);
  await pointAndClick(window, progress.getByTestId("task-progress-plan"));
  const plan = window.getByTestId("task-tray").getByTestId("research-plan-view");
  await expect(plan).toBeVisible();
  await expect(plan.getByTestId("research-plan-view-step").first()).toContainText(topic);
  for (const step of await plan.getByTestId("research-plan-view-step").all())
    await expect(step).toHaveAttribute("data-status", "done");
  await motionSettled(window);
  await screenshot(window, "research-done-plan-en-1600");
  await setLanguage(window, "zh-CN");
  await expect(plan).toHaveAttribute("aria-label", "运行中的研究计划");
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "计划",
    "查看",
    "详情",
  ]);
  await setLanguage(window, "en");
  await app.close();
});
