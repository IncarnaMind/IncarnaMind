import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  clickEditItem,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  openManageTags,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

type Route = "menu" | "keyboard";

// Playwright's key dispatch can bypass the macOS menu that takes ⌘A (#1351).
const chooseSelectAll = (app: ElectronApplication, window: Page, route: Route) =>
  route === "menu"
    ? clickEditItem(app, "edit.selectAll")
    : window.keyboard.press("ControlOrMeta+a");

async function selectAllIn(app: ElectronApplication, window: Page, route: Route, field: Locator) {
  const value = await field.inputValue();
  await chooseSelectAll(app, window, route);
  await expect
    .poll(() =>
      field.evaluate((element) => {
        if (!(element instanceof HTMLInputElement)) throw new Error("Not an input.");
        return element.selectionStart === null
          ? document.getSelection()?.toString()
          : element.value.slice(element.selectionStart, element.selectionEnd ?? 0);
      }),
    )
    .toBe(value);
}

for (const language of ["en", "zh-CN"] as const) {
  for (const route of ["menu", "keyboard"] as const) {
    test(`${route} Select All replaces text in the palette, Tags and monthly cap (${language})`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await setWindowSize(app, window, language === "en" ? 1280 : 900, 660);
        await dismissChatSetup(window);
        await setLanguage(window, language);
        const core = await coreOf(window);
        const selectAll = (field: Locator) => selectAllIn(app, window, route, field);
        const shot = async (name: string) => {
          const folder = process.env.INCARNAMIND_SCREENSHOTS;
          if (route === "menu" && folder) {
            await motionSettled(window);
            await window.screenshot({ path: join(folder, `${name}-${language}.png`) });
          }
        };

        await window.keyboard.press("ControlOrMeta+k");
        const palette = window.getByTestId("palette-search");
        await expect(palette).toBeFocused();
        await window.keyboard.type("abc def");
        await selectAll(palette);
        await window.keyboard.type("Z");
        await expect(palette).toHaveValue("Z");
        await selectAll(palette);
        await window.keyboard.type("财务 review 🧾");
        await selectAll(palette);
        await window.keyboard.type("财务");
        await expect(palette).toHaveValue("财务");
        await shot("palette-after");

        const minds = await core.evaluate(async (bridge) => (await bridge.listMinds()).length);
        await window.keyboard.press("ControlOrMeta+t");
        await expect(palette).toBeFocused();
        expect(await core.evaluate(async (bridge) => (await bridge.listMinds()).length)).toBe(
          minds,
        );
        await window.keyboard.press("Escape");

        await openManageTags(window, language);
        const tags = window.getByTestId("tags-dialog");
        const search = tags.getByTestId("tag-search");
        await pointAndClick(window, search);
        await window.keyboard.type("caiwu");
        await selectAll(search);
        await window.keyboard.type("cw");
        await expect(search).toHaveValue("cw");
        await selectAll(search);
        await window.keyboard.press("Backspace");
        await expect(search).toHaveValue("");
        await pointAndClick(
          window,
          tags.getByRole("button", { name: translate(language, "tags.dialog.done"), exact: true }),
        );
        await expect(tags).toBeHidden();

        await window.keyboard.press("ControlOrMeta+,");
        const settings = await showSettingsPage(window, "general");
        const toggle = settings.getByTestId("spending-cap-switch");
        await pointAndClick(window, toggle);
        const amount = settings.getByTestId("spending-cap-amount");
        await amount.fill("150");
        await window.keyboard.press("Enter");
        await expect
          .poll(() => core.evaluate(async (bridge) => (await bridge.getSettings()).user.monthlyCap))
          .toMatchObject({ amount: 150 });
        await pointAndClick(window, amount);
        await window.keyboard.press("End");
        await selectAll(amount);
        await window.keyboard.type("7");
        await window.keyboard.press("Tab");
        await expect(amount).toHaveValue("7");
        await expect
          .poll(() => core.evaluate(async (bridge) => (await bridge.getSettings()).user.monthlyCap))
          .toMatchObject({ amount: 7 });
        await shot("cap-after");
      } finally {
        await app.close();
      }
    });
  }
}

for (const route of ["menu", "keyboard"] as const) {
  test(`${route} Select All in the Library selects every row and no page text (#1350)`, async () => {
    const sources = await createDataFolder();
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1280, 660);
      await dismissChatSetup(window);
      await setLanguage(window, "en");
      const paths = ["Tides", "Currents", "Waves"].map((name) => join(sources, `${name}.txt`));
      for (const path of paths) await writeFile(path, "The sea.\n");
      await addDocuments(window, paths);
      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      const rows = library.getByTestId("library-document");
      const bar = library.getByTestId("library-selection");
      await expect(rows).toHaveCount(3);
      const everyRowSelected = async () => {
        for (const row of await rows.all()) {
          await expect(row).toHaveAttribute("aria-selected", "true");
        }
      };
      const textSelected = () => window.evaluate(() => globalThis.getSelection()?.toString() ?? "");

      // A row is ticked, as in the issue, and its checkbox holds the focus.
      await pointAndClick(window, rows.first().getByTestId("library-select"));
      await chooseSelectAll(app, window, route);
      await expect(bar).toContainText("3 selected");
      await everyRowSelected();
      expect(await textSelected()).toBe("");

      // The bar's own Select All holds the focus, as Tab reaches it: ⌘A is still the rows'.
      await library.getByTestId("library-select-all").focus();
      await chooseSelectAll(app, window, route);
      await expect(bar).toContainText("3 selected");
      await everyRowSelected();
      expect(await textSelected()).toBe("");
    } finally {
      await app.close();
      await removeDataFolder(sources);
    }
  });

  test(`${route} Select All in a row's name field selects its text, and on a row every row (#1518)`, async () => {
    const sources = await createDataFolder();
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1280, 660);
      await dismissChatSetup(window);
      const paths = ["Tides", "Currents", "Waves"].map((name) => join(sources, `${name}.txt`));
      for (const path of paths) await writeFile(path, "The sea.\n");
      await addDocuments(window, paths);
      const sidebar = window.getByTestId("sidebar");
      const rows = sidebar.getByTestId("document-list-item");
      const selected = sidebar.getByTestId("sidebar-selection");

      // The field sits in the list, where ⌘A otherwise selects rows.
      await rows.first().getByTestId("open-document").focus();
      await window.keyboard.press("F2");
      const field = sidebar.locator("input:focus");
      await expect(field).toBeFocused();
      await window.keyboard.press("End");
      await window.keyboard.type(" 文件");
      await selectAllIn(app, window, route, field);
      await expect(selected).toHaveText("");
      await window.keyboard.type("采购 caigou");
      await expect(field).toHaveValue("采购 caigou");
      await window.keyboard.press("Enter");
      await expect(rows.filter({ hasText: "采购 caigou" })).toHaveCount(1);

      await rows.first().getByTestId("open-document").focus();
      await chooseSelectAll(app, window, route);
      await expect(selected).toHaveText("3 selected · Esc clears");
    } finally {
      await app.close();
      await removeDataFolder(sources);
    }
  });
}
