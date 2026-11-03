import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  mindWrittenBefore,
  moveAssistant,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LANGUAGES = ["en", "zh-CN"] as const;

const mindRow = (window: Page, title: string): Locator =>
  window.getByTestId("mind-row").filter({
    has: window.getByTestId("mind-list-item").filter({ hasText: title }),
  });

const mindItem = (window: Page, title: string): Locator =>
  mindRow(window, title).getByTestId("mind-list-item");

const rowTitles = (window: Page) =>
  window.getByTestId("mind-row").getByTestId("row-text").allTextContents();

const mindsNamed = (window: Page, ...titles: string[]) =>
  window.evaluate(async (names) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const title of names) await core.createMind({ title });
  }, titles);

for (const language of LANGUAGES) {
  test(`after Record a meeting, Start recording has the focus, Enter starts and Esc keeps the Mind as a note (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 720);
    await setLanguage(window, language);

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-record-meeting"));
    const start = window.getByTestId("meeting-start");
    await expect(start).toBeVisible();
    await expect(start.getByTestId("meeting-start-record")).toBeFocused();

    await window.keyboard.press("Escape");
    await expect(start).toHaveCount(0);
    await expect(window.locator('[data-testid="mind-editor"]:visible')).toBeFocused();
    expect(await (await coreOf(window)).evaluate((core) => core.listMeetings())).toEqual([]);
    await app.close();
  });
}

test("after Record a meeting by keyboard, Enter starts the recording, through the one-time notice", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1100, 720);

  await window.getByTestId("plus-menu").focus();
  await window.keyboard.press("Enter");
  await window.getByTestId("plus-record-meeting").focus();
  await window.keyboard.press("Enter");
  const record = window.getByTestId("meeting-start-record");
  await expect(record).toBeFocused();

  await window.keyboard.press("Enter");
  await expect(window.getByTestId("meeting-notice")).toBeVisible();
  await app.close();
});

for (const language of LANGUAGES) {
  test(`after Delete in a Mind's menu, the focus is on the next Mind's row, and Undo brings the Mind back (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await mindsNamed(window, "Alpha", "Bravo", "Charlie");
    await expect.poll(() => rowTitles(window)).toEqual(["Charlie", "Bravo", "Alpha"]);

    const deleteFromMenu = async (title: string) => {
      const row = mindRow(window, title);
      await row.hover();
      await pointAndClick(window, row.getByTestId("mind-menu"));
      await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.delete"));
      await expect(row).toHaveCount(0);
    };

    await deleteFromMenu("Charlie");
    await expect(mindItem(window, "Bravo")).toBeFocused();

    await window.keyboard.press("ControlOrMeta+z");
    await expect(mindItem(window, "Charlie")).toBeVisible();
    await expect(mindItem(window, "Bravo")).toBeFocused();

    const last = (await rowTitles(window)).at(-1) ?? "";
    const previous = (await rowTitles(window)).at(-2) ?? "";
    await deleteFromMenu(last);
    await expect(mindItem(window, previous)).toBeFocused();

    await window.keyboard.press("ControlOrMeta+z");
    await expect(mindItem(window, last)).toBeVisible();
    await expect(mindItem(window, previous)).toBeFocused();
    await app.close();
  });
}

test("after Delete of the only Mind in the tree, the focus is on the row above it, and Undo brings the Mind back", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await mindsNamed(window, "Solo");

  const row = mindRow(window, "Solo");
  await row.hover();
  await pointAndClick(window, row.getByTestId("mind-menu"));
  await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.delete"));
  await expect(row).toHaveCount(0);
  await expect(window.getByTestId("open-library")).toBeFocused();

  await window.keyboard.press("ControlOrMeta+z");
  await expect(mindItem(window, "Solo")).toBeVisible();
  await expect(window.getByTestId("open-library")).toBeFocused();
  await app.close();
});

test("after Delete from a Mind's menu opened with the keyboard, the focus is on the next row", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await mindsNamed(window, "Alpha", "Bravo", "Charlie");
  await expect.poll(() => rowTitles(window)).toEqual(["Charlie", "Bravo", "Alpha"]);

  await mindItem(window, "Bravo").focus();
  await window.keyboard.press("Shift+F10");
  const menu = window.getByTestId("mind-actions").filter({ visible: true });
  await expect(menu).toBeVisible();
  await menu.getByTestId("mind.delete").focus();
  await window.keyboard.press("Enter");
  await expect(mindItem(window, "Bravo")).toHaveCount(0);
  await expect(mindItem(window, "Alpha")).toBeFocused();
  await app.close();
});

for (const language of LANGUAGES) {
  test(`after Move assistant to a place, the focus is on the assistant's ⋯ in its new place (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, language);
    await mindWrittenBefore(window, "Harbour log", [{ note: "The harbour log for the week." }]);
    await pointAndClick(window, mindItem(window, "Harbour log"));
    const assistant = window.getByTestId("assistant");

    for (const place of ["bottom", "float", "left", "right"] as const) {
      await moveAssistant(window, place);
      await expect(assistant).toHaveAttribute("data-chosen-dock", place);
      await expect(window.getByTestId("assistant-more")).toBeFocused();
    }
    await app.close();
  });
}

test("after Move assistant chosen with the keyboard, the focus is on the assistant's ⋯", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await mindWrittenBefore(window, "Harbour log", [{ note: "The harbour log for the week." }]);
  await pointAndClick(window, mindItem(window, "Harbour log"));

  await window.getByTestId("assistant-more").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("assistant-menu-move")).toBeFocused();
  await window.keyboard.press("ArrowRight");
  await window.getByTestId("assistant-menu-bottom").focus();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-chosen-dock", "bottom");
  await expect(window.getByTestId("assistant-more")).toBeFocused();
  await app.close();
});
