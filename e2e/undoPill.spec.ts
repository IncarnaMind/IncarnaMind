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
  frontMindName,
  lastLineBoxOf,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  placeAssistant,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setSidebarShown,
  setWindowSize,
} from "./app";

/*
 * The undo line with the sidebar out of sight (#1776): a User working with the
 * mouse still has Undo, the same line in the same words, as a small pill at
 * the window's bottom left. It takes the change back, stays clear of the check
 * badge and the assistant's composer, goes back to the sidebar's foot when the
 * sidebar shows, and the pointer resting on it keeps it. Set
 * INCARNAMIND_SCREENSHOTS to a folder to save screenshots of each step.
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
  en: { renamed: "Renamed to “", undo: "Undo" },
  "zh-CN": { renamed: "已重命名为“", undo: "撤销" },
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

/** Renames the Mind in front where it is shown: a double-click on its tab, the new name, Enter. */
async function renameInTab(window: Page, name: string): Promise<void> {
  const tab = window.locator('[role="tab"][aria-selected="true"]');
  const at = await pointAt(window, tab);
  await window.mouse.dblclick(at.x, at.y);
  const field = window.getByTestId("tab-rename");
  await expect(field).toBeFocused();
  await field.fill(name);
  await field.press("Enter");
  await expect(frontMindName(window)).toHaveText(name);
}

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

      // The pointer or the focus on the pill keeps it open, and it goes a few seconds after they leave.
      await setWindowSize(app, window, 1600, 900);
      await newMind(window);
      await nameMind(window, `Tides ${language} held`);
      await setSidebarShown(window, false);
      await window.clock.install();
      await renameInTab(window, `Tides ${language} held on`);
      await expect(pill).toBeVisible();
      await pointAt(window, pill);
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

test("at 900 px with the first open's Ask pill, the pill sits above it", async () => {
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
    expect(overlaps(pillBox, askBox)).toBe(false);
    expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(askBox.y);
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
