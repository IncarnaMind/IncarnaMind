import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Lists in a Mind (#1341): Tab and Shift-Tab change an item's level (bullets, numbers and
 * checklists), each one ⌘Z; and a list is indented as Word indents it (DESIGN.md): the text of
 * level 1 starts 48px from the text edge, each further level 48px more, wrapped lines aligned to it.
 * A to-do isn't indented: its box is on the text edge, its text 28px in, and each further level
 * 24px more. English at 1,440 px, Chinese at 900 px; to-dos also at 900 and 1,600 px in both.
 */
const MAC = process.platform === "darwin";
const UNDO = MAC ? "Meta+z" : "Control+z";
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const SETTINGS = [
  {
    language: "en",
    width: 1440,
    body: "Tides rise twice a day.",
    items: ["Spring tides", "Neap tides", "Tidal range"],
    long: "A long item whose words wrap onto a second line so that the lines can be seen to start at the same place under the first word of it, whatever the width of the window is today.",
  },
  {
    language: "zh-CN",
    width: 900,
    body: "潮汐每天涨落两次。",
    items: ["大潮", "小潮", "潮差"],
    long: "这是一个很长的条目，它的文字会折到第二行，这样就能看出各行是否都从同一处开始，而不论今天窗口有多宽，也不论字有多少。这是一个很长的条目，它的文字会折到第二行。",
  },
] as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** The first Block, the body's text edge, and each list item's text, from the page's left. */
const edge = (editor: Locator) =>
  editor
    .locator(":scope > p")
    .first()
    .evaluate((p) => p.getBoundingClientRect().left);

const textLeft = (item: Locator) =>
  item.evaluate((li) => {
    const text = li.querySelector(":scope > p, :scope > div > p");
    return text ? text.getBoundingClientRect().left : Number.NaN;
  });

const near = (value: number, expected: number) =>
  expect(
    Math.abs(value - expected),
    `${value} is not within 1px of ${expected}`,
  ).toBeLessThanOrEqual(1);

/** Where an item's bullet or checkbox is drawn, which is not where its text is. */
const markerLeft = (item: Locator) =>
  item.evaluate((li) => {
    const box = li.querySelector(":scope > label");
    if (box) return box.getBoundingClientRect().left;
    const text = li.querySelector(":scope > p");
    if (!text) return Number.NaN;
    const before = getComputedStyle(text, "::before");
    return before.content === "none"
      ? Number.NaN
      : li.getBoundingClientRect().left + Number.parseFloat(before.left);
  });

/** How far a number ends before its text, and how far a bullet's centre is from its first line's, as drawn. */
const numberGap = (item: Locator) =>
  item.evaluate((li) => {
    const text = li.querySelector(":scope > p") as HTMLElement;
    const before = getComputedStyle(text, "::before");
    const markerLeft = li.getBoundingClientRect().left + Number.parseFloat(before.left);
    return text.getBoundingClientRect().left - (markerLeft + Number.parseFloat(before.width));
  });

const bulletOffCentre = (item: Locator) =>
  item.evaluate((li) => {
    const text = li.querySelector(":scope > p") as HTMLElement;
    const before = getComputedStyle(text, "::before");
    const line = Number.parseFloat(getComputedStyle(text).lineHeight);
    return Number.parseFloat(before.marginTop) + Number.parseFloat(before.height) / 2 - line / 2;
  });

async function openMind(language: "en" | "zh-CN", width: number, body: string) {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 760);
  await newMind(window);
  await enterContent(window);
  const editor = window.getByTestId("mind-editor");
  await window.keyboard.type(body);
  await window.keyboard.press("Enter");
  return { app, window, editor };
}

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

