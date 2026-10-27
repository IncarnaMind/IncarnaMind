import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  openPageMenu,
  pointAndClick,
  pointAt,
  removeDataFolder,
  savedLine,
  setWindowSize,
  useOutputLocation,
  WINDOW_SIZE,
} from "./app";

/*
 * A submenu stays open while the pointer slides toward it, across the rows
 * beside its item (#1237), as in the menus of macOS and Windows. Every move
 * here is a slid one, as a person's hand makes it.
 */

let dataDir: string;
let output: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  output = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(output);
});

/** From now on, the ids of the menu rows the pointer comes onto. */
const watchRows = (window: Page) =>
  window.evaluate(() => {
    const rows: string[] = [];
    (globalThis as { rowsEntered?: string[] }).rowsEntered = rows;
    document.addEventListener("pointerover", (event) => {
      const row =
        event.target instanceof Element ? event.target.closest('[role^="menuitem"]') : null;
      const id = row?.getAttribute("data-testid");
      if (id && rows.at(-1) !== id) rows.push(id);
    });
  });
const rowsEntered = (window: Page) =>
  window.evaluate(() => (globalThis as { rowsEntered?: string[] }).rowsEntered ?? []);

test("Export › More formats stays open while the pointer slides across the rows under it to its last format; resting on a row it crossed lets that row take over", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, WINDOW_SIZE.width, WINDOW_SIZE.height);
  await newMind(window);
  await nameMind(window, "Tides");
  await window.getByTestId("mind-editor").click();
  await window.keyboard.type("Spring tides come twice a month.");
  await useOutputLocation(window, output);
  const menu = window.getByTestId("export-menu");
  const more = window.getByTestId("export-more-menu");

  await pointAndClick(window, window.getByTestId("export-mind"));
  await expect(menu).toBeVisible();
  await motionSettled(window);
  await pointAt(window, menu.getByTestId("export-more"));
  await expect(more).toBeVisible();
  await motionSettled(window);

  // Down and to the right, over Citation style and Export options…, onto the last format.
  await watchRows(window);
  await pointAndClick(window, more.getByTestId("export-as-markdown"));
  expect(await rowsEntered(window)).toEqual(
    expect.arrayContaining([expect.stringMatching(/^export-(citation-style-menu|options)$/)]),
  );
  await expect(window.getByTestId("export-result").getByTestId("export-done")).toContainText(
    savedLine("Tides.md", output),
  );

  // Stopping on a row it crossed, it takes over: More formats closes.
  await pointAndClick(window, window.getByTestId("export-mind"));
  await expect(menu).toBeVisible();
  await motionSettled(window);
  await pointAt(window, menu.getByTestId("export-more"));
  await expect(more).toBeVisible();
  await motionSettled(window);
  const submenu = await more.boundingBox();
  const options = await menu.getByTestId("export-citation-style-menu").boundingBox();
  if (!submenu || !options) throw new Error("The menu isn't laid out.");
  await window.mouse.move(submenu.x - 12, options.y + options.height / 2, { steps: 8 });
  await expect(more).toBeHidden();
  await expect(menu).toBeVisible();
  await app.close();
});

test("Style › in the page's ⋯ stays open while the pointer slides down to a lower choice, and the choice is made", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await enterContent(window);
  await window.keyboard.type("Spring tides come at new moon");
  const paragraph = window.getByTestId("mind-editor").locator("p").first();
  const familyOf = () => paragraph.evaluate((element) => getComputedStyle(element).fontFamily);

  const menu = await openPageMenu(window);
  await pointAt(window, menu.getByTestId("page-style"));
  const choices = window.getByTestId("page-style-menu");
  await expect(choices).toBeVisible();
  await motionSettled(window);
  await pointAndClick(window, choices.getByTestId("mind-style-font-mono"));
  await expect.poll(familyOf).toMatch(/JetBrains Mono/);
  await expect(choices).toBeVisible();
  await app.close();
});
