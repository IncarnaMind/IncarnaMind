import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Task } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  expectDotsBetweenParts,
  forceQuit,
  launchApp,
  motionSettled,
  newMind,
  notificationsShown,
  placeAssistant,
  pointAndClick,
  recordNotifications,
  removeDataFolder,
  setWindowSize,
  startScriptedTask,
  useLocalChatModel,
} from "./app";

/*
 * Tasks (#126, #657): a comparison table keeps filling as a Task when its
 * Mind is closed and when IncarnaMind is force-quit, and goes on at the next
 * start; its progress shows in the assistant's thread, where it started, with
 * its bar, latest steps and what it can be asked (Pause, Stop). A Task that
 * was waiting for approval comes back paused, "Needs you", with the ask in
 * the tray above the composer, which holds nothing else. The Tasks chip in the band says
 * what runs or needs the User, and its popover opens a Task's Mind. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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

/** The Mind of this name, typed or taken from its first line, once the core has it. */
async function mindIdOf(window: Page, name: string): Promise<string> {
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
}

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** The tray sits joined above the composer, inside the assistant, and never over it. */
async function expectAboveComposer(window: Page, tray: Locator): Promise<void> {
  const composer = window.getByTestId("composer");
  const [trayBox, composerBox] = [await tray.boundingBox(), await composer.boundingBox()];
  if (!trayBox || !composerBox) throw new Error("The tray or the composer isn't on screen.");
  expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(composerBox.y + 1);
  expect(Math.abs(trayBox.x - composerBox.x)).toBeLessThan(2);
  expect(Math.abs(trayBox.width - composerBox.width)).toBeLessThan(2);
}

/** The Tasks chip's popover never covers the assistant: its composer, its thread, its tray. */
async function expectClearOfAssistant(window: Page, popover: Locator): Promise<void> {
  await motionSettled(window);
  const [own, other] = [
    await popover.boundingBox(),
    await window.getByTestId("assistant").boundingBox(),
  ];
  if (!own || !other) throw new Error("The popover or the assistant isn't on screen.");
  const apart =
    own.x + own.width <= other.x + 1 ||
    other.x + other.width <= own.x + 1 ||
    own.y + own.height <= other.y + 1 ||
    other.y + other.height <= own.y + 1;
  expect(apart).toBe(true);
}

const cellTexts = (table: Locator) =>
  table
    .getByTestId("comparison-row")
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('[data-testid="comparison-cell"]')].map((cell) =>
          (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        ),
      ),
    );

/** Starts a comparison of the three suppliers' Documents on two Questions the scripted model fills slowly, and returns its table. */
async function startSlowComparison(window: Page, sources: string): Promise<Locator> {
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
  // "slowly": the scripted model takes its time over each cell, so the fill is halfway when quit.
  await window.keyboard.type("Termination notice, slowly");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Liability cap, slowly");
  await window.keyboard.press("ControlOrMeta+Enter");

  const table = window.getByTestId("comparison-table");
  await expect(table).toBeVisible();
  return table;
}

