import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  frontMindName,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * A new Mind's first line starts as its title (DESIGN.md › A Mind's
 * page: only its text): an empty Heading 1 with a grey "Title" (标题)
 * placeholder and the cursor on it, as Apple Notes starts a note. Enter goes
 * on in body text; Backspace on the empty heading, or Turn into, makes it
 * body text; text pasted into the new Mind keeps its formatting. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const linesOf = (window: Page) =>
  frontMind(window)
    .locator(".mind-editor > *")
    .evaluateAll((lines) => lines.map((line) => `${line.tagName} ${line.textContent ?? ""}`));

/** ⌘N, waiting until the new Mind's first line has the cursor. */
async function pressNewMind(window: Page) {
  await window.keyboard.press("ControlOrMeta+n");
  const first = frontMind(window).locator(".mind-editor > :first-child");
  await expect.poll(() => linesOf(window)).toEqual(["H1 "]);
  await expect(frontMind(window).getByTestId("mind-editor")).toBeFocused();
  return first;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`⌘N starts a Mind with an empty Heading 1 titled by a grey placeholder; typed, Enter goes on in body text (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 760);
    const [placeholder, body, title, line] =
      language === "en"
        ? [
            "Title",
            "Type / for headings, tables, code and math",
            "Harbour notes",
            "High water at noon.",
          ]
        : ["标题", "输入“/”插入标题、表格、代码或公式", "港口笔记", "中午涨潮。"];

    const first = await pressNewMind(window);
    await expect(first).toHaveAttribute("data-placeholder", placeholder);
    // The title's placeholder, not the empty Mind's hint over the same line.
    await expect(window.getByTestId("end-hint")).toHaveCount(0);
    await motionSettled(window);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `title-line-${language}.png`) });
    }

    await window.keyboard.type(title);
    await window.keyboard.press("Enter");
    const second = frontMind(window).locator(".mind-editor > :nth-child(2)");
    await expect(second).toHaveJSProperty("tagName", "P");
    await expect(second).toHaveAttribute("data-placeholder", body);
    await window.keyboard.type(line);
    expect(await linesOf(window)).toEqual([`H1 ${title}`, `P ${line}`]);
    // Named by its first line, whatever its format.
    await expect(frontMindName(window)).toHaveText(title);
    await app.close();
  });
}

test("Backspace on the empty title makes it body text, and Undo brings the title back; Turn into changes a typed one", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1100, 760);

  await pressNewMind(window);
  await window.keyboard.press("Backspace");
  await expect.poll(() => linesOf(window)).toEqual(["P "]);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => linesOf(window)).toEqual(["H1 "]);

  await window.keyboard.type("Tide tables");
  const first = frontMind(window).locator(".mind-editor > :first-child");
  await slideSelect(window, first, "Tide tables");
  const turnInto = window.getByTestId("selection-turn-into");
  await expect(turnInto).toContainText("Heading 1");
  await turnInto.click();
  await window.getByTestId("turn-into-text").click();
  await expect.poll(() => linesOf(window)).toEqual(["P Tide tables"]);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => linesOf(window)).toEqual(["H1 Tide tables"]);
  await app.close();
});

test("two paragraphs pasted into a new Mind keep their formatting: the first isn't made the title", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1100, 760);

  await pressNewMind(window);
  await window.evaluate(() => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      "<p>Spring tides come at new moon.</p><p>Neap tides come between.</p>",
    );
    data.setData("text/plain", "Spring tides come at new moon.\n\nNeap tides come between.");
    (document.activeElement ?? document.body).dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  });
  await expect
    .poll(() => linesOf(window))
    .toEqual(["P Spring tides come at new moon.", "P Neap tides come between."]);

  // One line pasted over the empty title is the title: plain text, a line with its newline,
  // or a sentence copied from a web page, which has no paragraph around it.
  const pasteOverTitle = async (data: { html?: string; plain: string }) => {
    await newMind(window, { title: true });
    await window.evaluate((given) => {
      const clipboard = new DataTransfer();
      if (given.html) clipboard.setData("text/html", given.html);
      clipboard.setData("text/plain", given.plain);
      (document.activeElement ?? document.body).dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true }),
      );
    }, data);
  };
  await pasteOverTitle({ plain: "Harbour notes" });
  await expect.poll(() => linesOf(window)).toEqual(["H1 Harbour notes"]);
  await pasteOverTitle({ plain: "Harbour notes\n" });
  await expect.poll(() => linesOf(window)).toEqual(["H1 Harbour notes"]);
  await pasteOverTitle({
    html: '<meta charset="utf-8"><span style="color: rgb(0, 0, 0);">Spring tides at <b>new moon</b></span>',
    plain: "Spring tides at new moon",
  });
  await expect.poll(() => linesOf(window)).toEqual(["H1 Spring tides at new moon"]);
  await app.close();
});
