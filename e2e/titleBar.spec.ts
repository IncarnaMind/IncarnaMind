import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { createDataFolder, dismissChatSetup, launchApp, nameMind, removeDataFolder } from "./app";

/*
 * The window's title bar (src/shared/titleBar.ts): on macOS there is no title
 * row of the system's; its traffic lights sit in the sidebar's header, and the
 * 44px band of pane headers is the title bar, dragged by its empty parts.
 * Playwright's mouse reaches the page without the system's hit test, so these
 * tests check each point's app-region (what Electron hands macOS) and that the
 * controls in the band still work. Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots of the band.
 */

test.skip(process.platform !== "darwin", "The traffic lights in the band are macOS's.");

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
/** The room the sidebar's header keeps for the traffic lights (styles.css). */
const LIGHTS_ROOM = 84;
/** macOS 26's traffic lights: 14px, 9px apart (src/main/titleBar.ts). */
const LIGHT = { size: 14, gap: 9 };

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

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  const width = await window.evaluate(() => innerWidth);
  await window.screenshot({
    path: join(SCREENSHOTS, `${name}.png`),
    clip: { x: 0, y: 0, width, height: 120 },
  });
}

/**
 * What a press at this point does to the window: "drag" moves it, "no-drag"
 * goes to the page. The innermost element there with an app-region decides,
 * as the regions Electron hands the system nest.
 */
function regionAt(window: Page, x: number, y: number): Promise<string> {
  return window.evaluate(
    (point) => {
      for (let at = document.elementFromPoint(point.x, point.y); at; at = at.parentElement) {
        const region = getComputedStyle(at).getPropertyValue("-webkit-app-region");
        if (region && region !== "none") return region;
      }
      return "none";
    },
    { x, y },
  );
}

/** The app-region at the middle of an element, after checking nothing covers it there. */
async function regionOf(window: Page, locator: Locator): Promise<string> {
  const box = await boxOf(locator);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const onTop = await locator.evaluate(
    (element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && element.contains(hit);
    },
    { x, y },
  );
  expect(onTop).toBe(true);
  return regionAt(window, x, y);
}

/** Slides the mouse onto an element, as a hand does, and clicks it. */
async function slideAndClick(window: Page, locator: Locator): Promise<void> {
  const box = await boxOf(locator);
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await window.mouse.down();
  await window.mouse.up();
}

/** Drags a tab by the mouse onto another's left or right half: before it or after it. */
async function dragTab(
  window: Page,
  tab: Locator,
  onto: Locator,
  side: "before" | "after",
): Promise<void> {
  const from = await boxOf(tab);
  const to = await boxOf(onto);
  await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 8 });
  await window.mouse.down();
  const x = side === "before" ? to.x + 12 : to.x + to.width - 12;
  await window.mouse.move(x, to.y + to.height / 2, { steps: 12 });
  await window.mouse.up();
}

const tabsOf = (window: Page) => window.getByTestId("mind-tab");
const titlesOf = (window: Page) => tabsOf(window).getByTestId("tab-title");
const tabNamed = (window: Page, title: string) =>
  window.locator(`[data-testid="mind-tab"][title=${JSON.stringify(title)}]`);

/** The window's frame as Electron sees it. */
function frameOf(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("No window.");
    return {
      bounds: window.getBounds(),
      content: window.getContentBounds(),
      title: window.getTitle(),
      background: window.getBackgroundColor(),
      lights: window.getWindowButtonPosition(),
    };
  });
}

/** The frame's colour in the theme the system shows (#1262): a Mac in Dark opens dark. */
const frameColour = (app: ElectronApplication) =>
  app.evaluate(({ nativeTheme }) => (nativeTheme.shouldUseDarkColors ? "#141518" : "#F4F5F7"));

