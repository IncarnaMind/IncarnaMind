import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  afterEditorFocus,
  assistantAnswers,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  interceptOpenExternal,
  launchApp,
  newMind,
  pointAndClick,
  pressTextStart,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  urlsOpened,
  useLocalChatModel,
  wordsBox,
} from "./app";

/*
 * The editor's basics (#115): lists, a checklist, a quote and a divider from
 * "/", links, the outline, find in the Mind, "@" for a Document, each by
 * keyboard and by mouse. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */
let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Opens a new Mind with the cursor on its first line, in a window of a fixed size. */
async function startMind(language: "en" | "zh-CN" = "en", width = 1280) {
  const running = await launchApp(dataDir);
  const { app, window } = running;
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 700);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  return { ...running, editor };
}

const BLOCKS = [
  { id: "bulleted-list", selector: "ul > li > p", typed: "bullet" },
  { id: "numbered-list", selector: "ol > li > p", typed: "numbered" },
  { id: "checklist", selector: "ul:has(> li[data-checked]) > li > div > p", typed: "check" },
  { id: "quote", selector: "blockquote > p", typed: "quote" },
] as const;

test("checklist boxes keep their text, state and localized empty name when the language changes", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 560);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await window.keyboard.type("[ ] ");
    await expect(
      editor.getByRole("checkbox", { name: "Empty checklist item", exact: true }),
    ).toBeVisible();
    await window.keyboard.insertText("核查清单项");
    await expect(editor.getByRole("checkbox", { name: "核查清单项", exact: true })).toBeVisible();
    await window.keyboard.press("Enter");
    await window.keyboard.type("Submit report");
    await window.keyboard.press("Enter");
    const boxes = editor.getByRole("checkbox");
    await expect(boxes).toHaveCount(3);
    await expect(boxes.nth(2)).toHaveAccessibleName("Empty checklist item");

    const secondText = editor.locator("li[data-checked] > div > p").nth(1);
    await window.keyboard.press("ArrowUp");
    await expect
      .poll(() =>
        secondText.evaluate((element) => {
          const root = element.closest(".ProseMirror") as (Element & { editor?: Editor }) | null;
          const view = root?.editor?.view;
          return !!view && element.contains(view.domAtPos(view.state.selection.from).node);
        }),
      )
      .toBe(true);
    await window.keyboard.press("Tab");
    await expect(editor.locator("ul ul li[data-checked]")).toHaveCount(1);
    await expect(editor.locator("ul ul li[data-checked] > div > p")).toHaveText("Submit report");
    await expect(boxes.first()).toHaveAccessibleName("核查清单项Submit report");
    await expect(boxes.nth(1)).toHaveAccessibleName("Submit report");

    await setLanguage(window, "zh-CN");
    await expect(boxes.nth(2)).toHaveAccessibleName("空白待办项");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator("ul ul")).toHaveCount(0);
    await expect(boxes.first()).toHaveAccessibleName("核查清单项");
    await expect(boxes.nth(1)).toHaveAccessibleName("Submit report");
    await boxes.first().press("Space");
    await expect(boxes.first()).toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    await test.info().attach("checklist-zh-CN", {
      body: await editor.ariaSnapshot(),
      contentType: "text/plain",
    });

    const firstText = editor.locator("li[data-checked] > div > p").first();
    await pointAndClick(window, firstText);
    await firstText.press("End");
    await window.keyboard.insertText("已完成");
    await expect(boxes.first()).toHaveAccessibleName("核查清单项已完成");
    await expect(boxes.first()).toBeChecked();

    await setLanguage(window, "en");
    await expect(boxes.nth(2)).toHaveAccessibleName("Empty checklist item");
    await expect(boxes.first()).toHaveAccessibleName("核查清单项已完成");
    await boxes.first().press("Space");
    await expect(boxes.first()).not.toBeChecked();
    await expect(boxes.nth(1)).not.toBeChecked();
    await test.info().attach("checklist-en", {
      body: await editor.ariaSnapshot(),
      contentType: "text/plain",
    });
  } finally {
    await app.close();
  }
});

