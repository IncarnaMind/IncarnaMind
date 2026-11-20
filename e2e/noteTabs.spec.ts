import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  type NoteBlock,
  pointAndClick,
  pointAt,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  writeNote,
} from "./app";

/*
 * Tabs in a Note (#3414): the panel at the left of the page lists the Note's tabs, the open one's
 * headings under it, and "New tab…"; the page shows one tab at a time. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save stills.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const check = (text: string) => ({
  id: crypto.randomUUID(),
  request: "check-1",
  action: "check-against-documents",
  state: "unsupported",
  text,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-11-18T09:00:00.000Z",
});

const WORDS = {
  en: {
    title: "Harbourline Ferries: annual report",
    tabs: ["Summary", "Fleet", "Appendix"],
    headings: [
      ["Harbourline Ferries: annual report", "Highlights", "Outlook"],
      ["Refits", "Crews"],
      ["Timetables"],
    ],
    line: (heading: string, at: number) =>
      `${heading}, part ${at + 1}: sailings ran on time on most days of the season, with the spring tides and the weather the main causes of delay.`,
    checked: "The Kestrel was refitted in eleven days.",
    timetable: "The island routes sail every hour from the outer harbour pier.",
    untitled: "Tab 1",
    newTab: "New tab…",
    panel: "Tabs and outline",
  },
  "zh-CN": {
    title: "港湾轮渡年度报告",
    tabs: ["摘要", "船队", "附录"],
    headings: [["港湾轮渡年度报告", "要点", "展望"], ["改装", "船员"], ["时刻表"]],
    line: (heading: string, at: number) =>
      `${heading}（第 ${at + 1} 段）：本季大多数日子航班准点，延误主要来自大潮和天气。`,
    checked: "鹰号改装用了十一天。",
    timetable: "海岛航线每小时从外港码头开出一班。",
    untitled: "标签页 1",
    newTab: "新建标签页…",
    panel: "标签页和目录",
  },
} as const;

type Language = keyof typeof WORDS;

/** The ferry company's report in three tabs, each heading followed by a few paragraphs. */
function report(language: Language): NoteBlock[] {
  const words = WORDS[language];
  return words.tabs.flatMap((tab, index) => [
    { tab },
    ...(words.headings[index] ?? []).flatMap((heading, at): NoteBlock[] => [
      { heading, level: index === 0 && at === 0 ? 1 : 2 },
      ...Array.from({ length: index === 0 ? 4 : 2 }, (_, n) => ({ text: words.line(heading, n) })),
    ]),
    ...(index === 1 ? [{ text: words.checked, check: check(words.checked) }] : []),
    ...(index === 2 ? [{ text: words.timetable }] : []),
  ]);
}

async function openNote(window: Page, title: string): Promise<Locator> {
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
  const editor = window.getByTestId("mind-editor");
  await expect(editor).toBeVisible();
  return editor;
}

async function showPanel(window: Page): Promise<Locator> {
  const outline = window.getByTestId("outline");
  if (!(await outline.isVisible()))
    await pointAndClick(window, window.getByTestId("outline-button"));
  await expect(outline).toBeVisible();
  return outline;
}

const tabRows = (outline: Locator) => outline.getByTestId("note-tab");
const openTab = (outline: Locator) =>
  outline.locator('[data-testid="note-tab"][aria-current="page"]');
const scrollTop = (window: Page) =>
  window.getByTestId("mind-scroller").evaluate((scroller) => scroller.scrollTop);
const moveKeys = (direction: "Up" | "Down") =>
  process.platform === "darwin" ? `Alt+Shift+Arrow${direction}` : `Control+Shift+Arrow${direction}`;

