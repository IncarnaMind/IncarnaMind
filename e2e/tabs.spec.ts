import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  dragTabTo,
  enterContent,
  frontMind,
  frontMindName,
  launchApp,
  nameMind,
  newMind as newMindFromMenu,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  splitFromTabMenu,
  WINDOW_SIZE,
} from "./app";

/*
 * Tabs in one group (DESIGN.md, Components: Mind tabs): several Minds open at
 * once, as in a browser; tabs and groups side by side are in tabGroups.spec.ts.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save a screenshot of the strip.
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

const tabsOf = (window: Page) => window.getByTestId("mind-tab");
const titlesOf = (window: Page) => tabsOf(window).getByTestId("tab-title");
const activeTab = (window: Page) => window.locator('[role="tab"][aria-selected="true"]');
/** The tab of the Mind with this title (a tab's tooltip is its full title). */
const tabNamed = (window: Page, title: string) =>
  window.locator(`[data-testid="mind-tab"][title=${JSON.stringify(title)}]`);
const sidebarMind = (window: Page, title: string) =>
  window.getByTestId("mind-list-item").filter({ hasText: title });

/** Creates a Mind with "+" in the tab strip, in a new tab, and names it. */
async function newMind(window: Page, title: string): Promise<void> {
  const count = await tabsOf(window).count();
  await window.getByTestId("new-tab").click();
  await expect(tabsOf(window)).toHaveCount(count + 1);
  await nameMind(window, title);
  await expect(activeTab(window).getByTestId("tab-title")).toHaveText(title);
}

test("Minds open as tabs; the sidebar shows an open one, opens another in a new tab without replacing the Mind in view, and ⌘-click opens it to the side", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // No tab yet: the empty state, and no Export.
  await expect(window.getByTestId("mind-none-open")).toBeVisible();
  await expect(window.getByTestId("export-mind")).toHaveCount(0);

  for (const title of ["Alpha", "Beta", "Gamma"]) await newMind(window, title);
  await expect(titlesOf(window)).toHaveText(["Alpha", "Beta", "Gamma"]);
  await expect(activeTab(window)).toHaveCount(1);
  await expect(activeTab(window)).toContainText("Gamma");
  await expect(window.getByRole("tablist", { name: "Group 1" })).toBeVisible();

  // A Mind already open: the sidebar shows its tab.
  await sidebarMind(window, "Alpha").click();
  await expect(tabsOf(window)).toHaveCount(3);
  await expect(activeTab(window)).toContainText("Alpha");
  const alphaId = await sidebarMind(window, "Alpha").getAttribute("data-mind-id");
  await expect(window.getByTestId("mind-pane")).toHaveAttribute("data-mind-id", `${alphaId}`);
  const panel = window.getByRole("tabpanel");
  await expect(panel).toHaveAttribute(
    "aria-labelledby",
    `${await activeTab(window).getAttribute("id")}`,
  );

  // Clicking a tab shows its Mind.
  await tabNamed(window, "Beta").click();
  await expect(activeTab(window)).toContainText("Beta");

  // Down to one tab; a click on another Mind opens it in a new tab after it: the Mind in view stays.
  await tabNamed(window, "Alpha").getByTestId("tab-close").click();
  await tabNamed(window, "Gamma").getByTestId("tab-close").click();
  await expect(titlesOf(window)).toHaveText(["Beta"]);
  await sidebarMind(window, "Gamma").click();
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma"]);
  await expect(activeTab(window)).toContainText("Gamma");

  // ⌘-click (Ctrl-click) selects it and opens nothing.
  const groups = window.getByTestId("tab-group");
  await sidebarMind(window, "Alpha").click({ modifiers: ["ControlOrMeta"] });
  await expect(groups).toHaveCount(1);
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma"]);
  // The open Mind and Alpha are selected, so their menu has only what applies to both; Esc clears.
  await window.keyboard.press("Escape");
  // The menu's "Open in new tab" and a middle click each open it in a new tab of the same group.
  await pointAndClick(window, sidebarMind(window, "Alpha"), { button: "right" });
  await pointAndClick(window, window.getByTestId("mind.openTab"));
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma", "Alpha"]);
  await expect(activeTab(window)).toContainText("Alpha");
  await expect(groups).toHaveCount(1);
  await tabNamed(window, "Alpha").getByTestId("tab-close").click();
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma"]);
  await pointAndClick(window, sidebarMind(window, "Alpha"), { button: "middle" });
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma", "Alpha"]);
  await expect(groups).toHaveCount(1);
  // Split to the right, in the tab's menu, is the one way to put it beside.
  await splitFromTabMenu(window);
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(1).getByTestId("tab-title")).toHaveText(["Alpha"]);
  await app.close();
});