test('"/" offers lists, a checklist, a quote and a divider, chosen by keyboard or mouse and undone', async () => {
  const { window, editor } = await startMind();

  for (const [index, block] of BLOCKS.entries()) {
    await window.keyboard.type("/");
    for (const other of BLOCKS) {
      await expect(window.getByTestId(`slash-item-${other.id}`)).toBeVisible();
    }
    const item = window.getByTestId(`slash-item-${block.id}`);
    if (index % 2 === 0) {
      // By keyboard: type the name, Enter.
      await window.keyboard.type(block.typed);
      await expect(item).toHaveAttribute("aria-selected", "true");
      await window.keyboard.press("Enter");
    } else {
      // By mouse: point at the item and click it.
      await item.hover();
      await item.click();
    }
    await expect(editor.locator(block.selector)).toHaveCount(1);
    await window.keyboard.type(`Item ${index}`);
    await expect(editor.locator(block.selector)).toHaveText(`Item ${index}`);
    // Enter twice leaves the block, to a plain line for the next one.
    await window.keyboard.press("Enter");
    await window.keyboard.press("Enter");
  }

  // A checklist item is ticked with its box.
  await window.keyboard.type("/check");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Buy milk");
  const box = editor.locator("li[data-checked] input").last();
  await box.hover();
  await box.click();
  await expect(editor.locator('li[data-checked="true"]')).toHaveCount(1);
  await window.keyboard.press("Enter");
  await window.keyboard.press("Enter");

  // A divider, and the cursor goes on to the line after it.
  await window.keyboard.type("/divider");
  await expect(window.getByTestId("slash-item-divider")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(editor.locator("hr")).toHaveCount(1);
  await window.keyboard.type("After the rule");
  await expect(editor.locator("hr + p")).toHaveText("After the rule");

  // Undo takes the typing back, then the divider.
  await window.keyboard.press("ControlOrMeta+Z");
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(editor.locator("hr")).toHaveCount(0);
});

test('"/" finds the new items by their Chinese names, their pinyin and their initials', async () => {
  const { window, editor } = await startMind("zh-CN");
  const names = [
    ["列表", ["bulleted-list", "numbered-list"]],
    ["待办", ["checklist"]],
    ["引述", ["quote"]],
    ["分割", ["divider"]],
  ] as const;
  for (const [typed, ids] of names) {
    await window.keyboard.type(`/${typed}`);
    for (const id of ids) await expect(window.getByTestId(`slash-item-${id}`)).toBeVisible();
    await window.keyboard.press("Escape");
    for (let count = 0; count <= typed.length; count++) await window.keyboard.press("Backspace");
  }
  // The pinyin and initials ⌘K already matches a name by (#1298).
  const pinyin = [
    ["biaoge", "table"],
    ["bg", "table"],
    ["daima", "code"],
    ["dm", "code"],
    ["gongshi", "math"],
    ["yinshu", "quote"],
  ] as const;
  for (const [typed, id] of pinyin) {
    await window.keyboard.type(`/${typed}`);
    await expect(window.getByTestId(`slash-item-${id}`)).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("Escape");
    for (let count = 0; count <= typed.length; count++) await window.keyboard.press("Backspace");
  }
  await window.keyboard.type("/待办");
  await window.keyboard.press("Enter");
  await expect(editor.locator("ul:has(> li[data-checked])")).toHaveCount(1);
  // Enter puts in the item its initials found.
  await window.keyboard.press("Enter");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/bg");
  await window.keyboard.press("Enter");
  await expect(editor.locator("table")).toHaveCount(1);
});

// While the selection menu isn't shown (put away with Esc, or never shown over all of the Mind),
// what is in it isn't on the page, where a popover can't open (#1461).
for (const [how, language, width] of [
  ["Esc", "en", 900],
  ["Esc", "zh-CN", 1600],
  ["⌘A", "en", 1600],
  ["⌘A", "zh-CN", 900],
] as const) {
  test(`⌘K on a selection whose menu isn't shown (${how}) opens the link field beside it, at ${width} px (${language})`, async () => {
    const { window, editor } = await startMind(language, width);
    const errors: string[] = [];
    window.on("pageerror", (error) => errors.push(error.message));
    const sentence = "Read the Tides paper today and the Moon one tomorrow";
    await window.keyboard.type(sentence);
    const line = editor.locator("p").first();
    const menu = window.getByTestId("selection-menu");
    const words = how === "Esc" ? "Tides paper" : sentence;
    if (how === "Esc") {
      await slideSelect(window, line, words);
      await expect(menu).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    } else {
      await window.keyboard.press("ControlOrMeta+a");
    }
    await window.keyboard.press("ControlOrMeta+K");

    const field = window.getByTestId("link-field");
    await expect(field).toBeFocused();
    // Beside the words and inside the window: not over the words, and no selection menu over it.
    const panel = await window.locator('[popover]:has([data-testid="link-field"])').boundingBox();
    const lineBox = await line.boundingBox();
    const text = await wordsBox(line, words);
    const view = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!panel || !lineBox) throw new Error("The field or the line isn't on the page.");
    const right = panel.x + panel.width;
    const bottom = panel.y + panel.height;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.y).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(view.width);
    expect(bottom).toBeLessThanOrEqual(view.height);
    expect(panel.x).toBeLessThan(text.right);
    expect(right).toBeGreaterThan(text.left);
    const under = panel.y > text.y && panel.y < lineBox.y + 2 * lineBox.height;
    const over = bottom < text.y && bottom > lineBox.y - lineBox.height;
    expect(under || over).toBe(true);
    await expect(menu).toBeHidden();

    // Esc goes back to the text with the words still selected, and ⌘K opens the field again.
    await window.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect
      .poll(() => window.evaluate(() => globalThis.getSelection()?.toString().trim()))
      .toBe(words);
    await focusSettled(window, editor);
    await window.keyboard.press("ControlOrMeta+K");
    await expect(field).toBeFocused();
    await window.keyboard.type("example.com/tides");
    await window.keyboard.press("Enter");
    const link = line.locator("a");
    await expect(link).toHaveText(words);
    await expect(link).toHaveAttribute("href", "https://example.com/tides");

    // Undo takes the link back as one step, and Redo puts it back.
    await expect(editor).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Z");
    await expect(link).toHaveCount(0);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(link).toHaveAttribute("href", "https://example.com/tides");
    expect(errors).toEqual([]);
  });
}