test("New tab… makes the Note's text its first tab and opens the new one named; a double-click and F2 rename; ⌘Z takes each back", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1280, 800);
    await writeNote(window, "Crew rota", [
      { heading: "Crew rota", level: 1 },
      { text: "Two crews a day on the island routes." },
    ]);
    const editor = await openNote(window, "Crew rota");
    const outline = await showPanel(window);
    await expect(outline).toHaveAccessibleName("Tabs and outline");
    await expect(tabRows(outline)).toHaveCount(0);
    const add = outline.getByTestId("note-tab-new");
    await expect(add).toHaveText("New tab…");

    // The Note becomes "Tab 1"; the new tab opens, its name field open with its default selected.
    await pointAndClick(window, add);
    const field = outline.getByTestId("note-tab-name");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Tab 2");
    await window.keyboard.type("Rotas by season");
    await window.keyboard.press("Enter");
    await expect(tabRows(outline)).toHaveText(["Tab 1", "Rotas by season"]);
    await expect(openTab(outline)).toHaveText("Rotas by season");
    // The page shows the new tab, empty, with the cursor in it.
    await expect(editor.getByText("Two crews a day on the island routes.")).toBeHidden();
    await expect(editor).toBeFocused();
    await window.keyboard.type("Three crews in summer.");
    await expect(editor.getByText("Three crews in summer.")).toBeVisible();

    // A double-click renames the tab the first click opened; Esc keeps the old name.
    const first = tabRows(outline).first();
    const point = await pointAt(window, first);
    await window.mouse.dblclick(point.x, point.y);
    await expect(field).toBeFocused();
    await window.keyboard.type("Not this");
    await window.keyboard.press("Escape");
    await expect(tabRows(outline)).toHaveText(["Tab 1", "Rotas by season"]);
    await expect(editor.getByText("Two crews a day on the island routes.")).toBeVisible();

    // F2 renames; Enter saves; a blank name changes nothing.
    await tabRows(outline).first().focus();
    await window.keyboard.press("F2");
    await expect(field).toBeFocused();
    await window.keyboard.type("Everyday rota");
    await window.keyboard.press("Enter");
    await expect(tabRows(outline)).toHaveText(["Everyday rota", "Rotas by season"]);
    await tabRows(outline).first().focus();
    await window.keyboard.press("F2");
    await window.keyboard.press("Backspace");
    await window.keyboard.press("Enter");
    await expect(tabRows(outline)).toHaveText(["Everyday rota", "Rotas by season"]);

    // ⌘Z in the Note takes back the rename, then the typing, the new tab's name and the tab.
    await editor.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tabRows(outline)).toHaveText(["Tab 1", "Rotas by season"]);
    await expect(async () => {
      await window.keyboard.press("ControlOrMeta+z");
      await expect(tabRows(outline)).toHaveCount(0, { timeout: 500 });
    }).toPass();
    await expect(editor.getByText("Two crews a day on the island routes.")).toBeVisible();

    // ⌘K adds one too, with its name field.
    await runCommand(window, "noteTab.new", "New tab in this note");
    await expect(field).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(tabRows(outline)).toHaveText(["Tab 1", "Tab 2"]);
  } finally {
    await app.close();
  }
});

