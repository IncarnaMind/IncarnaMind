import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import type { TestHooks } from "../src/shared/testHooks";
import {
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  leavingCopies,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setMotionSpeed,
  setWindowSize,
} from "./app";

/*
 * Hiding and showing the sidebar (#219): Cmd+\ (Ctrl+\), the button, View >
 * Hide Sidebar, peeking at the left edge, dragging the divider shut, and
 * what is remembered; and how it moves (#855): the sidebar and the card's
 * edge slide together, Reduced fades the sidebar, Off is instant. Driven with
 * a real mouse and keyboard; where a test looks during a slide, the motion
 * runs slowed down, and it waits for it to settle, not for a time.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const isMac = process.platform === "darwin";
const COMMAND = isMac ? "Meta" : "Control";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Where the sidebar is: its box in the window, or null when it is out of sight. */
async function sidebarLeft(window: Page): Promise<number> {
  const box = await window.getByTestId("sidebar").boundingBox();
  if (!box) throw new Error("The sidebar has no box.");
  return box.x;
}

/** Whether the sidebar takes room from the card: the card starts at 8px when it is hidden. */
async function cardLeft(window: Page): Promise<number> {
  const box = await window.getByTestId("card").boundingBox();
  if (!box) throw new Error("The card has no box.");
  return box.x;
}

const isHidden = (window: Page) =>
  window.getByTestId("sidebar-panel").evaluate((panel) => panel.hasAttribute("data-hidden"));

interface Edges {
  left: number;
  right: number;
}

interface Frame {
  sidebar: Edges;
  card: Edges;
  /** The first tab group's band and its Split button, while the window shows them. */
  band: Edges | null;
  split: Edges | null;
}

/** The sidebar's and the card's edges as drawn now, in one frame, and whether anything moves. */
function edges(window: Page): Promise<Frame & { moving: boolean }> {
  return window.evaluate(() => {
    const maybeEdgesOf = (testId: string) => {
      const box = document.querySelector(`[data-testid="${testId}"]`)?.getBoundingClientRect();
      return box && box.width > 0 ? { left: box.left, right: box.right } : null;
    };
    const edgesOf = (testId: string) => {
      const edges = maybeEdgesOf(testId);
      if (!edges) throw new Error(`No ${testId} on screen.`);
      return edges;
    };
    const hooks = (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks;
    return {
      sidebar: edgesOf("sidebar"),
      card: edgesOf("card"),
      band: maybeEdgesOf("tab-strip"),
      split: maybeEdgesOf("split-group"),
      moving: (hooks?.motionRunning() ?? 0) > 0,
    };
  });
}

/** Every frame the test sees while the sidebar slides, until nothing moves, and where it settled. */
async function slide(window: Page): Promise<{ frames: Frame[]; settled: Frame }> {
  const frames: Frame[] = [];
  for (;;) {
    const frame = await edges(window);
    if (!frame.moving) return { frames, settled: frame };
    frames.push(frame);
  }
}

/** Out of the window, and the card 8px from the window's left edge. */
function expectHiddenAtRest(settled: Frame): void {
  expect(settled.sidebar.right).toBeLessThanOrEqual(0);
  expect(settled.card.left).toBeCloseTo(8, 0);
}

/** At the window's left edge, and the card 8px right of it. */
function expectShownAtRest(settled: Frame): void {
  expect(settled.sidebar.left).toBeCloseTo(0, 0);
  expect(settled.card.left - settled.sidebar.right).toBeCloseTo(8, 0);
}

/**
 * One motion: in every frame the card's edge keeps 8px from the sidebar, its
 * right edge is where it settles, so nothing jumps at the end, and the tab
 * band reaches it, never falling short. What is in the band rides the card's
 * left edge at its new place.
 */
function expectTogether(frames: Frame[], settled: Frame): void {
  for (const frame of frames) {
    expect(Math.abs(frame.card.left - frame.sidebar.right - 8)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.card.right - settled.card.right)).toBeLessThanOrEqual(1);
    if (frame.band) expect(Math.abs(frame.band.right - frame.card.right)).toBeLessThanOrEqual(1);
    if (frame.split && settled.split) {
      const offset = frame.split.left - frame.card.left;
      expect(Math.abs(offset - (settled.split.left - settled.card.left))).toBeLessThanOrEqual(1);
    }
  }
}

/** Part way out, across the window's left edge: at neither end. */
const midway = (frame: Frame) => frame.sidebar.left < -1 && frame.sidebar.right > 1;

/** The View menu's item for the sidebar, as the app's menu has it. */
function viewMenuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((item) =>
      ["View", "显示", "查看"].includes(item.label),
    );
    return view?.submenu?.items.map((item) => item.label) ?? [];
  });
}

