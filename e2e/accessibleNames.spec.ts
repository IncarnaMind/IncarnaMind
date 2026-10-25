import { expect, type Page, test } from "@playwright/test";
import { offeredSettingsPages } from "../src/renderer/src/settingsPages";
import {
  askInAssistant,
  createDataFolder,
  launchApp,
  openSettings,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  useLocalChatModel,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/*
 * The browser's own accessible names, from Playwright's ARIA snapshot: a control
 * the snapshot lists without a quoted name has none, which a screen reader
 * speaks as only "button".
 */
const UNNAMED =
  /^\s*- (?:button|link|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|switch|combobox|slider|spinbutton)(?: \[[^\]]*\])*:?\s*$/;

async function unnamedControls(window: Page): Promise<string[]> {
  const lines = (await window.locator("body").ariaSnapshot()).split("\n");
  return lines.flatMap((line, index) =>
    UNNAMED.test(line) ? [lines.slice(Math.max(0, index - 2), index + 2).join("\n")] : [],
  );
}

/** Visible icon buttons without a native tooltip or a described tooltip. */
const untitledIcons = (window: Page) =>
  window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, [role=button]")]
      .filter(
        (each) =>
          each.getClientRects().length > 0 &&
          (each.textContent ?? "").trim() === "" &&
          each.getAttribute("title") === null &&
          !(each.getAttribute("aria-describedby") ?? "").split(/\s+/).some((id) => {
            const description = document.getElementById(id);
            return (
              description?.getAttribute("role") === "tooltip" && description.textContent?.trim()
            );
          }) &&
          each.closest("[aria-hidden=true]") === null &&
          each.closest("[popover]:not(:popover-open)") === null,
      )
      .map(
        (each) =>
          each.getAttribute("data-testid") ??
          each.getAttribute("aria-label") ??
          each.outerHTML.slice(0, 80),
      ),
  );

const expectNamed = async (window: Page, where: string) => {
  expect(await unnamedControls(window), `controls with no name: ${where}`).toEqual([]);
  expect(await untitledIcons(window), `icon buttons with no tooltip: ${where}`).toEqual([]);
};

for (const language of ["en", "zh-CN"] as const) {
  test(`every control on the first screens, an Answer and each Settings page has a name (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { examples: true, fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await expect(window.getByTestId("first-open-steps")).toBeVisible();
    await setLanguage(window, language);
    await expectNamed(window, "the first open");

    await useLocalChatModel(window);
    await askInAssistant(window, "Which figure is wrong?");
    await expectNamed(window, "an Answer");

    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette")).toBeVisible();
    await expectNamed(window, "the command palette");
    await window.keyboard.press("Escape");

    await setLanguage(window, "en");
    await openSettings(window, "general");
    await setLanguage(window, language);
    for (const page of offeredSettingsPages) {
      await showSettingsPage(window, page);
      await expectNamed(window, `Settings, ${page}`);
    }
    await app.close();
  });
}
