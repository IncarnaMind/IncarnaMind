/**
 * Formatting (#912) in the built app, with a slid mouse and the keys: each of the selection menu's
 * Aa controls on a selection and on the caret's paragraph, each taken back by one Undo; Word's
 * keys and ⌘K; and the Mind's line spacing in Style. English at 1,600 px, Chinese at 1,100 px.
 */
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  tabMenu,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

const WINDOW_HEIGHT = 760;
const MAC = process.platform === "darwin";
/** A point of a Mind's formatting at the default text size: its 16px writing is 11 pt. */
const POINT = 16 / 11;

const LINES = [
  "Spring tides come at new moon and full moon.",
  "Neap tides come at the quarter moons, when the pull is weakest.",
  "大潮在新月和满月时出现，小潮在上弦和下弦时出现。",
] as const;
const WORDS = "the quarter moons";

const SETTINGS = [
  { language: "en", width: 1600, lineChanged: "Line spacing changed to 1.5" },
  { language: "zh-CN", width: 1100, lineChanged: "行距已改为“1.5”" },
] as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function writtenMind(language: "en" | "zh-CN", width: number) {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, WINDOW_HEIGHT);
  await newMind(window);
  await enterContent(window);
  for (const [index, line] of LINES.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  const editor = window.getByTestId("mind-editor");
  const lines = [0, 1, 2].map((index) => editor.locator("p").nth(index));
  await expect(lines[2] as Locator).toHaveText(LINES[2]);
  return { app, window, editor, lines: lines as [Locator, Locator, Locator] };
}

interface Drawn {
  html: string;
  align: string;
  left: number;
  indent: number;
  leading: number;
  top: number;
  bottom: number;
}

const drawn = (line: Locator): Promise<Drawn> =>
  line.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    // Which Block has the focus isn't formatting.
    const copy = element.cloneNode(true) as Element;
    copy.classList.remove("has-focus");
    if (copy.getAttribute("class") === "") copy.removeAttribute("class");
    return {
      html: copy.outerHTML,
      align: style.textAlign,
      left: box.left,
      indent: Number.parseFloat(style.textIndent),
      leading: Number.parseFloat(style.lineHeight),
      top: box.top,
      bottom: box.bottom,
    };
  });

const allDrawn = (lines: readonly Locator[]) => Promise.all(lines.map(drawn));

/** A control of the Aa menu, and what it changes on the middle paragraph, as drawn. */
interface Control {
  name: string;
  choose(window: Page, menu: Locator): Promise<void>;
  changed(before: Drawn[], after: Drawn[], middle: Locator): Promise<void>;
}

const near = (value: number, expected: number) =>
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(1);

const click = (window: Page, target: Locator) => pointAndClick(window, target);

/** Clicks into a line, and waits until the editor has the caret there, not only the page. */
async function caretIn(window: Page, line: Locator): Promise<void> {
  await click(window, line);
  await expect(line).toHaveClass(/has-focus/);
}

async function inSpacing(window: Page, menu: Locator, id: string): Promise<void> {
  await click(window, menu.getByTestId("format-line-spacing"));
  const spacing = window.getByTestId("format-line-spacing-menu");
  await expect(spacing).toBeVisible();
  await click(window, spacing.getByTestId(id));
}