test("a comparison table keeps filling as a Task: closing its Mind and force-quitting don't stop it, and it goes on at the next start", async () => {
  test.setTimeout(150_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 860);
  await useLocalChatModel(window);
  const table = await startSlowComparison(window, sources);
  // Its progress is in the thread: its name, how far, the bar and its latest steps; no tray.
  const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
  await expect(progress).toContainText("Compare Documents");
  await expect(progress.getByTestId("task-progress-meta")).toHaveText(/^\d of 6 cells · \d+ min$/);
  await expect(progress.getByRole("progressbar")).toBeVisible();
  await expect(progress.getByTestId("task-progress-steps")).toContainText(
    "Corvane Agreement · Termination notice, slowly",
  );
  await expect(window.getByTestId("task-tray")).toHaveCount(0);
  const waiting = table.getByTestId("comparison-cell").last().locator(".comparison-cell-running");
  await expect(waiting).toBeVisible();
  await expect(waiting).toHaveText("Waiting…");
  await expect(table.getByTestId("comparison-cell").first()).toContainText("90 days", {
    timeout: 30_000,
  });
  // A comparison offers Pause and Stop; Tab reaches them, and Enter pauses and resumes it.
  await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "Pause",
    "Stop",
  ]);
  await screenshot(window, "compare-task-en-1440");
  await progress.getByTestId("task-progress-pause").focus();
  await window.keyboard.press("Tab");
  await expect(progress.getByTestId("task-progress-stop")).toBeFocused();
  await window.keyboard.press("Shift+Tab");
  await window.keyboard.press("Enter");
  await expect(progress).toHaveAttribute("data-status", "paused");
  await expect(progress.getByTestId("task-progress-waiting")).toHaveText("Paused");
  // Resume takes Pause's place, the focus on it.
  await expect(progress.getByTestId("task-progress-resume")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(progress).toHaveAttribute("data-status", "running");

  // The chip in the band says it runs; its popover lists it, by keyboard, beside the assistant.
  const chip = window.getByTestId("tasks-chip");
  await expect(chip).toHaveText("1 running");
  await chip.focus();
  await window.keyboard.press("Enter");
  const popover = window.getByTestId("tasks-popover");
  const listed = popover.getByTestId("tasks-popover-row");
  await expect(listed).toHaveCount(1);
  await expect(listed).toBeFocused();
  await expect(listed).toContainText("Compare Documents");
  await expect(listed).toContainText(/Shortlist · Filling cell \d of 6/);
  await expectClearOfAssistant(window, popover);
  await screenshot(window, "tasks-popover-en-1440");
  await window.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(chip).toBeFocused();

  // Closing the Mind doesn't stop it.
  const settledBefore = (await tasksOf(window))[0]?.progress?.done ?? 0;
  await window.keyboard.press("ControlOrMeta+w");
  await expect(table).toHaveCount(0);
  await expect
    .poll(async () => (await tasksOf(window))[0]?.progress?.done ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(settledBefore);
  const [halfway] = await tasksOf(window);
  expect(halfway).toMatchObject({ kind: "comparison", status: "running" });
  expect(halfway?.progress?.done).toBeLessThan(6);

  // Force-quit halfway; at the next start it goes on by itself.
  await forceQuit(app);
  const again = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 860);
  await expect
    .poll(async () => (await tasksOf(again.window)).find((each) => each.id === halfway?.id)?.status)
    .toBe("running");
  const mindId = await mindIdOf(again.window, "Shortlist");
  await again.window.evaluate(
    (id) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.changeLayout("main", {
        type: "open",
        item: { kind: "mind", mindId: id },
        where: { in: "place" },
      }),
    mindId,
  );
  const reopened = again.window.getByTestId("comparison-table");
  await expect(reopened).toBeVisible();
  // Done: it says how long it took, its steps stay, and it offers Review and Details; no tray.
  const done = again.window.getByTestId("assistant-thread").getByTestId("task-progress");
  await expect(done).toHaveAttribute("data-status", "done", { timeout: 90_000 });
  await expect(done.getByTestId("task-progress-meta")).toHaveText(/^Done in \d+ min$/);
  await expect(done.getByRole("progressbar")).toHaveCount(0);
  await expect(done.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
    "Review",
    "Details",
  ]);
  await expect(again.window.getByTestId("task-tray")).toHaveCount(0);
  await pointAndClick(again.window, done.getByTestId("task-progress-details"));
  await expect(done.getByTestId("task-progress-record")).toContainText("6 of 6 cells written");
  await expect(done.getByTestId("task-progress-steps").locator("li")).toHaveCount(6);
  // Every cell answered once: one Citation each where its Document answers.
  expect(await cellTexts(reopened)).toEqual([
    ["90 days 1", "12 months of fees 2"],
    ["6 months 3", "twice the annual fees 4"],
    ["30 days 5", "! not found"],
  ]);
  await screenshot(again.window, "compare-task-done-en-1440");
  // Review brings the table into view.
  await again.window
    .locator(".mind-scroller")
    .first()
    .evaluate((scroller) => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  await pointAndClick(again.window, done.getByTestId("task-progress-review"));
  await expect(reopened).toBeInViewport();
  // Progress never goes into the Mind.
  const text = await again.window.locator(".mind-editor").first().innerText();
  expect(text).not.toContain("6 cells");
  expect(text).not.toContain("Done in");
});

