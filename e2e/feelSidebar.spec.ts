import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  leaveText,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  sidebarFolder,
} from "./app";
import { endFeel, startFeel } from "./feel";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const mindRow = (window: Page, title: string) =>
  window.getByTestId("mind-row").filter({
    has: window.getByTestId("mind-list-item").filter({ hasText: title }),
  });

const mindsNamed = (window: Page, ...titles: string[]) =>
  window.evaluate(async (names) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const title of names) await core.createMind({ title });
  }, titles);

test("the sidebar: open, rename in place, move, delete and Undo, and a new Mind and Folder", async () => {
  const run = await startFeel(dataDir, "sidebar");
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await (await coreOf(window)).evaluate((core) =>
    core.createLibraryGroup({ name: "Finance", description: "" }),
  );
  await mindsNamed(window, "Alpha", "Bravo", "Charlie");

  await feel.step("open a Mind", async () => {
    await pointAndClick(window, mindRow(window, "Bravo").getByTestId("mind-list-item"));
    await expect(mindRow(window, "Bravo").getByTestId("mind-list-item")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  await feel.step("rename in place", async () => {
    await mindRow(window, "Bravo").getByTestId("mind-list-item").dblclick();
    const field = window.getByTestId("mind-rename");
    await expect(field).toBeFocused();
    await field.fill("Budget");
    await window.keyboard.press("Enter");
    // Changed last, it goes to the top: focus is read once the list has moved it there.
    await expect(window.getByTestId("mind-row").first()).toContainText("Budget");
  });
  await feel.expectFocus(
    "rename in place",
    mindRow(window, "Budget").getByTestId("mind-list-item"),
  );

  await feel.step("menu opened and closed", async () => {
    const row = mindRow(window, "Budget");
    await row.hover();
    await pointAndClick(window, row.getByTestId("mind-menu"));
    await expect(row.getByTestId("mind-actions")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(row.getByTestId("mind-actions")).toBeHidden();
  });
  // The ⋯ button shows only on hover, so Esc gives focus back to its row (ObjectMenu).
  await feel.expectFocus(
    "menu opened and closed",
    mindRow(window, "Budget").getByTestId("mind-list-item"),
  );

  await feel.step("move to a Folder", async () => {
    const row = mindRow(window, "Budget");
    await row.hover();
    await pointAndClick(window, row.getByTestId("mind-menu"));
    await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.moveTo"));
    const picker = window.locator('[data-testid="move-to-picker"]:visible');
    await pointAndClick(
      window,
      picker.getByTestId("move-to-option").filter({ hasText: "Finance" }),
    );
    await expect(picker).toHaveCount(0);
    await expect(sidebarFolder(window, "Finance")).toContainText("Budget");
  });
  await feel.expectFocus("move to a Folder", mindRow(window, "Budget"));

  await feel.step("delete", async () => {
    const row = mindRow(window, "Alpha");
    await row.hover();
    await pointAndClick(window, row.getByTestId("mind-menu"));
    await pointAndClick(window, row.getByTestId("mind-actions").getByTestId("mind.delete"));
    await expect(row).toHaveCount(0);
  });
  await feel.expectFocus("delete", mindRow(window, "Charlie").getByTestId("mind-list-item"));

  await feel.step("Undo", async () => {
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(mindRow(window, "Alpha")).toBeVisible();
  });

  await feel.step("new Mind", async () => {
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    await expect(window.getByTestId("mind-row")).toHaveCount(4);
  });
  await feel.expectFocus("new Mind", window.locator('[data-testid="mind-editor"]:visible'));

  await feel.step("new Folder", async () => {
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-folder"));
    await expect(window.getByTestId("folder-rename-field")).toBeVisible();
  });
  await feel.expectFocus("new Folder", window.getByTestId("folder-rename-field"));

  await endFeel(run);
});
