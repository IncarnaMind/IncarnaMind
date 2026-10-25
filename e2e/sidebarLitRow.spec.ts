import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * One lit row in the sidebar, for what the User is looking at (#1098): a
 * selection of one follows the shown tab, however it was reached (the tab
 * strip, ⌃Tab, ⌘K, a Citation, another group taking the focus); a selection
 * of several made with ⌘-click stays; nothing is lit while the Library or
 * Settings shows. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

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

const sidebar = (window: Page) => window.getByTestId("sidebar");
const lit = (window: Page) => sidebar(window).locator('[role="treeitem"][aria-selected="true"]');
const mindRow = (window: Page, title: string) =>
  sidebar(window).getByTestId("mind-row").filter({ hasText: title });
const documentRow = (window: Page, name: string) =>
  sidebar(window).getByTestId("document-list-item").filter({ hasText: name });
const shownTab = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused] [role="tab"][aria-selected="true"]');

/** The one lit row is the shown tab's: the same title. */
async function litIsShown(window: Page): Promise<void> {
  await expect(lit(window)).toHaveCount(1);
  const title = (await shownTab(window).getByTestId("tab-title").textContent()) ?? "";
  expect(title).not.toBe("");
  await expect(lit(window)).toContainText(title);
}

async function litAre(window: Page, names: readonly string[]): Promise<void> {
  await expect(lit(window)).toHaveCount(names.length);
  for (const name of names) await expect(lit(window).filter({ hasText: name })).toHaveCount(1);
}

