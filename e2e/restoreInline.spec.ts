import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * Review changes puts a Restore original after the new words of each group of
 * changes, never over the text, and the applied line sits with the paragraph
 * it changed (#1018). A group is a section rewritten as a whole, a paragraph
 * rewritten whole, or one word-level change (#1177, as #1028 draws them). The
 * scripted model's "shorten" drops "very" and "really" (非常 and 真的): two
 * changes in one paragraph. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1100, height: 760 },
] as const;

interface Case {
  language: "en" | "zh-CN";
  lines: readonly [string, string];
  ask: string;
  shortened: string;
  veryBack: string;
  reallyBack: string;
  restore: string;
}

const CASES: readonly Case[] = [
  {
    language: "en",
    lines: [
      "Tides rise twice a day along this coast.",
      "The tides here are very strong and really regular.",
    ],
    ask: "shorten it",
    shortened: "The tides here are strong and regular.",
    veryBack: "The tides here are very strong and regular.",
    reallyBack: "The tides here are strong and really regular.",
    restore: "Restore original",
  },
  {
    language: "zh-CN",
    lines: ["潮水每天涨落两次。", "潮水非常强，而且真的很有规律。"],
    ask: "缩短",
    shortened: "潮水强，而且很有规律。",
    veryBack: "潮水非常强，而且很有规律。",
    reallyBack: "潮水强，而且真的很有规律。",
    restore: "恢复原文",
  },
];

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const wordsOf = (paragraph: Locator) =>
  paragraph.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let words = "";
    for (let each = walker.nextNode(); each; each = walker.nextNode()) {
      if (!each.parentElement?.closest(".applied-old, [contenteditable='false']")) {
        words += each.textContent ?? "";
      }
    }
    return words;
  });

const controlsOverText = (editor: Locator) =>
  editor.evaluate((node) => {
    const rects = (range: Range) => [...range.getClientRects()];
    const words: DOMRect[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let each = walker.nextNode(); each; each = walker.nextNode()) {
      if (each.parentElement?.closest("button, [contenteditable='false']:not(.applied-old)")) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(each);
      words.push(...rects(range));
    }
    const frame = node.closest(".mind-editor-frame") ?? node;
    const controls = [...frame.querySelectorAll("button, .change-bar")].map((each) =>
      each.getBoundingClientRect(),
    );
    const meets = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    return controls.filter((control) => words.some((word) => meets(control, word))).length;
  });

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const readsBefore = (a: Box, b: Box) => {
  const apart = b.y + b.height / 2 - (a.y + a.height / 2);
  return Math.abs(apart) < Math.min(a.height, b.height) / 2 ? a.x < b.x : apart > 0;
};

const gapsAround = async (line: Locator, above: Locator, below: Locator) => {
  const [lineBox, aboveBox, belowBox] = await Promise.all([
    line.boundingBox(),
    above.boundingBox(),
    below.boundingBox(),
  ]);
  if (!lineBox || !aboveBox || !belowBox) throw new Error("The line or a paragraph isn't drawn.");
  return {
    above: lineBox.y - (aboveBox.y + aboveBox.height),
    below: belowBox.y - (lineBox.y + lineBox.height),
  };
};

