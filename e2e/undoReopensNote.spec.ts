import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  frontMind,
  frontMindName,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tabMenu,
} from "./app";

/*
 * Undo puts the Note back on screen (#2195): a Note's delete closes its tabs, so its restore
 * has to open them again, from the tab's menu, its sidebar row or ⌘K, in either language.
 * A row in the list with nothing on screen reads as an Undo that did nothing.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const LANGUAGES = ["en", "zh-CN"] as const;

const TITLE = "Harbour log";
const WORDS = "The harbour log for the week.";

const noteRow = (window: Page, title: string): Locator =>
  window
    .getByTestId("mind-row")
    .filter({ has: window.getByTestId("mind-list-item").filter({ hasText: title }) });

const undoAction = (window: Page) =>
  pointAndClick(window, window.getByTestId("undo-line").getByTestId("undo-action"));

/** What the User sees once the Note is back: its page in front, its words on it, its row listed. */
async function expectNoteOnScreen(window: Page): Promise<void> {
  await expect(frontMindName(window)).toHaveText(TITLE);
  await expect(frontMind(window)).toContainText(WORDS);
  await expect(noteRow(window, TITLE)).toBeVisible();
}

/** Two Notes, the one under test open in front of "Tide tables". */
async function twoNotes(window: Page): Promise<void> {
  await dismissChatSetup(window);
  await mindWrittenBefore(window, "Tide tables", [{ note: "Neap tides are the smallest." }]);
  await mindWrittenBefore(window, TITLE, [{ note: WORDS }]);
  await expect(noteRow(window, "Tide tables")).toBeVisible();
  await pointAndClick(window, noteRow(window, "Tide tables").getByTestId("mind-list-item"));
  await expect(frontMindName(window)).toHaveText("Tide tables");
  await pointAndClick(window, noteRow(window, TITLE).getByTestId("mind-list-item"));
  await expectNoteOnScreen(window);
}

for (const language of LANGUAGES) {
  test(`a Note deleted from its tab menu is the one on screen again after Undo (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await twoNotes(window);

    const menu = await tabMenu(window);
    await pointAndClick(window, menu.getByTestId("mind.delete"));
    // The delete took the Note off the screen: the other one shows.
    await expect(frontMindName(window)).toHaveText("Tide tables");
    await expect(noteRow(window, TITLE)).toHaveCount(0);
    await screenshot(window, `deleted-${language}`);

    await undoAction(window);

    await screenshot(window, `undone-${language}`);
    await expectNoteOnScreen(window);
    await app.close();
  });

  test(`a Note deleted from its sidebar row is the one on screen again after ⌘Z (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await twoNotes(window);

    const row = noteRow(window, TITLE);
    await row.hover();
    await pointAndClick(window, row.getByTestId("mind-menu"));
    await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.delete"));
    await expect(frontMindName(window)).toHaveText("Tide tables");
    await expect(noteRow(window, TITLE)).toHaveCount(0);

    await window.keyboard.press("ControlOrMeta+z");

    await expectNoteOnScreen(window);
    await app.close();
  });
}

for (const language of LANGUAGES) {
  test(`a Note deleted from ⌘K is the one on screen again after Undo (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await twoNotes(window);

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("> delete");
    await pointAndClick(window, window.locator('[data-key="command:mind.delete"]'));
    await expect(frontMindName(window)).toHaveText("Tide tables");
    await expect(noteRow(window, TITLE)).toHaveCount(0);

    await undoAction(window);

    await expectNoteOnScreen(window);
    await app.close();
  });

  test(`a Note restored from Recently deleted leaves the Library in front, with no tab of it (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await twoNotes(window);

    const menu = await tabMenu(window);
    await pointAndClick(window, menu.getByTestId("mind.delete"));
    await expect(frontMindName(window)).toHaveText("Tide tables");

    // Recently deleted is at the foot of the Library, so the User goes there to restore it.
    await pointAndClick(window, window.getByTestId("open-library"));
    const head = window.getByTestId("deleted-section-head");
    if ((await head.getAttribute("data-open")) === "false") {
      await pointAndClick(window, head.getByTestId("deleted-heading"));
    }
    const deleted = window.getByTestId("deleted-item").filter({ hasText: TITLE });
    await pointAndClick(window, deleted.getByTestId("deleted-restore"));
    await expect(noteRow(window, TITLE)).toBeVisible();

    // Nothing replaces what the User is in: the Library stays, and no tab of the Note opens.
    await expect(window.getByTestId("library")).toBeVisible();
    await expect(frontMindName(window)).toHaveCount(0);
    await expect(window.getByTestId("mind-tab").filter({ hasText: TITLE })).toHaveCount(0);
    await app.close();
  });
}

for (const language of LANGUAGES) {
  test(`Undo of a Note deleted from its tab menu is where it was: the same tab, shown, after a second delete and Undo (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await twoNotes(window);
    const shownTabId = () =>
      window
        .locator('[data-testid="mind-tab"][aria-selected="true"]')
        .first()
        .getAttribute("data-tab-id");
    const kept = await shownTabId();

    const deleteFromTabMenu = async () => {
      const menu = await tabMenu(window);
      await pointAndClick(window, menu.getByTestId("mind.delete"));
      await expect(frontMindName(window)).toHaveText("Tide tables");
    };

    await deleteFromTabMenu();
    await undoAction(window);
    await expectNoteOnScreen(window);
    expect(await shownTabId()).toBe(kept);

    await deleteFromTabMenu();
    await undoAction(window);
    await expectNoteOnScreen(window);
    // One tab of the Note, not two: the delete-and-restore twice over leaves no copy behind.
    await expect(window.getByTestId("mind-tab").filter({ hasText: TITLE })).toHaveCount(1);
    expect(await shownTabId()).toBe(kept);
    await app.close();
  });
}
