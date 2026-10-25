import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  DEFAULT_FOLDER_ZH,
  dismissChatSetup,
  documentIdOf,
  exportFromMenu,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openDocumentAt,
  placeAssistant,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots. */
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (folder) await target.screenshot({ path: join(folder, `${name}.png`) });
}

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const WRONG = "Harbours publish the times of high water every 6 months.";

// With ".docx", the first two are 70 characters long; a file name is cut a little short of a long Mind name.
const WITH_COMMENT = "Summary for the manager of the quarterly review of harbour dues";
const PLAIN = "Harbour times note for the manager and the wider quarterly review";
const CHINESE = "信贷委员会合同审阅笔记".repeat(6);

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

/** How many lines the Saved sentence is set in, and which of its words a box it sits in cuts off. */
function measure(saved: Locator): Promise<{ lines: number; clipped: string[] }> {
  return saved.evaluate((root) => {
    const result = root.closest('[data-testid="export-result"]');
    if (!result) throw new Error("The sentence isn't in the result line.");
    const centres: number[] = [];
    const clipped: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      const words = node.textContent?.trim() ?? "";
      if (!owner || words === "") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        centres.push(rect.top + rect.height / 2);
        for (let box: Element | null = owner; box; box = box.parentElement) {
          const edge = box.getBoundingClientRect();
          const style = getComputedStyle(box);
          const holds =
            box === result || style.overflowX !== "visible" || style.overflowY !== "visible";
          const inside =
            rect.left >= edge.left - 0.5 &&
            rect.right <= edge.right + 0.5 &&
            rect.top >= edge.top - 0.5 &&
            rect.bottom <= edge.bottom + 0.5;
          if (holds && !inside) clipped.push(words);
          if (box === result) break;
        }
      }
    }
    let lines = 0;
    let last = Number.NEGATIVE_INFINITY;
    for (const centre of centres.toSorted((a, b) => a - b)) {
      if (centre - last > 8) lines++;
      last = centre;
    }
    return { lines, clipped };
  });
}

async function addComment(window: Page): Promise<void> {
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type(WRONG);
  const line = editor.locator(":scope > p").first();
  await slideSelect(window, line, "Harbours", { line, words: "months." });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "contradicted");
}

for (const beside of [false, true]) {
  test(`a long file name: the Saved line is whole, in two lines at most, with the name cut in the middle, at 900, 1,100 and 1,440 px, ${
    beside ? "beside an open Document" : "alone"
  }, in English and Chinese`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 760);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    await nameMind(window, CHINESE);
    await newMind(window);
    await nameMind(window, PLAIN);
    await newMind(window);
    await nameMind(window, WITH_COMMENT);
    await addComment(window);
    if (beside) {
      await openDocumentAt(window, { documentId: await documentIdOf(window, "Tides") });
      await expect(window.getByTestId("tab-group")).toHaveCount(2);
    }

    const tabs = window.getByTestId("mind-tab");
    const result = window.getByTestId("export-result");
    const saved = result.getByTestId("export-saved");
    const done = result.getByTestId("export-done");
    // The first save names the folder and offers Change folder…, which makes its line the longest.
    for (const width of beside ? [1440, 1100, 900] : [900, 1100, 1440]) {
      await setWindowSize(app, window, width, 760);
      if (beside && width === 1100) {
        // Two groups need a card of 736px, which the assistant on the right leaves only at 1,440.
        await placeAssistant(window, { folded: true });
        await expect(window.getByTestId("tab-group")).toHaveCount(2);
      }
      for (const title of [WITH_COMMENT, PLAIN, CHINESE]) {
        await pointAndClick(window, tabs.filter({ hasText: title.slice(0, 12) }));
        await exportFromMenu(window, "docx");
        await expect(done).toContainText(".docx", { timeout: 30_000 });
        const name = basename((await done.getAttribute("title")) ?? "");
        expect(Array.from(name).length).toBeGreaterThanOrEqual(60);
        for (const language of ["en", "zh-CN"] as const) {
          await setLanguage(window, language);
          const english = language === "en";
          // The accessible name gives the whole name, and so does the tooltip, the file's path.
          await expect(done).toHaveAccessibleName(
            english
              ? `Saved “${name}” in Documents › IncarnaMind`
              : `已保存“${name}”到“${DEFAULT_FOLDER_ZH}”`,
          );

          // The start and the extension stay, and the middle goes.
          const shown = (await saved.textContent()) ?? "";
          expect(shown.startsWith(`${english ? "Saved “" : "已保存“"}${name.slice(0, 8)}`)).toBe(
            true,
          );
          expect(shown).toMatch(/…[^…]*\.docx”/);
          expect(shown).not.toContain(name);

          const measured = await measure(saved);
          expect(measured.clipped).toEqual([]);
          expect(measured.lines).toBeLessThanOrEqual(2);

          await motionSettled(window);
          await screenshot(
            window,
            `saved-${beside ? "beside" : "alone"}-${width}-${title === WITH_COMMENT ? "comment" : title === PLAIN ? "plain" : "chinese"}-${language}`,
          );
        }
      }
    }
    await app.close();
  });
}
