import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  lastLineBoxOf,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  textBoxOf,
} from "./app";

/*
 * The sidebar foot's one line (#1016): a closed tab takes the undo line's slot
 * and style, its name cut in the middle so "· Undo" and "· Reopen" stay whole,
 * and the newest line replaces the one before. Set INCARNAMIND_SCREENSHOTS to
 * a folder to keep screenshots of each step.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

const LONG_NAME = "Quarterly review of harbour dues and the wider coastal levy plans";

const WORDS = {
  en: {
    renamed: { start: "Renamed to “", end: "”" },
    closed: { start: "Closed “", end: "”" },
    undo: "Undo",
    reopen: "Reopen",
  },
  "zh-CN": {
    renamed: { start: "已重命名为“", end: "”" },
    closed: { start: "已关闭“", end: "”" },
    undo: "撤销",
    reopen: "重新打开",
  },
} as const;

const boxOf = async (target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
};

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function linesOf(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
}

async function expectWholeLine(window: Page, full: string, actionTestId: string): Promise<void> {
  const line = window.getByTestId("undo-line");
  const message = line.getByTestId("undo-message");
  const action = line.getByTestId(actionTestId);
  const said = (await message.textContent()) ?? "";
  expect(said).toContain("…");
  expect(said).not.toContain(full);
  expect(said).toContain([...full].slice(0, 4).join(""));
  expect(said).toContain([...full].slice(-4).join(""));
  expect(await message.getAttribute("title")).toContain(full);
  expect(await linesOf(message)).toBeLessThanOrEqual(2);

  const [lineBox, messageBox, actionBox] = await Promise.all([
    boxOf(line),
    textBoxOf(message),
    boxOf(action),
  ]);
  for (const box of [messageBox, actionBox]) {
    expect(box.x).toBeGreaterThanOrEqual(lineBox.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(lineBox.x + lineBox.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(lineBox.y - 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(lineBox.y + lineBox.height + 0.5);
  }
  const last = await lastLineBoxOf(message);
  expect(actionBox.x).toBeGreaterThanOrEqual(last.x + last.width - 0.5);
  expect(Math.abs(actionBox.y + actionBox.height / 2 - (last.y + last.height / 2))).toBeLessThan(
    last.height,
  );
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: a closed tab takes the undo line's one slot, Reopen whole, clear of the status row, at 1,440 and 1,100 px`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await writeFile(join(sources, "Brief.md"), "The facts of the case.\n");
      await addDocuments(window, [join(sources, "Brief.md")]);
      const words = WORDS[language];
      const line = window.getByTestId("undo-line");
      const message = line.getByTestId("undo-message");
      const tabs = window.getByTestId("mind-tab");
      let open = 0;

      for (const [width, height] of [
        [1440, 900],
        [1100, 760],
      ] as const) {
        await setWindowSize(app, window, width, height);
        await newMind(window);
        open += 1;
        await expect(tabs).toHaveCount(open);
        const title = `Tides ${language} ${width}`;
        await nameMind(window, title);

        await window.getByTestId("mind-list-item").filter({ hasText: title }).dblclick();
        const field = window.getByTestId("mind-rename");
        await expect(field).toBeVisible();
        await field.fill(LONG_NAME);
        await field.press("Enter");
        await expect(message).toContainText(words.renamed.start);
        await expect(line.getByTestId("undo-action")).toHaveText(words.undo);
        await motionSettled(window);
        await expectWholeLine(window, LONG_NAME, "undo-action");

        await window.locator('[role="tab"][aria-selected="true"]').getByTestId("tab-close").click();
        open -= 1;
        await expect(tabs).toHaveCount(open);
        await expect(message).toContainText(words.closed.start);
        await expect(message).toContainText(words.closed.end);
        await expect(line.getByTestId("tab-notice-reopen")).toHaveText(words.reopen);
        await expect(window.getByTestId("undo-message")).toHaveCount(1);
        await motionSettled(window);
        await expectWholeLine(window, LONG_NAME, "tab-notice-reopen");
        if (SCREENSHOTS) {
          await window
            .getByTestId("sidebar")
            .screenshot({ path: join(SCREENSHOTS, `foot-closed-${language}-${width}.png`) });
        }

        const [lineBox, statusBox, footerBox] = await Promise.all([
          boxOf(line),
          boxOf(window.getByTestId("sidebar-status")),
          boxOf(window.getByTestId("sidebar-footer")),
        ]);
        expect(overlaps(lineBox, statusBox)).toBe(false);
        expect(overlaps(lineBox, footerBox)).toBe(false);
        expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(statusBox.y + 0.5);

        await line.getByTestId("tab-notice-reopen").click();
        open += 1;
        await expect(tabs).toHaveCount(open);
        await expect(frontMindName(window)).toHaveText(LONG_NAME);
        await expect(line.getByTestId("undo-message")).toHaveCount(0);

        await window.locator('[role="tab"][aria-selected="true"]').getByTestId("tab-close").click();
        open -= 1;
        await expect(line.getByTestId("tab-notice-reopen")).toBeVisible();
        await window.keyboard.press("ControlOrMeta+Shift+t");
        open += 1;
        await expect(tabs).toHaveCount(open);
        await expect(frontMindName(window)).toHaveText(LONG_NAME);

        await window.locator('[role="tab"][aria-selected="true"]').getByTestId("tab-close").click();
        open -= 1;
        await expect(line.getByTestId("tab-notice-reopen")).toBeVisible();
        await window.keyboard.press("Escape");
        await expect(line.getByTestId("undo-message")).toHaveCount(0);
        await expect(tabs).toHaveCount(open);

        await window.keyboard.press("ControlOrMeta+Shift+t");
        open += 1;
        await expect(tabs).toHaveCount(open);
      }
    } finally {
      await app.close();
    }
  });
}
