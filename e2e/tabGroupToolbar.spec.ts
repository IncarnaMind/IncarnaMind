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
 * Every tab group's toolbar holds the same controls in the same order (#2731), whatever its group
 * is and whatever it shows. "Export"'s label shows or hides by the group's own width, never by
 * which group it is: a Note beside the Library has the same controls in both strips, and moving
 * the divider swaps which strip is wide.
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
          '[data-testid="new-tab"], [data-testid="export-mind"], [data-testid="export-idle"], [data-testid="split-group"], [data-testid="group-menu"]',
        ) ?? []),
      ];
      const export_ = strip?.querySelector<HTMLElement>(
        '[data-testid="export-mind"] > span, [data-testid="export-idle"] > span',
      );
      return {
        controls: named.map((each) => {
          const id = each.dataset.testid ?? "";
          return id === "export-idle" ? "export-mind" : id;
        }),
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

      const same = ["new-tab", "export-mind", "split-group", "group-menu"];
      let [left, right] = await strips(window);
      expect(left?.controls).toEqual(same);
      expect(right?.controls).toEqual(same);

      // The group's own width decides the label: the narrow group of two shows none, whichever it is.
      await resize(window, 0.25);
      await expect
        .poll(async () => {
          [left, right] = await strips(window);
          return [left?.label, right?.label];
        })
        .toEqual([false, true]);
      expect(left?.width).toBeLessThan(420);
      expect(right?.width).toBeGreaterThan(420);

      await resize(window, 0.75);
      await expect
        .poll(async () => {
          [left, right] = await strips(window);
          return [left?.label, right?.label];
        })
        .toEqual([true, false]);
      expect(left?.controls).toEqual(same);
      expect(right?.controls).toEqual(same);
    } finally {
      await app.close();
    }
  });
}

test("Export waits in a strip whose group shows no Note, saying what it needs", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1600, 900);
    await newMind(window);
    await nameMind(window, "Tides");
    await setGroupBeside(window, true);
    const idle = window.getByTestId("export-idle");
    await expect(idle).toHaveCount(1);
    await expect(idle).toHaveAttribute("aria-disabled", "true");
    await expect(idle).toHaveAttribute("title", "Open a note to export it");
    // A screen reader reads it as a disabled button, with its reason as the description.
    await expect(window.getByRole("button", { name: "Export", disabled: true })).toHaveCount(1);
    await expect(idle).toHaveAccessibleName("Export");
    await expect(idle).toHaveAccessibleDescription("Open a note to export it");
    await setLanguage(window, "zh-CN");
    await expect(idle).toHaveAttribute("title", "打开一篇笔记后才能导出");
    await expect(idle).toHaveAccessibleName("导出");
    await expect(idle).toHaveAccessibleDescription("打开一篇笔记后才能导出");
    // It does nothing: no menu opens.
    await idle.click({ force: true });
    await expect(window.getByTestId("export-menu")).toBeHidden();
    // The Note's own strip keeps its working Export.
    await expect(window.getByTestId("export-mind")).toHaveCount(1);
  } finally {
    await app.close();
  }
});