test("a link: added with the button or ⌘K on a selection, edited, opened and removed in place, each undone", async () => {
  const { app, window, editor } = await startMind();
  await interceptOpenExternal(app);
  await window.keyboard.type("Read the Tides paper today and the Moon one tomorrow");
  const line = editor.locator("p").first();
  const menu = window.getByTestId("selection-menu");
  const field = window.getByTestId("link-field");

  // ⌘K on a selection opens the address field; Enter makes the link.
  await slideSelect(window, line, "Tides paper");
  await expect(menu).toBeVisible();
  await window.keyboard.press("ControlOrMeta+K");
  await expect(field).toBeFocused();
  // The menu stays, with the field by its link button.
  await expect(menu).toBeVisible();
  await window.keyboard.type("example.com/tides");
  await window.keyboard.press("Enter");
  await expect(line.locator("a")).toHaveText("Tides paper");
  await expect(line.locator("a")).toHaveAttribute("href", "https://example.com/tides");
  // Undo takes the link back as one step.
  await expect(editor).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(line.locator("a")).toHaveCount(0);
  await expect(line).toHaveText("Read the Tides paper today and the Moon one tomorrow");

  // The selection menu's link button does the same, by mouse.
  await slideSelect(window, line, "Moon one");
  await expect(menu).toBeVisible();
  await window.getByTestId("format-link").hover();
  await window.getByTestId("format-link").click();
  await expect(field).toBeFocused();
  await window.keyboard.type("https://example.com/moon");
  await window.keyboard.press("Enter");
  const link = line.locator("a");
  await expect(link).toHaveAttribute("href", "https://example.com/moon");

  // A click in the link shows where it goes, without leaving the page.
  await link.hover();
  await link.click();
  const bubble = window.getByTestId("link-bubble-address");
  await expect(bubble).toHaveText("https://example.com/moon");
  // The address and the three buttons sit in one row.
  await expect
    .poll(() =>
      window.evaluate(
        (ids) => {
          const middles = ids.map((id) => {
            const box = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
            return box ? box.y + box.height / 2 : Number.NaN;
          });
          return Math.max(...middles) - Math.min(...middles);
        },
        ["link-bubble-address", "link-open", "link-edit", "link-remove"],
      ),
    )
    .toBeLessThan(8);
  await window.getByTestId("link-open").hover();
  await window.getByTestId("link-open").click();
  await expect.poll(() => urlsOpened(app)).toEqual(["https://example.com/moon"]);

  // Edit in place: the field has the address; a new one replaces it on the whole link.
  await window.getByTestId("link-edit").hover();
  await window.getByTestId("link-edit").click();
  await expect(field).toHaveValue("https://example.com/moon");
  await field.fill("example.com/moons");
  await field.press("Enter");
  await expect(link).toHaveAttribute("href", "https://example.com/moons");
  await expect(link).toHaveText("Moon one");

  // Remove it from the bubble; Undo puts it back.
  await link.click();
  await window.getByTestId("link-remove").hover();
  await window.getByTestId("link-remove").click();
  await expect(line.locator("a")).toHaveCount(0);
  await expect(editor).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(link).toHaveAttribute("href", "https://example.com/moons");

  // By keyboard: the cursor into the link, ⌘K edits it, Esc leaves it as it was.
  await window.keyboard.press("End");
  for (let count = 0; count < 12; count++) await window.keyboard.press("ArrowLeft");
  await expect(bubble).toBeVisible();
  await window.keyboard.press("ControlOrMeta+K");
  await expect(field).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(link).toHaveAttribute("href", "https://example.com/moons");
  await expect(editor).toBeFocused();

  // Cleared and confirmed, the field removes the link.
  await window.keyboard.press("ControlOrMeta+K");
  await field.fill("");
  await field.press("Enter");
  await expect(line.locator("a")).toHaveCount(0);

  // With nothing selected and the cursor outside a link, ⌘K does nothing here. The words the link
  // was on stay selected, so the cursor goes to the end of the line first.
  await clickEndOf(window, line);
  await window.keyboard.press("ControlOrMeta+K");
  await expect(field).toHaveCount(0);
});

