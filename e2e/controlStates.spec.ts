import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  focusRingShows,
  launchApp,
  nameMind,
  newMind,
  paintOf,
  pointAt,
  removeDataFolder,
  scaleOf,
  setWindowSize,
  tabTo,
  tokenColor,
} from "./app";

/*
 * Every control answers hover, press and keyboard focus (#2731): a sidebar row or a tab steps its
 * surface on hover and once more on press, the Ask button scales to 98% on press (and only then),
 * and the sidebar's and the assistant's resize handles show the focus ring when a key reaches them.
 * Motion is the stylesheet's instant state, with no transition of its own.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const lightness = (colour: string) => {
  const channels = colour.match(/[\d.]+/g)?.map(Number) ?? [];
  return (channels[0] ?? 0) + (channels[1] ?? 0) + (channels[2] ?? 0);
};

async function twoNotes(window: Page): Promise<void> {
  await newMind(window);
  await nameMind(window, "Tides");
  await newMind(window);
  await nameMind(window, "Moon");
}

test("a sidebar row steps its surface on hover and once more on press", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    await twoNotes(window);
    const row = window.getByTestId("mind-row").filter({ hasText: "Tides" });
    await expect(row).toBeVisible();
    await window.mouse.move(0, 0);
    const resting = (await paintOf(row)).background;

    await pointAt(window, row);
    await expect
      .poll(async () => (await paintOf(row)).background)
      .toBe(await tokenColor(window, "--color-hover"));
    const hovered = (await paintOf(row)).background;
    expect(hovered).not.toBe(resting);

    await window.mouse.down();
    await expect
      .poll(async () => (await paintOf(row)).background)
      .toBe(await tokenColor(window, "--color-press"));
    const pressed = (await paintOf(row)).background;
    expect(lightness(pressed), "pressed is a step past hovered").toBeLessThan(lightness(hovered));
    await window.mouse.up();
  } finally {
    await app.close();
  }
});

test("a tab steps its surface on hover and once more on press", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    await twoNotes(window);
    const inner = window.getByRole("tab", { selected: false }).first().locator(".tab-inner");
    await expect(inner).toBeVisible();
    await window.mouse.move(0, 0);
    const resting = (await paintOf(inner)).background;

    await pointAt(window, inner);
    await expect
      .poll(async () => (await paintOf(inner)).background)
      .toBe(await tokenColor(window, "--color-tab-hover"));
    const hovered = (await paintOf(inner)).background;
    expect(hovered).not.toBe(resting);

    await window.mouse.down();
    await expect
      .poll(async () => (await paintOf(inner)).background)
      .toBe(await tokenColor(window, "--color-tab-press"));
    const pressed = (await paintOf(inner)).background;
    expect(lightness(pressed), "pressed is a step past hovered").toBeLessThan(lightness(hovered));
    await window.mouse.move(0, 0);
    await window.mouse.up();
  } finally {
    await app.close();
  }
});

test("the Ask button darkens on hover and scales to 98% only while it is pressed", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type("Is anyone there?");
    const ask = window.getByTestId("composer-ask");
    await expect(ask).toBeEnabled();
    const transform = () => ask.evaluate((element) => getComputedStyle(element).transform);
    await window.mouse.move(0, 0);
    const resting = (await paintOf(ask)).background;
    expect(await transform()).toBe("none");

    await pointAt(window, ask);
    await expect
      .poll(async () => (await paintOf(ask)).background)
      .toBe(await tokenColor(window, "--color-ink-strong"));
    expect((await paintOf(ask)).background).not.toBe(resting);
    expect(await transform(), "hover alone doesn't scale it").toBe("none");

    await window.mouse.down();
    await expect.poll(async () => scaleOf(await transform())).toBeCloseTo(0.98, 2);
    // Let go away from the button: pressing it was all this checks.
    await window.mouse.move(0, 0);
    await window.mouse.up();
    await expect.poll(transform).toBe("none");
  } finally {
    await app.close();
  }
});

test("the sidebar's and the assistant's resize handles show the focus ring when a key reaches them", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1440, 900);
    await newMind(window);
    for (const id of ["sidebar-resize", "assistant-resize"]) {
      const handle = window.getByTestId(id);
      await expect(handle).toBeVisible();
      await tabTo(window, handle, 120);
      expect(await focusRingShows(window), `${id} shows the ring`).toBe(true);
    }
    // The ring is the handle's own: a 2px accent outline, as every control's, not only a hairline.
    const sidebar = window.getByTestId("sidebar-resize");
    await sidebar.focus();
    const outline = await sidebar.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline).toEqual({ style: "solid", width: 2 });
  } finally {
    await app.close();
  }
});
