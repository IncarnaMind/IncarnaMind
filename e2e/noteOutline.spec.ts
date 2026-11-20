import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import {
  blocksUpdate,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openMoreMenu,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  tabMenu,
} from "./app";

/*
 * A Note's outline (#3414): the button at the top left of its tab, the panel at the left of its
 * page, as the viewers have theirs. Set INCARNAMIND_SCREENSHOTS to a folder to also save stills.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function still(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

type Section = { heading: string; level: number } | { text: string };

const REPORT = {
  en: {
    title: "Harbourline Ferries: operations report",
    sections: [
      { heading: "Harbourline Ferries: operations report", level: 1 },
      { heading: "Summary", level: 2 },
      { heading: "Routes and sailings", level: 2 },
      { heading: "Island routes", level: 3 },
      { heading: "Night crossings to Kestrel Point and the outer harbour piers", level: 3 },
      { heading: "Fleet", level: 2 },
      { heading: "Refits", level: 3 },
      { heading: "Safety", level: 2 },
      { heading: "Outlook", level: 2 },
    ],
    line: (heading: string, at: number) =>
      `${heading}, part ${at + 1}: sailings ran on time on most days of the season, with the spring tides and the weather the main causes of delay.`,
  },
  "zh-CN": {
    title: "港湾轮渡运营报告",
    sections: [
      { heading: "港湾轮渡运营报告", level: 1 },
      { heading: "摘要", level: 2 },
      { heading: "航线与班次", level: 2 },
      { heading: "海岛航线", level: 3 },
      { heading: "开往鹰角及外港各码头的夜间航班", level: 3 },
      { heading: "船队", level: 2 },
      { heading: "改装", level: 3 },
      { heading: "安全", level: 2 },
      { heading: "展望", level: 2 },
    ],
    line: (heading: string, at: number) =>
      `${heading}（第 ${at + 1} 段）：本季大多数日子航班准点，延误主要来自大潮和天气。`,
  },
} as const;

/** A Note of these blocks, made through the core as another device's edit arrives. */
async function writeNote(window: Page, title: string, blocks: readonly Section[]): Promise<string> {
  const doc = new Y.Doc();
  doc.getXmlFragment("blocks").push(
    blocks.map((block) => {
      const node = new Y.XmlElement("heading" in block ? "heading" : "paragraph");
      node.setAttribute("id", crypto.randomUUID());
      // Stored as the editor stores them: a heading's level is a number.
      if ("heading" in block) node.setAttribute("level", block.level as unknown as string);
      node.insert(0, [new Y.XmlText("heading" in block ? block.heading : block.text)]);
      return node;
    }),
  );
  const update = Array.from(Y.encodeStateAsUpdate(doc));
  return window.evaluate(
    async ([title, change]) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await core.createMind({ title });
      await core.applyMindUpdate(mind.id, new Uint8Array(change));
      await core.closeMind(mind.id);
      return mind.id;
    },
    [title, update] as const,
  );
}

/** The ferry company's report: each heading followed by a few paragraphs. */
const writeReport = (window: Page, language: keyof typeof REPORT) => {
  const report = REPORT[language];
  return writeNote(
    window,
    report.title,
    report.sections.flatMap((section) => [
      section,
      ...Array.from({ length: 5 }, (_, at) => ({ text: report.line(section.heading, at) })),
    ]),
  );
};

async function openNote(window: Page, title: string): Promise<Locator> {
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
  const editor = window.getByTestId("mind-editor");
  await expect(editor.locator("h1")).toBeVisible();
  return editor;
}

/** Where each heading of the page starts, from the top of what scrolls the Note. */
const headingTops = (window: Page) =>
  window.getByTestId("mind-scroller").evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top;
    return [...scroller.querySelectorAll(".mind-editor :is(h1, h2, h3)")].map(
      (heading) => heading.getBoundingClientRect().top - top,
    );
  });

/** The entry the outline marks as being read, by its place in the list. */
const currentEntry = (outline: Locator) =>
  outline
    .getByTestId("outline-item")
    .evaluateAll((items) => items.findIndex((item) => item.getAttribute("aria-current")));

