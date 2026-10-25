import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { paragraph, run, wordFile } from "../tests/helpers/word";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  importWordFile,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A change's review card (#1358, #1826): beside the change in the page's right margin when about
 * 300px are free there, and at the page's foot when there isn't, never over its change or the line
 * after it, at a narrow and a wide window, in English and Chinese. The scripted model rewrites the
 * two paragraphs as two short ones, so the first change is narrow enough for the margin and the
 * second, once its original shows, is as wide as the page.
 */

const SHORT = "Tides rise twice a day.";
const LONG =
  "The harbour office posts the times each week, and the boats leave on the morning tide when there is enough water over the bar to clear it, so the schedule moves with the moon rather than the clock.";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const right = (box: Box) => box.x + box.width;
const bottom = (box: Box) => box.y + box.height;
const overlaps = (a: Box, b: Box) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't on screen.");
  return box;
}

/** What a change shows, as one box over all of its lines, and the line after it when it has one. */
async function onScreen(
  editor: Locator,
  insert: Locator,
): Promise<{ change: Box; next: Box | null }> {
  const id = await insert.getAttribute("data-proposal-id");
  if (!id) throw new Error("The change has no id.");
  return editor.evaluate((board, proposalId) => {
    const parts = [...board.querySelectorAll(`[data-proposal-id="${proposalId}"]`)];
    let change: Box | null = null;
    for (const part of parts) {
      const rect = part.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const left: number = change ? Math.min(change.x, rect.x) : rect.x;
      const top: number = change ? Math.min(change.y, rect.y) : rect.y;
      const right: number = change ? Math.max(change.x + change.width, rect.right) : rect.right;
      const bottom: number = change ? Math.max(change.y + change.height, rect.bottom) : rect.bottom;
      change = { x: left, y: top, width: right - left, height: bottom - top };
    }
    if (!change) throw new Error("The change doesn't show.");
    const last = parts.at(-1);
    const block = last?.closest("p, h1, h2, h3, li, blockquote, pre");
    const next = block?.nextElementSibling?.getBoundingClientRect();
    return {
      change,
      next:
        next && next.width > 0 && next.height > 0
          ? { x: next.x, y: next.y, width: next.width, height: next.height }
          : null,
    };
  }, id);
}

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const scrolled = (window: Page) =>
  window.evaluate(() => document.querySelector(".mind-scroller")?.scrollTop ?? 0);

/**
 * A long redline: one paragraph-wide change Dana added near the end, too wide
 * to sit beside, and one short change just under it.
 */
function longRedline(): Buffer {
  const dana = 'w:author="Dana Kim" w:date="2026-10-03T10:00:00Z"';
  const clause = (index: number) =>
    paragraph(`Clause ${index}: the parties keep the schedule for the works.`);
  return wordFile({
    body: [
      ...Array.from({ length: 24 }, (_, index) => clause(index + 1)),
      paragraph(
        `${run("The Landlord insures the building. ")}<w:ins w:id="9" ${dana}>${run(
          "The Tenant must tell the Landlord of any damage at once, in writing, and the Landlord may inspect the works within ten working days.",
        )}</w:ins>`,
      ),
      paragraph(
        `${run("Clause 25: the parties keep the schedule")}<w:ins w:id="10" ${dana}>${run(
          " with written notice",
        )}</w:ins>${run(" for the works.")}`,
      ),
      ...Array.from({ length: 9 }, (_, index) => clause(index + 26)),
    ].join(""),
  });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a change's card sits in the margin beside it, or at the page's foot, never over the change or the next line, in English and Chinese at 900 and 1440", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await enterContent(window);
  await window.keyboard.type(SHORT);
  await window.keyboard.press("Enter");
  await window.keyboard.type(LONG);
  await expect(editor.locator(":scope > p")).toHaveText([SHORT, LONG]);

  await askInAssistant(window, "Rewrite the intro to be clearer");
  const inserts = editor.locator("ins.proposal-insert");
  await expect(inserts).toHaveCount(2);
  await pointAndClick(window, editor.getByTestId("change-was").nth(1));
  await expect(editor.locator("[data-original-shown]")).toHaveCount(1);
  const card = window.getByTestId("change-bar");

  for (const [width, language] of [
    [1440, "en"],
    [900, "en"],
    [1440, "zh-CN"],
    [900, "zh-CN"],
  ] as const) {
    await setWindowSize(app, window, width, 900);
    await setLanguage(window, language);
    const page = await boxOf(window.locator(".mind-tab-page:visible"));

    await inserts.nth(0).hover();
    await expect(card).toHaveAccessibleName(
      language === "en" ? "Change 1 of 2" : "第 1 处修订，共 2 处",
    );
    const beside = await onScreen(editor, inserts.nth(0));
    const atMargin = await boxOf(card);
    expect(atMargin.x).toBeGreaterThanOrEqual(right(beside.change));
    expect(overlaps(atMargin, beside.change)).toBe(false);
    if (beside.next) expect(overlaps(atMargin, beside.next)).toBe(false);
    expect(atMargin.x).toBeGreaterThanOrEqual(page.x);
    expect(right(atMargin)).toBeLessThanOrEqual(right(page) + 1);
    expect(bottom(atMargin)).toBeLessThan(bottom(page) - 48);
    await screenshot(window, `review-card-margin-${language}-${width}`);

    await inserts.nth(1).hover();
    await expect(card).toHaveAccessibleName(
      language === "en" ? "Change 2 of 2" : "第 2 处修订，共 2 处",
    );
    const wide = await onScreen(editor, inserts.nth(1));
    const docked = await boxOf(card);
    expect(overlaps(docked, wide.change)).toBe(false);
    if (wide.next) expect(overlaps(docked, wide.next)).toBe(false);
    expect(bottom(wide.change)).toBeLessThanOrEqual(docked.y);
    expect(docked.x).toBeGreaterThanOrEqual(page.x);
    expect(right(docked)).toBeLessThanOrEqual(right(page) + 1);
    expect(bottom(docked)).toBeLessThanOrEqual(bottom(page) + 1);
    expect(bottom(docked)).toBeGreaterThanOrEqual(bottom(page) - 48);
    await screenshot(window, `review-card-dock-${language}-${width}`);
  }
});

