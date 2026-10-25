import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  documentIdOf,
  dragBy,
  dragTabTo,
  enterContent,
  expectFirstTabAtCardStart,
  frontMind,
  launchApp,
  nameMind,
  openDocumentAt,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  WINDOW_SIZE,
  widthOf,
} from "./app";

/*
 * Everything that opens is a tab, in up to three groups side by side, with
 * preview tabs, as VS Code's editor groups (#264). Driven with a sliding mouse
 * and the keyboard, as a person does. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element isn't visible.");
  return box;
}

const groupsOf = (window: Page) => window.getByTestId("tab-group");
const groupAt = (window: Page, index: number) => groupsOf(window).nth(index);
/** A group's tab titles, in order. */
const titlesIn = (group: Locator) => group.getByRole("tab").getByTestId("tab-title");
const tabNamed = (window: Page, title: string) =>
  window
    .getByRole("tab")
    .filter({ has: window.getByTestId("tab-title").getByText(title, { exact: true }) });

/** Long enough to scroll: twelve pages. */
const REPORT = buildPdf(
  Array.from({ length: 12 }, (_, index) => ({
    lines: [`Urban heat, page ${index + 1}`, "Eastgate peaked at 47.2 degrees on 19 July."],
  })),
);

/** The report, a paper and field notes, added as Documents; their IDs by name. */
async function addSources(window: Page) {
  const paths = {
    report: join(sources, "Urban heat.pdf"),
    paper: join(sources, "Bowler 2010.md"),
    notes: join(sources, "Field notes.txt"),
    list: join(sources, "Reading list.md"),
  };
  await writeFile(paths.report, REPORT);
  await writeFile(
    paths.list,
    "# Reading list\n\nOke 1982 explains why the heat island is a night-time effect.\n",
  );
  await writeFile(paths.paper, "# Bowler 2010\n\nParks were about 1 degree cooler than streets.\n");
  await writeFile(paths.notes, "Field notes from July.\n\nNorthgate was cooler at night.\n");
  await addDocuments(window, Object.values(paths));
  return {
    report: await documentIdOf(window, "Urban heat"),
    paper: await documentIdOf(window, "Bowler 2010"),
    notes: await documentIdOf(window, "Field notes"),
    list: await documentIdOf(window, "Reading list"),
  };
}

/** A new Mind in a new tab of the focused group, named. */
async function newMind(window: Page, title: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+t");
  await expect(frontMind(window).getByTestId("mind-editor")).toBeFocused();
  await nameMind(window, title);
  await expect(window.getByRole("tab", { selected: true }).last()).toContainText(title);
}

/** Opens a tab's right-click menu, as a person does. */
async function openTabMenu(window: Page, tab: Locator): Promise<Locator> {
  const box = await boxOf(tab);
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const menu = tab.getByTestId("tab-actions");
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens a tab's right-click menu and chooses an item. */
async function chooseFromTabMenu(window: Page, tab: Locator, item: string): Promise<void> {
  const menu = await openTabMenu(window, tab);
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await expect(menu).toBeHidden();
}

/** A group's tabs' IDs, in order, from the core. */
const tabIdOrder = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const layout = await bridge.getLayout("main");
    return layout.groups[0]?.tabs.map((tab) => tab.id) ?? [];
  });

/** Whether a tab is drawn whole inside its strip's visible part. */
async function wholeInStrip(window: Page, tab: Locator): Promise<boolean> {
  const list = await boxOf(window.getByTestId("tab-list"));
  const box = await boxOf(tab);
  return box.x >= list.x - 1 && box.x + box.width <= list.x + list.width + 1;
}