for (const { language, lines, ask, shortened, veryBack, reallyBack, restore } of CASES) {
  test(`Review changes ends each change with its own Restore original, after its words and in reading order; the applied line sits with the paragraph it changed (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);

    for (const { width, height } of SIZES) {
      await setWindowSize(app, window, width, height);
      await newMind(window);
      const editor = frontMind(window).getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.type(lines[0]);
      await window.keyboard.press("Enter");
      await window.keyboard.type(lines[1]);
      const paragraphs = editor.locator(":scope > p");
      await expect(paragraphs).toHaveText([...lines]);
      const [first, note] = [paragraphs.first(), paragraphs.nth(1)];
      const line = editor.getByTestId("applied-line");

      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.press("ControlOrMeta+j");
      await expect(window.getByTestId("composer-input")).toBeFocused();
      await window.keyboard.type(ask);
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("edit-pending")).toHaveCount(0);
      await expect.poll(() => wordsOf(note)).toBe(shortened);

      const applied = await gapsAround(line, first, note);
      expect(applied.below).toBeGreaterThanOrEqual(0);
      expect(applied.below).toBeLessThan(applied.above);
      await expect(line.getByTestId("applied-count")).toHaveCSS("font-weight", "600");
      await expect(line.getByTestId("applied-review")).toHaveCSS("font-weight", "600");
      await expect(line.getByTestId("applied-review")).toHaveCSS("color", "rgb(23, 25, 28)");

      await pointAndClick(window, line.getByTestId("applied-review"));
      const restores = note.getByTestId("change-restore");
      const removed = note.locator("del.applied-old");
      await expect(restores).toHaveText([restore, restore]);
      await expect(removed).toHaveCount(2);
      const reviewing = await gapsAround(line, first, note);
      expect(reviewing.below).toBeGreaterThanOrEqual(0);
      expect(reviewing.below).toBeLessThan(reviewing.above);
      await expect(line.getByTestId("applied-count")).toHaveCSS("font-weight", "600");
      await expect(line.getByTestId("applied-done")).toHaveCSS("font-weight", "600");
      await expect(line.getByTestId("applied-done")).toHaveCSS("color", "rgb(23, 25, 28)");
      await expect(restores.first()).toHaveCSS("font-size", "12px");
      await expect(restores.first()).toHaveAttribute(
        "aria-keyshortcuts",
        process.platform === "darwin" ? "Meta+Backspace" : "Control+Backspace",
      );
      await expect(restores.first()).toHaveAttribute(
        "title",
        process.platform === "darwin" ? /·\s⌘⌫$/ : /·\sCtrl\+Backspace$/,
      );
      await expect(restores.first()).toHaveCSS("color", "rgb(101, 107, 116)");

      await expect(window.getByTestId("applied-change-bar")).toHaveCount(0);
      expect(await controlsOverText(editor)).toBe(0);
      const [struckFirst, struckLast, restoreFirst, restoreLast] = await Promise.all([
        removed.first().boundingBox(),
        removed.last().boundingBox(),
        restores.first().boundingBox(),
        restores.last().boundingBox(),
      ]);
      const editorBox = await editor.boundingBox();
      if (!struckFirst || !struckLast || !restoreFirst || !restoreLast || !editorBox) {
        throw new Error("A change isn't drawn.");
      }
      expect(readsBefore(struckFirst, restoreFirst)).toBe(true);
      expect(readsBefore(restoreFirst, struckLast)).toBe(true);
      expect(readsBefore(struckLast, restoreLast)).toBe(true);
      for (const box of [restoreFirst, restoreLast]) {
        expect(box.x + box.width).toBeLessThanOrEqual(editorBox.x + editorBox.width + 1);
      }
      await motionSettled(window);
      await screenshot(window, `restore-inline-${language}-${width}`);

      await editor.focus();
      const reached: Box[] = [];
      for (let presses = 0; presses < 8 && reached.length < 2; presses++) {
        await window.keyboard.press("Tab");
        const box = await window.evaluate(() => {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || active.dataset.testid !== "change-restore") {
            return null;
          }
          const { x, y, width, height } = active.getBoundingClientRect();
          return { x, y, width, height };
        });
        if (box) reached.push(box);
      }
      expect(reached).toHaveLength(2);
      const [early, late] = reached;
      expect(early && late && readsBefore(early, late)).toBe(true);

      await window.keyboard.press("Enter");
      await expect.poll(() => wordsOf(note)).toBe(reallyBack);
      await expect(removed).toHaveCount(1);
      await expect(restores).toHaveCount(1);
      await expect(window.getByTestId("undo-message")).toBeVisible();
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => wordsOf(note)).toBe(shortened);

      // The Restore taken back shows its change again.
      await expect(restores).toHaveCount(2);
      await pointAndClick(window, restores.first());
      await expect.poll(() => wordsOf(note)).toBe(veryBack);
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => wordsOf(note)).toBe(shortened);
    }
    await app.close();
  });
}

const REPLACEMENTS = [
  {
    language: "en",
    line: "The tides here are strong and regular.",
    ask: "replace regular with punctual",
    old: "regular",
    added: "punctual",
  },
  {
    language: "zh-CN",
    line: "潮水每天非常规律地涨落两次。",
    ask: "把规律换成准时",
    old: "规律",
    added: "准时",
  },
] as const;

for (const { language, line: written, ask, old, added } of REPLACEMENTS) {
  test(`a replaced word has a space between its struck and new words, and its Restore original after them, which puts the old word back and leaves the line clear (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    const editor = frontMind(window).getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type(written);
    const note = editor.locator(":scope > p").first();
    await expect(note).toHaveText(written);

    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type(ask);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("edit-pending")).toHaveCount(0);
    const line = editor.getByTestId("applied-line");
    await pointAndClick(window, line.getByTestId("applied-review"));

    const struck = note.locator("del.applied-old");
    const underlined = note.locator(".applied-new");
    const restore = note.getByTestId("change-restore");
    await expect(struck).toHaveText(old);
    await expect(underlined).toHaveText(added);
    const [struckBox, addedBox, restoreBox] = await Promise.all([
      struck.boundingBox(),
      underlined.boundingBox(),
      restore.boundingBox(),
    ]);
    if (!struckBox || !addedBox || !restoreBox) throw new Error("The change isn't drawn.");
    expect(addedBox.x - (struckBox.x + struckBox.width)).toBeGreaterThanOrEqual(2);
    expect(restoreBox.x - (addedBox.x + addedBox.width)).toBeGreaterThanOrEqual(2);
    expect(await controlsOverText(editor)).toBe(0);

    await pointAndClick(window, restore);
    await expect.poll(() => wordsOf(note)).toBe(written);
    await expect(line).toHaveCount(0);
    await app.close();
  });
}