test("tabs close, reopen, move and switch by mouse and keyboard; a deleted Mind's tab closes; the last tab closed shows the empty state", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // ⌘T (Ctrl+T) is a new Mind in a new tab.
  for (const title of ["Alpha", "Beta", "Gamma"]) {
    const count = await tabsOf(window).count();
    await window.keyboard.press("ControlOrMeta+t");
    await expect(tabsOf(window)).toHaveCount(count + 1);
    await nameMind(window, title);
    await frontMind(window).getByTestId("mind-editor").blur();
  }
  await expect(titlesOf(window)).toHaveText(["Alpha", "Beta", "Gamma"]);

  // Ctrl+Tab and Ctrl+Shift+Tab cycle through the group's tabs.
  await window.keyboard.press("Control+Tab");
  await expect(activeTab(window)).toContainText("Alpha");
  await window.keyboard.press("Control+Shift+Tab");
  await expect(activeTab(window)).toContainText("Gamma");

  // The tabs are a tab list: the arrow keys move to the next tab and show it.
  await activeTab(window).focus();
  await window.keyboard.press("ArrowLeft");
  await expect(activeTab(window)).toContainText("Beta");
  await expect(activeTab(window)).toBeFocused();
  await expect(tabsOf(window).and(window.locator('[tabindex="0"]'))).toHaveCount(1);

  // Dragged with the mouse onto the right half of Gamma, Alpha moves after it; onto Beta's left half, before it.
  const gamma = await boxOf(tabNamed(window, "Gamma"));
  await dragTabTo(window, tabNamed(window, "Alpha"), {
    x: gamma.x + gamma.width - 12,
    y: gamma.y + gamma.height / 2,
  });
  await expect(titlesOf(window)).toHaveText(["Beta", "Gamma", "Alpha"]);
  const beta = await boxOf(tabNamed(window, "Beta"));
  await dragTabTo(window, tabNamed(window, "Alpha"), { x: beta.x + 12, y: beta.y + 17 });
  await expect(titlesOf(window)).toHaveText(["Alpha", "Beta", "Gamma"]);

  // A middle click closes a tab; closing the shown one shows the tab after it.
  await tabNamed(window, "Beta").click();
  await tabNamed(window, "Beta").click({ button: "middle" });
  await expect(titlesOf(window)).toHaveText(["Alpha", "Gamma"]);
  await expect(activeTab(window)).toContainText("Gamma");
  // ⌘W (Ctrl+W) closes the shown tab, and not the window, and says so with Reopen.
  await window.keyboard.press("ControlOrMeta+w");
  await expect(titlesOf(window)).toHaveText(["Alpha"]);
  await expect(activeTab(window)).toContainText("Alpha");
  expect(window.isClosed()).toBe(false);
  const line = window.getByTestId("undo-line");
  await expect(line.getByTestId("undo-message")).toHaveText("Closed “Gamma”");
  // ⇧⌘T reopens it where it was; the line's Reopen does the same.
  await window.keyboard.press("ControlOrMeta+Shift+t");
  await expect(titlesOf(window)).toHaveText(["Alpha", "Gamma"]);
  await expect(activeTab(window)).toContainText("Gamma");
  await window.keyboard.press("ControlOrMeta+w");
  await line.getByTestId("tab-notice-reopen").click();
  await expect(titlesOf(window)).toHaveText(["Alpha", "Gamma"]);

  // Deleting a Mind closes its tab.
  const gammaRow = window.getByTestId("mind-row").filter({ hasText: "Gamma" });
  await gammaRow.hover();
  await gammaRow.getByTestId("mind-menu").click();
  await gammaRow.getByTestId("mind.delete").click();
  await expect(titlesOf(window)).toHaveText(["Alpha"]);
  await expect(activeTab(window)).toContainText("Alpha");

  // Closing the last tab shows the empty state.
  await activeTab(window).getByTestId("tab-close").click();
  await expect(tabsOf(window)).toHaveCount(0);
  await expect(window.getByTestId("mind-none-open")).toBeVisible();
  await expect(window.getByTestId("mind-pane")).toHaveCount(0);
  await expect(window.getByTestId("export-mind")).toHaveCount(0);
  await app.close();
});