test("a Citation opens its Document as a preview in the group to the right, the focus staying in the Mind; three in a row leave one tab, and reading it keeps it", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  // Wide enough for the group's tabs to keep their names' room, so a drag can reach each.
  await setWindowSize(app, window, 2000, 800);
  const ids = await addSources(window);
  await newMind(window, "Lit review: urban heat islands");
  await enterContent(window);
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toBeFocused();

  // A Citation: the Document opens in a new group on the right, at its quote, as a preview.
  await openDocumentAt(window, {
    documentId: ids.report,
    pageFrom: 3,
    quote: "Eastgate peaked at 47.2 degrees on 19 July.",
    citation: { check: "found", number: 1 },
  });
  await expect(groupsOf(window)).toHaveCount(2);
  const right = groupAt(window, 1);
  const preview = right.getByTestId("document-tab");
  await expect(preview).toHaveAttribute("data-preview", "true");
  await expect(right.getByTestId("tab-title")).toHaveText("Urban heat");
  await expect(right.getByTestId("pdf-page-number")).toHaveValue("3");
  // Its title is in italics, and it says what a preview is.
  expect(
    await preview.getByTestId("tab-title").evaluate((title) => getComputedStyle(title).fontStyle),
  ).toBe("italic");
  await expect(preview).toHaveAttribute("title", /Preview/);
  // The Mind stays on the left, shown, focused, with the cursor still in it.
  await expect(groupAt(window, 0).getByTestId("mind-tab")).toHaveAttribute("aria-selected", "true");
  await expect(groupAt(window, 0)).toHaveAttribute("data-focused", "true");
  await expect(editor).toBeFocused();
  await screenshot(window, "groups-citation-right");

  // Three Citations in a row leave one tab, showing the last.
  await openDocumentAt(window, { documentId: ids.paper, quote: "Parks were about 1 degree" });
  await openDocumentAt(window, { documentId: ids.notes, quote: "Northgate was cooler" });
  await expect(right.getByRole("tab")).toHaveCount(1);
  await expect(right.getByTestId("tab-title")).toHaveText("Field notes");
  await expect(right.getByTestId("viewer-title")).toHaveText("Field notes");
  await screenshot(window, "groups-three-citations-one-preview");

  // ⌘W closes the tab the User is in, the Mind's; ⇧⌘T reopens it.
  await window.keyboard.press("ControlOrMeta+w");
  await expect(window.getByTestId("mind-tab")).toHaveCount(0);
  await expect(groupsOf(window)).toHaveCount(1);
  await window.keyboard.press("ControlOrMeta+Shift+t");
  await expect(window.getByTestId("mind-tab")).toHaveCount(1);
  await expect(groupsOf(window)).toHaveCount(2);
  await expect(groupAt(window, 0).getByTestId("mind-tab")).toHaveAttribute("aria-selected", "true");

  // A double-click on the preview's tab keeps it; the next Citation opens beside it.
  const notesTab = right.getByTestId("document-tab");
  await notesTab.getByTestId("tab-title").dblclick();
  await expect(notesTab).not.toHaveAttribute("data-preview");
  // Back in the Mind (⌘1), as a Citation is clicked there.
  await window.keyboard.press("ControlOrMeta+1");
  await openDocumentAt(window, { documentId: ids.paper, quote: "Parks were about 1 degree" });
  await expect(titlesIn(right)).toHaveText(["Field notes", "Bowler 2010"]);
  // Keep open, in its toolbar, keeps it too.
  await expect(right.getByTestId("document-tab").last()).toHaveAttribute("data-preview", "true");
  await right.getByTestId("viewer-keep").click();
  await expect(right.locator('[data-preview="true"]')).toHaveCount(0);
  await expect(right.getByTestId("viewer-keep")).toHaveCount(0);

  // Scrolling a preview a page or so with the wheel keeps it; the jump to its quote doesn't.
  await window.keyboard.press("ControlOrMeta+1");
  await openDocumentAt(window, { documentId: ids.report, pageFrom: 2, quote: "Eastgate peaked" });
  const reportTab = right.getByTestId("document-tab").last();
  await expect(reportTab).toHaveAttribute("data-preview", "true");
  await expect(right.locator('[data-page-number="2"]')).toHaveAttribute("data-drawn", "true");
  await expect(reportTab).toHaveAttribute("data-preview", "true");
  const scroller = await boxOf(right.getByTestId("pdf-scroller"));
  await window.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2, {
    steps: 6,
  });
  await window.mouse.wheel(0, 600);
  await expect(reportTab).not.toHaveAttribute("data-preview");

  // Dragged, even within its strip, a preview is kept.
  await window.keyboard.press("ControlOrMeta+1");
  await openDocumentAt(window, { documentId: ids.list, quote: "Oke 1982" });
  const listTab = right.getByTestId("document-tab").filter({ hasText: "Reading list" });
  await expect(listTab).toHaveAttribute("data-preview", "true");
  // The tabs keep the start of their names and the strip rests on whole tabs, so the first tabs
  // are out of sight: it moves a place left, onto the tab before it.
  const before = await boxOf(right.getByRole("tab").nth(2));
  await dragTabTo(window, listTab, { x: before.x + 12, y: before.y + before.height / 2 });
  await expect(titlesIn(right)).toHaveText([
    "Field notes",
    "Bowler 2010",
    "Reading list",
    "Urban heat",
  ]);
  await expect(listTab).not.toHaveAttribute("data-preview");

  // Selecting some of a preview's text keeps it too.
  await right
    .getByTestId("document-tab")
    .filter({ hasText: "Bowler 2010" })
    .getByTestId("tab-close")
    .click();
  await window.keyboard.press("ControlOrMeta+1");
  await openDocumentAt(window, { documentId: ids.paper, quote: "Parks were about 1 degree" });
  const paperTab = right.getByTestId("document-tab").filter({ hasText: "Bowler 2010" });
  await expect(paperTab).toHaveAttribute("data-preview", "true");
  const words = await boxOf(right.getByTestId("viewer-text").getByText("cooler than streets"));
  await window.mouse.move(words.x + 2, words.y + words.height / 2, { steps: 6 });
  await window.mouse.down();
  await window.mouse.move(words.x + words.width - 2, words.y + words.height / 2, { steps: 8 });
  await window.mouse.up();
  await expect(paperTab).not.toHaveAttribute("data-preview");
});