const CONTROLS: readonly Control[] = [
  {
    name: "center",
    choose: (window, menu) => click(window, menu.getByTestId("format-align-center")),
    async changed(before, after) {
      expect(after[1]?.align).toBe("center");
      expect(after[0]?.align).toBe(before[0]?.align);
    },
  },
  {
    name: "justify",
    choose: (window, menu) => click(window, menu.getByTestId("format-align-justify")),
    async changed(_before, after) {
      expect(after[1]?.align).toBe("justify");
    },
  },
  {
    name: "line spacing 1.5",
    choose: (window, menu) => inSpacing(window, menu, "format-line-spacing-1.5"),
    async changed(_before, after) {
      near(after[1]?.leading ?? 0, 16 * 1.15 * 1.5);
    },
  },
  {
    name: "add space before",
    choose: (window, menu) => inSpacing(window, menu, "format-space-before"),
    async changed(before, after) {
      const gap = (lines: Drawn[]) => (lines[1]?.top ?? 0) - (lines[0]?.bottom ?? 0);
      near(gap(after), gap(before) + 12 * POINT);
    },
  },
  {
    name: "remove space after",
    choose: (window, menu) => inSpacing(window, menu, "format-space-after"),
    async changed(_before, after) {
      near((after[2]?.top ?? 0) - (after[1]?.bottom ?? 0), 0);
    },
  },
  {
    name: "increase indent",
    choose: (window, menu) => click(window, menu.getByTestId("format-indent-increase")),
    async changed(before, after) {
      near((after[1]?.left ?? 0) - (before[1]?.left ?? 0), 36 * POINT);
      expect(after[0]?.left).toBe(before[0]?.left);
    },
  },
  {
    name: "first-line indent of 2 characters",
    choose: (window, menu) => click(window, menu.getByTestId("format-first-line")),
    async changed(_before, after) {
      near(after[1]?.indent ?? 0, 32);
    },
  },
  {
    name: "text color",
    choose: (window, menu) => click(window, menu.getByTestId("format-color-red")),
    async changed(_before, _after, middle) {
      await expect(middle.locator('[data-text-color="B42318"]').first()).toHaveCSS(
        "color",
        "rgb(180, 35, 24)",
      );
    },
  },
  {
    name: "superscript",
    choose: (window, menu) => click(window, menu.getByTestId("format-superscript")),
    async changed(_before, _after, middle) {
      await expect(middle.locator("sup")).not.toHaveCount(0);
    },
  },
  {
    name: "subscript",
    choose: (window, menu) => click(window, menu.getByTestId("format-subscript")),
    async changed(_before, _after, middle) {
      await expect(middle.locator("sub")).not.toHaveCount(0);
    },
  },
  {
    name: "font",
    async choose(window, menu) {
      await click(window, menu.getByTestId("format-font"));
      await click(window, window.getByTestId("format-fonts-serif"));
    },
    async changed(_before, _after, middle) {
      const family = await middle
        .locator('[data-text-font="Source Serif 4"]')
        .first()
        .evaluate((element) => getComputedStyle(element).fontFamily);
      expect(family).toMatch(/Source Serif 4/);
    },
  },
  {
    name: "size",
    async choose(window, menu) {
      await click(window, menu.getByTestId("format-size"));
      await click(window, window.getByTestId("format-sizes-18"));
    },
    async changed(_before, _after, middle) {
      const size = await middle
        .locator('[data-text-size="18"]')
        .first()
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
      near(size, 18 * POINT);
    },
  },
];