function clickViewMenu(app: ElectronApplication, label: string): Promise<void> {
  return app.evaluate(({ Menu }, wanted) => {
    const view = Menu.getApplicationMenu()?.items.find((item) =>
      ["View", "显示", "查看"].includes(item.label),
    );
    view?.submenu?.items.find((item) => item.label === wanted)?.click();
  }, label);
}

test("the shortcut, the button and the View menu hide and show the sidebar, and the User's place stays", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1280, 800);

  // A Mind with some text in it, the focus in it.
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toBeFocused();
  await window.keyboard.type("A place to keep");
  expect(await sidebarLeft(window)).toBe(0);
  expect(await cardLeft(window)).toBeGreaterThan(200);
  await screenshot(window, "shown");

  // The keyboard: the focus stays where it was, and the Mind keeps its state.
  await window.keyboard.press(`${COMMAND}+Backslash`);
  await expect.poll(() => isHidden(window)).toBe(true);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("A place to keep");
  await expect.poll(() => cardLeft(window)).toBe(8);
  await expect(window.getByTestId("sidebar-announcement")).toHaveText("Sidebar hidden");
  await expect.poll(() => viewMenuLabels(app)).toContain("Show Sidebar");
  await screenshot(window, "hidden");
  // Not a place the pointer can reach by accident: the sidebar is out of the window.
  expect(await sidebarLeft(window)).toBeLessThan(0);

  await window.keyboard.press(`${COMMAND}+Backslash`);
  await expect.poll(() => isHidden(window)).toBe(false);
  await expect(editor).toBeFocused();
  await expect(window.getByTestId("sidebar-announcement")).toHaveText("Sidebar shown");
  await expect.poll(() => cardLeft(window)).toBeGreaterThan(200);
  await expect.poll(() => viewMenuLabels(app)).toContain("Hide Sidebar");

  // The button, with the mouse: it says what it does, and keeps the keyboard's focus on itself.
  const button = window.getByTestId("sidebar-toggle");
  await expect(button).toHaveAccessibleName("Hide sidebar");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await button.hover();
  await window.mouse.down();
  await window.mouse.up();
  await expect.poll(() => isHidden(window)).toBe(true);
  await expect(button).toHaveAccessibleName("Show sidebar");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await window.mouse.move(700, 400, { steps: 6 });
  await button.click();
  await expect.poll(() => isHidden(window)).toBe(false);

  // The same button, by keyboard: the Tab makes the keyboard the last input, so the focus the
  // button takes matches :focus-visible and Enter hides the sidebar, as when a person tabs to it.
  await window.keyboard.press("Tab");
  await button.focus();
  await window.keyboard.press("Enter");
  await expect.poll(() => isHidden(window)).toBe(true);
  await expect(window.getByTestId("sidebar-toggle")).toBeFocused();
  // It still goes out of the window: the focus it had in its header is no reason to stay over the
  // content. A peek is the pointer or the keyboard arriving after it is hidden.
  await motionSettled(window);
  await expect(window.getByTestId("sidebar-panel")).not.toHaveAttribute("data-open", "true");
  expectHiddenAtRest(await edges(window));
  await window.keyboard.press("Enter");
  await expect.poll(() => isHidden(window)).toBe(false);
  await expect(window.getByTestId("sidebar-toggle")).toBeFocused();

  // View > Hide Sidebar.
  await clickViewMenu(app, "Hide Sidebar");
  await expect.poll(() => isHidden(window)).toBe(true);
  await clickViewMenu(app, "Show Sidebar");
  await expect.poll(() => isHidden(window)).toBe(false);

  // The Mind is the one that was open, named by its first line.
  await expect(frontMindName(window)).toHaveText("A place to keep");
  await app.close();
});

