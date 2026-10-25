import { expect, test } from "@playwright/test";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  dragBlock,
  fontsDrawing,
  launchApp,
  newMind,
  removeDataFolder,
  slideToHandle,
} from "./app";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a heading and a formula inserted from the slash menu are still there, rendered, after reopening the app", async () => {
  const first = await launchApp(dataDir);
  const { window } = first;
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();

  // "/" opens the slash menu, and Esc closes it.
  const menu = window.getByTestId("slash-menu");
  await window.keyboard.type("/");
  await expect(menu).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await window.keyboard.press("Backspace");

  // The arrows choose an entry and Enter inserts it: Text, then Heading 1.
  await window.keyboard.type("/");
  await expect(window.getByTestId("slash-item-text")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("ArrowDown");
  await expect(window.getByTestId("slash-item-heading-1")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Results");
  const heading = editor.locator("h1");
  await expect(heading).toHaveText("Results");
  const headingId = await heading.getAttribute("data-id");
  expect(headingId).toMatch(UUID);

  // Typing after the slash finds an entry: a math block, whose LaTeX field opens on insert.
  await window.keyboard.press("Enter");
  await window.keyboard.type("/math");
  await expect(window.getByTestId("slash-item-math")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  const latexField = window.getByTestId("math-editor");
  await expect(latexField).toBeFocused();
  await window.keyboard.type("E = mc^2");
  await window.keyboard.press("Enter");
  await expect(latexField).toHaveCount(0);
  const formula = editor.locator('[data-type="block-math"]');
  await expect(formula).toHaveAttribute("data-latex", "E = mc^2");
  await expect(formula.locator(".katex")).toBeVisible();
  await first.app.close();

  // After a restart: the same heading Block, and the formula rendered by KaTeX.
  const second = await launchApp(dataDir);
  await second.window.getByTestId("mind-list-item").click();
  const reopened = second.window.getByTestId("mind-editor");
  await expect(reopened.locator("h1")).toHaveText("Results");
  await expect(reopened.locator("h1")).toHaveAttribute("data-id", `${headingId}`);
  const restored = reopened.locator('[data-type="block-math"]');
  await expect(restored).toHaveAttribute("data-latex", "E = mc^2");
  await expect(restored.locator(".katex")).toBeVisible();
  await second.app.close();
});

test("a Block dragged above another stays there after reopening the app", async () => {
  const first = await launchApp(dataDir);
  const { window } = first;
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, text] of ["First", "Second", "Third"].entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(text);
  }
  const paragraphs = editor.locator("p");
  await expect(paragraphs).toHaveText(["First", "Second", "Third"]);

  // Pointing at a Block shows its handle, which stays while the mouse crosses the margin to it.
  // Dragging it down the margin to the top of "First" moves the Block above it.
  await dragBlock(window, paragraphs.nth(2), paragraphs.nth(0));
  await expect(paragraphs).toHaveText(["Third", "First", "Second"]);
  await first.app.close();

  const second = await launchApp(dataDir);
  await second.window.getByTestId("mind-list-item").click();
  await expect(second.window.getByTestId("mind-editor").locator("p")).toHaveText([
    "Third",
    "First",
    "Second",
  ]);
  await second.app.close();
});

test("Esc closes a Block's menu, and the handle then moves on to the Block under the mouse", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, text] of ["One", "Two", "Three"].entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(text);
  }
  const paragraphs = editor.locator("p");

  // Opened with the mouse, the menu takes the focus, so Esc closes it.
  await (await slideToHandle(window, paragraphs.nth(0))).click();
  const menu = window.getByTestId("block-menu");
  await expect(menu).toBeVisible();
  await expect(window.getByTestId("block-menu-context")).toBeFocused();
  await window.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // The handle isn't stuck on the first Block: it follows the mouse to the third.
  const handle = await slideToHandle(window, paragraphs.nth(2));
  const grip = await handle.boundingBox();
  const third = await paragraphs.nth(2).boundingBox();
  if (!grip || !third) throw new Error("The handle or the Block isn't visible.");
  expect(Math.abs(grip.y + grip.height / 2 - (third.y + third.height / 2))).toBeLessThan(4);
  await app.close();
});

test("a Block is deleted from its handle's menu, and with the keyboard", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, text] of [
    "Keep",
    "Delete from the menu",
    "Delete with the keyboard",
  ].entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(text);
  }
  const paragraphs = editor.locator("p");

  // Clicking the handle opens the Block's menu.
  await (await slideToHandle(window, paragraphs.nth(1))).click();
  await expect(window.getByTestId("block-menu")).toBeVisible();
  await window.getByTestId("block-menu-delete").click();
  await expect(window.getByTestId("block-menu")).toHaveCount(0);
  await expect(paragraphs).toHaveText(["Keep", "Delete with the keyboard"]);

  // Cmd/Ctrl+Shift+Backspace deletes the Block the cursor is in.
  await paragraphs.nth(1).click();
  await window.keyboard.press("ControlOrMeta+Shift+Backspace");
  await expect(paragraphs).toHaveText(["Keep"]);
  await app.close();
});

