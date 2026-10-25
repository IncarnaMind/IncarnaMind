import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  addToNote,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  frontMindName,
  lastLineBoxOf,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openDocumentAt,
  placeAssistant,
  pointAndClick,
  pointAt,
  removeDataFolder,
  renameInTab,
  setLanguage,
  setSidebarShown,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * The undo line with the sidebar out of sight (#1776): a User working with the
 * mouse still has Undo, the same line in the same words, as a small pill at
 * the window's bottom left. It takes the change back, stays clear of the check
 * badge and the assistant's composer, goes back to the sidebar's foot when the
 * sidebar shows, and the pointer resting on it keeps it.
 *
 * It covers no text (#1914): in a card with room it sits in the gutter left of
 * the page's text, and otherwise the page's scroll area ends above it, so a
 * press or a drag on the page never lands on the pill and never takes a change
 * back. Set INCARNAMIND_SCREENSHOTS to a folder to save screenshots of each
 * step.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: {
    renamed: "Renamed to “",
    undo: "Undo",
    page: "The tide turns at night under the moon.",
    word: "moon",
    first: "Reef",
  },
  "zh-CN": {
    renamed: "已重命名为“",
    undo: "撤销",
    page: "夜里潮水随月亮转向，越过礁石。",
    word: "月亮",
    first: "礁石",
  },
} as const;

const TIDES = buildPdf([
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const boxOf = async (target: Locator) => {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't drawn.");
  return box;
};

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const editorOf = (window: Page) => window.getByTestId("mind-editor");
const scrollerOf = (window: Page) => window.getByTestId("mind-scroller");
const measureOf = (window: Page) =>
  window.getByTestId("mind-pane").locator(".mind-measure").first();

/** The Mind's text, long enough that lines run the whole height of the page's view. */
async function fillPage(window: Page, sentence: string): Promise<void> {
  const editor = editorOf(window);
  await editor.evaluate(
    (dom, content) => {
      (
        dom as unknown as {
          editor: { commands: { insertContentAt: (at: number, content: unknown) => void } };
        }
      ).editor.commands.insertContentAt(0, content);
    },
    Array.from({ length: 80 }, () => ({
      type: "paragraph",
      content: [{ type: "text", text: sentence }],
    })),
  );
}

const scrollTo = (window: Page, top: number) =>
  scrollerOf(window).evaluate((element, at) => {
    element.scrollTop = at;
  }, top);

/** The editor's paragraph that a line at `y` in the window falls in, or the nearest above it. */
async function lineAt(window: Page, y: number): Promise<Locator> {
  for (const offset of [0, -6, -12, -18, -24]) {
    const index = await editorOf(window).evaluate((dom, at) => {
      return Array.from(dom.children).findIndex((child) => {
        const box = child.getBoundingClientRect();
        return box.height > 0 && at >= box.top + 2 && at <= box.bottom - 2;
      });
    }, y + offset);
    if (index >= 0) return editorOf(window).locator(":scope > *").nth(index);
  }
  throw new Error(`No line of the Mind is at ${y}.`);
}

/** A press on text at `x`, `y` places the caret in the Mind and leaves the selection empty. */
async function pressAt(window: Page, x: number, y: number): Promise<void> {
  await window.mouse.move(x, y, { steps: 6 });
  await window.mouse.click(x, y);
  await expect(editorOf(window)).toBeFocused();
  expect(await window.evaluate(() => globalThis.getSelection()?.toString())).toBe("");
}

const selectedText = (window: Page) => window.evaluate(() => globalThis.getSelection()?.toString());

/** The whole layout of the page below the toolbar, for "nothing moves, the view gets shorter". */
const viewOf = async (window: Page) => {
  const scroller = await boxOf(scrollerOf(window));
  return { top: scroller.y, bottom: scroller.y + scroller.height, height: scroller.height };
};

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: with the sidebar hidden, Undo is a pill at the window's bottom left at 1,600 and 900 px, and takes the change back`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const words = WORDS[language];
      const pill = window.getByTestId("undo-pill");
      const foot = window.getByTestId("undo-line");

      for (const [width, height] of [
        [1600, 900],
        [900, 700],
      ] as const) {
        await setWindowSize(app, window, width, height);
        await newMind(window);
        const original = `Tides ${language} ${width}`;
        await nameMind(window, original);
        await setSidebarShown(window, false);

        // A change made with the mouse while the sidebar is out of sight: the Mind renamed in its tab.
        const renamed = `Tides ${language} ${width} renamed`;
        await renameInTab(window, renamed);
        await expect(pill).toBeVisible();
        await expect(pill.getByTestId("undo-message")).toContainText(words.renamed);
        await expect(pill.getByTestId("undo-action")).toHaveText(words.undo);
        // One line, not two: the sidebar's foot, out of sight, draws nothing.
        await expect(foot.getByTestId("undo-message")).toHaveCount(0);
        await motionSettled(window);

        // In the card's bottom left corner: 16px from the window's left, and clear of the composer, the
        // check badge and the Mind's text, whose foot the card keeps below the writing.
        const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const box = await boxOf(pill);
        const card = await boxOf(window.getByTestId("card"));
        expect(Math.round(box.x)).toBe(16);
        expect(Math.round(box.y + box.height)).toBe(Math.round(card.y + card.height - 8));
        const composer = window.getByTestId("assistant-composer");
        if (await composer.isVisible()) {
          expect(overlaps(box, await boxOf(composer))).toBe(false);
        }
        // Below the Mind's last line: the card keeps that line clear of its foot.
        const lastLine = await lastLineBoxOf(
          window.getByTestId("mind-editor").locator(":scope > *").last(),
        );
        expect(box.y).toBeGreaterThanOrEqual(lastLine.y + lastLine.height);
        const badge = window.getByTestId("check-badge");
        if ((await badge.count()) > 0) expect(overlaps(box, await boxOf(badge))).toBe(false);
        // The assistant docked at the bottom leaves the card above its composer; docked on a side,
        // the pill is 16px from the window's bottom edge too.
        const dock = await window.getByTestId("workbench").getAttribute("data-dock");
        if (dock !== "bottom") expect(Math.round(size.height - (box.y + box.height))).toBe(16);
        if (SCREENSHOTS) {
          await window.screenshot({
            path: join(SCREENSHOTS, `undo-pill-${language}-${width}.png`),
          });
        }

        // The sidebar peeked out (the pointer on the window's left edge) has the line at its foot,
        // and the pill is back when it slides away.
        const panel = window.getByTestId("sidebar-panel");
        await window.mouse.move(3, 300, { steps: 6 });
        await expect(panel).toHaveAttribute("data-open", "true");
        await expect(pill).toHaveCount(0);
        await expect(foot.getByTestId("undo-message")).toContainText(words.renamed);
        await window.mouse.move(600, 300, { steps: 10 });
        await expect(panel).not.toHaveAttribute("data-open", "true");
        await expect(pill).toBeVisible();

        await pointAndClick(window, pill.getByTestId("undo-action"));
        await expect(frontMindName(window)).toHaveText(original);
        await expect(pill).toHaveCount(0);

        // Shown again while the line is up, the sidebar takes it back to its foot.
        await renameInTab(window, `${renamed} again`);
        await expect(pill).toBeVisible();
        await setSidebarShown(window, true);
        await expect(pill).toHaveCount(0);
        await expect(foot.getByTestId("undo-message")).toContainText(words.renamed);
        await motionSettled(window);
        await window.keyboard.press("Escape");
        await expect(foot.getByTestId("undo-message")).toHaveCount(0);
      }

      // The pointer on Undo, or the focus in it, keeps it open; it goes a few seconds after they leave.
      await setWindowSize(app, window, 1600, 900);
      await newMind(window);
      await nameMind(window, `Tides ${language} held`);
      await setSidebarShown(window, false);
      await window.clock.install();
      await renameInTab(window, `Tides ${language} held on`);
      await expect(pill).toBeVisible();
      await pointAt(window, pill.getByTestId("undo-action"));
      await window.clock.fastForward("00:30");
      await expect(pill).toBeVisible();
      await window.mouse.move(4, 4);
      await window.clock.fastForward("00:09");
      await expect(pill).toBeVisible();
      await window.clock.fastForward("00:02");
      await expect(pill).toHaveCount(0);

      // The keyboard focus in it keeps it too, with the pointer elsewhere: Tab reaches its Undo.
      await renameInTab(window, `Tides ${language} held again`);
      await expect(pill).toBeVisible();
      await pill.getByTestId("undo-action").focus();
      await window.clock.fastForward("00:30");
      await expect(pill).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(pill).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`${language}: a press or a drag on the text under the pill places the caret or selects, and nothing is undone, in both placements at 1,600 and 900 px, with the viewer open and closed`, async () => {
    test.setTimeout(300_000);
    const sources = await createDataFolder();
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const words = WORDS[language];
      await setWindowSize(app, window, 1600, 900);
      await addDocuments(window, [join(sources, "Tides.pdf")]);
      await window.keyboard.press("Escape");
      await newMind(window);
      await nameMind(window, "Tides");
      await fillPage(window, words.page);
      await setSidebarShown(window, false);
      const pill = window.getByTestId("undo-pill");
      const undo = pill.getByTestId("undo-action");
      const measure = measureOf(window);
      const name = words.first;

      for (const viewer of [false, true]) {
        if (viewer) {
          await openDocumentAt(window, { documentId: await documentIdOf(window, "Tides") });
          await expect(window.getByTestId("viewer")).toBeVisible();
        }
        for (const [width, height] of [
          [1600, 900],
          [900, 700],
        ] as const) {
          await setWindowSize(app, window, width, height);
          await motionSettled(window);
          // The Mind is the page in front, in its own group or beside the viewer's.
          await window.getByTestId("mind-tab").first().click();
          await window.keyboard.press("Escape");
          await motionSettled(window);
          await scrollTo(window, 500);
          const before = await viewOf(window);
          const anchored = await lineAt(window, before.top + 120);
          const anchoredBox = await boxOf(anchored);

          await renameInTab(window, name);
          await expect(pill).toBeVisible();
          await motionSettled(window);
          const pillBox = await boxOf(pill);
          const card = await boxOf(window.getByTestId("card"));
          const column = await boxOf(measure);
          const scroller = await boxOf(scrollerOf(window));
          // 16px from the window's bottom left, as the line was, over the card's foot.
          expect(Math.round(pillBox.x)).toBe(16);
          expect(Math.round(pillBox.y + pillBox.height)).toBe(Math.round(card.y + card.height - 8));
          // The shell and its words let presses through; only Undo takes them.
          expect(await pill.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
            "none",
          );
          expect(await undo.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe(
            "auto",
          );
          const button = await boxOf(undo);
          const label = await undo.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getBoundingClientRect().width;
          });
          expect(button.width - label).toBeLessThanOrEqual(8.5);

          const gutter = column.x - card.x;
          const fits = gutter >= pillBox.width + 8;
          // In the gutter, no text starts under the pill; otherwise the page ends above it.
          if (fits) {
            expect(pillBox.x + pillBox.width).toBeLessThanOrEqual(column.x + 0.5);
            expect(Math.abs(scroller.height - before.height)).toBeLessThanOrEqual(1);
          } else {
            expect(Math.abs(scroller.y + scroller.height - pillBox.y)).toBeLessThanOrEqual(1);
            expect(Math.abs(scroller.y - before.top)).toBeLessThanOrEqual(1);
            expect(scroller.height).toBeLessThan(before.height);
            // Nothing moves with the shorter view: the line that was in the middle is where it was.
            expect(Math.abs((await boxOf(anchored)).y - anchoredBox.y)).toBeLessThanOrEqual(1);
          }

          // A press and a drag where a line under the pill would be: the caret, then a selection,
          // and the change stays. The line is the lowest one the shortened view shows, or the one at
          // the pill's own height in the gutter.
          const at = fits ? pillBox.y + pillBox.height / 2 : pillBox.y - 4;
          const line = await lineAt(window, at);
          const lineBox = await boxOf(line);
          await pressAt(window, lineBox.x + 3, at);
          await expect(frontMindName(window)).toHaveText(name);
          await expect(pill).toBeVisible();
          if (SCREENSHOTS) {
            await window.screenshot({
              path: join(
                SCREENSHOTS,
                `undo-pill-passes-${language}-${width}${viewer ? "-viewer" : ""}.png`,
              ),
            });
          }
          await slideSelect(window, line, words.word);
          expect(await selectedText(window)).toBe(words.word);
          await expect(frontMindName(window)).toHaveText(name);
          await expect(pill).toBeVisible();
          // Collapse the selection, so its menu closes and doesn't sit over the next view.
          await window.keyboard.press("ArrowRight");

          // A press on the pill's own words, not its button, does nothing either.
          const message = await boxOf(pill.getByTestId("undo-message"));
          await window.mouse.click(message.x + message.width / 2, message.y + message.height / 2);
          await expect(frontMindName(window)).toHaveText(name);
          await expect(pill).toBeVisible();

          // Undo still takes the change back, by pointer, and the page gets its view back.
          await pointAndClick(window, undo);
          await expect(frontMindName(window)).toHaveText("Tides");
          await expect(pill).toHaveCount(0);
          if (!fits)
            await expect
              .poll(async () => Math.abs((await viewOf(window)).height - before.height))
              .toBeLessThanOrEqual(1);

          // And by keyboard: the focus reaches it and Enter takes the change back.
          await renameInTab(window, name);
          await expect(pill).toBeVisible();
          await undo.focus();
          await window.keyboard.press("Enter");
          await expect(frontMindName(window)).toHaveText("Tides");
          await expect(pill).toHaveCount(0);
          if (!fits)
            await expect
              .poll(async () => Math.abs((await viewOf(window)).height - before.height))
              .toBeLessThanOrEqual(1);
        }
      }
    } finally {
      await app.close();
      await removeDataFolder(sources);
    }
  });
}