test("a hidden sidebar peeks at the left edge, and keyboard focus shows it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1280, 800);
  await window.keyboard.press(`${COMMAND}+Backslash`);
  await expect.poll(() => isHidden(window)).toBe(true);
  const panel = window.getByTestId("sidebar-panel");
  // Until it has slid away, it covers the left edge the pointer goes to.
  await motionSettled(window);

  // The pointer slides to the left edge: the sidebar slides out over the content, which stays.
  await setMotionSpeed(window, 0.1);
  await window.mouse.move(600, 300);
  await window.mouse.move(2, 300, { steps: 12 });
  await expect(panel).toHaveAttribute("data-open", "true");
  await expect.poll(async () => midway(await edges(window))).toBe(true);
  expect(await cardLeft(window)).toBe(8);
  await setMotionSpeed(window, 1);
  await expect.poll(() => sidebarLeft(window)).toBe(0);
  expect(await cardLeft(window)).toBe(8);
  await screenshot(window, "peek");

  // It can be used while it's out, and goes back when the pointer leaves.
  await window.mouse.move(120, 300, { steps: 4 });
  await expect(panel).toHaveAttribute("data-open", "true");
  await window.mouse.move(700, 300, { steps: 12 });
  await expect(panel).not.toHaveAttribute("data-open", "true");
  await expect.poll(() => sidebarLeft(window)).toBeLessThan(0);

  // Keyboard focus into it (Tab, as ⌘K will) shows it, and leaving the sidebar hides it.
  const allDocuments = window.getByTestId("open-library");
  await allDocuments.focus();
  await window.keyboard.press("Shift+Tab");
  await window.keyboard.press("Tab");
  await expect(allDocuments).toBeFocused();
  await expect(panel).toHaveAttribute("data-open", "true");
  await window.getByTestId("tab-group").click({ position: { x: 400, y: 300 } });
  await expect(panel).not.toHaveAttribute("data-open", "true");
  await app.close();
});

test("dragging the divider past its minimum hides the sidebar, and its width and the choice survive a restart", async () => {
  const first = await launchApp(dataDir);
  let { app, window } = first;
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1280, 800);

  // Resize it: the divider between its minimum and maximum.
  const rod = window.getByTestId("sidebar-resize");
  let box = await rod.boundingBox();
  if (!box) throw new Error("No divider.");
  await window.mouse.move(box.x + box.width / 2, 400, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(box.x + 60, 400, { steps: 10 });
  await window.mouse.up();
  await expect.poll(() => window.getByTestId("sidebar").evaluate((el) => el.clientWidth)).toBe(304);
  // Below the minimum but not far past: it stops at the minimum.
  box = await rod.boundingBox();
  if (!box) throw new Error("No divider.");
  await window.mouse.move(box.x + box.width / 2, 400, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(154, 400, { steps: 10 });
  await window.mouse.up();
  await expect.poll(() => window.getByTestId("sidebar").evaluate((el) => el.clientWidth)).toBe(165);
  expect(await isHidden(window)).toBe(false);

  // Far past the minimum: it folds away, and the focus it held comes to the button that shows it.
  await window.getByTestId("open-library").focus();
  box = await rod.boundingBox();
  if (!box) throw new Error("No divider.");
  await window.mouse.move(box.x + box.width / 2, 400, { steps: 4 });
  await window.mouse.down();
  await window.mouse.move(40, 400, { steps: 12 });
  await window.mouse.up();
  await expect.poll(() => isHidden(window)).toBe(true);
  await expect(window.getByTestId("sidebar-toggle")).toBeFocused();

  // Restart: hidden, and when shown again it has the width it had before it folded.
  await app.close();
  ({ app, window } = await launchApp(dataDir));
  await setWindowSize(app, window, 1280, 800);
  await expect.poll(() => isHidden(window)).toBe(true);
  await expect.poll(() => cardLeft(window)).toBe(8);
  await window.keyboard.press(`${COMMAND}+Backslash`);
  await expect.poll(() => isHidden(window)).toBe(false);
  expect(await window.getByTestId("sidebar").evaluate((el) => el.clientWidth)).toBe(165);

  // Shown, and kept shown after another restart.
  await app.close();
  ({ app, window } = await launchApp(dataDir));
  expect(await isHidden(window)).toBe(false);
  await app.close();
});

test("the button, its announcement and the View menu are in Chinese too", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1280, 800);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await expect(window.getByTestId("sidebar-toggle")).toHaveAccessibleName("隐藏侧边栏");
  await expect.poll(() => viewMenuLabels(app)).toContain("隐藏侧边栏");
  await clickViewMenu(app, "隐藏侧边栏");
  await expect.poll(() => isHidden(window)).toBe(true);
  await expect(window.getByTestId("sidebar-announcement")).toHaveText("侧边栏已隐藏");
  await expect(window.getByTestId("sidebar-toggle")).toHaveAccessibleName("显示侧边栏");
  await expect.poll(() => viewMenuLabels(app)).toContain("显示侧边栏");
  await screenshot(window, "hidden-zh");
  await app.close();
});

const pressShortcut = (window: Page) => window.keyboard.press("ControlOrMeta+Backslash");

async function pressButton(window: Page): Promise<void> {
  await window.getByTestId("sidebar-toggle").hover();
  await window.mouse.down();
  await window.mouse.up();
}

