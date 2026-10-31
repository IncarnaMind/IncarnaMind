import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CV_TEXT_WIDTH_TWIPS, cvFile } from "../tests/helpers/wordLookFiles";
import {
  createDataFolder,
  dismissChatSetup,
  importWordFile,
  launchApp,
  motionSettled,
  placeAssistant,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A Word file's page fits its widest table, with an 11px floor under its body
 * text; narrower, its tables shrink and wrap; only one whose figures can't
 * fit scrolls, faded and with its scrollbar (#1035). Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let home: string;
let files: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
  files = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
  await removeDataFolder(files);
});

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const frameOf = (window: Page) => window.locator(".mind-editor-frame:visible").first();

/**
 * Where the page's tables and their cells' text fall against the Mind's column:
 * how far the furthest reaches past it on each side, in px, and whether any
 * table's frame can scroll.
 */
const layoutOf = (frame: Locator) =>
  frame.evaluate((element) => {
    const column = element.getBoundingClientRect();
    let pastRight = 0;
    let pastLeft = 0;
    let scrolls = 0;
    for (const table of element.querySelectorAll("table")) {
      const wrapper = table.closest<HTMLElement>(".tableWrapper");
      if (wrapper && wrapper.scrollWidth > wrapper.clientWidth + 1) scrolls++;
      for (const cell of table.querySelectorAll("td, th")) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        for (const rect of range.getClientRects()) {
          if (rect.width === 0) continue;
          pastRight = Math.max(pastRight, rect.right - column.right);
          pastLeft = Math.max(pastLeft, column.left - rect.left);
        }
      }
    }
    const body = element.querySelector(".mind-editor td p, .mind-editor p");
    return {
      pastRight,
      pastLeft,
      scrolls,
      bodyPx: body ? Number.parseFloat(getComputedStyle(body).fontSize) : 0,
      widest: Math.max(
        0,
        ...[...element.querySelectorAll("table")].map(
          (table) => table.getBoundingClientRect().right,
        ),
      ),
      columnRight: column.right,
    };
  });

for (const language of ["en", "zh-CN"] as const) {
  test(`a résumé laid out in tables fits its column, docked and floating, at 1,440, 1,100 and 900 px (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { home });
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await importWordFile(app, window, files, "résumé.docx", cvFile());
    const frame = frameOf(window);
    await expect(frame.locator("table")).toHaveCount(11);

    for (const [width, height] of [
      [1440, 900],
      [1100, 720],
      [900, 760],
    ] as const) {
      for (const dock of ["right", "float"] as const) {
        await setWindowSize(app, window, width, height);
        await placeAssistant(window, { dock, folded: false });
        await motionSettled(window);
        // No cell's text past the column on either side, and no table's frame can scroll.
        await expect
          .poll(() => layoutOf(frame), { message: `${width}px, ${dock}` })
          .toMatchObject({ scrolls: 0 });
        const layout = await layoutOf(frame);
        expect(layout.pastRight, `${width}px, ${dock}`).toBeLessThanOrEqual(1);
        expect(layout.pastLeft, `${width}px, ${dock}`).toBeLessThanOrEqual(1);
        expect(layout.bodyPx).toBeGreaterThanOrEqual(11);
        // At 1,440 the page zooms so the widest table fits whole; narrower, tables wrap their cells.
        if (width === 1440) expect(layout.widest).toBeLessThanOrEqual(layout.columnRight + 1);
        await shot(window, `word-fit-${language}-${width}-${dock}`);
      }
    }
    await app.close();
  });
}

test("End in a table's line and a sideways swipe leave every row's start in place", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 900, 760);
  await importWordFile(app, window, files, "résumé.docx", cvFile());
  const frame = frameOf(window);
  const table = frame.locator("table").nth(2);
  const date = table.locator("td").first();
  await expect(date).toContainText("2021.04-至今");
  const wrapper = table.locator("xpath=ancestor::div[contains(@class,'tableWrapper')]");
  const start = async () => (await date.boundingBox())?.x ?? Number.NaN;
  const before = await start();

  const line = table.locator("td").nth(1).locator("p");
  await line.click({ position: { x: 8, y: 6 } });
  await window.keyboard.press("End");
  await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  expect(await wrapper.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await start()).toBeCloseTo(before, 0);

  const box = await table.boundingBox();
  if (!box) throw new Error("The table isn't laid out.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.wheel(400, 0);
  await expect.poll(() => wrapper.evaluate((element) => element.scrollLeft)).toBe(0);
  expect(await start()).toBeCloseTo(before, 0);
  await app.close();
});

test("a table of twelve figures a row that can't fit scrolls in its frame, its cut edge faded and its scrollbar shown", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await importWordFile(app, window, files, "billings.docx", cvFile({ figures: true }));
  const frame = frameOf(window);
  const figures = frame.locator("table", { hasText: "Jan" });
  const wrapper = figures.locator("xpath=ancestor::div[contains(@class,'tableWrapper')]");
  // Playwright's scrollIntoViewIfNeeded would also scroll the table's own frame to its middle.
  await wrapper.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await expect
    .poll(() => wrapper.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  // A figure is never cut inside: the columns keep its width, and the frame scrolls.
  await expect(wrapper).toHaveAttribute("data-more-after", "");
  await expect(wrapper).not.toHaveAttribute("data-more-before");
  expect(await wrapper.evaluate((element) => getComputedStyle(element).maskImage)).toContain(
    "gradient",
  );
  expect(
    await wrapper.evaluate((element: HTMLElement) => element.offsetHeight - element.clientHeight),
  ).toBeGreaterThanOrEqual(6);
  await shot(window, "word-fit-figures-start");

  await wrapper.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(wrapper).toHaveAttribute("data-more-before", "");
  await expect(wrapper).not.toHaveAttribute("data-more-after");
  await shot(window, "word-fit-figures-end");
  // The résumé's own tables still fit.
  expect((await layoutOf(frame)).scrolls).toBe(1);
  await app.close();
});

test("a résumé with a 12 pt body whose tables keep to the text's width looks as before at 1,440 px", async () => {
  const { app, window } = await launchApp(dataDir, { home });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  const tableTwips = 9000;
  await importWordFile(app, window, files, "résumé 12pt.docx", cvFile({ size: 24, tableTwips }));
  const frame = frameOf(window);
  const table = frame.locator("table").first();
  await expect(table).toBeVisible();
  // Zoomed to fit its text's width, as before, and each table as wide as the file has it.
  const { columnWidth, point } = await frame.evaluate((element) => ({
    columnWidth: element.getBoundingClientRect().width,
    point: Number.parseFloat(
      getComputedStyle(element.querySelector(".mind-editor") ?? element).getPropertyValue(
        "--word-pt",
      ),
    ),
  }));
  expect(point * (CV_TEXT_WIDTH_TWIPS / 20)).toBeCloseTo(columnWidth, 0);
  expect((await table.boundingBox())?.width ?? 0).toBeCloseTo((tableTwips / 20) * point, 0);
  await app.close();
});
