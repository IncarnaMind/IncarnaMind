import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  splitFromTabMenu,
} from "./app";

/*
 * The shown tab looks the same in every group (#1100), as Chrome's: its title in weight 400 and
 * `ink`, its ✕ shown and its `sheet` fill, whichever group has the focus; italic marks only a
 * preview. In English and Chinese, with two groups at 1,440px and merged at 900px, where the
 * shown tab keeps its 132px and its title ends with "…". Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** How a tab looks: its title's weight, colour and style, its ✕'s opacity and its fill. */
const lookOf = (tab: Locator) =>
  tab.evaluate((element) => {
    const title = element.querySelector('[data-testid="tab-title"]');
    const close = element.querySelector('[data-testid="tab-close"]');
    const titleStyle = title ? getComputedStyle(title) : null;
    return {
      weight: titleStyle?.fontWeight ?? "",
      colour: titleStyle?.color ?? "",
      italic: titleStyle?.fontStyle === "italic",
      close: close ? getComputedStyle(close).opacity : "",
      fill: getComputedStyle(element).backgroundColor,
    };
  });

const shownIn = (group: Locator) => group.getByRole("tab", { selected: true });

for (const language of ["en", "zh-CN"] as const) {
  test(`the shown tab looks the same in every group (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 860);
    await writeFile(join(sources, "Currents.txt"), "Currents carry warm water north.\n");
    await addDocuments(window, [join(sources, "Currents.txt")]);
    await newMind(window);
    await nameMind(window, "Alpha");
    await newMind(window);
    await nameMind(window, "Gamma");

    // Beta, not open yet, to the side: two groups, the side one focused.
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createMind({
        title: "Beta",
      }),
    );
    const groups = window.getByTestId("tab-group");
    const sidebar = window.getByTestId("sidebar");
    const beta = sidebar.getByTestId("mind-row").filter({ hasText: "Beta" });
    await expect(beta).toHaveCount(1);
    await splitFromTabMenu(window);
    await pointAndClick(window, beta);
    await expect(groups).toHaveCount(2);

    for (const focus of [1, 0]) {
      await pointAndClick(window, shownIn(groups.nth(focus)));
      await expect(groups.nth(focus)).toHaveAttribute("data-focused", "true");
      const [first, second] = await Promise.all([
        lookOf(shownIn(groups.nth(0))),
        lookOf(shownIn(groups.nth(1))),
      ]);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ weight: "400", close: "1", italic: false });
      // Not the shown one: lighter than it, in the same weight.
      const other = groups.nth(0).getByRole("tab", { selected: false }).first();
      const rest = await lookOf(other);
      expect(rest.weight).toBe("400");
      expect(rest.colour).not.toBe(first.colour);
    }
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `tab-look-two-groups-${language}.png`) });
    }

    // A preview is italic, and only a preview.
    await pointAndClick(
      window,
      sidebar.getByTestId("document-list-item").filter({ hasText: "Currents" }),
    );
    const preview = window.locator('[role="tab"][data-preview]');
    await expect(preview).toHaveCount(1);
    expect((await lookOf(preview)).italic).toBe(true);
    const tabs = window.getByRole("tab");
    for (let index = 0; index < (await tabs.count()); index++) {
      const tab = tabs.nth(index);
      const isPreview = (await tab.getAttribute("data-preview")) !== null;
      expect((await lookOf(tab)).italic, `tab ${index}`).toBe(isPreview);
    }

    // Narrow, the groups merge: the shown tab keeps 132px, its long title ends with "…".
    await nameMind(window, "A Mind with a title long enough to be cut short in its tab");
    await setWindowSize(app, window, 900, 760);
    const shown = window.locator(
      '[data-testid="tab-group"][data-focused] [role="tab"][aria-selected="true"]',
    );
    await expect
      .poll(async () => (await shown.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(132);
    expect(
      await shown
        .getByTestId("tab-title")
        .evaluate((title) => getComputedStyle(title).textOverflow),
    ).toBe("ellipsis");
    expect((await lookOf(shown)).weight).toBe("400");
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `tab-look-900-${language}.png`) });
    }
  });
}