test("a paragraph an edit removed ends with its own Restore original, on a line of its own under it, which puts the paragraph back", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  const lines = [
    "Tides rise twice a day along this coast.",
    "It is a big harbour and a lot of boats do not leave at low water.",
    "The harbour office posts the times each week.",
  ];
  await newMind(window);
  const editor = frontMind(window).getByTestId("mind-editor");
  await editor.click();
  for (const [index, written] of lines.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(written);
  }
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText(lines);
  const line = editor.getByTestId("applied-line");
  const restore = editor.getByTestId("change-restore");

  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("delete the second paragraph");
  await window.keyboard.press("Enter");
  await expect(paragraphs).toHaveText([lines[0] ?? "", lines[2] ?? ""]);
  await pointAndClick(window, line.getByTestId("applied-review"));

  const struck = editor.locator(".applied-old--block");
  await expect(struck).toHaveText(lines[1] ?? "");
  await expect(restore).toHaveCount(1);
  const [struckBox, restoreBox] = await Promise.all([struck.boundingBox(), restore.boundingBox()]);
  if (!struckBox || !restoreBox) throw new Error("The change isn't drawn.");
  expect(restoreBox.y).toBeGreaterThanOrEqual(struckBox.y + struckBox.height - 1);
  expect(await controlsOverText(editor)).toBe(0);
  await pointAndClick(window, restore);
  await expect(paragraphs).toHaveText(lines);
  await expect(line).toHaveCount(0);
  await app.close();
});

interface SectionCase {
  language: "en" | "zh-CN";
  heading: string;
  lines: readonly string[];
  ask: string;
  rewrote: string;
  position: string;
  restore: string;
}

const SECTIONS: readonly SectionCase[] = [
  {
    language: "en",
    heading: "Highlights and open items",
    lines: [
      "Data analysis across health and finance.",
      "Financial modelling and valuation.",
      "English, IELTS 7.5.",
    ],
    ask: "rewrite the section",
    rewrote: "Key strengths",
    position: "Change 1 of 1",
    restore: "Restore original",
  },
  {
    language: "zh-CN",
    heading: "履历亮点与待核实事项",
    lines: [
      "跨医疗、金融两个行业的数据分析经验。",
      "熟悉财务建模与估值。",
      "英语 CET-6，雅思 7.5。",
    ],
    ask: "重写这一节",
    rewrote: "核心优势",
    position: "第 1 处修订，共 1 处",
    restore: "恢复原文",
  },
];

for (const { language, heading, lines, ask, rewrote, position, restore } of SECTIONS) {
  test(`a section rewritten as a whole shows one Restore original after its last new words, which restores the whole section with one Undo, and never overlaps the text (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);

    for (const [round, { width, height }] of SIZES.entries()) {
      await setWindowSize(app, window, width, height);
      await newMind(window);
      const editor = frontMind(window).getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.type(`## ${heading}`);
      for (const written of lines) {
        await window.keyboard.press("Enter");
        await window.keyboard.type(written);
      }
      const title = editor.locator(":scope > h2");
      const paragraphs = editor.locator(":scope > p");
      await expect(title).toHaveText(heading);
      await expect(paragraphs).toHaveText([...lines]);

      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.press("ControlOrMeta+j");
      await expect(window.getByTestId("composer-input")).toBeFocused();
      await window.keyboard.type(ask);
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("edit-pending")).toHaveCount(0);
      await expect(title).toHaveText(rewrote);
      const line = editor.getByTestId("applied-line");
      const written = await paragraphs.allTextContents();
      await pointAndClick(window, line.getByTestId("applied-review"));

      await expect(editor.getByTestId("change-section-line")).toHaveCount(1);
      const restores = editor.getByTestId("change-restore");
      await expect(restores).toHaveCount(1);
      await expect(restores).toHaveText(restore);
      await expect(restores).toHaveAttribute("title", new RegExp(`^${position} · `));
      await expect(restores).toHaveCSS("font-size", "12px");
      await expect(restores).toHaveCSS("color", "rgb(101, 107, 116)");
      expect(await controlsOverText(editor)).toBe(0);
      const [lastWords, restoreBox, editorBox] = await Promise.all([
        editor.locator(".applied-new").last().boundingBox(),
        restores.boundingBox(),
        editor.boundingBox(),
      ]);
      if (!lastWords || !restoreBox || !editorBox) throw new Error("The section isn't drawn.");
      expect(readsBefore(lastWords, restoreBox)).toBe(true);
      expect(restoreBox.x + restoreBox.width).toBeLessThanOrEqual(
        editorBox.x + editorBox.width + 1,
      );
      await motionSettled(window);
      await screenshot(window, `restore-section-${language}-${width}`);

      // By mouse, then by keyboard: ⌘⌫ with the cursor anywhere in the section.
      if (round === 0) {
        await pointAndClick(window, restores);
      } else {
        await pointAndClick(window, paragraphs.last());
        await window.keyboard.press("ControlOrMeta+Backspace");
      }
      await expect(title).toHaveText(heading);
      await expect(paragraphs).toHaveText([...lines]);
      await expect(line).toHaveCount(0);
      await expect(window.getByTestId("undo-message")).toBeVisible();

      await window.keyboard.press("ControlOrMeta+z");
      await expect(title).toHaveText(rewrote);
      await expect(paragraphs).toHaveText(written);
    }
    await app.close();
  });
}