test("tabs split off and move by dragging with the mouse, by the tab's menu and by ⌥⌘\\, three groups at most; a group goes with its last tab", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) await newMind(window, title);
  const first = groupAt(window, 0);

  // Dragged to the right edge of its group, Delta splits off: the half it will take lights up.
  const body = await boxOf(first.locator("[data-group-body]"));
  await dragTabTo(
    window,
    tabNamed(window, "Delta"),
    { x: body.x + body.width - 40, y: body.y + body.height / 2 },
    async () => {
      const zone = window.getByTestId("tab-drop-zone");
      await expect(zone).toHaveAttribute("data-zone", "right");
      await expect(zone).toContainText("Split right");
      const lit = await boxOf(zone);
      expect(lit.x).toBeGreaterThan(body.x + body.width / 2 - 1);
      expect(lit.x + lit.width).toBeLessThanOrEqual(body.x + body.width);
      await screenshot(window, "groups-drag-to-edge");
    },
  );
  await expect(window.getByTestId("tab-drop-zone")).toHaveCount(0);
  await expect(groupsOf(window)).toHaveCount(2);
  await expect(titlesIn(first)).toHaveText(["Alpha", "Beta", "Gamma"]);
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["Delta"]);

  // Dropped on the other group's strip, after its tab, Gamma moves there: a line shows where.
  const strip = await boxOf(groupAt(window, 1).getByTestId("tab-list"));
  await dragTabTo(
    window,
    tabNamed(window, "Gamma"),
    { x: strip.x + strip.width - 8, y: strip.y + strip.height / 2 },
    async () => {
      await expect(window.getByTestId("tab-drop-line")).toBeVisible();
      await screenshot(window, "groups-drag-onto-strip");
    },
  );
  await expect(titlesIn(first)).toHaveText(["Alpha", "Beta"]);
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["Delta", "Gamma"]);
  await expect(groupAt(window, 1)).toHaveAttribute("data-focused", "true");

  // ⌥⌘\ copies the shown tab into a new group on the right; a fourth is refused with a line.
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(groupsOf(window)).toHaveCount(3);
  await expect(titlesIn(groupAt(window, 2))).toHaveText(["Gamma"]);
  await expect(groupAt(window, 2).getByRole("tab")).toBeFocused();
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(window.getByTestId("undo-message")).toHaveText(
    /Three groups fit side by side at most/,
  );
  await expect(groupsOf(window)).toHaveCount(3);
  await screenshot(window, "groups-three");

  // With three groups, a group's edge moves rather than splits, and says so. Delta's strip rests
  // on the tab it shows, so Delta is shown from the sidebar first.
  await window.getByTestId("mind-list-item").filter({ hasText: "Delta" }).click();
  await expect(groupAt(window, 1).getByRole("tab", { selected: true })).toHaveText("Delta");
  const firstBody = await boxOf(first.locator("[data-group-body]"));
  await dragTabTo(
    window,
    tabNamed(window, "Delta"),
    { x: firstBody.x + 20, y: firstBody.y + firstBody.height / 2 },
    async () => {
      const zone = window.getByTestId("tab-drop-zone");
      await expect(zone).toHaveAttribute("data-zone", "center");
      await expect(zone).toContainText("Three groups at most");
    },
  );
  await expect(titlesIn(first)).toHaveText(["Alpha", "Beta", "Delta"]);

  // ⌘1–⌘3 go to a group: the keyboard's focus on its shown tab.
  await window.keyboard.press("ControlOrMeta+1");
  await expect(first).toHaveAttribute("data-focused", "true");
  await expect(first.getByRole("tab", { selected: true })).toBeFocused();
  await window.keyboard.press("ControlOrMeta+3");
  await expect(groupAt(window, 2)).toHaveAttribute("data-focused", "true");

  // The tab's menu moves it too: to the group on its right.
  await chooseFromTabMenu(window, tabNamed(window, "Beta"), "Move to the right group");
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["Gamma", "Beta"]);

  // A group goes with its last tab, and its width goes to its neighbour.
  await groupAt(window, 2).getByTestId("tab-close").click();
  await expect(groupsOf(window)).toHaveCount(2);
  await window.keyboard.press("ControlOrMeta+3");
  await expect(window.getByTestId("undo-message")).toHaveText(/There’s no group 3/);
});