test("a Mind is written in the system's font, and in the bundled Source Serif 4 once it is in the Serif style, Chinese in a system face of the same kind", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("Spring tides come ");
  await window.keyboard.press("ControlOrMeta+I");
  await window.keyboard.type("at new moon");
  await window.keyboard.press("Enter");
  await window.keyboard.type("大潮在新月和满月时出现。");
  await expect(editor.locator("p")).toHaveText([
    "Spring tides come at new moon",
    "大潮在新月和满月时出现。",
  ]);
  const paragraph = '[data-testid="mind-editor"] p';
  const familyOf = () =>
    editor
      .locator("p")
      .first()
      .evaluate((first) => getComputedStyle(first).fontFamily);

  // By default the text is the system's font, which nothing bundled draws; Chinese is its sans.
  expect(await familyOf()).not.toMatch(/Source Serif 4/);
  expect((await fontsDrawing(window, paragraph)).filter((font) => font.bundled)).toEqual([]);
  const sansChinese = await fontsDrawing(window, `${paragraph}:nth-child(2)`);
  expect(sansChinese).not.toEqual([]);
  expect(sansChinese.filter((font) => font.bundled)).toEqual([]);
  // By its PostScript name: the system's font has no Chinese, and the face macOS falls back to
  // comes with its family named in one of the system's languages ("蘋方-簡" on CI's Mac).
  if (process.platform === "darwin") {
    expect(sansChinese.map((font) => font.name)).toEqual([expect.stringMatching(/^PingFangSC-/)]);
  }

  const [mind] = await (await coreOf(window)).evaluate((core) => core.listMinds());
  if (!mind) throw new Error("The Mind wasn't made.");
  await (await coreOf(window)).evaluate(
    (core, mindId) => core.setMindStyle(mindId, { font: "serif", size: "default" }),
    mind.id,
  );
  await expect.poll(familyOf).toMatch(/^"?Source Serif 4"?,/);
  // Upright and italic are both the bundled font, which the CSP (font-src 'self') lets load.
  const latin = await fontsDrawing(window, paragraph);
  expect(latin).toHaveLength(2);
  expect(latin.every((font) => font.family === "Source Serif 4" && font.bundled)).toBe(true);
  // Chinese falls through to the system's Simplified Chinese serif.
  const chinese = await fontsDrawing(window, `${paragraph}:nth-child(2)`);
  expect(chinese).not.toEqual([]);
  expect(chinese.filter((font) => font.bundled)).toEqual([]);
  expect(chinese.map((font) => font.family)).not.toEqual(sansChinese.map((font) => font.family));
  if (process.platform === "darwin")
    expect(chinese.map((font) => font.family)).toEqual(["Songti SC"]);

  // The interface and code fonts are bundled too.
  const others = await window.evaluate(async () =>
    Promise.all(
      ["16px 'Source Sans 3'", "13px 'JetBrains Mono'"].map(async (font) =>
        (await document.fonts.load(font)).map((face) => face.status),
      ),
    ),
  );
  expect(others).toEqual([["loaded"], ["loaded"]]);
  await app.close();
});

test("text highlighted with the keyboard stays highlighted after reopening the app", async () => {
  const first = await launchApp(dataDir);
  const { window } = first;
  await dismissChatSetup(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();

  // Typing makes quotes curly and "--" a dash.
  await window.keyboard.type('"Neap" tides -- the weakest');
  await expect(editor.locator("p")).toHaveText("“Neap” tides — the weakest");

  // Select "strongest" and press Cmd/Ctrl+Shift+H: it is highlighted, and the menu says so.
  await window.keyboard.press("Enter");
  await window.keyboard.type("Spring tides are the strongest");
  for (const _ of "strongest") await window.keyboard.press("Shift+ArrowLeft");
  await expect(window.getByTestId("selection-menu")).toBeVisible();
  await expect
    .poll(() => window.evaluate(() => globalThis.getSelection()?.toString()))
    .toBe("strongest");
  await window.keyboard.press("ControlOrMeta+Shift+H");
  await expect(editor.locator("p mark")).toHaveText("strongest");
  await expect(window.getByTestId("format-highlight")).toHaveAttribute("aria-checked", "true");
  await first.app.close();

  const second = await launchApp(dataDir);
  await second.window.getByTestId("mind-list-item").click();
  const reopened = second.window.getByTestId("mind-editor");
  await expect(reopened.locator("p")).toHaveText([
    "“Neap” tides — the weakest",
    "Spring tides are the strongest",
  ]);
  await expect(reopened.locator("p").nth(1).locator("mark")).toHaveText("strongest");
  await second.app.close();
});