test("a Note's outline opens beside its page by mouse and keyboard, follows the reading, jumps, closes with Esc and is remembered", async () => {
  let running = await launchApp(dataDir);
  try {
    const { app, window } = running;
    await dismissChatSetup(window);
    await setLanguage(window, "en");
    await setWindowSize(app, window, 1280, 800);
    const reportId = await writeReport(window, "en");
    await writeNote(window, "Crew rota", [
      { heading: "Crew rota", level: 1 },
      { text: "Two crews a day on the island routes." },
    ]);

    // One heading has nowhere to go: no button, and ⌘K doesn't offer it.
    await openNote(window, "Crew rota");
    await expect(window.getByTestId("outline-button")).toHaveCount(0);
    expect(await paletteOffers(window, "mind.outline", "outline")).toBe(0);

    // A Note with headings: the button at the top left of its tab, level with the ⋯; closed at first.
    const editor = await openNote(window, REPORT.en.title);
    const button = window.getByTestId("outline-button");
    const outline = window.getByTestId("outline");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveAttribute("title", /^Show outline \((⌥⌘L|Ctrl\+Alt\+L)\)$/);
    await expect(outline).toHaveCount(0);
    const buttonBox = await button.boundingBox();
    const menuBox = await window.getByTestId("page-menu").boundingBox();
    const textBox = await editor.locator("h1").boundingBox();
    if (!buttonBox || !menuBox || !textBox) throw new Error("The page isn't drawn.");
    expect(Math.abs(buttonBox.y - menuBox.y)).toBeLessThanOrEqual(1);
    expect(buttonBox.x).toBeLessThan(textBox.x);
    expect(buttonBox.y + buttonBox.height).toBeLessThan(textBox.y);
    await still(window, "note-outline-closed");

    // By mouse: the panel at the left of the page, its headings indented by level, the first read.
    await pointAndClick(window, button);
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(outline).toHaveAccessibleName("Outline");
    const items = outline.getByTestId("outline-item");
    await expect(items).toHaveText(REPORT.en.sections.map((section) => section.heading));
    expect(
      await items.evaluateAll((all) => all.map((each) => each.getAttribute("data-depth"))),
    ).toEqual(["0", "1", "1", "2", "2", "1", "2", "1", "1"]);
    const indents = await items.evaluateAll((all) =>
      all.map((each) => Number.parseFloat(getComputedStyle(each).paddingLeft)),
    );
    expect(indents[1]).toBeGreaterThan(indents[0] ?? 0);
    expect(indents[3]).toBeGreaterThan(indents[1] ?? 0);
    const panelBox = await outline.boundingBox();
    const pageBox = await window.locator(".mind-tab-page").boundingBox();
    if (!panelBox || !pageBox) throw new Error("The outline isn't drawn.");
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(pageBox.x + 1);
    await expect(items.first()).toHaveAttribute("aria-current", "location");
    // A long heading is cut to fit, the whole of it in its tooltip and for a screen reader.
    const long = items.nth(4);
    await expect(long).toHaveAttribute("title", REPORT.en.sections[4].heading);
    await expect(long).toHaveAccessibleName(REPORT.en.sections[4].heading);
    expect(await long.evaluate((each) => each.scrollWidth > each.clientWidth)).toBe(true);

    // As the page scrolls, the entry marked is the last heading above the reading line.
    await window.mouse.move(pageBox.x + pageBox.width / 2, pageBox.y + pageBox.height / 2);
    await window.mouse.wheel(0, 1600);
    await expect.poll(() => currentEntry(outline)).toBeGreaterThan(1);
    await expect
      .poll(async () => {
        const tops = await headingTops(window);
        return tops.findLastIndex((top) => top <= 96) === (await currentEntry(outline));
      })
      .toBe(true);
    await still(window, "note-outline-scrolled");

    // A click goes to its heading, with the cursor at its start, and marks it.
    const safety = editor.locator("h2", { hasText: "Safety" });
    await pointAndClick(window, items.filter({ hasText: "Safety" }));
    await expect(items.nth(7)).toHaveAttribute("aria-current", "location");
    await expect(editor).toBeFocused();
    const landed = (await headingTops(window))[7] ?? -1;
    expect(landed).toBeGreaterThanOrEqual(0);
    expect(landed).toBeLessThanOrEqual(96);
    await window.keyboard.type("Fleet ");
    await expect(safety).toHaveText("Fleet Safety");
    // The outline follows the edit: the entry is renamed.
    await expect(items.nth(7)).toHaveText("Fleet Safety");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(items.nth(7)).toHaveText("Safety");

    // By keyboard: ⌥⌘L hides it, and shows it again with the focus on the entry being read.
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await expect(outline).toHaveCount(0);
    await expect(editor).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await expect(items.nth(7)).toBeFocused();
    expect(await items.nth(7).evaluate((item) => item.matches(":focus-visible"))).toBe(true);
    await window.keyboard.press("ArrowUp");
    await expect(items.nth(6)).toBeFocused();
    await window.keyboard.press("Home");
    await expect(items.first()).toBeFocused();
    await window.keyboard.press("End");
    await expect(items.last()).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await window.keyboard.press("ArrowUp");
    await expect(items.nth(6)).toBeFocused();
    // Enter goes there and gives the focus back to the Note, the cursor at the heading's start.
    await window.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(items.nth(6)).toHaveAttribute("aria-current", "location");
    await window.keyboard.type("Hull ");
    await expect(editor.locator("h3", { hasText: "Hull Refits" })).toBeVisible();
    await window.keyboard.press("ControlOrMeta+z");

    // The outline is one Tab stop after its button: Shift+Tab reaches the button, Enter works it.
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await window.keyboard.press("ControlOrMeta+Alt+L");
    await expect(items.nth(6)).toBeFocused();
    await window.keyboard.press("Shift+Tab");
    await expect(button).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(outline).toHaveCount(0);
    await expect(button).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(outline).toBeVisible();
    await window.keyboard.press("Tab");
    await expect(items.nth(6)).toBeFocused();
    // Esc closes it and gives the focus back to the Note.
    await window.keyboard.press("Escape");
    await expect(outline).toHaveCount(0);
    await expect(editor).toBeFocused();

    // ⌘K and the Note's menu show and hide it too, by name.
    expect(await paletteOffers(window, "mind.outline", "outline")).toBe(1);
    await runCommand(window, "mind.outline", "Show outline");
    await expect(outline).toBeVisible();
    const more = await openMoreMenu(window, await tabMenu(window));
    await expect(more.getByTestId("mind.outline")).toHaveText(/Hide outline/);
    await pointAndClick(window, more.getByTestId("mind.outline"));
    await expect(outline).toHaveCount(0);
    await pointAndClick(window, button);
    await expect(outline).toBeVisible();

    // A heading another writer adds (the assistant, an agent, another device) shows at once.
    const added = new Y.XmlElement("heading");
    added.setAttribute("id", crypto.randomUUID());
    added.setAttribute("level", 2 as unknown as string);
    added.insert(0, [new Y.XmlText("Dispatcher's note")]);
    const update = Array.from(blocksUpdate([added]));
    await window.evaluate(
      ([id, change]) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.applyMindUpdate(
          id,
          new Uint8Array(change),
        ),
      [reportId, update] as const,
    );
    await expect(items).toHaveCount(REPORT.en.sections.length + 1);
    await expect(items.filter({ hasText: "Dispatcher's note" })).toHaveCount(1);

    // Remembered for this Note: the other Note opens without it, and this one comes back with it.
    await openNote(window, "Crew rota");
    await expect(outline).toHaveCount(0);
    await openNote(window, REPORT.en.title);
    await expect(outline).toBeVisible();
    await app.close();

    running = await launchApp(dataDir);
    await openNote(running.window, REPORT.en.title);
    await expect(running.window.getByTestId("outline")).toBeVisible();
    await pointAndClick(running.window, running.window.getByTestId("outline-button"));
    await expect(running.window.getByTestId("outline")).toHaveCount(0);
  } finally {
    await running.app.close();
  }
});