test("no title row of the system's: the traffic lights sit in the sidebar's header, and the band drags the window while its tabs and buttons still work", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);

  // The page fills the whole window, title row and all; the window keeps its name for Mission Control.
  const frame = await frameOf(app);
  expect(frame.content).toEqual(frame.bounds);
  expect(frame.title).toBe("IncarnaMind");
  expect(frame.background.toUpperCase()).toBe(await frameColour(app));
  await expect(window.locator("html")).toHaveAttribute("data-title-bar", "inset");

  // The lights: on the line the headers' contents share (the sidebar's toggle is on it), the
  // first on the sidebar's icon column, all inside the room the sidebar's header keeps for
  // them, where the app's mark would be.
  const toggle = await boxOf(window.getByTestId("sidebar-toggle"));
  expect(frame.lights?.x).toBe(16);
  const lightsCentre = (frame.lights?.y ?? 0) + LIGHT.size / 2;
  expect(Math.abs(lightsCentre - (toggle.y + toggle.height / 2))).toBeLessThanOrEqual(1);
  expect(16 + 3 * LIGHT.size + 2 * LIGHT.gap).toBeLessThan(LIGHTS_ROOM);
  const header = window.getByTestId("sidebar-header");
  expect(await boxOf(header)).toMatchObject({ x: 0, y: 0, height: 44 });
  expect(await header.evaluate((element) => getComputedStyle(element).paddingLeft)).toBe(
    `${LIGHTS_ROOM}px`,
  );
  await expect(header.getByTestId("app-mark")).toBeHidden();
  await expect(header).not.toContainText("IncarnaMind");

  // Three Minds, each made with "+" in the band.
  const newTab = window.getByTestId("new-tab");
  expect(await regionOf(window, newTab)).toBe("no-drag");
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    const count = await tabsOf(window).count();
    await slideAndClick(window, newTab);
    await expect(tabsOf(window)).toHaveCount(count + 1);
    await nameMind(window, title);
  }
  await expect(titlesOf(window)).toHaveText(["Alpha", "Beta", "Gamma"]);
  await screenshot(window, "title-bar-band");

  // The band's empty parts drag the window: the sidebar's header, beside and between the
  // lights too, and the strip past the tabs. Tabs, their ✕, "+" and Export don't.
  const strip = await boxOf(window.getByTestId("tab-strip"));
  const plus = await boxOf(newTab);
  expect(await regionAt(window, 30, 22)).toBe("drag");
  expect(await regionAt(window, 120, 22)).toBe("drag");
  expect(await regionAt(window, plus.x + plus.width + 40, 22)).toBe("drag");
  expect(await regionAt(window, plus.x + plus.width + 40, 4)).toBe("drag");
  expect(await regionAt(window, strip.x + 40, 4)).toBe("drag");
  for (const control of [
    tabNamed(window, "Alpha"),
    tabNamed(window, "Gamma"),
    tabNamed(window, "Gamma").getByTestId("tab-close"),
    window.getByTestId("export-mind"),
  ]) {
    expect(await regionOf(window, control)).toBe("no-drag");
  }
  // The sidebar's divider, the 8px gap before the card, can still be grabbed in the band.
  const rod = await boxOf(window.locator("hr.pane-divider").first());
  expect(rod.width).toBe(8);
  expect(await regionAt(window, rod.x + 1, 22)).toBe("no-drag");
  expect(await regionAt(window, rod.x + 6, 22)).toBe("no-drag");
  // The 8px above the card moves the window.
  expect(await regionAt(window, rod.x + 400, 3)).toBe("drag");

  // A click on a tab shows its Mind; its ✕ closes it; a drag moves it.
  await slideAndClick(window, tabNamed(window, "Alpha"));
  await expect(window.locator('[role="tab"][aria-selected="true"]')).toContainText("Alpha");
  await dragTab(window, tabNamed(window, "Alpha"), tabNamed(window, "Gamma"), "after");
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma", "Alpha"]);
  await window.mouse.move(400, 400, { steps: 4 });
  await slideAndClick(window, tabNamed(window, "Beta").getByTestId("tab-close"));
  await expect(titlesOf(window)).toHaveText(["Gamma", "Alpha"]);

  // However narrow the sidebar, the tabs start right of the lights' room.
  const divider = window.locator("hr.pane-divider").first();
  const at = await boxOf(divider);
  await window.mouse.move(at.x - 30, 400);
  await window.mouse.move(at.x - 3, 400, { steps: 6 });
  await window.mouse.down();
  await window.mouse.move(at.x - 400, 400, { steps: 10 });
  await window.mouse.up();
  expect((await boxOf(tabsOf(window).first())).x).toBeGreaterThanOrEqual(LIGHTS_ROOM);
  await screenshot(window, "title-bar-narrow-sidebar");

  // A second group's strip carries the band on: its empty part drags, its tabs and buttons click.
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  const second = window.getByTestId("tab-strip").nth(1);
  const secondBox = await boxOf(second);
  expect(secondBox).toMatchObject({ y: 8, height: 36 });
  const secondPlus = await boxOf(second.getByTestId("new-tab"));
  expect(await regionAt(window, secondPlus.x + secondPlus.width + 20, 22)).toBe("drag");
  for (const control of [
    second.getByRole("tab"),
    second.getByTestId("tab-close"),
    second.getByTestId("group-menu"),
  ]) {
    expect(await regionOf(window, control)).toBe("no-drag");
  }
  await screenshot(window, "title-bar-groups");
  await slideAndClick(window, second.getByTestId("tab-close"));
  await expect(window.getByTestId("tab-strip")).toHaveCount(1);

  // The Library opens as a tab in the same band (#119): past the tabs the band still drags,
  // and the Library's tab and its ✕ don't.
  await slideAndClick(window, window.getByTestId("open-library"));
  const libraryTab = window.getByTestId("library-tab");
  await expect(libraryTab).toHaveAttribute("aria-selected", "true");
  const plusNow = await boxOf(newTab);
  expect(await regionAt(window, plusNow.x + plusNow.width + 40, 22)).toBe("drag");
  expect(await regionOf(window, libraryTab.getByTestId("tab-title"))).toBe("no-drag");
  expect(await regionOf(window, libraryTab.getByTestId("tab-close"))).toBe("no-drag");
  await app.close();
});

test("in full screen the traffic lights hide, so the sidebar's header gives their room back to the app's mark, and takes it again on leaving", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const header = window.getByTestId("sidebar-header");
  const html = window.locator("html");
  const paddingLeft = () => header.evaluate((element) => getComputedStyle(element).paddingLeft);
  expect(await paddingLeft()).toBe(`${LIGHTS_ROOM}px`);

  // What the window says as it finishes going full screen and coming back. macOS takes
  // a window full screen only while its app is in front, which a test running beside
  // the User's own apps can't count on (nor take the front from them), so the test
  // sends the window's own events rather than asking macOS for full screen.
  const say = (event: "enter-full-screen" | "leave-full-screen") =>
    app.evaluate(({ BrowserWindow }, name) => {
      BrowserWindow.getAllWindows()[0]?.emit(name);
    }, event);

  await say("enter-full-screen");
  await expect(html).toHaveAttribute("data-full-screen", "");
  expect(await paddingLeft()).toBe("16px");
  const mark = header.getByTestId("app-mark");
  await expect(mark).toBeVisible();
  expect((await boxOf(mark)).x).toBe(16);
  await screenshot(window, "title-bar-full-screen");

  await say("leave-full-screen");
  await expect(html).not.toHaveAttribute("data-full-screen");
  expect(await paddingLeft()).toBe(`${LIGHTS_ROOM}px`);
  await expect(mark).toBeHidden();
  await app.close();
});
