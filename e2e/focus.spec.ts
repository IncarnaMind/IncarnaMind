import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { createDataFolder, launchApp, leaveFirstOpen, removeDataFolder } from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** A Tab stop: what it is, where it is, and whether its focus shows. */
interface Stop {
  what: string;
  where: "sidebar" | "mind" | "settings" | "other";
  shows: boolean;
}

/**
 * Presses Tab, as a person does, and reads where the focus went. It shows when
 * the control has DESIGN.md's focus ring (a solid accent outline, 2px; 1px
 * around a text field, whose edge turns blue too), or, in the Mind's text and
 * title, the caret. A pane divider turns blue instead, and the gap before the
 * card shows the ring's line.
 */
async function pressTab(window: Page): Promise<Stop | null> {
  await window.keyboard.press("Tab");
  return window.evaluate(async () => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body) return null;
    // As it looks once its colours have faded in (a button's 80ms; the composer's edge).
    const composer = element.closest(".composer");
    const fading = [
      ...element.getAnimations({ subtree: true }),
      ...(composer?.getAnimations() ?? []),
    ].filter((each) => {
      return each instanceof CSSTransition;
    });
    await Promise.all(fading.map((each) => each.finished.catch(() => undefined)));
    const probe = document.createElement("span");
    probe.style.color = "var(--color-accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const ringOn = (target: Element | null, width: number) => {
      if (!target) return false;
      const style = getComputedStyle(target);
      return (
        style.outlineStyle === "solid" &&
        Number.parseFloat(style.outlineWidth) >= width &&
        style.outlineColor === accent
      );
    };
    const caret = element.isContentEditable;
    const field = element.matches("textarea, select, input:not([type=radio], [type=checkbox])");
    const shows =
      caret ||
      ringOn(element, field ? 1 : 2) ||
      // A sidebar row's main button leaves its ring to the row, which draws it round the whole row.
      (element.matches(".row-main") && ringOn(element.closest(".group"), 2)) ||
      // A tab draws its ring on its inner shape.
      (element.matches(".tab") && ringOn(element.querySelector(".tab-inner"), 2)) ||
      // A pane's divider, a 1px rule, turns blue and shows its grip; the 8px gap before the
      // card draws the ring's 2px line down its middle instead.
      (element.matches(".pane-divider") &&
        (getComputedStyle(element).backgroundColor === accent ||
          (element.matches(".pane-divider--gap") &&
            getComputedStyle(element).backgroundImage.includes(accent) &&
            getComputedStyle(element).backgroundSize.startsWith("2px")))) ||
      // The composer's text: the composer's edge turns blue, as a field's does.
      (element.matches(".composer-input") &&
        composer !== null &&
        getComputedStyle(composer).borderTopColor === accent);
    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      (element.textContent ?? "").trim().slice(0, 40);
    const testId = element.closest("[data-testid]")?.getAttribute("data-testid") ?? "";
    const where = element.closest('[data-testid="settings"]')
      ? "settings"
      : element.closest('[data-testid="sidebar"]')
        ? "sidebar"
        : element.closest('[data-testid="tab-groups"]')
          ? "mind"
          : "other";
    return {
      what: `${element.tagName.toLowerCase()} [${testId}] "${label}"`,
      where,
      shows,
    } satisfies Stop;
  });
}

/** Tabs from the top until the focus comes round again (or `max` stops), reading each stop. */
async function tabRound(window: Page, max: number): Promise<Stop[]> {
  await window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: Stop[] = [];
  for (let step = 0; step < max; step++) {
    const stop = await pressTab(window);
    if (!stop) continue;
    if (stops.length > 0 && stop.what === stops[0]?.what) break;
    stops.push(stop);
  }
  return stops;
}

/** Slides the mouse onto an element, in steps, and clicks it. */
async function pointAndClick(window: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y, { steps: 8 });
  await window.mouse.click(x, y);
}

test("every Tab stop in a Mind, the sidebar and Settings shows the blue focus ring", async () => {
  // The example Mind is a working one: a Question with a scope, an Answer with checked Citations.
  const { app, window } = await launchApp(dataDir, { examples: true });
  await leaveFirstOpen(window);
  // A chat model, so the composer shows its model chip: an Ollama on a closed port, never called.
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({
      kind: "ollama",
      modelId: "a-model",
      baseUrl: "http://127.0.0.1:9",
    });
  });
  await expect(window.getByTestId("composer-model")).toBeVisible();
  const checks = window
    .getByTestId("mind-pane")
    .getByTestId("mind-editor")
    .getByTestId("citation-chip");
  await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 30_000 });

  const stops = await tabRound(window, 120);
  expect(stops.filter((stop) => stop.where === "sidebar").length).toBeGreaterThan(5);
  expect(stops.filter((stop) => stop.where === "mind").length).toBeGreaterThan(5);
  expect(stops.filter((stop) => !stop.shows).map((stop) => stop.what)).toEqual([]);

  // Settings, opened with the mouse and gone through with the keyboard.
  await pointAndClick(window, window.getByTestId("sidebar-footer").getByRole("button").last());
  const settings = window.getByTestId("settings");
  await expect(settings).toBeVisible();
  const settingsStops = await tabRound(window, 40);
  expect(settingsStops.filter((stop) => stop.where === "settings").length).toBeGreaterThan(5);
  expect(settingsStops.filter((stop) => !stop.shows).map((stop) => stop.what)).toEqual([]);
  await app.close();
});