test("in Chinese, in a 900-pixel window with the sidebar open and in dark, the outline and the text both stay readable", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 700);
    await window.emulateMedia({ colorScheme: "dark" });
    await writeReport(window, "zh-CN");
    const editor = await openNote(window, REPORT["zh-CN"].title);
    await expect(window.getByTestId("sidebar")).toBeVisible();
    const button = window.getByTestId("outline-button");
    await expect(button).toHaveAttribute("aria-label", "显示目录");
    expect(await paletteOffers(window, "mind.outline", "大纲")).toBe(1);

    await pointAndClick(window, editor.locator("p").first());
    await window.keyboard.press("ControlOrMeta+Alt+L");
    const outline = window.getByTestId("outline");
    await expect(outline).toHaveAccessibleName("目录");
    await expect(button).toHaveAttribute("aria-label", "隐藏目录");
    await expect(outline.getByTestId("outline-item")).toHaveText(
      REPORT["zh-CN"].sections.map((section) => section.heading),
    );
    await expect(outline.getByTestId("outline-item").first()).toBeFocused();

    // Beside the page, as a PDF's: the text column narrows and still holds a readable line.
    const panelBox = await outline.boundingBox();
    const pageBox = await window.locator(".mind-tab-page").boundingBox();
    const lineBox = await editor.locator("p").first().boundingBox();
    if (!panelBox || !pageBox || !lineBox) throw new Error("The page isn't drawn.");
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(pageBox.x + 1);
    expect(lineBox.width).toBeGreaterThanOrEqual(320);
    expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
    await still(window, "note-outline-900-zh-dark");
  } finally {
    await app.close();
  }
});