/** The Aa menu holds inside the window, with its rows inside it. */
async function fitsWindow(menu: Locator, width: number): Promise<void> {
  const box = await menu.boundingBox();
  if (!box) throw new Error("The Aa menu isn't showing.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(WINDOW_HEIGHT);
  for (const row of await menu.locator('[role^="menuitem"]').all()) {
    const each = await row.boundingBox();
    if (!each) continue;
    expect(each.x).toBeGreaterThanOrEqual(box.x);
    expect(each.x + each.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
}

for (const { language, width } of SETTINGS) {
  test(`Aa: each control on a selection, each taken back by one Undo (${language}, ${width} px)`, async () => {
    test.setTimeout(150_000);
    const { window, editor, lines } = await writtenMind(language, width);
    const selectionMenu = window.getByTestId("selection-menu");
    const menu = window.getByTestId("format-menu");
    for (const [index, control] of CONTROLS.entries()) {
      // A menu closed over a selection stays closed until the selection changes; the line above isn't under it.
      await click(window, lines[0]);
      await slideSelect(window, lines[1], WORDS);
      await expect(selectionMenu).toBeVisible();
      await click(window, selectionMenu.getByTestId("format-aa"));
      await expect(menu).toBeVisible();
      await motionSettled(window);
      if (index === 0) {
        await fitsWindow(menu, width);
        await screenshot(window, `aa-${language}-${width}`);
      }
      const before = await allDrawn(lines);
      await control.choose(window, menu);
      await expect
        .poll(async () => (await drawn(lines[1])).html, { message: control.name })
        .not.toBe(before[1]?.html);
      await control.changed(before, await allDrawn(lines), lines[1]);
      // The selection stays in the text, so ⌘Z is the text's own Undo.
      await expect(editor).toBeFocused();
      await window.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => (await allDrawn(lines)).map((each) => each.html), {
          message: `${control.name}, undone`,
        })
        .toEqual(before.map((each) => each.html));
      await window.keyboard.press("Escape");
    }

    // Several choices in one go, the menu staying open, each its own Undo step.
    await click(window, lines[0]);
    await slideSelect(window, lines[1], WORDS);
    await click(window, selectionMenu.getByTestId("format-aa"));
    const before = await allDrawn(lines);
    await expect(menu).toBeVisible();
    await motionSettled(window);
    await click(window, menu.getByTestId("format-align-right"));
    await expect.poll(async () => (await drawn(lines[1])).align).toBe("right");
    await click(window, menu.getByTestId("format-color-blue"));
    await expect(lines[1].locator('[data-text-color="1D4ED8"]')).not.toHaveCount(0);
    await inSpacing(window, menu, "format-line-spacing-2");
    await expect
      .poll(async () => Math.abs((await drawn(lines[1])).leading - 16 * 1.15 * 2) <= 1)
      .toBe(true);
    expect((await drawn(lines[1])).align).toBe("right");
    await expect(lines[1].locator('[data-text-color="1D4ED8"]')).not.toHaveCount(0);
    for (let step = 0; step < 3; step++) await window.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await allDrawn(lines)).map((each) => each.html))
      .toEqual(before.map((each) => each.html));
  });

  test(`Aa from ⌘K: each control on the caret's paragraph, each taken back by one Undo (${language}, ${width} px)`, async () => {
    test.setTimeout(150_000);
    const { window, editor, lines } = await writtenMind(language, width);
    const menu = window.getByTestId("format-menu");
    for (const [index, control] of CONTROLS.entries()) {
      await caretIn(window, lines[1]);
      await window.keyboard.press("ControlOrMeta+K");
      const palette = window.getByTestId("palette");
      await expect(palette).toBeVisible();
      await window.getByTestId("palette-search").fill(language === "en" ? "Format" : "格式");
      await click(window, palette.locator('[data-key="command:format.open"]'));
      await expect(menu).toBeVisible();
      await motionSettled(window);
      if (index === 0) {
        await fitsWindow(menu, width);
        await screenshot(window, `aa-caret-${language}-${width}`);
      }
      const before = await allDrawn(lines);
      await control.choose(window, menu);
      await expect
        .poll(async () => (await drawn(lines[1])).html, { message: control.name })
        .not.toBe(before[1]?.html);
      await control.changed(before, await allDrawn(lines), lines[1]);
      expect((await drawn(lines[0])).html).toBe(before[0]?.html);
      // Esc closes the menu and gives the focus back to the text, where ⌘Z takes the change back.
      await window.keyboard.press("Escape");
      if (await menu.isVisible()) await window.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(editor).toBeFocused();
      await window.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => (await allDrawn(lines)).map((each) => each.html), {
          message: `${control.name}, undone`,
        })
        .toEqual(before.map((each) => each.html));
    }
  });
}

test("Word's keys align and indent the caret's paragraph, each with one Undo, and ⌘K shows them", async () => {
  test.setTimeout(120_000);
  const { window, editor, lines } = await writtenMind("en", 1600);
  await caretIn(window, lines[1]);
  const keys: [string, (after: Drawn, before: Drawn) => void][] = [
    ["ControlOrMeta+R", (after) => expect(after.align).toBe("right")],
    ["ControlOrMeta+Shift+J", (after) => expect(after.align).toBe("justify")],
    ["ControlOrMeta+BracketRight", (after, before) => near(after.left - before.left, 36 * POINT)],
  ];
  for (const [key, check] of keys) {
    const before = await allDrawn(lines);
    await window.keyboard.press(key);
    await expect
      .poll(async () => (await drawn(lines[1])).html, { message: key })
      .not.toBe(before[1]?.html);
    check(await drawn(lines[1]), before[1] as Drawn);
    expect((await drawn(lines[0])).html).toBe(before[0]?.html);
    await window.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await allDrawn(lines)).map((each) => each.html), {
        message: `${key}, undone`,
      })
      .toEqual(before.map((each) => each.html));
  }
  // ⌘R, then ⌘L: left again, as the User set it; ⌘], then ⌘[: back to the edge.
  const plain = await drawn(lines[1]);
  await window.keyboard.press("ControlOrMeta+R");
  await window.keyboard.press("ControlOrMeta+L");
  await expect.poll(async () => (await drawn(lines[1])).align).toBe("left");
  await window.keyboard.press("ControlOrMeta+BracketRight");
  await expect.poll(async () => (await drawn(lines[1])).left).toBeGreaterThan(plain.left);
  await window.keyboard.press("ControlOrMeta+BracketLeft");
  await expect.poll(async () => (await drawn(lines[1])).left).toBe(plain.left);
  // ⌘E is still inline code's.
  await slideSelect(window, lines[0], "full moon");
  await window.keyboard.press("ControlOrMeta+E");
  await expect(lines[0].locator("code")).toHaveText("full moon");
  await expect(editor).toBeFocused();

  // ⌘K lists each command with its keys (on selected text, ⌘K is a link's).
  await window.keyboard.press("Escape");
  await caretIn(window, lines[2]);
  await window.keyboard.press("ControlOrMeta+K");
  const palette = window.getByTestId("palette");
  for (const [words, id, shown] of [
    ["Align right", "format.alignRight", MAC ? "⌘R" : "Ctrl+R"],
    ["Align left", "format.alignLeft", MAC ? "⌘L" : "Ctrl+L"],
    ["Justify", "format.justify", MAC ? "⇧⌘J" : "Ctrl+Shift+J"],
    ["Increase indent", "format.indent", MAC ? "⌘]" : "Ctrl+]"],
    ["Decrease indent", "format.outdent", MAC ? "⌘[" : "Ctrl+["],
    ["Superscript", "format.superscript", null],
  ] as const) {
    await window.getByTestId("palette-search").fill(words);
    const item = palette.locator(`[data-key="command:${id}"]`);
    await expect(item).toBeVisible();
    if (shown) await expect(item).toContainText(shown);
  }
  await window.keyboard.press("Escape");
});