test("a Mind's tab is renamed in place: a double-click or F2, Enter saves, Esc changes nothing, and a blank name goes back to the first line", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window, "Alpha notes");
  await window.keyboard.type("Tide tables");
  const tab = tabsOf(window).first();
  await tab.getByTestId("tab-title").dblclick();
  const field = tab.getByTestId("tab-rename");
  await expect(field).toBeFocused();
  await field.fill("Alpha, revised");
  await field.press("Enter");
  await expect(titlesOf(window)).toHaveText(["Alpha, revised"]);
  await expect(sidebarMind(window, "Alpha, revised")).toHaveCount(1);
  await expect(tab).toBeFocused();

  await window.keyboard.press("F2");
  await expect(field).toBeFocused();
  await field.fill("Not this");
  await field.press("Escape");
  await expect(titlesOf(window)).toHaveText(["Alpha, revised"]);
  await expect(tab).toBeFocused();
  // Blank, the typed name goes and the first line names the Mind again; its text is as it was.
  await window.keyboard.press("F2");
  await expect(field).toHaveAttribute("placeholder", "Alpha, revised");
  await field.fill("   ");
  await field.press("Enter");
  await expect(titlesOf(window)).toHaveText(["Tide tables"]);
  await expect(window.getByTestId("mind-editor")).toHaveText("Tide tables");
  await app.close();
});

test("F2 on a tab right after a rename ended keeps its field when the frame the tab's focus waits for is late", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window, "Alpha notes");
  const tab = tabsOf(window).first();
  await tab.getByTestId("tab-title").dblclick();
  const field = tab.getByTestId("tab-rename");
  await expect(field).toBeFocused();
  // As on a busy runner, whatever the app asks of the next frame comes a moment after it.
  await window.evaluate(() => {
    const frame = globalThis.requestAnimationFrame.bind(globalThis);
    globalThis.requestAnimationFrame = (callback) =>
      frame(() => void setTimeout(() => callback(performance.now()), 300));
  });
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await tab.focus();
  await window.keyboard.press("F2");
  await expect(field).toBeFocused();
  // Asked after the app's own, so it comes after it: the field still has the focus.
  await window.evaluate(() => new Promise((late) => requestAnimationFrame(() => late(null))));
  await expect(field).toBeFocused();
  await app.close();
});

test("open tabs and their order come back after a restart, behind Home", async () => {
  const first = await launchApp(dataDir);
  await dismissChatSetup(first.window);
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) await newMind(first.window, title);
  // Delta is closed; Beta moves first and is shown.
  await tabNamed(first.window, "Delta").getByTestId("tab-close").click();
  const alpha = await boxOf(tabNamed(first.window, "Alpha"));
  await dragTabTo(first.window, tabNamed(first.window, "Beta"), {
    x: alpha.x + 12,
    y: alpha.y + 17,
  });
  await expect(titlesOf(first.window)).toHaveText(["Beta", "Alpha", "Gamma"]);
  await tabNamed(first.window, "Beta").click();
  const betaId = await sidebarMind(first.window, "Beta").getAttribute("data-mind-id");
  await first.app.close();

  const second = await launchApp(dataDir);
  const { window } = second;
  await expect(window.getByRole("tab").first()).toHaveAttribute("data-kind", "home");
  await expect(activeTab(window)).toHaveAttribute("data-kind", "home");
  await expect(titlesOf(window)).toHaveText(["Beta", "Alpha", "Gamma"]);
  await window.getByTestId("home-tab").getByTestId("tab-close").click();
  await expect(activeTab(window)).toContainText("Beta");
  await expect(window.getByTestId("mind-pane")).toHaveAttribute("data-mind-id", `${betaId}`);
  await expect(frontMindName(window)).toHaveText("Beta");
  await second.app.close();
});

