import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  tabTo,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function fits(window: Page, tooltip: Locator) {
  await motionSettled(window);
  const box = await tooltip.boundingBox();
  expect(box).not.toBeNull();
  const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
}

async function shot(window: Page, name: string) {
  const directory = process.env.INCARNAMIND_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await window.screenshot({ path: join(directory, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Settings help opens by keyboard and pointer without changing its setting, and Escape closes only the help (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    const settings = await openSettings(window, "ai");
    await setLanguage(window, language);
    const name = language === "en" ? "More information" : "查看说明";
    const tooltip = window.getByRole("tooltip");
    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, width === 900 ? 560 : 900);
      await showSettingsPage(window, "ai");
      await window.mouse.move(0, 0);
      const cap = settings.getByTestId("spending-cap-settings");
      const help = cap.getByRole("button", { name, exact: true });
      const toggle = cap.getByTestId("spending-cap-switch");
      const checked = await toggle.isChecked();
      const explanation = translate(language, "cost.cap.tip");
      await expect(help).toBeVisible();
      await expect(toggle).toHaveAccessibleDescription(explanation);
      await tabTo(window, help);
      await expect(help).toBeFocused();
      expect(await help.evaluate((each) => getComputedStyle(each).outlineStyle)).not.toBe("none");
      await expect(help).toHaveAccessibleDescription(explanation);
      await expect(tooltip).toHaveText(explanation);
      await fits(window, tooltip);
      await shot(window, `help-ai-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(help).toBeFocused();
      await expect(toggle).toHaveAccessibleDescription(explanation);
      await window.keyboard.press("Enter");
      await expect(tooltip).toBeVisible();
      await window.keyboard.press("Escape");
      await window.keyboard.press("Space");
      await expect(tooltip).toBeVisible();
      await window.keyboard.press("Tab");
      await expect(toggle).toBeFocused();
      await expect(tooltip).toHaveCount(0);
      await expect(toggle).toBeChecked({ checked });

      await showSettingsPage(window, "privacy");
      const updates = settings.locator('[data-traffic-id="update-check"]');
      const info = updates.getByRole("button", { name, exact: true });
      const updateSwitch = updates.getByTestId("automatic-update-checks");
      const updatesChecked = await updateSwitch.isChecked();
      await tabTo(window, info);
      await expect(info).toBeFocused();
      await expect(tooltip).toHaveText(translate(language, "privacy.traffic.update-check.tip"));
      await fits(window, tooltip);
      await shot(window, `help-privacy-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(info).toBeFocused();
      await window.keyboard.press("Tab");
      // The pointer rests on the ⓘ until the tip is shown and has grown to its place, as a person
      // reading it does, and only then moves onto the tip.
      await info.hover();
      await expect(tooltip).toBeVisible();
      await motionSettled(window);
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await window.mouse.move(0, 0);
      await expect(tooltip).toHaveCount(0);
      await info.hover();
      await expect(tooltip).toBeVisible();
      await motionSettled(window);
      await tooltip.hover();
      await window.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await window.mouse.move(0, 0);
      await tabTo(window, info);
      await expect(tooltip).toBeVisible();
      await window.keyboard.press("Tab");
      await expect(tooltip).toHaveCount(0);
      await pointAndClick(window, info);
      await expect(tooltip).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(updateSwitch).toBeChecked({ checked: updatesChecked });
    }
  });
}

test("Settings help shown for the keyboard goes as soon as the focus moves on, with the pointer resting where it shows; pointed at, it stays", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const settings = await openSettings(window, "ai");
    await setWindowSize(app, window, 1440, 900);
    await showSettingsPage(window, "ai");
    const tooltip = window.getByRole("tooltip");
    const cap = settings.getByTestId("spending-cap-settings");
    const help = cap.getByRole("button", { name: "More information", exact: true });
    const toggle = cap.getByTestId("spending-cap-switch");
    await window.mouse.move(0, 0);
    await tabTo(window, help);
    await expect(tooltip).toBeVisible();
    await motionSettled(window);
    const box = await tooltip.boundingBox();
    if (!box) throw new Error("The help isn't visible.");
    await window.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);

    // The pointer rests where the help shows, and the keyboard brings it up under it.
    const resting = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await window.mouse.move(resting.x, resting.y, { steps: 6 });
    await window.keyboard.press("Shift+Tab");
    await window.keyboard.press("Tab");
    await expect(help).toBeFocused();
    await expect(tooltip).toBeVisible();
    await motionSettled(window);
    await expect
      .poll(() =>
        tooltip.evaluate(
          (element, at) => element.contains(document.elementFromPoint(at.x, at.y)),
          resting,
        ),
      )
      .toBe(true);
    await window.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    await expect(tooltip).toHaveCount(0);

    // Pointed at, by a pointer that moves onto it, it stays as the focus moves on, until the pointer leaves.
    await window.keyboard.press("Shift+Tab");
    await expect(help).toBeFocused();
    await expect(tooltip).toBeVisible();
    await motionSettled(window);
    await window.mouse.move(resting.x + 4, resting.y, { steps: 2 });
    await window.keyboard.press("Tab");
    await expect(toggle).toBeFocused();
    await motionSettled(window);
    await expect(tooltip).toBeVisible();
    await window.mouse.move(0, 0, { steps: 4 });
    await expect(tooltip).toHaveCount(0);
  } finally {
    await app.close();
  }
});

