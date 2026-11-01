import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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

  const spacing = await editor.evaluate((root) => {
    const children = [...root.children];
    const between = (aboveText: string, belowText: string) => {
      const above = children.find((block) => block.textContent?.startsWith(aboveText));
      const below = children.find((block) => block.textContent?.startsWith(belowText));
      if (!above || !below) throw new Error("A pasted paragraph or heading isn't drawn.");
      return below.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
    };
    return {
      aroundPageBreak: between("Figure 1: the surveyed sites.", "3 Discussion"),
      aroundParagraph: between("This report covers", "1 Methods"),
    };
  });
  expect(spacing.aroundPageBreak).toBeLessThanOrEqual(spacing.aroundParagraph);

  const [first, second] = await Promise.all([
    steps.nth(0).boundingBox(),
    steps.nth(1).boundingBox(),
  ]);
  if (!first || !second) throw new Error("The pasted steps aren't drawn.");
  expect(second.y).toBeGreaterThan(first.y);
  expect(second.y - (first.y + first.height)).toBeLessThan(first.height);

  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("Calibrate each gauge");
  await expect(editor).not.toContainText("The central and southern estuaries");
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

/** A Word list paragraph as Word copies it: its level and the marker it typed before the words. */
const listParagraph = (list: string, level: number, marker: string, words: string) =>
  `<p class=MsoListParagraphCxSpMiddle style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:${list} level${level} lfo1'><![if !supportLists]><span><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>${words}<o:p></o:p></span></p>`;

const wordHtml = (body: string) =>
  `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><body><!--StartFragment-->${body}<!--EndFragment--></body></html>`;

/** Each numbered item's marker as the editor draws it. */
const markersIn = (window: Page) =>
  window
    .getByTestId("mind-editor")
    .locator("ol li > p")
    .evaluateAll((items) =>
      items.map((p) => {
        const content = getComputedStyle(p, "::before").content;
        return content === "none" ? "" : (JSON.parse(content) as string);
      }),
    );

test("a Word list in Clauses or the Chinese report scheme pastes as that list, each marker drawn as Word drew it", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await setWindowSize(app, window, 1100, 760);
  await dismissChatSetup(window);
  await newMind(window, { title: true });
  await paste(
    window,
    wordHtml(
      listParagraph("l0", 1, "(a)", "Rent") +
        listParagraph("l0", 2, "(i)", "Monthly") +
        listParagraph("l0", 1, "(b)", "Deposit") +
        "<p class=MsoNormal>Then:</p>" +
        listParagraph("l1", 1, "一、", "押金") +
        listParagraph("l1", 2, "（一）", "按月") +
        listParagraph("l1", 1, "二、", "维修"),
    ),
  );
  await expect
    .poll(() => markersIn(window))
    .toEqual(["(a)", "(i)", "(b)", "一、", "（一）", "二、"]);
  await expect(window.getByTestId("mind-editor")).not.toContainText("(a) Rent");
  await app.close();
});