test("a Task waiting for approval comes back paused after a quit: “Needs you”, the ask in the tray with its buttons pinned, answered by keyboard", async () => {
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
    // Typed once the new tab's text has the focus, or the first keys land in the last Mind.
    await enterContent(window);
    await window.keyboard.type("Notes");
    const memoTab = window.getByTestId("mind-tab").filter({ hasText: "Credit memo" });
    const notesTab = window.getByTestId("mind-tab").filter({ hasText: "Notes" });
    await expect(notesTab).toHaveAttribute("aria-selected", "true");
    const memo = await mindIdOf(window, "Credit memo");

    // Started while its Mind isn't on screen, its first ask is a system notification.
    const taskId = await startScriptedTask(app, memo, { folder, files: ["a.txt", "b.txt"] });
    await expect
      .poll(() => notificationsShown(app))
      .toEqual([{ title: "Task needs you", body: "Credit memo" }]);
    await expect(window.getByTestId("task-tray")).toHaveCount(0);

    // The chip says it needs the User; its row opens its Mind, with the ask in the tray.
    const chip = window.getByTestId("tasks-chip");
    await expect(chip).toHaveText("1 needs you");
    await expect(chip).toHaveAttribute("data-needs-you", "true");
    await pointAndClick(window, chip);
    const popover = window.getByTestId("tasks-popover");
    await expect(popover).toContainText("Needs you");
    const listed = popover.getByTestId("tasks-popover-row");
    await expect(listed).toContainText("Credit memo · Waiting for your approval");
    await pointAndClick(window, listed);
    await expect(popover).toBeHidden();
    await expect(memoTab).toHaveAttribute("aria-selected", "true");
    const tray = window.getByTestId("task-tray");
    const ask = tray.getByTestId("task-ask");
    const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
    await expect(progress.getByTestId("task-progress-waiting")).toHaveText(
      "Waiting for your approval below",
    );
    await expect(ask.getByTestId("approval-card")).toBeVisible();
    await expect(ask.getByTestId("task-ask-count")).toHaveCount(0);
    await expectAboveComposer(window, tray);
    // ⌘↵ allows, with the focus on the ask.
    await ask.getByTestId("approval-allow-once").focus();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(ask.getByTestId("task-ask-count")).toHaveText("2 of 2");
    await app.close();

    const again = await launchApp(dataDir, { scriptedTasks: true });
    await setWindowSize(again.app, again.window, 1440, 860);
    await pointAndClick(
      again.window,
      again.window.getByTestId("mind-tab").filter({ hasText: "Credit memo" }),
    );
    const paused = again.window.getByTestId("task-tray");
    const first = again.window.getByTestId("assistant-thread").getByTestId("task-progress");
    await expect(first).toHaveAttribute("data-needs-you", "true");
    await expect(first.getByTestId("task-progress-waiting")).toHaveText(
      "Paused while IncarnaMind was closed: it needs you below",
    );
    const pausedAsk = paused.getByTestId("task-ask");
    await expect(pausedAsk.getByTestId("task-ask-count")).toHaveText("2 of 2");
    await expectAboveComposer(again.window, paused);
    // The approval's buttons stay in view at the tray's foot.
    const buttons = pausedAsk.getByTestId("approval-allow-once");
    const [trayBox, buttonBox] = [await paused.boundingBox(), await buttons.boundingBox()];
    if (!trayBox || !buttonBox) throw new Error("The tray or its buttons aren't on screen.");
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(trayBox.y + trayBox.height + 1);
    await screenshot(again.window, "tasks-paused-en-1440");

    await setWindowSize(again.app, again.window, 900, 640);
    await expectAboveComposer(again.window, paused);
    // With the assistant at the bottom, the popover ends above it.
    const pausedChip = again.window.getByTestId("tasks-chip");
    await expect(pausedChip).toHaveText("1 needs you");
    await pausedChip.focus();
    await again.window.keyboard.press("Enter");
    const pausedPopover = again.window.getByTestId("tasks-popover");
    await expect(pausedPopover.getByTestId("tasks-popover-row")).toBeFocused();
    await expectClearOfAssistant(again.window, pausedPopover);
    await screenshot(again.window, "tasks-popover-en-900");
    await again.window.keyboard.press("Escape");
    await expect(pausedPopover).toBeHidden();
    await screenshot(again.window, "tasks-paused-en-900");
    await setLanguage(again.window, "zh-CN");
    await expect(first.getByTestId("task-progress-waiting")).toHaveText(
      "IncarnaMind 关闭时已暂停：需要你在下方处理",
    );
    await expect(first.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
      "停止",
    ]);
    await expect(pausedAsk.getByTestId("task-ask-count")).toHaveText("2/2");
    await screenshot(again.window, "tasks-paused-zh-900");
    await setLanguage(again.window, "en");
    await setWindowSize(again.app, again.window, 1440, 860);

    await buttons.focus();
    await again.window.keyboard.press("ControlOrMeta+Enter");
    await expect(first).toHaveAttribute("data-status", "done");
    await expect(again.window.getByTestId("task-tray")).toHaveCount(0);
    const finished: Task | undefined = (await tasksOf(again.window)).find(
      (each) => each.id === taskId,
    );
    expect(finished?.status).toBe("done");
    // Each file written once.
    expect(await readFile(join(folder, "a.txt"), "utf8")).toBe("Written by the scripted Task.\n");
    expect(await readFile(join(folder, "b.txt"), "utf8")).toBe("Written by the scripted Task.\n");
  } finally {
    await removeDataFolder(folder);
  }
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a Task's progress head keeps within its row at the narrowest assistant, and wraps between its parts, never at a dot (${language})`, async () => {
    test.setTimeout(150_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await startSlowComparison(window, sources);
    const progress = window.getByTestId("assistant-thread").getByTestId("task-progress");
    const meta = progress.getByTestId("task-progress-meta");
    await expect(meta.locator(".meta-part")).toHaveCount(2);
    await placeAssistant(window, { width: 240 });

    const head = progress.locator(".task-progress-head");
    const [row, own] = [await head.boundingBox(), await meta.boundingBox()];
    if (!row || !own) throw new Error("The head or its line isn't on screen.");
    expect(own.x + own.width).toBeLessThanOrEqual(row.x + row.width + 1);
    await expectDotsBetweenParts(meta);

    // With little room it wraps between its parts, and a part that starts a row shows no dot.
    await head.evaluate((element) => {
      element.style.width = "150px";
    });
    expect(await expectDotsBetweenParts(meta)).toBe(true);
    await app.close();
  });
}