interface TipNote {
  reached?: number;
  hoverColour?: string;
  opened?: number;
}

/**
 * Notes in the page when the pointer first reaches each ⓘ, what colour the ⓘ has two paints later,
 * and when each tooltip first shows, all by the tooltip's id. A test reads how long a tip waited
 * from the page's own clock, so how slow Playwright or the machine is doesn't enter into it.
 */
async function recordTips(window: Page, label: string) {
  await window.evaluate((name) => {
    const notes: Record<string, TipNote> = {};
    (globalThis as unknown as { tipNotes: Record<string, TipNote> }).tipNotes = notes;
    document.addEventListener(
      "pointermove",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest(`button[aria-label="${name}"]`);
        const id = button?.getAttribute("aria-describedby");
        if (!button || !id) return;
        const note = notes[id] ?? {};
        notes[id] = note;
        if (note.reached !== undefined) return;
        note.reached = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            note.hoverColour = getComputedStyle(button).backgroundColor;
          }),
        );
      },
      true,
    );
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            node.getAttribute("role") === "tooltip" &&
            !node.hasAttribute("hidden")
          ) {
            const note = notes[node.id] ?? {};
            notes[node.id] = note;
            note.opened ??= performance.now();
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, label);
}

const forgetTips = (window: Page) =>
  window.evaluate(() => {
    const notes = (globalThis as unknown as { tipNotes: Record<string, TipNote> }).tipNotes;
    for (const id of Object.keys(notes)) delete notes[id];
  });

const readTips = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { tipNotes: Record<string, TipNote> }).tipNotes);

const paints = (window: Page, count = 4) =>
  window.evaluate(
    (times) =>
      new Promise<void>((done) => {
        let seen = 0;
        const next = () => (++seen >= times ? done() : requestAnimationFrame(next));
        next();
      }),
    count,
  );

test("Settings help opens after the pointer rests on its ⓘ, not as it passes over, and at once when another is open (#2844)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const settings = await openSettings(window, "general");
    await setWindowSize(app, window, 1440, 900);
    await showSettingsPage(window, "privacy");
    const infos = settings
      .getByTestId("network-traffic-item")
      .getByRole("button", { name: "More information", exact: true });
    const upper = infos.first();
    const lower = infos.nth(1);
    await expect(lower).toBeVisible();
    const centreOf = async (button: Locator) => {
      const box = await button.boundingBox();
      if (!box) throw new Error("The ⓘ isn't visible.");
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
    };
    const tipOf = async (button: Locator) =>
      window.locator(`[id="${await button.getAttribute("aria-describedby")}"]:not([hidden])`);
    const idOf = async (button: Locator) => (await button.getAttribute("aria-describedby")) ?? "";
    await recordTips(window, "More information");

    // A pointer on its way across the ⓘ, as it goes to a button beside it, opens nothing.
    const passing = await centreOf(upper);
    await window.mouse.move(passing.box.x - 60, passing.y);
    await window.mouse.move(passing.box.x + passing.box.width + 60, passing.y, { steps: 40 });
    await paints(window);
    const passed = (await readTips(window))[await idOf(upper)];
    expect(passed?.reached).toBeDefined();
    expect(passed?.opened).toBeUndefined();
    await expect(window.getByRole("tooltip")).toHaveCount(0);

    // Resting on it opens it, no sooner than the wait, with the ⓘ's own hover showing meanwhile.
    await window.mouse.move(0, 0);
    await forgetTips(window);
    const unlit = await lower.evaluate((each) => getComputedStyle(each).backgroundColor);
    const resting = await centreOf(lower);
    await window.mouse.move(resting.x - 40, resting.y);
    await window.mouse.move(resting.x, resting.y, { steps: 6 });
    await expect(await tipOf(lower)).toBeVisible();
    const rested = (await readTips(window))[await idOf(lower)];
    expect((rested?.opened ?? 0) - (rested?.reached ?? Number.POSITIVE_INFINITY)).toBeGreaterThan(
      490,
    );
    expect(rested?.hoverColour).toBeDefined();
    expect(rested?.hoverColour).not.toBe(unlit);

    // With that open, moving up to the next ⓘ opens its tip without the wait.
    await forgetTips(window);
    const next = await centreOf(upper);
    await window.mouse.move(next.x, next.y, { steps: 8 });
    await expect(await tipOf(upper)).toBeVisible();
    const followed = (await readTips(window))[await idOf(upper)];
    expect((followed?.opened ?? Number.POSITIVE_INFINITY) - (followed?.reached ?? 0)).toBeLessThan(
      500,
    );
    await expect(await tipOf(lower)).toHaveCount(0);
  } finally {
    await app.close();
  }
});