test("a docked card scrolls its change above it only while the cursor is in the change", async () => {
  const files = await createDataFolder();
  try {
    const { app, window } = await launchApp(dataDir, { home: files });
    await setWindowSize(app, window, 900, 900);
    await dismissChatSetup(window);
    await importWordFile(app, window, files, "Long redline.docx", longRedline());
    const editor = window.getByTestId("mind-editor");
    const change = editor.locator("ins.proposal-theirs", { hasText: "ten working days" });
    await expect(editor.locator("ins.proposal-theirs")).toHaveCount(2);

    // The change at the page's foot: its card has nowhere to go but the foot, over it.
    await change.scrollIntoViewIfNeeded();
    const page = await boxOf(window.locator(".mind-tab-page:visible"));
    const below = bottom(page) - 30 - bottom(await boxOf(change));
    await window.mouse.move(page.x + page.width / 2, page.y + page.height / 2);
    await window.mouse.wheel(0, -below);
    await expect
      .poll(async () => bottom(page) - bottom(await boxOf(change)))
      .toBeLessThanOrEqual(60);

    // Only pointed at, nothing scrolls under the pointer.
    const before = await scrolled(window);
    await change.hover();
    const card = window.getByTestId("change-bar");
    await expect(card).toBeVisible();
    expect(await scrolled(window)).toBe(before);

    // Clicked, the cursor is in the change: the card docks and the change moves above it.
    // Its centre, which the card at the foot doesn't cover.
    await pointAndClick(window, change);
    await expect.poll(async () => bottom(await boxOf(change)) <= (await boxOf(card)).y).toBe(true);
    expect(await scrolled(window)).toBeGreaterThan(before);
    expect(overlaps(await boxOf(card), await boxOf(change))).toBe(false);
  } finally {
    await removeDataFolder(files);
  }
});

test("the card keeps its change while the pointer crosses another change to reach it", async () => {
  const files = await createDataFolder();
  try {
    const { app, window } = await launchApp(dataDir, { home: files });
    await setWindowSize(app, window, 900, 900);
    await dismissChatSetup(window);
    await importWordFile(app, window, files, "Long redline.docx", longRedline());
    const editor = window.getByTestId("mind-editor");
    const wide = editor.locator("ins.proposal-theirs", { hasText: "ten working days" });
    const short = editor.locator("ins.proposal-theirs", { hasText: "with written notice" });
    await expect(short).toHaveCount(1);

    // The wide change in the page's upper half, its docked card at the foot, the short
    // change between them: reaching the card means crossing it.
    await wide.scrollIntoViewIfNeeded();
    const page = await boxOf(window.locator(".mind-tab-page:visible"));
    const middle = await boxOf(wide);
    await window.mouse.move(page.x + page.width / 2, page.y + page.height / 2);
    await window.mouse.wheel(0, middle.y + middle.height / 2 - (page.y + 140));
    await expect.poll(async () => (await boxOf(wide)).y).toBeLessThanOrEqual(page.y + 200);
    const between = await boxOf(short);
    const card = window.getByTestId("change-bar");
    await wide.hover();
    await expect(card).toHaveAccessibleName("Change 1 of 2");
    expect(bottom(between)).toBeLessThan((await boxOf(card)).y);

    // Its Accept, reached past the other change, applies the change the card opened on.
    await pointAndClick(window, card.getByTestId("change-accept"));
    await expect(editor.locator("ins.proposal-theirs")).toHaveText([" with written notice"]);
    await expect(window.getByTestId("their-changes-count")).toHaveText("1 change from Dana Kim");
  } finally {
    await removeDataFolder(files);
  }
});