test("a Note in three tabs: one shown at a time, each keeping its place; moved by keys and by drag, deleted with Undo; find, ⌘K, a check and its card open the tab they point into", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1280, 800);
    const words = WORDS.en;
    await writeNote(window, words.title, report("en"));
    const editor = await openNote(window, words.title);
    const outline = await showPanel(window);
    await expect(tabRows(outline)).toHaveText(words.tabs);
    await expect(openTab(outline)).toHaveText("Summary");
    // The open tab's headings under it, and its text alone on the page.
    const headings = outline.getByTestId("outline-item");
    await expect(headings).toHaveText(words.headings[0] ?? []);
    await expect(editor.getByText(words.checked)).toBeHidden();
    // The Note's check counts every tab: the sentence in Fleet needs a look.
    await expect(window.getByTestId("check-badge")).toBeVisible();

    // Each tab keeps its scroll place.
    const page = window.getByTestId("mind-scroller");
    await pointAt(window, page);
    await window.mouse.wheel(0, 900);
    await expect.poll(() => scrollTop(window)).toBeGreaterThan(300);
    const summaryAt = await scrollTop(window);
    await pointAndClick(window, tabRows(outline).nth(1));
    await expect(openTab(outline)).toHaveText("Fleet");
    await expect(headings).toHaveText(words.headings[1] ?? []);
    await expect(editor.getByText(words.checked)).toBeVisible();
    expect(await scrollTop(window)).toBeLessThan(summaryAt);
    await pointAndClick(window, tabRows(outline).first());
    await expect.poll(async () => Math.abs((await scrollTop(window)) - summaryAt)).toBeLessThan(3);

    // By keyboard: the panel is one Tab stop; ↓ reaches a tab, Enter opens it.
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await expect(outline.locator("[data-outline-item]:focus")).toHaveCount(1);
    const appendix = tabRows(outline).filter({ hasText: "Appendix" });
    await appendix.focus();
    await window.keyboard.press("Enter");
    await expect(openTab(outline)).toHaveText("Appendix");
    await expect(editor).toBeFocused();

    // Moved by its keys, with its line; ⌘Z puts it back.
    await appendix.focus();
    await window.keyboard.press(moveKeys("Up"));
    await expect(tabRows(outline)).toHaveText(["Summary", "Appendix", "Fleet"]);
    await expect(appendix).toBeFocused();
    await expect(window.getByTestId("undo-message")).toHaveText("Moved tab “Appendix”");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tabRows(outline)).toHaveText(words.tabs);

    // Dragged above the first, it lands there, its Blocks with it.
    const fleet = tabRows(outline).filter({ hasText: "Fleet" });
    const from = await pointAt(window, fleet);
    const top = await tabRows(outline).first().boundingBox();
    if (!top) throw new Error("The tabs aren't drawn.");
    await window.mouse.down();
    await window.mouse.move(from.x, top.y + 2, { steps: 8 });
    await window.mouse.up();
    await expect(tabRows(outline)).toHaveText(["Fleet", "Summary", "Appendix"]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tabRows(outline)).toHaveText(words.tabs);

    // Deleted with Delete: its Blocks go, the line's Undo brings them back.
    await fleet.focus();
    await window.keyboard.press("Delete");
    await expect(tabRows(outline)).toHaveText(["Summary", "Appendix"]);
    await expect(window.getByTestId("undo-message")).toHaveText("Deleted tab “Fleet”");
    await pointAndClick(
      window,
      window.getByTestId("undo-line").getByRole("button", { name: "Undo" }),
    );
    await expect(tabRows(outline)).toHaveText(words.tabs);

    // Its right-click menu holds the same, in the rule's order.
    await pointAndClick(window, fleet, { button: "right" });
    const menu = window.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      /^Open/,
      /^Move up/,
      /^Move down/,
      /^Rename/,
      /^Delete tab/,
    ]);
    await window.keyboard.press("Escape");

    // ⌘K finds a tab by its title.
    await pointAndClick(window, tabRows(outline).first());
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("Fleet");
    const found = window
      .getByTestId("palette")
      .locator('[data-testid="palette-item"][data-kind="noteTab"]')
      .filter({ hasText: "Fleet" });
    await pointAndClick(window, found.first());
    await expect(openTab(outline)).toHaveText("Fleet");

    // Find searches every tab, and opens the one it lands in.
    await window.keyboard.press("ControlOrMeta+f");
    await window.keyboard.type("outer harbour pier");
    await expect(openTab(outline)).toHaveText("Appendix");
    await expect(editor.getByText(words.timetable)).toBeVisible();
    await window.keyboard.press("Escape");
    // A click into the match it left selected leaves a caret: ⌘K at once is ⌘K, not a link.
    const match = await editor.getByText(words.timetable).evaluate((line, word) => {
      const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let text = walk.nextNode(); text; text = walk.nextNode()) {
        const at = text.textContent?.indexOf(word) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + word.length);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    }, "harbour");
    if (!match) throw new Error("The match isn't drawn.");
    await window.mouse.click(match.x, match.y);
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette")).toBeVisible();
    await expect(window.getByTestId("link-field")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // The Note's health, from the first tab: Next goes to the sentence that needs a look, in Fleet.
    await pointAndClick(window, tabRows(outline).first());
    await window.mouse.move(2, 2);
    await pointAndClick(window, window.getByTestId("check-badge-open").first());
    await pointAndClick(window, window.getByTestId("check-card").getByTestId("health-look"));
    await expect(openTab(outline)).toHaveText("Fleet");
    await expect(window.getByTestId("claim-card")).toBeVisible();
    await motionSettled(window);
  } finally {
    await app.close();
  }
});