test("the pill stays clear of the assistant's composer docked on the left", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 900);
    await newMind(window);
    await nameMind(window, "Tides");
    await placeAssistant(window, { dock: "left" });
    await setSidebarShown(window, false);
    await renameInTab(window, "Tides on the left");
    const pill = window.getByTestId("undo-pill");
    await expect(pill).toBeVisible();
    await motionSettled(window);
    const [pillBox, composerBox] = await Promise.all([
      boxOf(pill),
      boxOf(window.getByTestId("assistant-composer")),
    ]);
    expect(overlaps(pillBox, composerBox)).toBe(false);
    expect(pillBox.x).toBeGreaterThan(composerBox.x + composerBox.width);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, "undo-pill-en-1600-left.png") });
    }
  } finally {
    await app.close();
  }
});

test("at 900 px with the first open's Ask pill, the pill sits beside it, at the same foot", async () => {
  test.setTimeout(180_000);
  const sources = await createDataFolder();
  await writeFile(join(sources, "Tides note.txt"), "Tides and the moon.\n");
  const { app, window } = await launchApp(dataDir, { examples: true });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 900, 700);
    await setSidebarShown(window, false);
    // A Document added at the first open is a change Undo takes back.
    await window
      .getByTestId("add-documents-input")
      .setInputFiles([join(sources, "Tides note.txt")]);
    const pill = window.getByTestId("undo-pill");
    const ask = window.getByTestId("ask-pill");
    await expect(pill).toBeVisible();
    await expect(ask).toBeVisible();
    await motionSettled(window);
    const [pillBox, askBox] = await Promise.all([boxOf(pill), boxOf(ask)]);
    // Neither covers the other: the pill is at the foot's left end, the Ask pill in the middle.
    expect(overlaps(pillBox, askBox)).toBe(false);
    expect(pillBox.x + pillBox.width).toBeLessThan(askBox.x);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, "undo-pill-en-900-ask.png") });
    }
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});

test("the pill at 900 px stays clear of the check badge at the Mind's foot", async () => {
  test.setTimeout(180_000);
  const sources = await createDataFolder();
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await setWindowSize(app, window, 900, 700);
    await newMind(window);
    await nameMind(window, "Tides");
    // A cited claim no check has looked at puts the badge at the foot's other end.
    await addToNote(window, await askInAssistant(window, "When do spring tides happen?"));
    const badge = window.getByTestId("check-badge");
    await expect(badge).toBeVisible();

    await setSidebarShown(window, false);
    await renameInTab(window, "Tides renamed");
    const pill = window.getByTestId("undo-pill");
    await expect(pill).toBeVisible();
    await motionSettled(window);
    const [pillBox, badgeBox] = await Promise.all([boxOf(pill), boxOf(badge)]);
    expect(overlaps(pillBox, badgeBox)).toBe(false);
    expect(pillBox.x + pillBox.width).toBeLessThan(badgeBox.x);
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, "undo-pill-en-900-badge.png") });
    }
  } finally {
    await app.close();
    await removeDataFolder(sources);
  }
});