for (const { language, width, body, items, long } of SETTINGS) {
  test(`Tab and Shift-Tab change a bullet's level, with the caret in place and one ⌘Z each, and a list is indented as in Word (${language})`, async () => {
    const { app, window, editor } = await openMind(language, width, body);

    await window.keyboard.type("- ");
    await window.keyboard.type(items[0]);
    const edgeLeft = await edge(editor);
    // The first item has nothing to go under: Tab changes nothing and the focus stays.
    await window.keyboard.press("Tab");
    await expect(editor).toBeFocused();
    await expect(editor.locator("ul")).toHaveCount(1);
    await expect(editor.locator("ul ul")).toHaveCount(0);
    const first = editor.locator("li").first();
    near((await textLeft(first)) - edgeLeft, 48);
    near((await markerLeft(first)) - edgeLeft, 24);
    await screenshot(window, `list-level-1-${language}-${width}`);

    await window.keyboard.press("Enter");
    await window.keyboard.type(items[1]);
    await window.keyboard.press("Tab");
    const second = editor.locator("ul ul > li");
    await expect(second).toHaveText(items[1]);
    await expect(editor).toBeFocused();
    near((await textLeft(second)) - edgeLeft, 96);
    near((await markerLeft(second)) - edgeLeft, 72);
    await window.keyboard.type("!");
    await expect(second).toHaveText(`${items[1]}!`);
    await window.keyboard.press("Backspace");
    await screenshot(window, `list-level-2-${language}-${width}`);

    await window.keyboard.press("Enter");
    await window.keyboard.type(long);
    await window.keyboard.press("Tab");
    const third = editor.locator("ul ul ul > li");
    await expect(third).toHaveCount(1);
    near((await textLeft(third)) - edgeLeft, 144);
    near((await markerLeft(third)) - edgeLeft, 120);
    const linesOf = (item: Locator) =>
      item.locator("> p").evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        const starts = new Map<number, number>();
        for (const rect of rects) {
          const top = Math.round(rect.top);
          starts.set(top, Math.min(starts.get(top) ?? Number.POSITIVE_INFINITY, rect.left));
        }
        return [...starts.values()];
      });
    const wrapped = await linesOf(third);
    expect(wrapped.length, "the long item wraps onto a second line").toBeGreaterThan(1);
    for (const start of wrapped) near(start, wrapped[0] ?? 0);

    await window.keyboard.press("Shift+Tab");
    await expect(third).toHaveCount(0);
    await expect(editor.locator("ul ul > li")).toHaveCount(2);
    await window.keyboard.press(UNDO);
    await expect(third).toHaveCount(1);
    await window.keyboard.press(UNDO);
    await expect(third).toHaveCount(0);
    await expect(editor.locator("ul ul > li")).toHaveCount(2);
    await window.keyboard.press("Shift+Tab");
    const level1 = editor.locator(":scope > ul > li").nth(1);
    await expect(editor.locator("ul ul > li")).toHaveCount(1);
    near((await textLeft(level1)) - edgeLeft, 48);
    const again = await linesOf(level1);
    for (const start of again) near(start, again[0] ?? 0);

    // The bullet stays on its first line's centre when the paragraph's line is taller (Aa › Line spacing).
    near(await bulletOffCentre(first), 0);
    await first.locator("> p").evaluate((p) => {
      p.style.lineHeight = "2.5";
    });
    near(await bulletOffCentre(first), 0);

    await window.keyboard.press("Enter");
    await window.keyboard.press("Tab");
    await expect(editor.locator("li")).toHaveCount(4);
    await expect(editor.locator("ul ul > li")).toHaveCount(2);
    await window.keyboard.press("Backspace");
    await expect(editor.locator("li")).toHaveCount(4);
    await expect(editor.locator("ul ul > li")).toHaveCount(1);
    await window.keyboard.press("Backspace");
    await expect(editor.locator("li")).toHaveCount(3);
    await app.close();
  });

  test(`Tab and Shift-Tab change the level of a numbered item, one ⌘Z each, indented the same (${language})`, async () => {
    const { app, window, editor } = await openMind(language, width, body);
    const edgeLeft = await edge(editor);

    await window.keyboard.type("1. ");
    await window.keyboard.type(items[0]);
    await window.keyboard.press("Enter");
    await window.keyboard.type(items[1]);
    await window.keyboard.press("Tab");
    await expect(editor.locator("ol ol > li")).toHaveText(items[1]);
    near((await textLeft(editor.locator("ol > li").first())) - edgeLeft, 48);
    near((await textLeft(editor.locator("ol ol > li"))) - edgeLeft, 96);
    expect(await numberGap(editor.locator("ol > li").first())).toBeGreaterThanOrEqual(8);
    expect(await numberGap(editor.locator("ol ol > li"))).toBeGreaterThanOrEqual(8);
    await screenshot(window, `numbers-${language}-${width}`);
    await window.keyboard.press(UNDO);
    await expect(editor.locator("ol ol")).toHaveCount(0);
    await expect(editor.locator("ol > li")).toHaveCount(2);
    await app.close();
  });

  test(`Tab and Shift-Tab change the level of a checklist item, one ⌘Z each, the box at the text edge (${language})`, async () => {
    const { app, window, editor } = await openMind(language, width, body);
    const edgeLeft = await edge(editor);

    await window.keyboard.type("[ ] ");
    await window.keyboard.type(items[0]);
    await window.keyboard.press("Enter");
    await window.keyboard.type(items[1]);
    const tasks = editor.locator("li[data-checked]");
    await expect(tasks).toHaveCount(2);
    near((await textLeft(tasks.first())) - edgeLeft, 28);
    near((await markerLeft(tasks.first())) - edgeLeft, 0);
    await window.keyboard.press("Tab");
    const nested = editor.locator("ul ul li[data-checked]");
    await expect(nested).toHaveCount(1);
    await expect(nested.locator("> div")).toHaveText(items[1]);
    near((await textLeft(nested)) - edgeLeft, 52);
    near((await markerLeft(nested)) - edgeLeft, 24);
    await screenshot(window, `checklist-${language}-${width}`);
    await window.keyboard.press("Shift+Tab");
    await expect(editor.locator("ul ul")).toHaveCount(0);
    near((await markerLeft(tasks.nth(1))) - edgeLeft, 0);
    await window.keyboard.press(UNDO);
    await expect(nested).toHaveCount(1);
    await window.keyboard.press(UNDO);
    await expect(editor.locator("ul ul")).toHaveCount(0);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1600]) {
    test(`a to-do under a paragraph has its box on the paragraph's text edge, wrapped lines under its text (${language}, ${width} px)`, async () => {
      const setting = SETTINGS.find((each) => each.language === language) ?? SETTINGS[0];
      const { app, window, editor } = await openMind(language, width, setting.body);
      const edgeLeft = await edge(editor);
      await window.keyboard.type("[ ] ");
      await window.keyboard.type(setting.long);
      const task = editor.locator("li[data-checked]").first();
      await screenshot(window, `todo-edge-${language}-${width}`);
      const box = task.locator("> label > input");
      const boxLeft = await box.evaluate((input) => input.getBoundingClientRect().left);
      near(boxLeft - edgeLeft, 0);
      near((await textLeft(task)) - edgeLeft, 28);
      const starts = await task.locator("> div > p").evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        const tops = new Map<number, number>();
        for (const rect of range.getClientRects()) {
          if (rect.width === 0) continue;
          const top = Math.round(rect.top);
          tops.set(top, Math.min(tops.get(top) ?? Number.POSITIVE_INFINITY, rect.left));
        }
        return [...tops.values()];
      });
      expect(starts.length, "the long item wraps onto a second line").toBeGreaterThan(1);
      for (const start of starts) near(start - edgeLeft, 28);
      // A bullet next to it is as Word indents it.
      await window.keyboard.press("Enter");
      await window.keyboard.press("Enter");
      await window.keyboard.type("- ");
      await window.keyboard.type(setting.items[0]);
      const bullet = editor.locator("ul > li:not([data-checked])").first();
      near((await textLeft(bullet)) - edgeLeft, 48);
      near((await markerLeft(bullet)) - edgeLeft, 24);
      await app.close();
    });
  }
}