test("the shown tab joins the Mind below with no edge under it, and long titles truncate on one line", async () => {
  const long =
    "A very long Mind title about the scaling laws of neural language models, data and compute, and what they predict";
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window, "Short");
  await newMind(window, long);
  await newMind(window, "Third");
  await tabNamed(window, "Short").click();

  const strip = window.getByTestId("tab-strip");
  const stripBox = await boxOf(strip);
  expect(stripBox.height).toBe(36);
  const active = activeTab(window);
  const activeBox = await boxOf(active);
  // Its bottom is the strip's bottom, and the Mind starts right there.
  expect(activeBox.height).toBe(32);
  expect(activeBox.y + activeBox.height).toBeCloseTo(stripBox.y + stripBox.height, 1);
  const panelBox = await boxOf(window.getByRole("tabpanel"));
  expect(panelBox.y).toBeCloseTo(activeBox.y + activeBox.height, 1);
  // No edge under it: no border, the Mind's own fill, and nothing drawn over its last row.
  const joined = await active.evaluate((tab) => {
    const style = getComputedStyle(tab);
    const box = tab.getBoundingClientRect();
    const panel = document.querySelector('[role="tabpanel"]');
    const below = panel ? getComputedStyle(panel).backgroundColor : "";
    const atBottom = document.elementFromPoint(box.left + box.width / 2, box.bottom - 0.5);
    return {
      border: style.borderBottomWidth,
      fill: style.backgroundColor,
      below,
      onTop: atBottom !== null && tab.contains(atBottom),
    };
  });
  expect(joined).toEqual({
    border: "0px",
    fill: "rgb(255, 255, 255)",
    below: "rgb(255, 255, 255)",
    onTop: true,
  });
  // The strip has no bottom rule either.
  expect(await strip.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe(
    "0px",
  );
  if (SCREENSHOTS) await strip.screenshot({ path: `${SCREENSHOTS}/tabs.png` });

  // The long title: one line, cut short with "…", in a tab no wider than 220px.
  const longTab = tabNamed(window, long);
  const longBox = await boxOf(longTab);
  expect(longBox.height).toBe(34);
  expect(longBox.width).toBeLessThanOrEqual(220);
  const title = longTab.getByTestId("tab-title");
  expect(await boxOf(title).then((box) => box.height)).toBe(20);
  expect(
    await title.evaluate((element) => ({
      cut: element.scrollWidth > element.clientWidth,
      wrap: getComputedStyle(element).whiteSpace,
      ellipsis: getComputedStyle(element).textOverflow,
    })),
  ).toEqual({ cut: true, wrap: "nowrap", ellipsis: "ellipsis" });
  // Its full title is its tooltip.
  await expect(longTab).toHaveAttribute("title", long);
  await app.close();
});

test("a new Mind's first line has the focus, so typing names it instead of making more Minds", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const minds = window.getByTestId("mind-list-item");

  // Clicked, the "+" menu's New Mind keeps no focus: a space typed next is part of the first line.
  for (const testId of ["plus-menu", "plus-new-mind"]) {
    const button = await boxOf(window.getByTestId(testId));
    await window.mouse.move(button.x + button.width / 2, button.y + button.height / 2, {
      steps: 5,
    });
    await window.mouse.down();
    await window.mouse.up();
  }
  const editor = frontMind(window).getByTestId("mind-editor");
  await expect(editor).toBeFocused();
  await window.keyboard.type("Hello world");
  await expect(minds).toHaveCount(1);
  await expect(editor).toHaveText("Hello world");
  await expect(titlesOf(window)).toHaveText(["Hello world"]);

  // The tab strip's "+" does the same as New Mind.
  await window.getByTestId("new-tab").click();
  await expect(frontMind(window).getByTestId("mind-editor")).toBeFocused();
  await window.keyboard.type("Second one");
  await expect(minds).toHaveCount(2);
  await expect(titlesOf(window)).toHaveText(["Hello world", "Second one"]);
  await app.close();
});

test("tabs are 220px while there is room, the shown one keeps 132px as they shrink, and a mouse wheel scrolls the strip to tabs out of sight", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // The card beside the assistant docked on the right (#253) as a 1280px window gave it before.
  await setWindowSize(app, window, WINDOW_SIZE.width, 660);
  for (const name of ["Alpha notes", "Beta research", "Gamma draft"]) {
    await newMindFromMenu(window);
    await enterContent(window);
    await window.keyboard.type(name);
  }
  // Short titles show in full: the tabs take their 220px, not their text's width.
  for (const tab of await tabsOf(window).all())
    expect((await boxOf(tab)).width).toBeCloseTo(220, 0);
  await expect(titlesOf(window)).toHaveText(["Alpha notes", "Beta research", "Gamma draft"]);

  // More tabs than room: the others shrink to the start of their names (#905), the shown one keeps
  // 132px, and the first ones scroll out of sight, the strip fading on that side.
  for (let index = 0; index < 13; index++) {
    await window.getByTestId("new-tab").click();
    await expect(tabsOf(window)).toHaveCount(4 + index);
  }
  expect((await boxOf(activeTab(window))).width).toBeGreaterThanOrEqual(132);
  const shrunk = (await boxOf(tabNamed(window, "Beta research"))).width;
  expect(shrunk).toBeGreaterThan(64);
  expect(shrunk).toBeLessThan(220);
  const strip = window.getByTestId("tab-list");
  await expect(strip).toHaveAttribute("data-hidden-before", "true");
  // A mouse wheel, turned up, brings them back.
  const box = await boxOf(strip);
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.wheel(0, -2000);
  await expect(strip).not.toHaveAttribute("data-hidden-before");
  await expect(strip).toHaveAttribute("data-hidden-after", "true");
  await app.close();
});