test("one divider runs the full height through the strips and the pages; it resizes the groups, by mouse and keys, and a double-click makes them equal", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await newMind(window, "Alpha");
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(groupsOf(window)).toHaveCount(2);

  // Where the strips meet is where the pages meet: the one divider, the card's full height.
  const card = await boxOf(window.getByTestId("card"));
  const divider = window.getByTestId("group-divider");
  const line = await boxOf(divider);
  expect(line.width).toBe(1);
  expect(line.y).toBeCloseTo(card.y, 0);
  expect(line.y + line.height).toBeCloseTo(card.y + card.height, 0);
  const strips = window.getByTestId("tab-strip");
  const bodies = window.locator("[data-group-body]");
  const leftStrip = await boxOf(strips.nth(0));
  const leftBody = await boxOf(bodies.nth(0));
  const rightStrip = await boxOf(strips.nth(1));
  const rightBody = await boxOf(bodies.nth(1));
  expect(leftStrip.x + leftStrip.width).toBeCloseTo(line.x, 0);
  expect(leftBody.x + leftBody.width).toBeCloseTo(line.x, 0);
  expect(rightStrip.x).toBeCloseTo(line.x + 1, 0);
  expect(rightBody.x).toBeCloseTo(line.x + 1, 0);
  // A later group's tabs start 10px in from it, so its shown first tab keeps its left foot.
  const tab = await boxOf(groupAt(window, 1).getByRole("tab"));
  expect(tab.x - (line.x + 1)).toBeCloseTo(10, 0);
  await expect(
    groupAt(window, 1).getByRole("tab").locator('.tab-foot[data-side="left"]'),
  ).toBeVisible();
  // The window's first group's tabs start at the card's edge.
  await expectFirstTabAtCardStart(window, groupAt(window, 0).getByRole("tab"));

  // Dragged 100px, the left group grows by 100px and the right one gives them.
  const before = await widthOf(groupAt(window, 0));
  await dragBy(window, divider, 100);
  await expect
    .poll(async () => Math.abs((await widthOf(groupAt(window, 0))) - (before + 100)))
    .toBeLessThanOrEqual(1);
  // Focused, the arrow keys move it.
  await divider.focus();
  await window.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Math.abs((await widthOf(groupAt(window, 0))) - (before + 90)))
    .toBeLessThanOrEqual(1);
  // A double-click makes them equal again.
  const at = await boxOf(divider);
  await window.mouse.move(at.x - 20, at.y + 300);
  await window.mouse.move(at.x, at.y + 300, { steps: 5 });
  await window.mouse.dblclick(at.x, at.y + 300);
  await expect
    .poll(async () =>
      Math.abs((await widthOf(groupAt(window, 0))) - (await widthOf(groupAt(window, 1)))),
    )
    .toBeLessThanOrEqual(1);
});

