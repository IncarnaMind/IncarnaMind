import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  motionSettled,
  newMind,
  openBlockMenuFor,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  wordsBox,
} from "./app";

/*
 * Numbered lists' schemes (#1419; DESIGN.md › Lists › Numbering styles) in the built app: the four
 * schemes at every level from Aa › Numbering, their markers right-aligned 8px before the text at
 * Word's indents; a typed first marker beginning a list and ⌘Z putting it back; Tab and Shift-Tab,
 * one ⌘Z each; a list item's right-click menu and ⌘K reaching Numbering ›, Restart at 1 and
 * Continue numbering; a wide marker moving its text by 12px; markers neither copied nor found.
 * English at 1,600 px, Chinese at 900 px.
 */
const UNDO = "ControlOrMeta+z";
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
// macOS Chinese says 拷贝 where Windows and Linux say 复制 (docs/agents/zh-CN.md, rule 14).
const COPY_ZH = process.platform === "darwin" ? /^拷贝/ : /^复制/;

const SETTINGS = [
  { language: "en", width: 1600, items: ["Rent", "Deposit", "Repairs", "Insurance"] },
  { language: "zh-CN", width: 900, items: ["租金", "押金", "维修", "保险"] },
] as const;

const SCHEMES = [
  ["outline", ["1.", "1.1.", "1.1.1.", "1.1.1.1."]],
  ["clauses", ["(a)", "(i)", "(A)", "(A)"]],
  ["chinese", ["一、", "（一）", "1.", "（1）"]],
  ["default", ["1.", "a.", "i.", "i."]],
] as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function openMind(language: "en" | "zh-CN", width: number) {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 760);
  await newMind(window);
  await enterContent(window);
  const editor = window.getByTestId("mind-editor");
  await window.keyboard.type(language === "en" ? "Terms of the lease." : "租约条款。");
  await window.keyboard.press("Enter");
  return { app, window, editor };
}

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const items = (editor: Locator) => editor.locator("ol li");
const itemText = (item: Locator) => item.locator(":scope > p").first();

const drawn = (item: Locator) =>
  item.evaluate((li) => {
    const text = li.querySelector(":scope > p") as HTMLElement;
    const before = getComputedStyle(text, "::before");
    const box = li.getBoundingClientRect();
    // The number sits where its own `left` puts it, measured in its containing block (the item).
    const markerLeft = box.left + Number.parseFloat(before.left);
    return {
      marker: before.content === "none" ? "" : (JSON.parse(before.content) as string),
      markerLeft,
      markerRight: markerLeft + Number.parseFloat(before.width),
      textLeft: text.getBoundingClientRect().left,
    };
  });

/** The room a list keeps for its markers, from its widest one, shared by every item of the list. */
const roomOf = (item: Locator) =>
  item.evaluate((li) => {
    const value = Number.parseFloat(getComputedStyle(li).getPropertyValue("--marker-room"));
    return Number.isFinite(value) ? value : 0;
  });

const markers = async (editor: Locator) =>
  Promise.all((await items(editor).all()).map(async (item) => (await drawn(item)).marker));

const edge = (editor: Locator) =>
  editor
    .locator(":scope > p")
    .first()
    .evaluate((p) => p.getBoundingClientRect().left);

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't visible.");
  return found;
}

const near = (value: number, expected: number, what: string) =>
  expect(Math.abs(value - expected), `${what}: ${value} is not ${expected}`).toBeLessThanOrEqual(1);

async function rightClickWords(window: Page, line: Locator, words: string): Promise<void> {
  const box = await wordsBox(line, words);
  const x = (box.left + box.right) / 2;
  await window.mouse.move(x, box.y, { steps: 8 });
  await window.mouse.click(x, box.y, { button: "right" });
}

