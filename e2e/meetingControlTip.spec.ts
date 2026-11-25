import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  type Box,
  boxesOverlap,
  boxOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  pointAt,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The meeting's control names each of its buttons with the app's one tip (#3762): it opens on a
 * rest and on keyboard focus, as every other tip does. A press does what the button does and puts
 * the tip away, so nothing is left over the buttons above the control to take their presses, and
 * the first Esc folds the sheet the press raised, the focus back on the chevron with no tip.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** A string with a shortcut in it, whatever the keys are on this platform. */
function withKeys(language: "en" | "zh-CN", key: "meetings.foot.show" | "meetings.foot.hide") {
  const [before = "", after = ""] = translate(language, key, { keys: "\u0000" }).split("\u0000");
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal(before)}.+${literal(after)}$`);
}

/** Counts each tip drawn from now on, however briefly. */
async function countTips(window: Page): Promise<() => Promise<number>> {
  await window.evaluate(() => {
    const held = globalThis as unknown as { tipsDrawn: number };
    held.tipsDrawn = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('[role="tooltip"]:not([hidden])')) {
            held.tipsDrawn += 1;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => window.evaluate(() => (globalThis as unknown as { tipsDrawn: number }).tipsDrawn);
}

/**
 * Presses where the tip was, on the sheet's button that lies there (its foot's, wherever the
 * control stands), else on what of the sheet does, as a person aiming at it would. Says what lies
 * there and what the press reached, heard before the app acts on it: what the button then does is
 * no part of this.
 */
async function pressWhereTipWas(
  window: Page,
  sheet: Locator,
  tipWas: Box,
): Promise<{ under: string | null; reached: string | null }> {
  const at = await sheet.evaluate((element, tip) => {
    const named = (hit: Element | null) =>
      hit?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
    for (const button of element.querySelectorAll("footer button")) {
      const box = button.getBoundingClientRect();
      const left = Math.max(box.left, tip.x);
      const right = Math.min(box.right, tip.x + tip.width);
      const top = Math.max(box.top, tip.y);
      const bottom = Math.min(box.bottom, tip.y + tip.height);
      if (left < right && top < bottom) {
        const x = (left + right) / 2;
        const y = (top + bottom) / 2;
        return { x, y, under: named(document.elementFromPoint(x, y)) };
      }
    }
    const x = tip.x + tip.width / 2;
    const y = tip.y + tip.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, under: hit && element.contains(hit) ? named(hit) : null };
  }, tipWas);
  await window.mouse.move(at.x, at.y, { steps: 8 });
  await window.evaluate(() => {
    const held = globalThis as unknown as { reached: string | null };
    held.reached = null;
    globalThis.addEventListener(
      "click",
      (event) => {
        const hit = event.target instanceof Element ? event.target : null;
        held.reached = hit?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
        event.stopPropagation();
        event.preventDefault();
      },
      { capture: true, once: true },
    );
  });
  await window.mouse.click(at.x, at.y);
  const reached = await window.evaluate(
    () => (globalThis as unknown as { reached: string | null }).reached,
  );
  return { under: at.under, reached };
}

for (const language of ["en", "zh-CN"] as const) {
  // protects=the control's names are the shared tip, by rest and by keyboard, with no native title; a press on the chevron puts its tip away for good while the pointer rests, a press where the tip was lands on the sheet's button under it, and one Esc folds the sheet with the focus back on the chevron and no tip (#3762); fails_when=the tip stays or comes back after the press, takes the press meant for the button above the control, or takes the first Esc
  test(`a press on the meeting's control puts its tip away: a press above it lands, and one Esc folds the sheet back to the chevron (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1440, 760);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      const control = await recordMeeting(window);
      const chevron = control.getByTestId("meeting-foot-transcript");
      const sheet = window.getByTestId("meeting-sheet");
      const tooltip = window.getByRole("tooltip");
      const show = withKeys(language, "meetings.foot.show");
      const hide = withKeys(language, "meetings.foot.hide");
      await expect(chevron).toHaveAccessibleName(show);
      await expect(chevron).not.toHaveAttribute("title", /.+/);
      await expect(control.getByTestId("meeting-foot-stop")).toHaveAccessibleName(
        translate(language, "meetings.bar.stopLabel"),
      );
      await expect(control.getByTestId("meeting-foot-stop")).not.toHaveAttribute("title", /.+/);

      // Resting on the chevron opens its name in the shared tip, over what lies above the control.
      const resting = await pointAt(window, chevron);
      await expect(tooltip).toHaveText(show);
      await motionSettled(window);
      const tipWas = await boxOf(tooltip);
      expect(tipWas.y + tipWas.height).toBeLessThanOrEqual((await boxOf(chevron)).y);

      // The press raises the sheet and puts the tip away; resting there, the focus on the chevron,
      // brings it back no more.
      const drawn = await countTips(window);
      await window.mouse.click(resting.x, resting.y);
      await expect(sheet).toBeVisible();
      await expect(chevron).toHaveAttribute("aria-expanded", "true");
      await expect(chevron).toHaveAccessibleName(hide);
      await expect(chevron).toBeFocused();
      await expect(tooltip).toHaveCount(0);
      await window.mouse.move(resting.x + 2, resting.y, { steps: 2 });

      // What the sheet raised lies where the tip was, and a press there reaches it.
      expect(boxesOverlap(await boxOf(sheet), tipWas)).toBe(true);
      const { under, reached } = await pressWhereTipWas(window, sheet, tipWas);
      expect(under).not.toBeNull();
      expect(reached).toBe(under);
      await expect(tooltip).toHaveCount(0);

      // One Esc folds the sheet, and the focus goes back to the chevron with no tip over the page.
      await window.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(chevron).toBeFocused();
      await expect(chevron).toHaveAttribute("aria-expanded", "false");
      await expect(tooltip).toHaveCount(0);
      expect(await drawn()).toBe(0);

      // From the keyboard: each name shows at once on the focus, Enter raises the sheet and puts the
      // name away, and one Esc folds the sheet again.
      await window.mouse.move(0, 0);
      const stop = control.getByTestId("meeting-foot-stop");
      await window.keyboard.press("Tab");
      await expect(stop).toBeFocused();
      await expect(tooltip).toHaveText(translate(language, "meetings.bar.stopLabel"));
      await window.keyboard.press("Shift+Tab");
      await expect(chevron).toBeFocused();
      await expect(tooltip).toHaveText(show);
      await window.keyboard.press("Enter");
      await expect(sheet).toBeVisible();
      await expect(tooltip).toHaveCount(0);
      await window.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(chevron).toBeFocused();
      await expect(tooltip).toHaveCount(0);

      // The pointer that leaves and comes back opens it again, with the name it has now.
      await pointAt(window, chevron);
      await expect(tooltip).toHaveText(show);
    } finally {
      await app.close();
    }
  });
}
