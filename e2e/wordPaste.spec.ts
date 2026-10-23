import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
} from "./app";

let dataDir: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

// What Word for Mac puts on the clipboard for the Field Report, ⌘A ⌘C.
const fieldReport = () =>
  readFile(join(__dirname, "../tests/fixtures/formats/word-clipboard-field-report.html"), "utf8");

async function paste(window: Page, html: string): Promise<void> {
  await window.evaluate((copied) => {
    const data = new DataTransfer();
    data.setData("text/html", copied);
    data.setData("text/plain", "Field Report: Northern Estuary");
    (document.activeElement ?? document.body).dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  }, html);
}

interface Drawn {
  tag: string;
  text: string;
  top: number;
  bottom: number;
}

// Read at one moment, so the picture loading above can't move one Block and not another.
const drawnBlocks = (editor: Locator): Promise<Drawn[]> =>
  editor.evaluate((root) =>
    [...root.children].map((block) => {
      const { top, bottom } = block.getBoundingClientRect();
      return { tag: block.tagName, text: block.textContent ?? "", top, bottom };
    }),
  );

function placeOf(blocks: Drawn[], words: string): number {
  const at = blocks.findIndex((block) => block.text.startsWith(words));
  if (at < 0) throw new Error(`"${words}" isn't drawn.`);
  return at;
}

function blockOf(blocks: Drawn[], words: string): Drawn {
  const block = blocks[placeOf(blocks, words)];
  if (!block) throw new Error(`"${words}" isn't drawn.`);
  return block;
}

const spaceBetween = (above: Drawn, below: Drawn) => below.top - above.bottom;

// What Word writes for an empty paragraph: the User's own, or the rest of the one that held a page break.
const EMPTY_PARAGRAPH = "<p class=MsoNormal><span lang=EN-US><o:p>&nbsp;</o:p></span></p>";

test("a Word document pasted into a new Mind keeps its Title, lists and table, leaves its comment out, and is undone in one step", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1100, 760);
  await dismissChatSetup(window);
  await newMind(window, { title: true });
  const editor = window.getByTestId("mind-editor");
  await paste(window, await fieldReport());

  await expect(editor.locator(":scope > :first-child")).toHaveJSProperty("tagName", "H1");
  await expect(editor.locator(":scope > :first-child")).toHaveText(
    "Field Report: Northern Estuary",
  );
  const steps = editor.locator("ol > li");
  await expect(steps).toHaveText([
    "Calibrate each gauge against the datum.",
    "Read it every fifteen minutes.",
    "Reject gaps longer than a month.",
  ]);
  await expect(editor.locator("ul > li")).toHaveText([
    "Pressure gauges",
    "Radar level sensors",
    "A survey boat",
  ]);
  await expect(editor.locator("table")).toBeVisible();
  await expect(editor).toContainText("Highlighted text marks open questions.");
  await expect(editor).not.toContainText("[JM1]");
  await expect(editor).not.toContainText("Confirm with the hydrology team");

  const [first, second] = await Promise.all([
    steps.nth(0).boundingBox(),
    steps.nth(1).boundingBox(),
  ]);
  if (!first || !second) throw new Error("The pasted steps aren't drawn.");
  expect(second.y).toBeGreaterThan(first.y);
  expect(second.y - (first.y + first.height)).toBeLessThan(first.height);

  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Calibrate each gauge");
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(steps).toHaveCount(3);

  await steps.nth(2).scrollIntoViewIfNeeded();
  await clickEndOf(window, steps.nth(2).locator("p"));
  await window.keyboard.press("Enter");
  await window.keyboard.type("Store the readings.");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(3)).toHaveText("Store the readings.");
  await app.close();
});

test("a page break pasted from Word leaves no gap, keeps the User's own empty line beside it, and goes with the paste in one step", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1100, 760);
  await dismissChatSetup(window);
  await newMind(window, { title: true });
  const editor = window.getByTestId("mind-editor");
  const discussion = editor.locator(":scope > *", { hasText: "3 Discussion" });
  const copied = await fieldReport();
  await paste(window, copied);
  await expect(discussion).toBeVisible();

  // Both pairs are a paragraph above a Heading 1.
  const pasted = await drawnBlocks(editor);
  expect(
    spaceBetween(blockOf(pasted, "Figure 1: the surveyed sites."), blockOf(pasted, "3 Discussion")),
  ).toBeLessThanOrEqual(
    spaceBetween(blockOf(pasted, "This report covers"), blockOf(pasted, "1 Methods")) + 1,
  );

  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Field Report");
  await expect(editor).not.toContainText("The central and southern estuaries");

  await paste(window, copied.replace(EMPTY_PARAGRAPH, EMPTY_PARAGRAPH.repeat(2)));
  await expect(discussion).toBeVisible();
  const withLine = await drawnBlocks(editor);
  const caption = placeOf(withLine, "Figure 1: the surveyed sites.");
  const [picture, captionBox, line, heading] = withLine.slice(caption - 1, caption + 3);
  if (!picture || !captionBox || !line || !heading) throw new Error("A pasted Block isn't drawn.");
  expect({ tag: line.tag, text: line.text.trim() }).toEqual({ tag: "P", text: "" });
  expect(heading.text).toBe("3 Discussion");
  expect(line.bottom - line.top).toBeLessThanOrEqual(captionBox.bottom - captionBox.top + 1);
  expect(spaceBetween(captionBox, line)).toBeLessThanOrEqual(spaceBetween(picture, captionBox) + 1);
  await app.close();
});
