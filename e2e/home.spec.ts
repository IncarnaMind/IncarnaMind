import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { formatLongDay } from "../src/shared/dates";
import { translate } from "../src/shared/i18n";
import type { MessageKey, MessageParams } from "../src/shared/i18n/types";
import type { TestHooks } from "../src/shared/testHooks";
import {
  createDataFolder,
  focusSettled,
  launchApp,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

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

const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

async function makeMinds(window: Page, titles: string[], folderId?: string): Promise<void> {
  const core = await bridge(window);
  for (const title of titles) {
    await core.evaluate((each, input) => each.createMind(input), {
      title,
      headed: true,
      folderId: folderId ?? null,
    });
  }
}

const makeFolder = async (window: Page, name: string): Promise<string> =>
  (await bridge(window)).evaluate(
    async (core, folderName) =>
      (await core.createLibraryGroup({ name: folderName, description: "" })).id,
    name,
  );

const meetingsComingUp = (window: Page, meetings: { id: string; title: string; start: string }[]) =>
  window.evaluate(
    (given) =>
      (globalThis as { incarnamindTestHooks?: TestHooks }).incarnamindTestHooks?.setComingUp(given),
    meetings,
  );

const homeTab = (window: Page) => window.getByTestId("home-tab");
const recentRows = (window: Page) => window.getByTestId("home-recent-row");
const recentRow = (window: Page, title: string) =>
  recentRows(window).filter({
    has: window.getByTestId("row-text").getByText(title, { exact: true }),
  });
const shownMindName = (window: Page) =>
  window.locator('[data-testid="mind-tab"][aria-selected="true"] [data-testid="tab-title"]');

async function expectHomeInFront(window: Page): Promise<void> {
  await expect(window.getByTestId("home")).toBeVisible();
  await expect(homeTab(window)).toHaveAttribute("aria-selected", "true");
  await expect(window.getByTestId("sidebar-home")).toHaveAttribute("aria-current", "page");
}

async function goHome(window: Page): Promise<void> {
  await window.getByTestId("sidebar-home").click();
  await expectHomeInFront(window);
}

const iconLeft = async (row: Locator) => (await row.locator("svg").first().boundingBox())?.x ?? 0;

for (const [language, width] of [
  ["en", 1440],
  ["en", 900],
  ["zh-CN", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a first run opens the example Mind under a sidebar of Home and Search; the next launch opens on Home with a welcome, and Coming up only once a meeting is coming (${language}, ${width}px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    let { app, window } = await launchApp(dataDir, { examples: true });
    try {
      await setWindowSize(app, window, width, 760);
      await setLanguage(window, language);
      const sidebar = window.getByTestId("sidebar");
      await expect(window.getByTestId("mind-pane")).toBeVisible();
      await expect(window.getByTestId("home")).toHaveCount(0);

      await expect(sidebar.getByTestId("plus-menu")).toBeVisible();
      await expect(sidebar.getByTestId("sidebar-home")).toHaveText(t("home.title"));
      await expect(sidebar.getByTestId("sidebar-search")).toContainText(t("sidebar.search"));
      await expect(sidebar.getByTestId("open-library")).toHaveCount(0);
      await expect(sidebar.getByRole("button", { name: t("assistant.newChat") })).toHaveCount(0);
      const settings = sidebar
        .getByTestId("sidebar-footer")
        .getByRole("button", { name: t("sidebar.settings") });
      const left = await iconLeft(sidebar.getByTestId("sidebar-home"));
      expect(await iconLeft(sidebar.getByTestId("sidebar-search"))).toBeCloseTo(left, 0);
      expect(await iconLeft(settings)).toBeCloseTo(left, 0);
      const homeBox = await sidebar.getByTestId("sidebar-home").boundingBox();
      const searchBox = await sidebar.getByTestId("sidebar-search").boundingBox();
      expect(homeBox?.y ?? 0).toBeLessThan(searchBox?.y ?? 0);
      await screenshot(window, `home-first-run-${language}-${width}`);
      await app.close();

      ({ app, window } = await launchApp(dataDir, { examples: true }));
      await setWindowSize(app, window, width, 760);
      await expectHomeInFront(window);
      await expect(window.getByTestId("mind-tab")).toHaveCount(1);
      await expect(window.getByRole("tab").first()).toHaveAttribute("data-kind", "home");
      await expect(window.getByTestId("home-greeting")).toHaveText(
        new RegExp(
          `^(${["morning", "afternoon", "evening"].map((part) => t(`home.greeting.${part}` as MessageKey)).join("|")})$`,
        ),
      );
      await expect(window.getByTestId("home-line")).toHaveText(t("home.welcome"));
      await expect(window.getByTestId("home-recent")).toHaveCount(0);
      await expect(window.getByTestId("home").getByRole("textbox")).toHaveCount(0);
      await expect(window.getByTestId("home-coming-up")).toHaveCount(0);
      await screenshot(window, `home-welcome-${language}-${width}`);

      const inAnHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await meetingsComingUp(window, [{ id: "board", title: "Harbour board", start: inAnHour }]);
      const comingUp = window.getByTestId("home-coming-up");
      await expect(comingUp).toContainText(t("home.comingUp"));
      await expect(comingUp.getByTestId("home-meeting")).toHaveCount(1);
      await expect(comingUp.getByTestId("home-meeting")).toContainText("Harbour board");
      await expect(comingUp.getByTestId("home-meeting-time")).not.toHaveText("");
      await meetingsComingUp(window, []);
      await expect(comingUp).toHaveCount(0);

      await window.getByTestId("mind-tab").click();
      await expect(window.getByTestId("mind-pane")).toBeVisible();
      await expect(window.getByTestId("sidebar-home")).not.toHaveAttribute("aria-current", "page");
      await goHome(window);
    } finally {
      await app.close();
    }
  });

  test(`New note on Home makes a Mind in one click, the cursor in its title; its ▾ opens the sidebar's New menu by mouse and keyboard; ⌘J goes to the assistant and Home stays (${language}, ${width}px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    let { app, window } = await launchApp(dataDir);
    await makeMinds(window, ["Ledger"]);
    await app.close();
    ({ app, window } = await launchApp(dataDir));
    try {
      await setWindowSize(app, window, width, 760);
      await setLanguage(window, language);
      await expectHomeInFront(window);

      const morning = new Date(2026, 9, 19, 9, 30);
      await window.clock.setFixedTime(morning);
      await homeTab(window).getByTestId("tab-close").click();
      await expect(window.getByTestId("home")).toHaveCount(0);
      await goHome(window);
      await expect(window.getByTestId("home-greeting")).toHaveText(t("home.greeting.morning"));
      await expect(window.getByTestId("home-line")).toHaveText(
        formatLongDay(morning, language, { now: morning }),
      );
      await expect(window.getByTestId("home-line")).toHaveText(
        language === "en" ? "Monday 19 October" : "10月19日 星期一",
      );
      await expect(window.getByTestId("home-line").getByRole("button")).toHaveCount(0);

      await window.getByTestId("home-new-mind").click();
      const pane = window.locator('[data-testid="mind-pane"]:visible');
      await expect(pane).toHaveCount(1);
      const first = pane.locator(".mind-editor > :first-child");
      await expect(first).toHaveJSProperty("tagName", "H1");
      await expect
        .poll(() => window.evaluate(() => document.activeElement?.closest(".mind-editor") !== null))
        .toBe(true);
      await window.keyboard.type("Harbour plan");
      await window.keyboard.press("Enter");
      await window.keyboard.type("Tide tables for the spring.");
      await expect(first).toHaveText("Harbour plan");
      await expect(pane.locator(".mind-editor > :nth-child(2)")).toHaveText(
        "Tide tables for the spring.",
      );
      await expect(homeTab(window)).toHaveCount(1);

      await goHome(window);
      await expect(recentRows(window).first().getByTestId("row-text")).toHaveText("Harbour plan");
      // A note under its title says where it stands (D266): nothing has checked it yet.
      await expect(recentRows(window).first().getByTestId("home-recent-state")).toHaveText(
        t("health.state.notChecked"),
      );

      await window.getByTestId("plus-menu").click();
      const sidebarItems = await window
        .getByTestId("plus-menu-items")
        .getByRole("menuitem")
        .allTextContents();
      await window.keyboard.press("Escape");
      expect(sidebarItems).toHaveLength(5);
      const trigger = window.getByTestId("home-new-menu");
      await expect(trigger).toHaveAccessibleName(t("home.newMind.more"));
      const items = window.getByTestId("home-plus-menu-items").getByRole("menuitem");
      await pointAt(window, trigger);
      await window.mouse.down();
      await window.mouse.up();
      await expect(items).toHaveText(sidebarItems);
      const menuBox = await window.getByTestId("home-plus-menu-items").boundingBox();
      const triggerBox = await trigger.boundingBox();
      expect(menuBox?.y ?? 0).toBeGreaterThan(triggerBox?.y ?? 0);
      expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeCloseTo(
        (triggerBox?.x ?? 0) + (triggerBox?.width ?? 0),
        -1,
      );
      await screenshot(window, `home-new-menu-${language}-${width}`);
      await window.keyboard.press("Escape");
      await expect(items).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await window.keyboard.press("Enter");
      await expect(window.getByTestId("home-plus-new-mind")).toBeFocused();
      await window.keyboard.press("ArrowDown");
      await window.keyboard.press("ArrowDown");
      await expect(window.getByTestId("home-plus-new-folder")).toBeFocused();
      await window.keyboard.press("Enter");
      const field = window.getByTestId("folder-rename-field");
      await expect(field).toBeFocused();
      await field.fill("Finance");
      await field.press("Enter");
      await expect(sidebarFolder(window, "Finance")).toHaveCount(1);
      await expect(
        window.getByTestId("home-folder-card").filter({ hasText: "Finance" }),
      ).toBeVisible();
      await expectHomeInFront(window);

      await window.getByTestId("home-greeting").click();
      await window.keyboard.press("ControlOrMeta+j");
      await expect(window.getByTestId("composer-input")).toBeFocused();
      await expectHomeInFront(window);
      await expect(window.getByTestId("composer-scope-all")).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`Recent lists the User's Minds newest first, six and then See all, kept with the scroll when Home comes back; each Folder is a card in the sidebar's order; rows and cards open by mouse and keyboard, rename with F2 and have the shared menu (${language}, ${width}px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    await writeFile(join(sources, "Budget.txt"), "Budget for the harbour project.\n");
    let { app, window } = await launchApp(dataDir);
    const finance = await makeFolder(window, "Finance");
    await makeMinds(window, ["Q3 review"], finance);
    await makeMinds(window, ["Ideas", "Tides", "Moorings", "Dredging", "Pilots", "Ferries"]);
    await (await bridge(window)).evaluate(
      (core, files) => core.addDocuments(files),
      [join(sources, "Budget.txt")],
    );
    await expect(
      window.locator('[data-testid="document-list-item"][data-status="ready"]'),
    ).toHaveCount(1);
    await (await bridge(window)).evaluate(async (core, folderId) => {
      const [budget] = await core.listDocuments();
      if (budget) await core.assignDocumentGroup(budget.id, folderId);
    }, finance);
    await app.close();
    ({ app, window } = await launchApp(dataDir));
    try {
      await setWindowSize(app, window, width, 760);
      await setLanguage(window, language);
      await expectHomeInFront(window);

      await expect(recentRows(window)).toHaveCount(6);
      await expect(recentRows(window).first().getByTestId("row-text")).toHaveText("Ferries");
      const all = window.getByTestId("home-recent-all");
      await expect(all).toHaveText(t("home.seeAll", { count: 7 }));
      await all.click();
      await expect(recentRows(window)).toHaveCount(7);
      await expect(recentRows(window).last().getByTestId("row-text")).toHaveText("Q3 review");
      await expect(all).toHaveText(t("home.showFewer"));
      await all.click();
      await expect(recentRows(window)).toHaveCount(6);
      await all.click();

      const folderColumn = recentRow(window, "Q3 review").getByTestId("home-recent-folder");
      if (width >= 1100) await expect(folderColumn).toHaveText("Finance");
      else await expect(folderColumn).toBeHidden();
      await expect(recentRow(window, "Q3 review").getByTestId("home-recent-time")).toHaveText(
        t("date.justNow"),
      );
      await screenshot(window, `home-recent-${language}-${width}`);

      const scroller = window.getByTestId("home-scroller");
      const scrolled = await scroller.evaluate((element) => {
        element.scrollTop = Math.min(160, element.scrollHeight - element.clientHeight);
        return element.scrollTop;
      });
      expect(scrolled).toBeGreaterThan(0);
      await recentRow(window, "Tides").getByTestId("home-recent-open").click();
      await expect(shownMindName(window)).toHaveText("Tides");
      await expect(window.getByTestId("home")).toHaveCount(0);
      await expect(homeTab(window)).toHaveCount(1);
      await goHome(window);
      await expect(recentRows(window)).toHaveCount(7);
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(scrolled);

      await recentRow(window, "Ideas").getByTestId("home-recent-open").focus();
      await window.keyboard.press("Enter");
      await expect(shownMindName(window)).toHaveText("Ideas");
      await goHome(window);
      await recentRow(window, "Moorings").getByTestId("home-recent-open").focus();
      await window.keyboard.press("F2");
      const name = recentRows(window).getByRole("textbox");
      await expect(name).toBeFocused();
      await name.fill("Mooring fees");
      await name.press("Enter");
      await expect(recentRow(window, "Mooring fees")).toHaveCount(1);
      await expect(
        recentRow(window, "Mooring fees").getByTestId("home-recent-snippet"),
      ).toHaveCount(0);
      await expect(
        window
          .getByTestId("sidebar")
          .getByTestId("mind-list-item")
          .filter({ hasText: "Mooring fees" }),
      ).toHaveCount(1);

      const pilots = recentRow(window, "Pilots");
      await pilots.click({ button: "right" });
      const menu = pilots.getByTestId("mind-actions");
      await expect(menu).toBeVisible();
      await expect(menu.getByTestId("mind.open")).toBeVisible();
      await expect(menu.getByTestId("mind.delete")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await pilots.getByTestId("home-recent-open").focus();
      await window.keyboard.press("Shift+F10");
      await expect(menu.getByTestId("mind.open")).toBeFocused();
      await window.keyboard.press("Escape");
      await expect(pilots.getByTestId("home-recent-open")).toBeFocused();

      const card = window.getByTestId("home-folder-card").filter({ hasText: "Finance" });
      await expect(card.getByTestId("home-folder-counts")).toHaveText(
        `${t("home.minds.one")} · ${t("library.count.one")}`,
      );
      await expect(card.getByTestId("home-folder-item")).toHaveCount(2);
      await expect(card.getByTestId("home-folder-active")).toHaveText(
        t("home.active", { time: t("date.justNow") }),
      );
      const newFolder = window.getByTestId("home-new-folder");
      await expect(newFolder).toHaveText(t("menu.newFolder"));
      const cardBox = await card.boundingBox();
      const newBox = await newFolder.boundingBox();
      expect(newBox?.y ?? 0).toBeCloseTo(cardBox?.y ?? 0, 0);
      expect(newBox?.x ?? 0).toBeGreaterThan((cardBox?.x ?? 0) + (cardBox?.width ?? 0));
      await screenshot(window, `home-folders-${language}-${width}`);

      await card.getByTestId("home-folder-open").click();
      await expect(window.getByTestId("library")).toBeVisible();
      await goHome(window);
      await card.getByTestId("home-folder-open").focus();
      await window.keyboard.press("Enter");
      await expect(window.getByTestId("library")).toBeVisible();
      await goHome(window);

      await card.getByTestId("home-folder-open").focus();
      await window.keyboard.press("F2");
      const folderName = window.getByTestId("home-folder-card").getByRole("textbox");
      await expect(folderName).toBeFocused();
      await folderName.fill("Accounts");
      await folderName.press("Enter");
      const renamed = window.getByTestId("home-folder-card").filter({ hasText: "Accounts" });
      await expect(renamed).toHaveCount(1);
      await expect(sidebarFolder(window, "Accounts")).toHaveCount(1);
      await renamed.click({ button: "right", position: { x: 40, y: 90 } });
      await expect(renamed.getByTestId("folder-actions")).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(renamed.getByTestId("folder-actions")).toBeHidden();

      await newFolder.click();
      const field = window.getByTestId("folder-rename-field");
      await expect(field).toBeFocused();
      await field.fill("Research");
      await field.press("Enter");
      await expect(
        window.getByTestId("home-folder-card").filter({ hasText: "Research" }),
      ).toBeVisible();
      const sidebarOrder = window
        .getByTestId("library-folders")
        .getByTestId("library-folder")
        .locator(':scope > div [data-testid="row-text"]');
      await expect(sidebarOrder).toHaveCount(2);
      await expect(window.getByTestId("home-folder-open")).toHaveText(
        await sidebarOrder.allTextContents(),
      );
    } finally {
      await app.close();
    }
  });
}

const menuIds = (menu: Locator) =>
  menu
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid") ?? ""));

for (const [language, width] of [
  ["en", 1440],
  ["en", 900],
  ["zh-CN", 1440],
  ["zh-CN", 900],
] as const) {
  test(`Recent rows and Folder cards select as the sidebar's rows do: ⌘-click, Shift-click, ⌘A and Esc, the count in the menu, and a middle click opening a tab behind Home (${language}, ${width}px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    let { app, window } = await launchApp(dataDir);
    await makeFolder(window, "Finance");
    await makeFolder(window, "Research");
    await makeMinds(window, ["Ideas", "Tides", "Moorings"]);
    await app.close();
    ({ app, window } = await launchApp(dataDir));
    try {
      await setWindowSize(app, window, width, 900);
      await setLanguage(window, language);
      await expectHomeInFront(window);
      const selected = window.locator('[data-surface="home"] [aria-selected="true"]');
      const card = (name: string) =>
        window.getByTestId("home-folder-card").filter({ hasText: name });

      await recentRow(window, "Moorings")
        .getByTestId("home-recent-open")
        .click({
          modifiers: ["ControlOrMeta"],
        });
      await recentRow(window, "Ideas")
        .getByTestId("home-recent-open")
        .click({
          modifiers: ["ControlOrMeta"],
        });
      await expect(selected).toHaveCount(2);
      await expect(recentRow(window, "Moorings")).toHaveAttribute("aria-selected", "true");
      await expect(window.getByTestId("home")).toBeVisible();
      await recentRow(window, "Ideas").click({ button: "right" });
      const rowMenu = recentRow(window, "Ideas").getByTestId("mind-actions");
      await expect(rowMenu.getByTestId("folder.newWith")).toContainText(
        t("folder.newWith.minds", { count: 2 }),
      );
      await window.keyboard.press("Escape");
      await expect(rowMenu).toBeHidden();

      await card("Research")
        .getByTestId("home-folder-open")
        .click({ modifiers: ["ControlOrMeta"] });
      await expect(selected).toHaveCount(3);
      await card("Research").click({ button: "right", position: { x: 40, y: 90 } });
      const cardMenu = card("Research").getByTestId("folder-actions");
      await expect(cardMenu.getByTestId("selection.delete")).toContainText(
        t("selection.delete", { count: 3 }),
      );
      await window.keyboard.press("Escape");
      await card("Research")
        .getByTestId("home-folder-open")
        .click({ modifiers: ["ControlOrMeta"] });
      await expect(card("Research")).toHaveAttribute("aria-selected", "false");
      await expect(selected).toHaveCount(2);
      await window.keyboard.press("Escape");
      await expect(selected).toHaveCount(0);

      await recentRow(window, "Moorings")
        .getByTestId("home-recent-open")
        .click({
          modifiers: ["ControlOrMeta"],
        });
      await recentRow(window, "Ideas")
        .getByTestId("home-recent-open")
        .click({
          modifiers: ["Shift"],
        });
      await expect(selected).toHaveCount(3);
      await window.keyboard.press("Escape");
      await expect(selected).toHaveCount(0);
      await recentRow(window, "Tides").getByTestId("home-recent-open").focus();
      await window.keyboard.press("ControlOrMeta+a");
      await expect(selected).toHaveCount(3);
      await expect(
        window.locator('[data-testid="home-folder-card"][aria-selected="true"]'),
      ).toHaveCount(0);

      await window
        .getByTestId("sidebar")
        .getByTestId("mind-list-item")
        .filter({ hasText: "Tides" })
        .click({ modifiers: ["ControlOrMeta"] });
      await expect(selected).toHaveCount(0);
      await expect(
        window.getByTestId("sidebar").getByTestId("mind-list-item").filter({ hasText: "Tides" }),
      ).toHaveAttribute("aria-selected", "true");
      await recentRow(window, "Tides")
        .getByTestId("home-recent-open")
        .click({
          modifiers: ["ControlOrMeta"],
        });
      await expect(selected).toHaveCount(1);
      await expect(
        window.getByTestId("sidebar").getByTestId("mind-list-item").filter({ hasText: "Tides" }),
      ).toHaveAttribute("aria-selected", "false");
      await window.keyboard.press("Escape");

      await recentRow(window, "Moorings").click({ button: "right" });
      expect(
        (await menuIds(recentRow(window, "Moorings").getByTestId("mind-actions"))).slice(0, 2),
      ).toEqual(["mind.open", "mind.openTab"]);
      await window.keyboard.press("Escape");
      await card("Finance").click({ button: "right", position: { x: 40, y: 90 } });
      expect((await menuIds(card("Finance").getByTestId("folder-actions"))).slice(0, 2)).toEqual([
        "folder.open",
        "folder.newMind",
      ]);
      await window.keyboard.press("Escape");

      await recentRow(window, "Tides").getByTestId("home-recent-open").click({ button: "middle" });
      await expect(window.getByTestId("mind-tab").filter({ hasText: "Tides" })).toHaveCount(1);
      await expectHomeInFront(window);
      await card("Finance").getByTestId("home-folder-open").click({ button: "middle" });
      await expect(window.getByTestId("library-tab")).toHaveCount(1);
      await expectHomeInFront(window);
      await screenshot(window, `home-selection-${language}-${width}`);
    } finally {
      await app.close();
    }
  });
}

test("Home beside a Mind follows it as it is saved, and tabs opened behind Home keep the order they were clicked in", async () => {
  let { app, window } = await launchApp(dataDir);
  await makeMinds(window, ["Ideas", "Tides", "Moorings"]);
  await app.close();
  ({ app, window } = await launchApp(dataDir));
  try {
    await setWindowSize(app, window, 1440, 900);
    await expectHomeInFront(window);
    for (const title of ["Moorings", "Tides", "Ideas"]) {
      await recentRow(window, title).getByTestId("home-recent-open").click({ button: "middle" });
    }
    await expect(window.getByRole("tab").getByTestId("tab-title")).toHaveText([
      "Home",
      "Moorings",
      "Tides",
      "Ideas",
    ]);
    await expectHomeInFront(window);

    await window.getByTestId("split-group").click();
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    await expect(window.getByTestId("home")).toBeVisible();
    const editor = window.locator('[data-testid="mind-pane"]:visible .mind-editor');
    await expect(editor).toHaveCount(1);
    const title = editor.locator("h1");
    const titleBox = await title.boundingBox();
    await title.click({
      position: { x: (titleBox?.width ?? 2) - 2, y: (titleBox?.height ?? 2) / 2 },
    });
    await focusSettled(window, editor);
    await window.keyboard.press("Enter");
    await window.keyboard.type("Harbour dues are due on the first of June.");
    const shownTitle = await window
      .locator('[data-testid="mind-tab"][aria-selected="true"] [data-testid="tab-title"]')
      .textContent();
    await expect(recentRow(window, shownTitle ?? "").getByTestId("home-recent-state")).toHaveText(
      "Not checked",
    );
  } finally {
    await app.close();
  }
});