/** Whether the sidebar can be seen: Reduced and Off leave it in place, transparent, while hidden. */
const sidebarSeen = (window: Page) =>
  window
    .getByTestId("sidebar")
    .evaluate((aside) => aside.checkVisibility({ opacityProperty: true }));

test("hiding and showing slide the sidebar and the card's edge together, 8px apart, at 1,440 and 1,100 px in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // Two tabs, so the band shows.
  await newMind(window);
  await newMind(window);
  await expect(window.getByTestId("tab-strip")).toBeVisible();
  const sizes = [
    { language: "en", width: 1440, hide: pressShortcut, show: pressButton },
    { language: "zh-CN", width: 1440, hide: pressButton, show: pressShortcut },
    { language: "en", width: 1100, hide: pressShortcut, show: pressShortcut },
    { language: "zh-CN", width: 1100, hide: pressButton, show: pressButton },
  ] as const;
  for (const { language, width, hide, show } of sizes) {
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 800);
    await motionSettled(window);
    await setMotionSpeed(window, 0.5);
    for (const hidden of [true, false]) {
      await (hidden ? hide : show)(window);
      await expect
        .poll(async () => midway(await edges(window)), {
          message: `${language} at ${width}: seen part way`,
        })
        .toBe(true);
      const { frames, settled } = await slide(window);
      expect(await isHidden(window)).toBe(hidden);
      expectTogether(frames, settled);
      if (hidden) expectHiddenAtRest(settled);
      else expectShownAtRest(settled);
    }
    await setMotionSpeed(window, 1);
  }
  await app.close();
});

test("a second press during the slide turns it around from where it is, and two quick presses end shown", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 800);

  await pressShortcut(window);
  await pressShortcut(window);
  await motionSettled(window);
  expect(await isHidden(window)).toBe(false);
  expectShownAtRest(await edges(window));

  // Slowed down, so the second press lands part way: the slide turns there, from neither end.
  await setMotionSpeed(window, 0.25);
  await pressShortcut(window);
  await expect.poll(async () => midway(await edges(window))).toBe(true);
  await pressShortcut(window);
  await expect.poll(() => isHidden(window)).toBe(false);
  const turned = await edges(window);
  expect(midway(turned)).toBe(true);
  const { frames, settled } = await slide(window);
  expectTogether([turned, ...frames], settled);
  expectShownAtRest(settled);
  await app.close();
});

test("Reduced fades the sidebar and places the card at once; Off hides and shows it at once", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await setWindowSize(app, window, 1440, 800);
  await window.emulateMedia({ reducedMotion: "reduce" });
  await expect(window.locator("html")).toHaveAttribute("data-motion", "reduced");
  const shown = await edges(window);
  await setMotionSpeed(window, 0.1);

  // Hiding: a copy fades where the sidebar was, unmoved, with the card already at the window's left.
  await pressShortcut(window);
  await expect.poll(async () => (await leavingCopies(window))[0]?.opacity ?? 1).toBeLessThan(1);
  const [copy] = await leavingCopies(window);
  expect(copy?.box.left).toBeCloseTo(shown.sidebar.left, 0);
  expect(copy?.transform).toBe("none");
  expect((await edges(window)).card.left).toBeCloseTo(8, 0);
  expect(await sidebarSeen(window)).toBe(false);
  await motionSettled(window);

  // Showing: it fades in where it rests, with the card already beside it.
  await pressShortcut(window);
  await expect.poll(() => isHidden(window)).toBe(false);
  const fadingIn = await edges(window);
  expect(fadingIn.sidebar.left).toBeCloseTo(0, 0);
  expect(fadingIn.card.left).toBeCloseTo(shown.card.left, 0);
  expect(
    await window
      .getByTestId("sidebar")
      .evaluate((aside) => Number(getComputedStyle(aside).opacity)),
  ).toBeLessThan(1);
  await motionSettled(window);
  await setMotionSpeed(window, 1);

  // Off: each change is there at once, and nothing moves.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ device: { motion: "off" } });
  });
  await expect(window.locator("html")).toHaveAttribute("data-motion", "off");
  await pressShortcut(window);
  await expect.poll(() => isHidden(window)).toBe(true);
  const hidden = await edges(window);
  expect(hidden.moving).toBe(false);
  expect(hidden.card.left).toBeCloseTo(8, 0);
  expect(await sidebarSeen(window)).toBe(false);
  await pressShortcut(window);
  await expect.poll(() => isHidden(window)).toBe(false);
  const back = await edges(window);
  expect(back.moving).toBe(false);
  expectShownAtRest(back);
  expect(await sidebarSeen(window)).toBe(true);
  await app.close();
});