test("the link field opens once beside the link each time Edit is pressed, though the editor loses the focus to it (#1705)", async () => {
  const { window, editor } = await startMind();
  await window.keyboard.type("Notes on the tides");
  // The link sits well below the first line, so a field anchored there would show it.
  for (let line = 0; line < 5; line++) await window.keyboard.press("Enter");
  await window.keyboard.type("Read the Tides paper today");
  const line = editor.locator("p").last();
  await slideSelect(window, line, "Tides paper");
  await window.keyboard.press("ControlOrMeta+K");
  const field = window.getByTestId("link-field");
  await expect(field).toBeFocused();
  await window.keyboard.type("example.com/tides");
  await window.keyboard.press("Enter");
  const link = line.locator("a");
  await expect(link).toHaveAttribute("href", "https://example.com/tides");

  // Each show of the popover that holds the field is one opening; a changed anchor shows it again.
  await window.evaluate(() => {
    const counter = { opens: 0 };
    (globalThis as { linkFieldOpens?: typeof counter }).linkFieldOpens = counter;
    const show = HTMLElement.prototype.showPopover;
    HTMLElement.prototype.showPopover = function (this: HTMLElement) {
      if (this.querySelector('[data-testid="link-field"]')) counter.opens += 1;
      return show.call(this);
    };
  });
  const opens = () =>
    window.evaluate(
      () => (globalThis as { linkFieldOpens?: { opens: number } }).linkFieldOpens?.opens ?? 0,
    );

  // Edit from the bubble: the field opens beside the link, in the window.
  await clickEndOf(window, line);
  await link.click();
  await window.getByTestId("link-edit").hover();
  await window.getByTestId("link-edit").click();
  await expect(field).toBeFocused();
  const panel = await window.locator('[popover]:has([data-testid="link-field"])').boundingBox();
  const lineBox = await line.boundingBox();
  if (!panel || !lineBox) throw new Error("The field or the line isn't on the page.");
  expect(panel.y).toBeGreaterThanOrEqual(lineBox.y - 2 * lineBox.height);
  expect(panel.y).toBeLessThanOrEqual(lineBox.y + 3 * lineBox.height);

  // Closed and edited again: two openings, not four.
  await window.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await window.getByTestId("link-edit").hover();
  await window.getByTestId("link-edit").click();
  await expect(field).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  expect(await opens()).toBe(2);
});

/** Types a Mind of headings with a page of text under each, then puts the cursor at its start. */
async function writeSections(window: Page, titles: readonly string[]) {
  for (const [index, title] of titles.entries()) {
    await window.keyboard.type(`${index === 1 ? "## " : "# "}${title}`);
    await window.keyboard.press("Enter");
    for (let line = 0; line < 14; line++) {
      await window.keyboard.type(`Line ${line} under ${index}`);
      await window.keyboard.press("Enter");
    }
  }
  await pressTextStart(window);
}