for (const { language, width, lineChanged } of SETTINGS) {
  test(`Style's line spacing: the whole Mind at once, with Undo, Custom…, and as the default for new Minds (${language}, ${width} px)`, async () => {
    test.setTimeout(120_000);
    const { window, editor, lines } = await writtenMind(language, width);
    const openStyle = async () => {
      const menu = await tabMenu(window);
      await pointAndClick(window, menu.getByTestId("mind.style"));
      const panel = window.getByTestId("mind-style");
      await expect(panel).toBeVisible();
      await motionSettled(window);
      return panel;
    };
    near((await drawn(lines[0])).leading, 26);
    let panel = await openStyle();
    await screenshot(window, `style-line-${language}-${width}`);
    const panelBox = await panel.boundingBox();
    if (!panelBox) throw new Error("Style isn't showing.");
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(WINDOW_HEIGHT);
    // Between Text size and the default for new Minds.
    const size = await panel.getByTestId("mind-style-size-default").boundingBox();
    const single = await panel.getByTestId("mind-style-line-1").boundingBox();
    const makeDefault = await panel.getByTestId("mind-style-make-default").boundingBox();
    if (!size || !single || !makeDefault) throw new Error("Style's rows aren't showing.");
    expect(size.y + size.height).toBeLessThanOrEqual(single.y);
    expect(single.y + single.height).toBeLessThanOrEqual(makeDefault.y);
    await expect(panel.getByTestId("mind-style-line-default")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await pointAndClick(window, panel.getByTestId("mind-style-line-1.5"));
    await expect
      .poll(async () => (await drawn(lines[2])).leading)
      .toBe(Math.round(16 * 1.15 * 1.5));
    await expect(window.getByText(lineChanged)).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await drawn(lines[2])).leading).toBe(26);

    // Custom…: a multiple typed, out of range said where it is typed.
    panel = await openStyle();
    await pointAndClick(window, panel.getByTestId("mind-style-line-custom"));
    const field = window.getByTestId("format-line-spacing-field");
    await expect(field).toBeVisible();
    const input = field.locator("input");
    await input.fill("9");
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("1.25");
    await input.press("Enter");
    await expect(field).toHaveCount(0);
    await expect
      .poll(async () => (await drawn(lines[0])).leading)
      .toBe(Math.round(16 * 1.15 * 1.25));

    // Double, made the default for new Minds.
    panel = await openStyle();
    await expect(panel.getByTestId("mind-style-line-custom")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await pointAndClick(window, panel.getByTestId("mind-style-line-2"));
    await expect.poll(async () => (await drawn(lines[0])).leading).toBe(Math.round(16 * 1.15 * 2));
    await pointAndClick(window, panel.getByTestId("mind-style-make-default"));
    await newMind(window);
    await enterContent(window);
    await window.keyboard.type("A new Mind.");
    await expect
      .poll(async () => (await drawn(editor.locator("p").first())).leading)
      .toBe(Math.round(16 * 1.15 * 2));
  });
}
