import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  moveAssistant,
  nameMind,
  newMind,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * The docked assistant sits 4px from the card (#1099), on the right, the left and at the bottom,
 * and folded, in English and Chinese, in a narrow and a wide window; the line between them can
 * still be grabbed across 8px; the sidebar and the window's edges stay 8px from the card. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

async function dock(window: Page, item: "right" | "left" | "bottom") {
  await moveAssistant(window, item);
  await expect(window.getByTestId("assistant")).toHaveAttribute("data-chosen-dock", item);
}

/** What is under a point of the window: the resize line's test id, or none. */
const testIdAt = (window: Page, x: number, y: number) =>
  window.evaluate(
    ([px, py]) =>
      document
        .elementFromPoint(px ?? 0, py ?? 0)
        ?.closest("[data-testid]")
        ?.getAttribute("data-testid") ?? null,
    [x, y],
  );

/** The gap between the card and the assistant, along the dock's axis. */
async function gapOf(window: Page): Promise<number> {
  const card = await boxOf(window.getByTestId("card"));
  const assistant = await boxOf(window.getByTestId("assistant"));
  const shown = await window.getByTestId("assistant").getAttribute("data-dock");
  if (shown === "left") return card.x - (assistant.x + assistant.width);
  if (shown === "bottom") return assistant.y - (card.y + card.height);
  return assistant.x - (card.x + card.width);
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1440] as const) {
    test(`the assistant is 4px from the card in each dock and folded (${language}, ${width}px)`, async () => {
      const { app, window } = await launchApp(dataDir);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, width, 820);
      await newMind(window);
      await nameMind(window, "Tides");
      const assistant = window.getByTestId("assistant");

      for (const item of ["right", "left", "bottom"] as const) {
        await dock(window, item);
        await expect.poll(() => gapOf(window), `${item}: the gap`).toBeCloseTo(4, 0);

        // The line in the gap is grabbed across 8px: 2px past each edge of the card and the assistant.
        const rod = await boxOf(window.getByTestId("assistant-resize"));
        const across = (await assistant.getAttribute("data-dock")) === "bottom";
        const middle = across ? rod.x + rod.width / 2 : rod.y + rod.height / 2;
        for (const reach of [-1.5, 1.5]) {
          const at = across
            ? { x: middle, y: (reach < 0 ? rod.y : rod.y + rod.height) + reach }
            : { x: (reach < 0 ? rod.x : rod.x + rod.width) + reach, y: middle };
          expect(await testIdAt(window, at.x, at.y), `${item}: grabbed at ${reach}`).toBe(
            "assistant-resize",
          );
        }
        if (SCREENSHOTS) {
          await window.screenshot({
            path: join(SCREENSHOTS, `assistant-gap-${item}-${language}-${width}.png`),
          });
        }
      }

      // Folded beside the card, on the right.
      await dock(window, "right");
      await window.getByTestId("assistant-fold").click();
      await expect(assistant).toHaveAttribute("data-folded", "true");
      await expect.poll(() => gapOf(window), "folded: the gap").toBeCloseTo(4, 0);

      // The sidebar and the window's edges stay 8px from the card.
      const sidebar = await boxOf(window.getByTestId("sidebar"));
      const card = await boxOf(window.getByTestId("card"));
      expect(card.x - (sidebar.x + sidebar.width)).toBeCloseTo(8, 0);
      expect(card.y).toBeCloseTo(8, 0);
      const folded = await boxOf(assistant);
      const height = await window.evaluate(() => globalThis.innerHeight);
      const lowest = Math.max(card.y + card.height, folded.y + folded.height);
      expect(height - lowest).toBeCloseTo(8, 0);
    });
  }
}