interface MixedCase {
  language: "en" | "zh-CN";
  lines: readonly [string, string];
  ask: string;
  anew: string;
  position: (index: number) => string;
}

const MIXED: readonly MixedCase[] = [
  {
    language: "en",
    lines: [
      "The harbour office",
      "Tides rise twice a day along this coast, and in the long summer months the harbour office posts the times each week, while the harbour office also lists the ferries.",
    ],
    ask: "replace harbour office with port authority",
    anew: "The port authority",
    position: (index) => `Change ${index} of 3`,
  },
  {
    language: "zh-CN",
    lines: [
      "海港办公室",
      "潮水每天涨落两次，夏季海港办公室每周公布潮汐时间，海港办公室还会公布渡轮时刻。",
    ],
    ask: "把海港办公室换成港务局",
    anew: "港务局",
    position: (index) => `第 ${index} 处修订，共 3 处`,
  },
];

for (const { language, lines, ask, anew, position } of MIXED) {
  test(`a paragraph rewritten whole shows one Restore original, and each word-level change keeps its own, clear of the text (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);

    for (const { width, height } of SIZES) {
      await setWindowSize(app, window, width, height);
      await newMind(window);
      const editor = frontMind(window).getByTestId("mind-editor");
      await editor.click();
      await window.keyboard.type(lines[0]);
      await window.keyboard.press("Enter");
      await window.keyboard.type(lines[1]);
      const paragraphs = editor.locator(":scope > p");
      await expect(paragraphs).toHaveText([...lines]);
      const [whole, words] = [paragraphs.first(), paragraphs.nth(1)];

      await window.keyboard.press("ControlOrMeta+a");
      await window.keyboard.press("ControlOrMeta+j");
      await expect(window.getByTestId("composer-input")).toBeFocused();
      await window.keyboard.type(ask);
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("edit-pending")).toHaveCount(0);
      await expect.poll(() => wordsOf(whole)).toBe(anew);
      const written = await wordsOf(words);
      await pointAndClick(window, editor.getByTestId("applied-line").getByTestId("applied-review"));

      const restores = editor.getByTestId("change-restore");
      await expect(editor.getByTestId("change-was-line")).toHaveCount(1);
      await expect(whole.getByTestId("change-restore")).toHaveCount(1);
      await expect(words.getByTestId("change-restore")).toHaveCount(2);
      await expect(restores).toHaveCount(3);
      for (const index of [1, 2, 3]) {
        await expect(restores.nth(index - 1)).toHaveAttribute(
          "title",
          new RegExp(`^${position(index)} · `),
        );
      }
      expect(await controlsOverText(editor)).toBe(0);
      await motionSettled(window);
      await screenshot(window, `restore-mixed-${language}-${width}`);

      await pointAndClick(window, restores.first());
      await expect.poll(() => wordsOf(whole)).toBe(lines[0]);
      await expect(restores).toHaveCount(2);
      expect(await wordsOf(words)).toBe(written);
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => wordsOf(whole)).toBe(anew);
      await expect(restores).toHaveCount(3);

      await pointAndClick(window, restores.last());
      await expect(restores).toHaveCount(2);
      await expect(words.locator("del.applied-old")).toHaveCount(1);
      expect(await wordsOf(whole)).toBe(anew);
    }
    await app.close();
  });
}