async function aaNumbering(window: Page, line: Locator, words: string): Promise<Locator> {
  // A menu closed over a selection stays closed until the selection changes: start from elsewhere.
  await pointAndClick(window, window.getByTestId("mind-editor").locator(":scope > p").first());
  await slideSelect(window, line, words);
  const selectionMenu = window.getByTestId("selection-menu");
  await expect(selectionMenu).toBeVisible();
  await pointAndClick(window, selectionMenu.getByTestId("format-aa"));
  const format = window.getByTestId("format-menu");
  await expect(format).toBeVisible();
  await motionSettled(window);
  await pointAndClick(window, format.getByTestId("format-numbering"));
  const menu = window.getByTestId("numbering-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function fourLevels(window: Page, words: readonly string[]): Promise<void> {
  await window.keyboard.type("1. ");
  for (const [index, word] of words.entries()) {
    if (index > 0) {
      await window.keyboard.press("Enter");
      await window.keyboard.press("Tab");
    }
    await window.keyboard.type(word);
  }
}

for (const { language, width, items: words } of SETTINGS) {
  test(`Aa › Numbering draws each scheme at every level, each marker at the marker room's left edge at Word's indents, one ⌘Z each (${language}, ${width} px)`, async () => {
    test.setTimeout(120_000);
    const { app, window, editor } = await openMind(language, width);
    await fourLevels(window, words);
    await expect(items(editor)).toHaveCount(4);
    const left = await edge(editor);
    expect(await markers(editor)).toEqual(["1.", "a.", "i.", "i."]);

    let before: readonly string[] = ["1.", "a.", "i.", "i."];
    for (const [scheme, expected] of SCHEMES) {
      const menu = await aaNumbering(window, itemText(items(editor).nth(2)), words[2]);
      await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveCount(1);
      if (scheme === "outline") {
        await motionSettled(window);
        await screenshot(window, `numbering-menu-${language}-${width}`);
      }
      await pointAndClick(window, menu.getByTestId(`numbering-${scheme}`));
      await expect(menu).toBeHidden();
      await expect.poll(() => markers(editor), { message: scheme }).toEqual([...expected]);
      for (const [level, item] of (await items(editor).all()).entries()) {
        const at = await drawn(item);
        near(
          at.textLeft - left,
          48 * (level + 1) + (await roomOf(item)),
          `${scheme} level ${level + 1}'s text`,
        );
        near(at.markerLeft - left, 24 + 48 * level, `${scheme} level ${level + 1}'s marker`);
        expect(at.markerLeft, `${scheme}'s marker stays in the Mind`).toBeGreaterThanOrEqual(
          left - 1,
        );
      }
      await screenshot(window, `numbering-${scheme}-${language}-${width}`);
      await expect(editor).toBeFocused();
      await window.keyboard.press(UNDO);
      await expect
        .poll(() => markers(editor), { message: `${scheme}, undone` })
        .toEqual([...before]);
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(() => markers(editor)).toEqual([...expected]);
      before = expected;
    }
    await app.close();
  });

  test(`a typed first marker begins its list and ⌘Z straight after puts it back; Tab and Shift-Tab change the level and the format, one ⌘Z each (${language}, ${width} px)`, async () => {
    const { app, window, editor } = await openMind(language, width);
    const left = await edge(editor);

    await window.keyboard.type("(i) ");
    await expect(items(editor)).toHaveCount(1);
    expect(await markers(editor)).toEqual(["(i)"]);
    near(
      (await drawn(items(editor).first())).textLeft - left,
      96 + (await roomOf(items(editor).first())),
      "a second-level list's text",
    );
    await window.keyboard.press(UNDO);
    await expect(items(editor)).toHaveCount(0);
    await expect(editor.locator(":scope > p").last()).toHaveText("(i) ");
    await window.keyboard.type(words[0]);
    await expect(items(editor)).toHaveCount(0);
    await expect(editor.locator(":scope > p").last()).toHaveText(`(i) ${words[0]}`);
    await window.keyboard.press("Enter");

    await window.keyboard.type(language === "en" ? "(a) " : "一、");
    await window.keyboard.type(words[0]);
    await window.keyboard.press("Enter");
    await window.keyboard.type(words[1]);
    const second = language === "en" ? "(b)" : "二、";
    expect(await markers(editor)).toEqual([language === "en" ? "(a)" : "一、", second]);
    await window.keyboard.press("Tab");
    const nested = language === "en" ? "(i)" : "（一）";
    await expect.poll(() => markers(editor)).toEqual([language === "en" ? "(a)" : "一、", nested]);
    near(
      (await drawn(items(editor).nth(1))).textLeft - left,
      96 + (await roomOf(items(editor).nth(1))),
      "the nested item's text",
    );
    await window.keyboard.press(UNDO);
    await expect.poll(() => markers(editor)).toEqual([language === "en" ? "(a)" : "一、", second]);
    await window.keyboard.press("Tab");
    await window.keyboard.press("Shift+Tab");
    await expect.poll(() => markers(editor)).toEqual([language === "en" ? "(a)" : "一、", second]);

    await clickEndOf(window, itemText(items(editor).first()));
    await expect
      .poll(() =>
        itemText(items(editor).first()).evaluate((p) =>
          p.contains(getSelection()?.anchorNode ?? null),
        ),
      )
      .toBe(true);
    await window.keyboard.press("Tab");
    await expect
      .poll(() => markers(editor))
      .toEqual(language === "en" ? ["(i)", "(a)"] : ["（一）", "一、"]);
    near(
      (await drawn(items(editor).first())).textLeft - left,
      96 + (await roomOf(items(editor).first())),
      "the deeper item's text",
    );
    near(
      (await drawn(items(editor).nth(1))).textLeft - left,
      48 + (await roomOf(items(editor).nth(1))),
      "the next item's text",
    );
    await expect(editor).toBeFocused();
    await window.keyboard.press("Shift+Tab");
    await expect.poll(() => markers(editor)).toEqual([language === "en" ? "(a)" : "一、", second]);
    await window.keyboard.press(UNDO);
    await expect
      .poll(() => markers(editor))
      .toEqual(language === "en" ? ["(i)", "(a)"] : ["（一）", "一、"]);
    await window.keyboard.press(UNDO);
    await expect.poll(() => markers(editor)).toEqual([language === "en" ? "(a)" : "一、", second]);
    await screenshot(window, `numbering-typed-${language}-${width}`);
    await app.close();
  });

  test(`a list item's right-click menu and ⌘K reach Numbering ›, Restart at 1 and Continue numbering; markers aren't copied or found (${language}, ${width} px)`, async () => {
    test.setTimeout(120_000);
    const { app, window, editor } = await openMind(language, width);
    await window.keyboard.type(`1. ${words[0]}`);
    await window.keyboard.press("Enter");
    await window.keyboard.type(words[1]);
    await window.keyboard.press("Enter");
    await window.keyboard.press("Enter");
    await window.keyboard.type(language === "en" ? "Between the lists." : "两个列表之间。");
    await window.keyboard.press("Enter");
    await window.keyboard.type(`1. ${words[2]}`);
    await window.keyboard.press("Enter");
    await window.keyboard.type(words[3]);
    await expect.poll(() => markers(editor)).toEqual(["1.", "2.", "1.", "2."]);

    await pointAndClick(window, itemText(items(editor).nth(2)), { button: "right" });
    const menu = window.getByTestId("list-item-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(
      language === "en"
        ? [/^Cut/, /^Copy/, /^Paste/, "Numbering", "Restart at 1", "Continue numbering"]
        : [/^剪切/, COPY_ZH, /^粘贴/, "编号", "重新从 1 开始", "继续编号"],
    );
    await expect(menu.getByTestId("list-item-cut")).toHaveAttribute("aria-disabled", "true");
    await expect(menu.getByTestId("numbering-restart")).toHaveAttribute("aria-disabled", "true");
    await screenshot(window, `numbering-right-click-${language}-${width}`);

    await window.getByTestId("list-item-numbering").focus();
    await window.keyboard.press("ArrowRight");
    const submenu = window.getByTestId("numbering-menu");
    await expect(submenu).toBeVisible();
    await expect(submenu.getByTestId("numbering-default")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(submenu.getByTestId("numbering-outline")).toBeFocused();
    await window.keyboard.press("ArrowLeft");
    await expect(submenu).toBeHidden();
    await expect(window.getByTestId("list-item-numbering")).toBeFocused();

    await pointAndClick(window, menu.getByTestId("numbering-continue"));
    await expect(menu).toBeHidden();
    await expect.poll(() => markers(editor)).toEqual(["1.", "2.", "3.", "4."]);
    await expect(editor).toBeFocused();

    // ⌘K "Numbering…" opens the same menu under the paragraph.
    await window.keyboard.press("ControlOrMeta+K");
    await window.getByTestId("palette-search").fill(language === "en" ? "Numbering" : "编号");
    await pointAndClick(
      window,
      window.getByTestId("palette").locator('[data-key="command:format.numbering"]'),
    );
    const numbering = window.getByTestId("numbering-menu");
    await expect(numbering).toBeVisible();
    const under = await itemText(items(editor).nth(2)).boundingBox();
    const opened = await numbering.boundingBox();
    expect(opened && under && opened.y >= under.y + under.height - 1).toBe(true);
    await expect(numbering.getByTestId("numbering-continue")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await pointAndClick(window, numbering.getByTestId("numbering-restart"));
    await expect.poll(() => markers(editor)).toEqual(["1.", "2.", "1.", "2."]);

    // Numbering › in the right-click menu: the whole list takes the scheme, the list above keeps its own.
    await pointAndClick(window, itemText(items(editor).nth(3)), { button: "right" });
    await pointAndClick(window, menu.getByTestId("list-item-numbering"));
    const schemes = window.getByTestId("numbering-menu");
    await expect(schemes).toBeVisible();
    await expect(schemes.getByTestId("numbering-restart")).toHaveCount(0);
    await pointAndClick(window, schemes.getByTestId("numbering-clauses"));
    await expect.poll(() => markers(editor)).toEqual(["1.", "2.", "(a)", "(b)"]);
    await window.keyboard.press(UNDO);
    await expect.poll(() => markers(editor)).toEqual(["1.", "2.", "1.", "2."]);
    await window.keyboard.press("ControlOrMeta+Shift+z");

    // Cut, Copy and Paste in the menu do what the Edit menu's do, where the right-click was.
    await slideSelect(window, itemText(items(editor).nth(3)), words[3]);
    // In a short card the selection menu can cover the words: Esc puts it away, keeping them selected.
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("selection-menu")).toBeHidden();
    await rightClickWords(window, itemText(items(editor).nth(3)), words[3]);
    await expect(menu).toBeVisible();
    await pointAndClick(window, menu.getByTestId("list-item-copy"));
    await expect(menu).toBeHidden();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(words[3]);
    await rightClickWords(window, itemText(items(editor).nth(3)), words[3]);
    await pointAndClick(window, menu.getByTestId("list-item-cut"));
    await expect(itemText(items(editor).nth(3))).toHaveText("");
    await rightClickWords(window, itemText(items(editor).nth(1)), words[1]);
    await expect(menu.getByTestId("list-item-cut")).toHaveAttribute("aria-disabled", "true");
    await pointAndClick(window, menu.getByTestId("list-item-paste"));
    await expect(itemText(items(editor).nth(1))).toContainText(words[3]);
    await window.keyboard.press(UNDO);
    await expect(itemText(items(editor).nth(1))).toHaveText(words[1]);
    await window.keyboard.press(UNDO);
    await expect(itemText(items(editor).nth(3))).toHaveText(words[3]);

    await slideSelect(window, itemText(items(editor).nth(2)), words[2], {
      line: itemText(items(editor).nth(3)),
      words: words[3],
    });
    const copied = await editor.evaluate((element) => {
      const data = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return { text: data.getData("text/plain"), html: data.getData("text/html") };
    });
    expect(copied.text).toContain(words[2]);
    expect(copied.html).not.toContain("(a)");
    expect(copied.text).not.toContain("(a)");
    await pointAndClick(window, itemText(items(editor).nth(3)));
    await window.keyboard.press("ControlOrMeta+F");
    await window.keyboard.type("(a)");
    await expect(window.getByTestId("find-count")).toHaveClass(/find-count--none/);
    await expect(editor.locator(".find-match")).toHaveCount(0);
    await window.keyboard.press("Escape");

    await slideSelect(window, itemText(items(editor).nth(3)), words[3]);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("selection-menu")).toBeHidden();
    await rightClickWords(window, itemText(items(editor).nth(3)), words[3]);
    await expect(menu).toBeVisible();
    await window.evaluate(() => {
      document.execCommand = () => false;
    });
    await pointAndClick(window, menu.getByTestId("list-item-copy"));
    await expect(menu).toBeHidden();
    await expect(window.getByTestId("error-notice-message")).toContainText(
      language === "en"
        ? "couldn’t put the selection on the clipboard"
        : "未能把所选内容放到剪贴板",
    );
    await app.close();
  });

  test(`one room for the whole list: a wide 十一、 widens it in 12px steps, and the short 一、 gets more space after it (${language}, ${width} px)`, async () => {
    const { app, window, editor } = await openMind(language, width);
    const left = await edge(editor);
    await window.keyboard.type("一、");
    for (let item = 1; item <= 11; item++) {
      if (item > 1) await window.keyboard.press("Enter");
      await window.keyboard.type(`${words[item % words.length]}`);
    }
    await expect(items(editor)).toHaveCount(11);
    const first = await drawn(items(editor).first());
    const eleventh = await drawn(items(editor).nth(10));
    expect(eleventh.marker).toBe("十一、");
    const room = await roomOf(items(editor).first());
    expect(room, "the widest marker widens the list's room").toBeGreaterThan(0);
    expect((eleventh.textLeft - left - 48) % 12).toBeLessThan(1);
    for (const [at, item] of (await items(editor).all()).entries()) {
      const one = await drawn(item);
      near(one.textLeft - left, 48 + room, `item ${at + 1}'s text`);
      near(one.markerLeft - left, 24, `item ${at + 1}'s marker`);
      near(await roomOf(item), room, `item ${at + 1}'s room`);
    }
    // The number starts at the room's left edge: a short marker leaves more space after it.
    expect(first.textLeft - first.markerRight).toBeGreaterThan(
      eleventh.textLeft - eleventh.markerRight,
    );
    expect(eleventh.markerRight).toBeLessThanOrEqual(eleventh.textLeft - 8 + 0.5);
    // The handle stays 4px before the room's left edge, where the number starts.
    await itemText(items(editor).nth(10)).hover();
    const handle = window.getByTestId("block-handle");
    await expect(handle).toBeVisible();
    const handleBox = await handle.boundingBox();
    expect(
      Math.abs(eleventh.markerLeft - 4 - ((handleBox?.x ?? 0) + (handleBox?.width ?? 0))),
    ).toBeLessThanOrEqual(1.5);
    await screenshot(window, `numbering-wide-${language}-${width}`);
    await app.close();
  });
}

test("a Chinese marker written through an input method begins its list when the composition ends, and ⌘Z puts it back (zh-CN, 900 px)", async () => {
  const { app, window, editor } = await openMind("zh-CN", 900);
  const session = await window.context().newCDPSession(window);
  try {
    await session.send("Input.imeSetComposition", {
      text: "yi",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await session.send("Input.insertText", { text: "一、" });
  } finally {
    await session.detach();
  }
  await expect(items(editor)).toHaveCount(1);
  expect(await markers(editor)).toEqual(["一、"]);
  await window.keyboard.press(UNDO);
  await expect(items(editor)).toHaveCount(0);
  await expect(editor.locator(":scope > p").last()).toHaveText("一、");
  await app.close();
});

for (const { language, width } of SETTINGS) {
  test(`one marker room for the whole list: 1 to 12 aligns every item and a Roman (iv) widens its list's room (${language}, ${width} px)`, async () => {
    test.setTimeout(120_000);
    const { app, window, editor } = await openMind(language, width);
    const entry = (text: string) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(
          (dom as unknown as { editor: Editor }).editor.state.doc.content.size,
          content,
        );
      },
      [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: Array.from({ length: 12 }, (_, at) => entry(`Item ${at + 1}`)),
        },
        {
          type: "orderedList",
          attrs: { numbering: "clauses" },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Clauses" }] },
                {
                  type: "orderedList",
                  content: Array.from({ length: 4 }, (_, at) => entry(`Roman ${at + 1}`)),
                },
              ],
            },
          ],
        },
      ],
    );
    const left = await edge(editor);
    const list = editor.locator(":scope > ol").first();
    const listed = list.locator(":scope > li");
    await expect(listed).toHaveCount(12);
    const texts = await Promise.all(
      (await listed.all()).map(async (li) => (await drawn(li)).textLeft),
    );
    const room = await listed.first().evaluate((li) => {
      const value = Number.parseFloat(getComputedStyle(li).getPropertyValue("--marker-room"));
      return Number.isFinite(value) ? value : 0;
    });
    for (const [at, textLeft] of texts.entries()) {
      near(textLeft - left, 48 + room, `item ${at + 1}'s text`);
      near((await drawn(listed.nth(at))).markerLeft - left, 24, `item ${at + 1}'s marker`);
    }
    // The room is one for the whole list, from its widest marker: a short "1." has more space after it.
    const first = await drawn(listed.first());
    const widest = await drawn(listed.nth(11));
    const widestWidth = widest.markerRight - widest.markerLeft;
    // The room is 24px or the widest marker plus the 8px gap, rounded up to a 12px step and no further.
    expect(24 + room).toBeGreaterThanOrEqual(widestWidth + 8 - 0.5);
    expect(24 + room - (widestWidth + 8)).toBeLessThan(12 + 0.5);
    expect(first.markerRight - first.markerLeft).toBeLessThan(
      widest.markerRight - widest.markerLeft,
    );
    expect(first.textLeft - first.markerRight).toBeGreaterThan(
      widest.textLeft - widest.markerRight,
    );

    // The handle stays 4px before the room's left edge, where the number starts.
    const handle = window.getByTestId("block-handle");
    await itemText(listed.nth(11)).hover();
    await expect(handle).toBeVisible();
    const at = await drawn(listed.nth(11));
    const handleBox = (await await handle.boundingBox()) ?? { x: 0, width: 0 };
    expect(Math.abs(at.markerLeft - 4 - (handleBox.x + handleBox.width))).toBeLessThanOrEqual(1.5);

    // The menu opened from the keyboard lands on the same item the pointer's handle stands by.
    await editor.evaluate((dom) => {
      const note = (dom as unknown as { editor: Editor }).editor;
      const items: number[] = [];
      note.state.doc.descendants((node, pos) => {
        if (node.type.name === "listItem") items.push(pos);
        return true;
      });
      const tenth = items[9];
      if (tenth === undefined) throw new Error("No tenth item.");
      note.commands.focus();
      note.commands.setTextSelection(tenth + 2);
    });
    await window.keyboard.press("Shift+F10");
    const menu = window.getByTestId("block-menu");
    await expect(menu).toBeVisible();
    const [menuBox, item10, item1] = [
      await box(menu),
      await box(listed.nth(9)),
      await box(listed.first()),
    ];
    expect(
      Math.abs(menuBox.y - item10.y),
      "the keyboard menu opens by item 10, not the list's first item",
    ).toBeLessThan(Math.abs(menuBox.y - item1.y));
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // A clauses list's second level numbers in Roman: "(iv)" widens its own list's room, alone.
    const clauses = editor.locator(":scope > ol").nth(1);
    const roman = clauses.locator("ol > li");
    await expect(roman).toHaveCount(4);
    const romanRoom = await roman.first().evaluate((li) => {
      const value = Number.parseFloat(getComputedStyle(li).getPropertyValue("--marker-room"));
      return Number.isFinite(value) ? value : 0;
    });
    expect(romanRoom, "the Roman markers widen their list's room").toBeGreaterThan(0);
    const romanTexts = await Promise.all(
      (await roman.all()).map(async (li) => (await drawn(li)).textLeft),
    );
    for (const [index, textLeft] of romanTexts.entries()) {
      near(textLeft - left, 96 + romanRoom, `Roman item ${index + 1}'s text`);
      near(
        (await drawn(roman.nth(index))).markerLeft - left,
        72,
        `Roman item ${index + 1}'s marker`,
      );
    }

    // A command can name another Block while the caret is in a different list: the menu goes
    // by the named Block's first line, never by the caret's item.
    const named = await editor.evaluate((dom) => {
      const note = (dom as unknown as { editor: Editor }).editor;
      let id: string | null = null;
      note.state.doc.forEach((node) => {
        const found: unknown = node.attrs.id;
        if (id === null && node.type.name === "orderedList" && typeof found === "string") {
          id = found;
        }
      });
      return id;
    });
    if (named === null) throw new Error("The list has no Block ID.");
    await editor.evaluate((dom) => {
      const note = (dom as unknown as { editor: Editor }).editor;
      const items: { pos: number; text: string }[] = [];
      note.state.doc.descendants((node, pos) => {
        if (node.type.name === "listItem") items.push({ pos, text: node.textContent });
        return true;
      });
      const fourth = items.find((item) => item.text === "Roman 4");
      if (!fourth) throw new Error("No fourth Roman item.");
      note.commands.setTextSelection(fourth.pos + 2);
    });
    await openBlockMenuFor(window, named);
    await expect(menu).toBeVisible();
    const [namedMenu, namedFirst, caretItem] = [
      await box(menu),
      await box(listed.first()),
      await box(roman.nth(3)),
    ];
    expect(
      Math.abs(namedMenu.y - namedFirst.y),
      "a command naming another Block anchors at that Block, not at the caret's item in another list",
    ).toBeLessThan(Math.abs(namedMenu.y - caretItem.y));
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await app.close();
  });
}