async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`one sidebar row is lit, for what the User is looking at (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1600, 860);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    await writeFile(join(sources, "Currents.txt"), "Currents carry warm water north.\n");
    await addDocuments(window, [join(sources, "Tides.pdf"), join(sources, "Currents.txt")]);
    await newMind(window);
    await nameMind(window, "Alpha");
    await newMind(window);
    await nameMind(window, "Gamma");

    // Opened from the sidebar, then shown again from its tab: only the shown one is lit.
    await pointAndClick(window, mindRow(window, "Alpha"));
    await litAre(window, ["Alpha"]);
    await pointAndClick(window, documentRow(window, "Currents"));
    await litAre(window, ["Currents"]);
    await pointAndClick(window, mindRow(window, "Alpha"));
    await litAre(window, ["Alpha"]);
    await pointAndClick(window, window.getByTestId("document-tab").filter({ hasText: "Currents" }));
    await litIsShown(window);
    await litAre(window, ["Currents"]);
    await screenshot(window, `one-lit-row-${language}`);

    // The sidebar's Tab stop moves to the lit row, while the focus stays where the User is.
    const stop = sidebar(window).locator('[data-tree-row][tabindex="0"]');
    await expect(stop).toHaveCount(1);
    await expect(stop).toContainText("Currents");
    expect(
      await window.evaluate(
        () =>
          document.querySelector('[data-testid="sidebar"]')?.contains(document.activeElement) ??
          false,
      ),
    ).toBe(false);
    // The arrows start there.
    const rows = sidebar(window).locator("[data-tree-row]");
    const names = (await rows.allTextContents()).map((text) => text.trim());
    const at = names.findIndex((name) => name.startsWith("Currents"));
    await stop.focus();
    await window.keyboard.press("ArrowDown");
    await expect(window.locator(":focus")).toContainText(names[at + 1] ?? "");

    // Shift-click starts from the row that followed the tab.
    await pointAndClick(window, mindRow(window, "Gamma"), { modifiers: ["Shift"] });
    await expect(lit(window).filter({ hasText: "Currents" })).toHaveCount(1);
    await expect(lit(window).filter({ hasText: "Gamma" })).toHaveCount(1);

    // ⌃Tab: the lit row follows.
    await pointAndClick(window, mindRow(window, "Alpha"));
    await window.keyboard.press("Control+Tab");
    await litIsShown(window);
    await window.keyboard.press("Control+Shift+Tab");
    await litAre(window, ["Alpha"]);

    // ⌘K.
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("Currents");
    await pointAndClick(
      window,
      window.getByTestId("palette-item").filter({ hasText: "Currents" }).first(),
    );
    await expect(window.getByTestId("palette-item")).toHaveCount(0);
    await litIsShown(window);

    // A Citation's Open.
    await pointAndClick(window, mindRow(window, "Gamma"));
    await window.getByTestId("mind-editor").click();
    const answer = await askInAssistant(window, "When do spring tides happen?");
    const chip = answer.getByTestId("citation-chip").first();
    await chip.hover();
    await window.getByTestId("citation-card").getByTestId("citation-open").click();
    await expect(window.getByTestId("citation-card")).toHaveCount(0);
    await litIsShown(window);

    // Several selected on purpose stay selected as the tabs change.
    await pointAndClick(window, mindRow(window, "Alpha"));
    await pointAndClick(window, mindRow(window, "Gamma"), { modifiers: ["ControlOrMeta"] });
    await litAre(window, ["Alpha", "Gamma"]);
    await window.keyboard.press("Control+Tab");
    await litAre(window, ["Alpha", "Gamma"]);

    // The Library and Settings have no row: none is lit.
    await pointAndClick(window, mindRow(window, "Alpha"));
    await pointAndClick(window, sidebar(window).getByTestId("open-library"));
    await expect(window.getByTestId("library")).toBeVisible();
    await expect(lit(window)).toHaveCount(0);
    // A row ⌘-clicked meanwhile stays lit as rows come and go.
    await pointAndClick(window, mindRow(window, "Alpha"), { modifiers: ["ControlOrMeta"] });
    await litAre(window, ["Alpha"]);
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createMind({
        title: "Beta",
      }),
    );
    await expect(mindRow(window, "Beta")).toHaveCount(1);
    await litAre(window, ["Alpha"]);
    await pointAndClick(window, mindRow(window, "Alpha"));
    await litAre(window, ["Alpha"]);
    await pointAndClick(
      window,
      window.getByRole("button", { name: language === "en" ? "Settings" : "设置", exact: true }),
    );
    await expect(window.getByRole("dialog")).toBeVisible();
    await expect(lit(window)).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await litAre(window, ["Alpha"]);

    // Esc clears the lit row, and a row that comes later doesn't light it again.
    await sidebar(window).locator('[data-tree-row][tabindex="0"]').focus();
    await window.keyboard.press("Escape");
    await expect(lit(window)).toHaveCount(0);
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createMind({
        title: "Later",
      }),
    );
    await expect(mindRow(window, "Later")).toHaveCount(1);
    await expect(lit(window)).toHaveCount(0);

    // Several chosen in the Library stay chosen as the tabs change.
    await pointAndClick(window, sidebar(window).getByTestId("open-library"));
    const library = window.getByTestId("library").getByTestId("library-document");
    await pointAndClick(window, library.nth(0).getByTestId("library-document-name"), {
      modifiers: ["ControlOrMeta"],
    });
    await pointAndClick(window, library.nth(1).getByTestId("library-document-name"), {
      modifiers: ["ControlOrMeta"],
    });
    const chosen = window.getByTestId("library").locator('[role="row"][aria-selected="true"]');
    await expect(chosen).toHaveCount(2);
    await window.keyboard.press("Control+Tab");
    await window.keyboard.press("Control+Shift+Tab");
    await expect(window.getByTestId("library")).toBeVisible();
    await expect(chosen).toHaveCount(2);
    await pointAndClick(window, mindRow(window, "Alpha"));

    // Two groups, the Document's beside the Mind: the lit row is the focused group's shown one.
    const groups = window.getByTestId("tab-group");
    await pointAndClick(window, mindRow(window, "Gamma"));
    await expect(groups).toHaveCount(2);
    await litIsShown(window);
    // Focus to the other group: the lit row moves to what that group shows.
    const other = window
      .locator('[data-testid="tab-group"]:not([data-focused])')
      .getByRole("tab", { selected: true });
    const otherTitle = (await other.getByTestId("tab-title").textContent()) ?? "";
    await pointAndClick(window, other);
    await litIsShown(window);
    await litAre(window, [otherTitle]);
    await screenshot(window, `one-lit-row-two-groups-${language}`);
  });
}