/** Clicks the application menu's item with this label, as a person picks it from the menu bar. */
async function chooseMenuItem(app: ElectronApplication, label: string): Promise<void> {
  const found = await app.evaluate(({ Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === wanted) return item;
        const inside = item.submenu && find(item.submenu.items);
        if (inside) return inside;
      }
      return undefined;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    item?.click();
    return item !== undefined;
  }, label);
  expect(found, `the menu has "${label}"`).toBe(true);
}

/** The labels of the application menu's top-level menus. */
const menuTitles = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label));

/** The labels of the File menu's items, without its separators. */
const fileMenuLabels = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((item) => item.label === "文件");
    return (file?.submenu?.items ?? [])
      .filter((item) => item.type !== "separator")
      .map((item) => item.label);
  });

test("the application menu makes a new Mind, opens Settings, and closes, reopens and splits tabs, in the interface's language", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);

  await chooseMenuItem(app, "New Mind");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(1);
  await enterContent(window);
  await chooseMenuItem(app, "Settings…");
  await expect(window.getByTestId("settings")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();
  await chooseMenuItem(app, "Split to the Right");
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await chooseMenuItem(app, "Close Tab");
  await expect(tabsOf(window)).toHaveCount(1);
  await chooseMenuItem(app, "Close Tab");
  await expect(tabsOf(window)).toHaveCount(0);
  await chooseMenuItem(app, "Reopen Closed Tab");
  await expect(tabsOf(window)).toHaveCount(1);

  // In Chinese, the menu is too.
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await expect.poll(() => menuTitles(app)).toContain("文件");
  // The File menu is all Chinese, Close All included: the app's own item, not macOS's (#1346).
  const fileLabels = await fileMenuLabels(app);
  expect(fileLabels).toContain("关闭窗口");
  expect(fileLabels).toContain("关闭全部");
  expect(fileLabels.filter((label) => !/\p{Script=Han}/u.test(label))).toEqual([]);
  await chooseMenuItem(app, "新建 Mind");
  await expect(window.getByTestId("mind-list-item")).toHaveCount(2);
  await chooseMenuItem(app, "向右拆分");
  await expect(window.getByTestId("tab-group")).toHaveCount(2);
  await expect(window.getByRole("tablist", { name: "第 2 栏" })).toBeVisible();
  await app.close();
});

test("a Mind is renamed in place from its sidebar row", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  for (const name of ["Alpha notes", "Beta research"]) {
    await newMindFromMenu(window);
    await enterContent(window);
    await window.keyboard.type(name);
  }
  const rows = window.getByTestId("mind-list-item");
  const alpha = rows.filter({ hasText: "Alpha notes" });

  // A double click types a new title in place; Enter saves it, and the tab follows.
  await alpha.dblclick();
  const field = window.getByTestId("mind-rename");
  await expect(field).toBeFocused();
  await field.fill("Alpha, revised");
  await field.press("Enter");
  await expect(rows.filter({ hasText: "Alpha, revised" })).toHaveCount(1);
  await expect(titlesOf(window)).toContainText(["Alpha, revised"]);

  // From the row's menu, Esc changes nothing.
  const beta = window
    .getByTestId("mind-row")
    .filter({ has: rows.filter({ hasText: "Beta research" }) });
  await beta.hover();
  await beta.getByTestId("mind-menu").click();
  await beta.getByTestId("mind.rename").click();
  await field.fill("Not this");
  await field.press("Escape");
  await expect(rows.filter({ hasText: "Beta research" })).toHaveCount(1);

  // By keyboard: Enter on the open Mind's row only opens it; F2 types its title in place.
  const betaRow = rows.filter({ hasText: "Beta research" });
  await betaRow.click();
  await betaRow.focus();
  await window.keyboard.press("Enter");
  await expect(field).toHaveCount(0);
  await window.keyboard.press("F2");
  await expect(field).toBeFocused();
  await window.keyboard.press("Escape");

  await app.close();
});