test("a pinned tab stays at the left of its group; ⌘W and a middle click leave it open, saying why; its pin unpins it", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  for (const title of ["Alpha", "Beta", "Gamma"]) await newMind(window, title);
  const group = groupAt(window, 0);

  await chooseFromTabMenu(window, tabNamed(window, "Gamma"), "Pin");
  await expect(titlesIn(group)).toHaveText(["Gamma", "Alpha", "Beta"]);
  const gamma = tabNamed(window, "Gamma");
  await expect(gamma).toHaveAttribute("data-pinned", "true");
  await expect(gamma.getByTestId("tab-unpin")).toBeVisible();
  await expect(gamma.getByTestId("tab-close")).toHaveCount(0);

  await gamma.click();
  await window.keyboard.press("ControlOrMeta+w");
  await expect(window.getByTestId("undo-message")).toHaveText(/“Gamma” is pinned/);
  await gamma.click({ button: "middle" });
  await expect(titlesIn(group)).toHaveText(["Gamma", "Alpha", "Beta"]);

  // Its pin unpins it; then ⌘W closes it.
  await gamma.getByTestId("tab-unpin").click();
  await expect(gamma).not.toHaveAttribute("data-pinned");
  await gamma.click();
  await window.keyboard.press("ControlOrMeta+w");
  await expect(titlesIn(group)).toHaveText(["Alpha", "Beta"]);
});

test("groups, tabs, previews, pins, widths and the focused group come back after a restart, Home in front of the tab that was, and ⌘W on it shows that tab again", async () => {
  let session = await launchApp(dataDir);
  let { window } = session;
  await dismissChatSetup(window);
  const ids = await addSources(window);
  await newMind(window, "Alpha");
  await newMind(window, "Beta");
  await chooseFromTabMenu(window, tabNamed(window, "Beta"), "Pin");
  await openDocumentAt(window, { documentId: ids.paper, quote: "Parks were about 1 degree" });
  await openDocumentAt(window, { documentId: ids.notes, quote: "Northgate" });
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["Field notes"]);
  const before = await widthOf(groupAt(window, 0));
  await dragBy(window, window.getByTestId("group-divider"), 120);
  await expect
    .poll(async () => Math.abs((await widthOf(groupAt(window, 0))) - (before + 120)))
    .toBeLessThanOrEqual(1);
  await groupAt(window, 1).getByRole("tab").click();
  await expect(groupAt(window, 1)).toHaveAttribute("data-focused", "true");
  const widths = [await widthOf(groupAt(window, 0)), await widthOf(groupAt(window, 1))];
  await session.app.close();

  session = await launchApp(dataDir);
  window = session.window;
  await expect(groupsOf(window)).toHaveCount(2);
  await expect(titlesIn(groupAt(window, 0))).toHaveText(["Beta", "Alpha"]);
  await expect(tabNamed(window, "Beta")).toHaveAttribute("data-pinned", "true");
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["Home", "Field notes"]);
  await expect(groupAt(window, 1).getByTestId("home-tab")).toHaveAttribute("aria-selected", "true");
  await expect(groupAt(window, 1)).toHaveAttribute("data-focused", "true");
  await expect(groupAt(window, 1).getByTestId("document-tab")).toHaveAttribute(
    "data-preview",
    "true",
  );
  await window.keyboard.press("ControlOrMeta+w");
  await expect(groupAt(window, 1).getByTestId("home-tab")).toHaveCount(0);
  await expect(groupAt(window, 1)).toHaveAttribute("data-focused", "true");
  await expect(groupAt(window, 1).getByTestId("viewer-title")).toHaveText("Field notes");
  await expect
    .poll(async () => Math.abs((await widthOf(groupAt(window, 0))) - (widths[0] ?? 0)))
    .toBeLessThanOrEqual(1);
  await session.app.close();
});

test("below 1,000px the groups merge into one strip holding every tab, a Citation's Document comes to the front, and the groups come back when the window is wider", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const ids = await addSources(window);
  await newMind(window, "Alpha");
  await newMind(window, "Beta");
  await openDocumentAt(window, { documentId: ids.paper, quote: "Parks were about 1 degree" });
  await expect(groupsOf(window)).toHaveCount(2);

  await setWindowSize(app, window, 960, 660);
  await expect(groupsOf(window)).toHaveCount(1);
  await expect(window.getByTestId("tab-strip")).toHaveCount(1);
  // Every tab, in group order; the sidebar stays.
  await expect(window.getByRole("tab").getByTestId("tab-title")).toHaveText([
    "Alpha",
    "Beta",
    "Bowler 2010",
  ]);
  await expect(window.getByTestId("sidebar-panel")).not.toHaveAttribute("data-hidden");
  await expect(window.getByRole("tab", { selected: true })).toContainText("Beta");
  // A Citation now brings its Document to the front, as only one group shows.
  await openDocumentAt(window, { documentId: ids.notes, quote: "Northgate" });
  await expect(window.getByRole("tab", { selected: true })).toContainText("Field notes");
  await expect(window.getByRole("tab")).toHaveCount(3);
  await screenshot(window, "groups-merged-960");

  await setWindowSize(app, window, WINDOW_SIZE.width, 660);
  await expect(groupsOf(window)).toHaveCount(2);
  await expect(titlesIn(groupAt(window, 0))).toHaveText(["Alpha", "Beta"]);
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["Field notes"]);
});