async function still(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`in ${language === "en" ? "English" : "Chinese"}, light and dark, at 1280 and 900 pixels, the tabs and the text both stay readable`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir);
    try {
      const words = WORDS[language];
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await writeNote(window, words.title, report(language));
      await writeNote(window, language === "en" ? "Crew rota" : "船员排班", [
        { text: words.line(words.tabs[0] ?? "", 0) },
      ]);
      const plain = language === "en" ? "Refit notes" : "改装笔记";
      const refits = words.headings[1]?.[0] ?? "";
      await writeNote(window, plain, [
        { heading: refits, level: 2 },
        { text: words.line(refits, 0) },
      ]);
      for (const [width, scheme] of [
        [1280, "light"],
        [900, "dark"],
        [1280, "dark"],
        [900, "light"],
      ] as const) {
        await setWindowSize(app, window, width, 760);
        await window.emulateMedia({ colorScheme: scheme });
        const editor = await openNote(window, words.title);
        const outline = await showPanel(window);
        await expect(outline).toHaveAccessibleName(words.panel);
        await pointAndClick(window, tabRows(outline).nth(1));
        await expect(openTab(outline)).toHaveText(words.tabs[1] ?? "");
        await expect(outline.getByTestId("outline-item")).toHaveText(words.headings[1] ?? []);
        await expect(outline.getByTestId("note-tab-new")).toHaveText(words.newTab);

        // Beside the page: the panel left of it, the text column still a readable line.
        const panelBox = await outline.boundingBox();
        const pageBox = await window.locator(".mind-tab-page").boundingBox();
        const line = editor.locator("p").filter({ hasText: words.checked });
        const lineBox = await line.boundingBox();
        if (!panelBox || !pageBox || !lineBox) throw new Error("The page isn't drawn.");
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(pageBox.x + 1);
        expect(lineBox.width).toBeGreaterThanOrEqual(240);
        // A long title is cut to fit, never wrapped.
        for (const row of await tabRows(outline).all()) {
          expect(await row.evaluate((each) => each.scrollHeight <= each.clientHeight + 1)).toBe(
            true,
          );
        }
        // One place marked as being read: the heading, its tab in darker text only.
        await expect(outline.locator('[aria-current="location"]')).toHaveText(
          words.headings[1]?.[0] ?? "",
        );
        expect(
          await openTab(outline).evaluate((tab) =>
            tab.parentElement?.classList.contains("pdf-outline-row--current"),
          ),
        ).toBe(false);
        const name = `note-tabs-${language}-${scheme}-${width}`;
        await still(window, `${name}-panel`);

        // Renaming in place.
        await tabRows(outline).nth(1).focus();
        await window.keyboard.press("F2");
        const field = outline.getByTestId("note-tab-name");
        await expect(field).toBeFocused();
        await still(window, `${name}-rename`);
        await window.keyboard.press("Escape");
        await expect(field).toHaveCount(0);
      }

      // A tab starts where a Note's first line starts: the hidden Blocks above it keep no room.
      await setWindowSize(app, window, 1280, 760);
      await window.emulateMedia({ colorScheme: "light" });
      const topOf = async (editor: Locator) =>
        editor.locator("h2", { hasText: refits }).evaluate((heading) => {
          const scroller = heading.closest(".mind-scroller");
          return heading.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0);
        });
      const plainEditor = await openNote(window, plain);
      await showPanel(window);
      const plainTop = await topOf(plainEditor);
      await still(window, `note-tabs-${language}-light-1280-top-plain`);
      const tabEditor = await openNote(window, words.title);
      await pointAndClick(window, tabRows(await showPanel(window)).nth(1));
      await expect.poll(async () => Math.abs((await topOf(tabEditor)) - plainTop)).toBeLessThan(1);
      await still(window, `note-tabs-${language}-light-1280-top-tab`);

      // A Note's first tab is named by its number in the interface's language.
      const rota = await openNote(window, language === "en" ? "Crew rota" : "船员排班");
      const outline = await showPanel(window);
      await still(window, `note-tabs-${language}-light-1280-none`);
      await pointAndClick(window, outline.getByTestId("note-tab-new"));
      await expect(outline.getByTestId("note-tab-name")).toBeFocused();
      await still(window, `note-tabs-${language}-light-1280-new`);
      await window.keyboard.press("Escape");
      await expect(tabRows(outline).first()).toHaveText(words.untitled);
      await expect(rota).toBeFocused();
    } finally {
      await app.close();
    }
  });
}