/** Whether the heading shows in the window. */
const inView = (heading: Locator) =>
  heading.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });

for (const [language, titles] of [
  ["en", ["Tides", "Spring tides", "Moons"]],
  ["zh-CN", ["潮汐", "大潮", "月亮"]],
] as const) {
  test(`the Mind's outline lists its headings and jumps to each, from the menu or the keyboard (${language})`, async () => {
    const { window, editor } = await startMind(language);
    await writeSections(window, titles);
    const items = window.getByTestId("outline-item");
    const last = editor.locator("h1", { hasText: titles[2] });
    expect(await inView(last)).toBe(false);

    // From the ⋯ menu, by mouse: a heading per line, indented by level.
    await pointAndClick(window, window.getByRole("tab", { selected: true }).first(), {
      button: "right",
    });
    await window.getByTestId("mind.outline").hover();
    await window.getByTestId("mind.outline").click();
    await expect(items).toHaveText([...titles]);
    const levels = await items.evaluateAll((all) =>
      all.map((each) => Number(each.getAttribute("data-level"))),
    );
    expect(levels).toEqual([1, 2, 1]);
    const indents = await items.evaluateAll((all) =>
      all.map((each) => Number.parseFloat(getComputedStyle(each).paddingLeft)),
    );
    expect(indents[1]).toBeGreaterThan(indents[0] ?? 0);
    await items.nth(2).hover();
    await items.nth(2).click();
    await expect(window.getByTestId("mind-outline")).toHaveCount(0);
    await expect.poll(() => inView(last)).toBe(true);
    // The cursor is at the start of the heading: typing goes there.
    await expect(editor).toBeFocused();
    await window.keyboard.type("!");
    await expect(last).toHaveText(`!${titles[2]}`);

    // From the keyboard: arrows and Enter; Esc closes it and gives the cursor back.
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await expect(items.first()).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(items).toHaveCount(0);
    await expect(editor).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await expect(items.first()).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await window.keyboard.press("Enter");
    await expect.poll(() => inView(editor.locator("h2"))).toBe(true);
    await expect(editor).toBeFocused();
    await window.keyboard.type("?");
    await expect(editor.locator("h2")).toHaveText(`?${titles[1]}`);
  });
}

test("the outline of a Mind with no headings says how to add one", async () => {
  const { window } = await startMind();
  await window.keyboard.type("Just a line");
  await window.keyboard.press("ControlOrMeta+Alt+L");
  await expect(window.getByTestId("mind-outline-empty")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("mind-outline")).toHaveCount(0);
});

test("find in the Mind: a count, next and previous by keyboard and mouse, Chinese text, and Esc leaves the cursor on the match", async () => {
  const { window, editor } = await startMind("zh-CN");
  await window.keyboard.type("潮汐是海水的周期性涨落。大潮和小潮交替出现。");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Tides follow the Moon, and tides are strongest at new moon.");
  const bar = window.getByTestId("find-bar");
  const field = window.getByTestId("find-field");
  const count = window.getByTestId("find-count");
  const current = editor.locator(".find-match--current");

  await window.keyboard.press("ControlOrMeta+F");
  await expect(bar).toBeVisible();
  await expect(field).toBeFocused();

  // A word of Chinese is found as it comes: 潮 is in 潮汐, 大潮 and 小潮.
  await window.keyboard.type("潮");
  await expect(count).toHaveText("1 / 3");
  await expect(editor.locator(".find-match")).toHaveCount(3);
  await expect(current).toHaveText("潮");
  await window.keyboard.type("汐");
  await expect(count).toHaveText("1 / 1");
  await window.keyboard.press("Backspace");

  // Enter and Shift+Enter go round the matches; the buttons do the same.
  await window.keyboard.press("Enter");
  await expect(count).toHaveText("2 / 3");
  await window.keyboard.press("Enter");
  await window.keyboard.press("Enter");
  await expect(count).toHaveText("1 / 3");
  await window.keyboard.press("Shift+Enter");
  await expect(count).toHaveText("3 / 3");
  await window.getByTestId("find-next").hover();
  await window.getByTestId("find-next").click();
  await expect(count).toHaveText("1 / 3");
  await window.getByTestId("find-previous").hover();
  await window.getByTestId("find-previous").click();
  await expect(count).toHaveText("3 / 3");

  // Case doesn't matter in Latin text, and a miss says so.
  await field.fill("TIDES");
  await expect(count).toHaveText("1 / 2");
  await field.fill("xyz");
  await expect(count).toHaveText("没有匹配项");
  await expect(editor.locator(".find-match")).toHaveCount(0);
  await expect(window.getByTestId("find-next")).toBeDisabled();

  // Esc closes the bar, clears the marks and selects the current match.
  await field.fill("moon");
  await expect(count).toHaveText("1 / 2");
  await window.keyboard.press("Enter");
  // The menu shows a moment after the selection changes: run the page's clock past it, so "it
  // stays closed" is checked, not only "it hasn't opened yet" (#1355).
  await window.clock.install();
  await window.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(editor.locator(".find-match")).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await window.evaluate(() => globalThis.getSelection()?.toString())).toBe("moon");
  const menu = window.getByTestId("selection-menu");
  await window.clock.runFor(500);
  await expect(menu).toBeHidden();
  await window.clock.resume();

  // The close button does the same, and ⌘F opens it again with the selected words.
  await window.keyboard.press("ControlOrMeta+F");
  await expect(field).toHaveValue("moon");
  await window.getByTestId("find-close").hover();
  await window.getByTestId("find-close").click();
  await expect(bar).toHaveCount(0);

  // A selection the User makes still opens it.
  await slideSelect(window, editor.locator("p").nth(1), "Tides");
  await expect(menu).toBeVisible();
});