test("the groups, their buttons and the tab's menu are in Chinese too", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: "zh-CN" } });
  });
  await newMind(window, "潮汐笔记");
  await window.keyboard.press("ControlOrMeta+Alt+Backslash");
  await expect(window.getByRole("tablist", { name: "第 1 栏" })).toBeVisible();
  await expect(window.getByRole("tablist", { name: "第 2 栏" })).toBeVisible();
  await expect(window.getByTestId("split-group").first()).toHaveAttribute("title", /^向右拆分/);
  await expect(window.getByTestId("group-divider")).toHaveAccessibleName(/各栏等宽/);
  const tab = groupAt(window, 1).getByRole("tab");
  const box = await boxOf(tab);
  await window.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const menu = tab.getByTestId("tab-actions");
  await expect(menu.getByRole("menuitem", { name: "移动到左侧一栏" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "置顶" })).toBeVisible();
  await screenshot(window, "groups-zh");
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(tab).toBeFocused();

  // A second tab there: its menu says it can move, in Chinese, with its keys.
  await newMind(window, "第二篇");
  const second = groupAt(window, 1).getByRole("tab").last();
  const moves = await openTabMenu(window, second);
  await expect(moves.getByTestId("tab.moveEarlier")).toContainText("将标签页左移");
  await expect(moves.getByTestId("tab.moveEarlier")).toContainText(/⇞|PageUp/);
  // The last tab of its group has no Move Tab Right.
  await expect(moves.getByTestId("tab.moveLater")).toHaveCount(0);
  await moves.getByTestId("tab.moveEarlier").click();
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["第二篇", "潮汐笔记"]);
  await expect(window.getByTestId("undo-message")).toHaveText("已将“第二篇”左移");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(titlesIn(groupAt(window, 1))).toHaveText(["潮汐笔记", "第二篇"]);
});

