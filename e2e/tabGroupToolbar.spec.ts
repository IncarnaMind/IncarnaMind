import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setGroupBeside,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A pane shows one ⋯ (#2868): a Note's pane puts the group's items in the page's ⋯, so its strip
 * has none, while a viewer pane keeps its strip's. Export and split are the Note's alone, and
 * "Export"'s label shows or hides by its group's own width.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

interface Strip {
  /** The strip's controls, left to right, by name. */
  controls: string[];
  width: number;
  /** Whether Export shows its word, not only its icon. */
  label: boolean | null;
}

const strips = (window: Page): Promise<Strip[]> =>
  window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="tab-group"]')].map((group) => {
      const strip = group.querySelector<HTMLElement>('[data-testid="tab-strip"]');
      const named = [
        ...(strip?.querySelectorAll<HTMLElement>(
          '[data-testid="new-tab"], [data-testid="export-mind"], [data-testid="split-group"], [data-testid="group-menu"]',
        ) ?? []),
      ];
      const export_ = strip?.querySelector<HTMLElement>('[data-testid="export-mind"] > span');
      return {
        controls: named.map((each) => each.dataset.testid ?? ""),
        width: Math.round(group.getBoundingClientRect().width),
        label: export_?.checkVisibility() ?? null,
      };
    }),
  );

const resize = (window: Page, first: number) =>
  window.evaluate(async (share) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.changeLayout("main", { type: "resize", widths: [share, 1 - share] });
  }, first);

for (const language of ["en", "zh-CN"] as const) {
  test(`a Note beside the Library has the same controls in both strips, and Export's label follows each group's own width, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1600, 900);
      await setLanguage(window, language);
      await newMind(window);
      await nameMind(window, "Tides");
      await setGroupBeside(window, true);

      // The Note's strip: its Export and split, and no group ⋯ (the page's holds it). The
      // Library's: its own ⋯, no Export and no split.
      let [left, right] = await strips(window);
      expect(left?.controls).toEqual(["new-tab", "export-mind", "split-group"]);
      expect(right?.controls).toEqual(["new-tab", "group-menu"]);

      // The Note group's own width decides its Export label: the narrow one shows none.
      await resize(window, 0.25);
      await expect
        .poll(async () => {
          [left, right] = await strips(window);
          return left?.label;
        })
        .toEqual(false);
      expect(left?.width).toBeLessThan(420);

      await resize(window, 0.75);
      await expect
        .poll(async () => {
          [left, right] = await strips(window);
          return left?.label;
        })
        .toEqual(true);
      expect(left?.controls).toEqual(["new-tab", "export-mind", "split-group"]);
      expect(right?.controls).toEqual(["new-tab", "group-menu"]);
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Note beside the Library shows one ⋯ per pane and one Export at 900 and 1,440 px, in ${language}`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await newMind(window);
      await nameMind(window, "Tides");
      await setGroupBeside(window, true);
      await setLanguage(window, language);
      for (const width of [900, 1440]) {
        await setWindowSize(app, window, width, 900);
        // The Note's pane: its page's ⋯ and its Export. The Library's: its strip's ⋯, and
        // neither Export nor split.
        await expect(window.getByTestId("page-menu")).toHaveCount(1);
        await expect(window.getByTestId("export-mind")).toHaveCount(1);
        await expect(window.getByTestId("split-group")).toHaveCount(width === 900 ? 0 : 1);
        await expect(window.getByTestId("group-menu")).toHaveCount(1);
        // Each pane keeps its tab's Close.
        await expect(window.getByTestId("tab-close")).toHaveCount(2);
      }
    } finally {
      await app.close();
    }
  });
}