test("find in the Mind works while an Answer streams into the assistant, and counts the text written meanwhile", async () => {
  const running = await launchApp(dataDir, { fakeChat: true });
  const { window } = running;
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(running.app, window, 1280, 700);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor);
  await window.keyboard.type("Tides follow the Moon, and tides are strongest at new moon.");
  await window.keyboard.press("ControlOrMeta+J");
  await window.keyboard.type("What are tides?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "streaming");

  await window.keyboard.press("ControlOrMeta+F");
  await window.keyboard.type("tides");
  const count = window.getByTestId("find-count");
  await expect(count).toHaveText("1 of 2");
  // Writing in the Mind meanwhile is counted as it is written.
  await window.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await afterEditorFocus(window);
  await window.keyboard.press("End");
  await window.keyboard.type(" Tides again.");
  await window.keyboard.press("ControlOrMeta+F");
  await window.keyboard.type("tides");
  await expect(count).toHaveText("1 of 3");
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  // The Answer finishing changes nothing in the Mind, and the current match stays.
  await expect(count).toHaveText("1 of 3");
  await window.keyboard.press("Enter");
  await expect(count).toHaveText("2 of 3");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("find-bar")).toHaveCount(0);
});

test('"@" in a Note puts in a Document chip that opens the viewer, by mouse or keyboard, survives a restart, and shows when its Document is deleted', async () => {
  const sources = await realpath(await createDataFolder());
  try {
    await writeFile(join(sources, "Tides.txt"), "Spring tides happen at new moon.");
    await writeFile(join(sources, "Moons.txt"), "The Moon orbits the Earth.");
    const first = await launchApp(dataDir);
    const { app, window } = first;
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1280, 700);
    await addDocuments(window, [join(sources, "Tides.txt"), join(sources, "Moons.txt")]);
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor);

    // "@" offers Documents only, filtered by what follows it; Enter puts the chip in.
    await window.keyboard.type("See @");
    const picker = window.getByTestId("scope-picker");
    await expect(picker.getByTestId("scope-choice")).toHaveCount(2);
    await expect(picker.locator('[data-kind="folder"], [data-kind="tag"]')).toHaveCount(0);
    await window.keyboard.type("tid");
    await expect(picker.getByTestId("scope-choice")).toHaveCount(1);
    await window.keyboard.press("Enter");
    const chips = editor.getByTestId("document-chip");
    await expect(chips).toHaveCount(1);
    await expect(chips).toHaveText("Tides");
    await expect(picker).toHaveCount(0);
    // Writing goes on after it, and a second one is chosen by mouse.
    await window.keyboard.type("and @");
    const moons = window.getByTestId("scope-choice").filter({ hasText: "Moons" });
    await moons.hover();
    await moons.click();
    await expect(chips).toHaveText(["Tides", "Moons"]);
    await window.keyboard.type("today");
    await expect(editor.locator("p").first()).toContainText("See Tides and Moons today");

    // By mouse: the chip opens its Document in the viewer.
    await chips.first().hover();
    await chips.first().click();
    await expect(window.getByTestId("viewer-title")).toHaveText("Tides");

    // By keyboard: back in the Mind, an arrow selects the chip and Enter opens its Document.
    const mindTab = window.getByTestId("mind-tab");
    await expect(mindTab.getByTestId("tab-title")).toHaveText("See Tides and Moons today");
    await mindTab.click();
    await expect(chips).toHaveCount(2);
    await pointAndClick(window, editor.locator("p").first());
    await expect(editor).toBeFocused();
    await window.keyboard.press("End");
    // One key at a time, each read by the editor before the next, until the chip is selected.
    const selected = editor.locator(".ProseMirror-selectednode");
    for (let step = 0; step < 10 && (await selected.count()) === 0; step++) {
      await window.keyboard.press("ArrowLeft");
      await window.evaluate(
        () =>
          new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done(null))),
          ),
      );
    }
    await expect(editor.locator(".ProseMirror-selectednode")).toHaveText("Moons");
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("viewer-title")).toHaveText("Moons");
    // Enter opened it rather than splitting the line.
    await mindTab.click();
    await expect(editor.locator("p")).toHaveCount(1);

    // After a restart the chips are there, and still open.
    await first.app.close();
    const second = await launchApp(dataDir);
    await second.window.getByTestId("mind-list-item").click();
    const reopened = second.window.getByTestId("mind-editor").getByTestId("document-chip");
    await expect(reopened).toHaveText(["Tides", "Moons"]);
    await reopened.nth(1).hover();
    await reopened.nth(1).click();
    await expect(second.window.getByTestId("viewer-title")).toHaveText("Moons");

    // A Document deleted leaves its chip, with the name it had, marked.
    await second.window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const gone = (await bridge.listDocuments()).find((each) => each.name === "Moons");
      if (gone) await bridge.deleteDocument(gone.id);
    });
    await second.window.getByTestId("mind-tab").click();
    const missing = second.window.getByTestId("mind-editor").getByTestId("document-chip").nth(1);
    await expect(missing).toHaveAttribute("data-missing", "true");
    await expect(missing).toHaveText("Moons");
  } finally {
    await removeDataFolder(sources);
  }
});