test("Stop in a Task's progress ends it and withdraws its ask; the progress fits the assistant's 320px in Chinese, under a header with no chat icon", async () => {
  const folder = await createDataFolder();
  try {
    const { app, window } = await launchApp(dataDir, { scriptedTasks: true });
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 860);
    await newMind(window);
    await window.keyboard.type("Credit memo");
    const memo = await mindIdOf(window, "Credit memo");
    await setLanguage(window, "zh-CN");
    await startScriptedTask(app, memo, { folder, files: ["a.txt"] });

    const thread = window.getByTestId("assistant-thread");
    const progress = thread.getByTestId("task-progress");
    await expect(progress.getByTestId("task-progress-waiting")).toHaveText("等待你在下方批准");
    await expect(window.getByTestId("task-tray").getByTestId("task-ask")).toBeVisible();
    await expect(progress.getByTestId("task-progress-actions").getByRole("button")).toHaveText([
      "停止",
    ]);
    // Its words wrap inside the assistant's column; nothing runs past it.
    const [block, column] = [await progress.boundingBox(), await thread.boundingBox()];
    if (!block || !column) throw new Error("The progress or the thread isn't on screen.");
    expect(block.x + block.width).toBeLessThanOrEqual(column.x + column.width + 1);
    // The header's title has only its ▾: no chat icon before it.
    await expect(window.getByTestId("assistant-title").locator("svg")).toHaveCount(1);
    await screenshot(window, "tasks-progress-zh-1440");

    await progress.getByTestId("task-progress-stop").focus();
    await window.keyboard.press("Enter");
    await expect(progress).toHaveAttribute("data-status", "stopped");
    await expect(progress.getByTestId("task-progress-meta")).toHaveText("已停止");
    await expect(window.getByTestId("task-tray")).toHaveCount(0);
    expect(
      await window.evaluate(() =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listApprovalRequests(),
      ),
    ).toEqual([]);
  } finally {
    await removeDataFolder(folder);
  }
});