test("a tab moves a place earlier or later in its group from its menu, its keys and ⌘K, among tabs pinned as it is, with Undo, and stays whole in view", async () => {
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const titles = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  for (const title of titles) await newMind(window, title);
  const first = groupAt(window, 0);

  // Right after Pin: Move Tab Left, then Move Tab Right, each with its keys; then the group moves.
  const beta = await openTabMenu(window, tabNamed(window, "Beta"));
  const items = await beta
    .getByRole("menuitem")
    .evaluateAll((each) => each.map((item) => item.getAttribute("data-testid")));
  const at = (id: string) => items.indexOf(id);
  expect(at("tab.pin")).toBeGreaterThan(-1);
  expect(at("tab.pin")).toBeLessThan(at("tab.moveEarlier"));
  expect(at("tab.moveEarlier")).toBeLessThan(at("tab.moveLater"));
  expect(at("tab.moveLater")).toBeLessThan(at("tab.rename"));
  await expect(beta.getByTestId("tab.moveEarlier")).toContainText(/⇞|PageUp/);
  await expect(beta.getByTestId("tab.moveLater")).toContainText(/⇟|PageDown/);

  // Moved later, it swaps with the tab after it, and Undo puts it back.
  await beta.getByTestId("tab.moveLater").click();
  await expect(titlesIn(first)).toHaveText(["Alpha", "Gamma", "Beta", "Delta", "Epsilon"]);
  await expect(window.getByTestId("undo-message")).toHaveText("Moved “Beta” right");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(titlesIn(first)).toHaveText(titles);

  // The first tab has no Move Left, the last no Move Right.
  const alpha = await openTabMenu(window, tabNamed(window, "Alpha"));
  await expect(alpha.getByTestId("tab.moveEarlier")).toHaveCount(0);
  await expect(alpha.getByTestId("tab.moveLater")).toBeVisible();
  await window.keyboard.press("Escape");
  const last = await openTabMenu(window, tabNamed(window, "Epsilon"));
  await expect(last.getByTestId("tab.moveEarlier")).toBeVisible();
  await expect(last.getByTestId("tab.moveLater")).toHaveCount(0);
  await window.keyboard.press("Escape");

  // Its keys move it the same way, as Chrome and VS Code move a tab or editor among its neighbours.
  await pointAndClick(window, tabNamed(window, "Beta"));
  await window.keyboard.press("Control+Shift+PageDown");
  await expect(titlesIn(first)).toHaveText(["Alpha", "Gamma", "Beta", "Delta", "Epsilon"]);
  await window.keyboard.press("Control+Shift+PageUp");
  await expect(titlesIn(first)).toHaveText(titles);
  // ⌘1–⌘3 stay the groups' keys, and ⌃Tab still walks the tabs.
  await window.keyboard.press("ControlOrMeta+1");
  await expect(first).toHaveAttribute("data-focused", "true");
  await window.keyboard.press("Control+Tab");
  await expect.poll(() => titleNamedShown(window)).toBe("Gamma");
  await pointAndClick(window, tabNamed(window, "Gamma"));

  // ⌘K finds them, with their keys, and runs them on the tab the keyboard is on.
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Move Tab Right");
  const item = window.getByTestId("palette").locator('[data-key="command:tab.moveLater"]');
  await expect(item).toContainText(/⇟|PageDown/);
  await pointAndClick(window, item);
  await expect(titlesIn(first)).toHaveText(["Alpha", "Beta", "Delta", "Gamma", "Epsilon"]);
  await window.keyboard.press("ControlOrMeta+z");
  await expect(titlesIn(first)).toHaveText(titles);

  // Out of sight in a narrow strip, a tab moved later is scrolled whole into view.
  await setWindowSize(app, window, 1100, 760);
  for (let index = 0; index < 9; index++) await window.getByTestId("new-tab").click();
  await expect(window.getByRole("tab")).toHaveCount(14);
  const list = window.getByTestId("tab-list");
  expect(await list.evaluate((each) => each.scrollWidth > each.clientWidth)).toBe(true);
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: "Alpha" }));
  await expect(window.getByRole("tab", { selected: true })).toContainText("Alpha");
  const alphaId = await tabNamed(window, "Alpha").getAttribute("data-tab-id");
  const shown = window.getByRole("tab", { selected: true });
  for (let place = 1; place <= 10; place++) {
    await window.keyboard.press("Control+Shift+PageDown");
    await expect
      .poll(() => tabIdOrder(window).then((ids) => ids.indexOf(alphaId ?? "")))
      .toBe(place);
    await expect.poll(() => wholeInStrip(window, shown)).toBe(true);
  }

  // A pinned tab stays among the pinned ones, and an unpinned one among the unpinned.
  await chooseFromTabMenu(window, tabNamed(window, "Alpha"), "Pin");
  await chooseFromTabMenu(window, tabNamed(window, "Beta"), "Pin");
  const pinnedOrder = await tabIdOrder(window);
  const pinnedBeta = await openTabMenu(window, tabNamed(window, "Beta"));
  await expect(pinnedBeta.getByTestId("tab.moveEarlier")).toBeVisible();
  await expect(pinnedBeta.getByTestId("tab.moveLater")).toHaveCount(0);
  await window.keyboard.press("Escape");
  const pinnedAlpha = await openTabMenu(window, tabNamed(window, "Alpha"));
  await expect(pinnedAlpha.getByTestId("tab.moveEarlier")).toHaveCount(0);
  await expect(pinnedAlpha.getByTestId("tab.moveLater")).toBeVisible();
  await pinnedAlpha.getByTestId("tab.moveLater").click();
  const moved = await tabIdOrder(window);
  expect(moved.slice(0, 2)).toEqual([pinnedOrder[1], pinnedOrder[0]]);
  await expect(tabNamed(window, "Alpha")).toHaveAttribute("data-pinned", "true");
  await expect(tabNamed(window, "Beta")).toHaveAttribute("data-pinned", "true");
  await expect(window.getByRole("tab").nth(2)).not.toHaveAttribute("data-pinned");
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => tabIdOrder(window)).toEqual(pinnedOrder);
  await app.close();
});

/** The title of the tab shown in the focused group. */
async function titleNamedShown(window: Page): Promise<string> {
  const shown = window.getByRole("tab", { selected: true });
  return (await shown.getByTestId("tab-title").textContent()) ?? "";
}