test("a Document dragged from the sidebar onto the composer joins the Question's scope, once", async () => {
  const sources = await realpath(await createDataFolder());
  try {
    await writeFile(join(sources, "Tides.txt"), "Spring tides happen at new moon.");
    await writeFile(join(sources, "Moons.txt"), "The Moon orbits the Earth.");
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1280, 760);
    await addDocuments(window, [join(sources, "Tides.txt"), join(sources, "Moons.txt")]);
    await newMind(window);
    const composer = window.getByTestId("composer");
    const chips = composer.getByTestId("scope-chip");
    const before = await chips.count();
    const row = window.getByTestId("open-document").filter({ hasText: "Tides" });
    const drag = async (lights: boolean) => {
      const from = await row.boundingBox();
      const to = await composer.boundingBox();
      if (!from || !to) throw new Error("Not laid out.");
      await window.mouse.move(from.x + 20, from.y + from.height / 2, { steps: 6 });
      await window.mouse.down();
      // A few pixels first, so the browser starts the drag, then across to the composer.
      await window.mouse.move(from.x + 30, from.y + from.height / 2 + 6, { steps: 3 });
      await window.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
      await window.mouse.move(to.x + to.width / 2 + 4, to.y + to.height / 2 + 2, { steps: 3 });
      // The composer shows it takes it while the Document is over it, and never when it would add nothing.
      if (lights) await expect(composer).toHaveAttribute("data-dropping", "true");
      else await expect(composer).not.toHaveAttribute("data-dropping", "true");
      await window.mouse.up();
      await expect(composer).not.toHaveAttribute("data-dropping", "true");
    };
    await drag(true);
    await expect(chips).toHaveCount(before + 1);
    await expect(chips.filter({ hasText: "Tides" })).toHaveCount(1);
    // The same Document again: already in the scope, so the composer doesn't light, and nothing is added.
    await drag(false);
    await expect(chips).toHaveCount(before + 1);
  } finally {
    await removeDataFolder(sources);
  }
});
