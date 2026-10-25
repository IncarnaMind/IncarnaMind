import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  decisionServer,
  dismissChatSetup,
  focusRingShows,
  launchApp,
  removeDataFolder,
  setSidebarWidth,
  setWindowSize,
  sidebarFolder,
  tabTo,
} from "./app";

/*
 * Tags in the sidebar (#71): the Tags section, last in the tree, and the
 * colours of a Document's Tags on its row. Driven as a
 * person would: the mouse slides to what it clicks, in steps, and the
 * keyboard is real key presses. Set INCARNAMIND_SCREENSHOTS to a folder to
 * save screenshots there, in English and Chinese.
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
  if (!SCREENSHOTS) return;
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Slides the mouse onto `target`, in steps, and checks it is what lies under the pointer. */
async function slideTo(window: Page, target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("Nothing to point at: the target has no box.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await window.mouse.move(x, y, { steps: 12 });
  await expect
    .poll(() =>
      target.evaluate(
        (element, [px, py]) => {
          const hit = document.elementFromPoint(px as number, py as number);
          return hit !== null && (element === hit || element.contains(hit));
        },
        [x, y],
      ),
    )
    .toBe(true);
  return { x, y };
}

async function slideAndClick(window: Page, target: Locator): Promise<void> {
  await slideTo(window, target);
  await window.mouse.down();
  await window.mouse.up();
}

/**
 * Puts the focus on a row of the tree as the keyboard does: the tree is one Tab stop, the row
 * last focused, so Tab from outside it comes back to `row`.
 */
async function tabIntoRow(window: Page, row: Locator): Promise<void> {
  await row.focus();
  await window.keyboard.press("Shift+Tab");
  await window.keyboard.press("Tab");
  await expect(row).toBeFocused();
}

/** Writes text files and adds them; waits until each is ready. */
async function addTextDocuments(window: Page, files: Record<string, string>): Promise<void> {
  const paths: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    const path = join(sources, name);
    await writeFile(path, text);
    paths.push(path);
  }
  await addDocuments(window, paths);
}

/** Puts Tags on Documents, by name, through the core's bridge, as the Tag picker would. */
const tagDocuments = (window: Page, wanted: Record<string, string[]>) =>
  window.evaluate(async (byName) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const tags = await bridge.listTags();
    for (const item of await bridge.listDocuments()) {
      for (const name of byName[item.name] ?? []) {
        const tag = tags.find((each) => each.name === name);
        if (!tag) throw new Error(`No Tag named ${name}.`);
        await bridge.addDocumentTag(item.id, tag.id);
      }
    }
  }, wanted);

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (wanted) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: wanted },
      }),
    language,
  );

/** Each Tag row's name, count and dot's colour (null for "Needs review", which has the review ring). */
const tagRowsListed = (rows: Locator) =>
  rows.evaluateAll((all) =>
    all.map((row) => {
      const head = row.firstElementChild as HTMLElement;
      return [
        head.querySelector('[data-testid="row-text"]')?.textContent,
        Number(head.querySelector('[data-testid="browse-count"]')?.textContent),
        head.querySelector('[data-testid="tag-dot"]')?.getAttribute("data-colour") ?? null,
      ];
    }),
  );

/** The colours a Document row shows, in order, and its "+N" (or null). */
const marksOf = (row: Locator) =>
  row.evaluate((element) => {
    const marks = element.querySelector('[data-testid="tag-marks"]');
    return {
      colours: Array.from(marks?.querySelectorAll('[data-testid="tag-dot"]') ?? []).map((dot) =>
        dot.getAttribute("data-colour"),
      ),
      more: marks?.querySelector('[data-testid="tag-marks-more"]')?.textContent ?? null,
    };
  });

test("the Tags section lists each Tag a Document carries with its colour and count, and filters the Library by it, with the mouse and the keyboard", async () => {
  const { server } = await decisionServer();
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.setViewportSize({ width: 1100, height: 760 });
    await addTextDocuments(window, {
      "Attention.txt": "Attention is all you need: transformers for translation.",
      "Q1 report.txt": "Quarterly report: sales grew in every region.",
      "March invoice.txt": "Invoice 2026-03 for consulting. Total due: 1,200.",
      "Field notes.txt": "Observations of tides at the harbour.",
    });
    await tagDocuments(window, { Attention: ["Paper", "Book", "Contract", "Report"] });
    // Library Folders, and Organize with a local decision server: Report on the report,
    // and Invoice on the invoice, awaiting review.
    const port = (server.address() as AddressInfo).port;
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.addLibraryStarterGroups(["reports", "finance"]);
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: false,
      });
      await core.classifyDocuments();
    }, `http://127.0.0.1:${port}`);

    // One tree: the Folders, then the Tags in use, under their headings.
    await expect(window.getByTestId("folders-title")).toHaveText("Folders");
    const tagsToggle = window.getByTestId("tags-toggle");
    await expect(tagsToggle).toHaveText("Tags");
    await expect(tagsToggle).toHaveAttribute("aria-expanded", "true");
    // In the Folders, the rows show their Tags' colours too: Organize files
    // Attention in Reports & presentations, which opens in place.
    const reports = sidebarFolder(window, "Reports & presentations");
    await expect(reports.getByTestId("browse-count")).toHaveText("3");
    await slideAndClick(window, reports.getByTestId("folder-row"));
    await expect(reports).toHaveAttribute("data-expanded", "true");
    const attentionInFolders = reports
      .getByTestId("document-list-item")
      .filter({ hasText: "Attention" });
    await expect(attentionInFolders.getByTestId("tag-dot")).toHaveCount(3);
    expect(await marksOf(attentionInFolders)).toEqual({
      colours: ["orange", "red", "purple"],
      more: "+1",
    });

    // The Tags each Document carries, in name order, with its colour and how many carry it. A Tag
    // no Document has isn't listed, and nor is "Needs review": Tags are reviewed in the Library.
    const tagList = window.getByTestId("sidebar-tags");
    const tagRows = tagList.getByTestId("sidebar-tag");
    await expect
      .poll(() => tagRowsListed(tagRows), { timeout: 20_000 })
      .toEqual([
        ["Book", 1, "orange"],
        ["Contract", 1, "red"],
        ["Invoice", 1, "green"],
        ["Paper", 1, "purple"],
        ["Report", 2, "blue"],
      ]);
    const byName = (name: string) =>
      tagRows.filter({
        has: window.locator(':scope > div [data-testid="row-text"]', { hasText: name }),
      });
    // A Tag is an 11px solid dot, as in Finder's Tags; "Needs review" a hollow amber ring.
    const paperDot = byName("Paper").locator(":scope > div").getByTestId("tag-dot");
    expect(await paperDot.evaluate(dotShape)).toEqual({
      width: 11,
      height: 11,
      round: true,
      filled: true,
      border: 1,
    });
    // Rows are 28px, their marks in the icon column and their names on the text edge.
    const sidebarLeft = (await window.getByTestId("sidebar").boundingBox())?.x ?? 0;
    for (const row of await tagRows.all()) {
      const head = await row.locator(":scope > div").boundingBox();
      expect(head?.height).toBeCloseTo(28, 0);
      const text = await row.locator(':scope > div [data-testid="row-text"]').boundingBox();
      expect((text?.x ?? 0) - sidebarLeft).toBeCloseTo(40, 0);
    }
    // Clicking a Tag shows its Documents in the Library, through its Tag filter, and marks it
    // chosen; the sidebar's tree stays as it was, so nothing moves under the pointer.
    const library = window.getByTestId("library");
    const tagFilter = library.locator('[data-testid="library-filter"][data-facet="tag"]');
    const openTag = (name: string) => byName(name).locator(":scope > div > button").first();
    const listBefore = await tagList.boundingBox();
    await slideAndClick(window, openTag("Paper"));
    await expect(library).toBeVisible();
    await expect(tagFilter).toHaveText("Tags: Paper");
    await expect(library.getByTestId("library-document")).toHaveCount(1);
    await expect(openTag("Paper")).toHaveAttribute("aria-selected", "true");
    await expect(openTag("Report")).toHaveAttribute("aria-selected", "false");
    expect(await tagList.boundingBox()).toEqual(listBefore);
    await expect(reports.getByTestId("document-list-item")).toHaveCount(3);
    await screenshot(window, "tags-tab-en");

    // By keyboard: on Report's row, Enter shows it, Enter again stops filtering.
    await tabIntoRow(window, openTag("Report"));
    expect(await focusRingShows(window)).toBe(true);
    await window.keyboard.press("Enter");
    await expect(tagFilter).toHaveText("Tags: Report");
    await expect(library.getByTestId("library-document")).toHaveCount(2);
    await expect(openTag("Report")).toHaveAttribute("aria-selected", "true");
    await expect(openTag("Paper")).toHaveAttribute("aria-selected", "false");
    await window.keyboard.press("Enter");
    await expect(tagFilter).toHaveCount(0);
    await expect(library.getByTestId("library-document")).toHaveCount(4);
    await expect(openTag("Report")).toHaveAttribute("aria-selected", "false");
    await window.keyboard.press("Enter");
    await expect(tagFilter).toHaveText("Tags: Report");
    await expect(openTag("Report")).toBeFocused();
    expect(await focusRingShows(window)).toBe(true);
    // On to the Tags heading, which folds them, every stop with its ring.
    await tabTo(window, tagsToggle);
    expect(await focusRingShows(window)).toBe(true);

    // The Library's Tags filter has each Tag after its dot, and "Needs review" after the ring.
    await slideAndClick(window, tagFilter.getByTestId("library-filter-chip"));
    const libraryTagMenu = library.locator('[data-testid="library-filter-menu"][data-facet="tag"]');
    const reviewOption = libraryTagMenu.locator(
      '[data-testid="library-filter-option"][data-value="needs-review"]',
    );
    await expect(reviewOption.getByTestId("review-ring")).toHaveCount(1);
    await expect(reviewOption.getByTestId("tag-dot")).toHaveCount(0);
    await expect(
      libraryTagMenu
        .getByTestId("library-filter-option")
        .filter({ hasText: "Report" })
        .getByTestId("tag-dot"),
    ).toHaveAttribute("data-colour", "blue");
    await screenshot(window, "library-filter-menu-en");
    await window.keyboard.press("Escape");
    await expect(libraryTagMenu).toBeHidden();

    // In Chinese.
    await setLanguage(window, "zh-CN");
    await expect(tagsToggle).toHaveText("标签");
    await slideAndClick(window, openTag("Paper"));
    await expect(tagFilter).toHaveText("标签：Paper");
    await expect(openTag("Paper")).toHaveAttribute("aria-selected", "true");
    await window.mouse.move(700, 400, { steps: 6 });
    await screenshot(window, "tags-tab-zh");
    await slideAndClick(window, tagFilter.getByTestId("library-filter-chip"));
    await expect(reviewOption.getByTestId("review-ring")).toHaveCount(1);
    await screenshot(window, "library-filter-menu-zh");
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
    server.close();
  }
});

test("a Document row shows up to three Tag colours and +N after its name, names them on hover and on focus, and stays one 28px line", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.setViewportSize({ width: 1100, height: 760 });
    const long = "Tidal patterns in the North Sea, observed over two winters at three harbours";
    await addTextDocuments(window, {
      "Attention.txt": "Attention is all you need.",
      "Q1 report.txt": "Quarterly report: sales grew.",
      "Field notes.txt": "Observations of tides.",
      [`${long}.txt`]: "Tides.",
    });
    const items = window.getByTestId("document-list-item");
    const row = (name: string) => items.filter({ hasText: name });
    const boxes = async () => Promise.all((await items.all()).map((each) => each.boundingBox()));
    const before = await boxes();

    await tagDocuments(window, {
      Attention: ["Paper", "Book", "Contract", "Report"],
      "Q1 report": ["Report"],
      [long]: ["Paper", "Notes"],
    });
    await expect(row("Attention").getByTestId("tag-dot")).toHaveCount(3);
    // The Tags arrive one by one: wait for the fourth's "+1", not just three dots.
    await expect
      .poll(() => marksOf(row("Attention")))
      .toEqual({ colours: ["orange", "red", "purple"], more: "+1" });
    await expect.poll(() => marksOf(row("Q1 report"))).toEqual({ colours: ["blue"], more: null });
    await expect
      .poll(() => marksOf(row(long)))
      .toEqual({ colours: ["gray", "purple"], more: null });
    await expect(row("Field notes").getByTestId("tag-marks")).toHaveCount(0);
    // Nothing moved: every row where it was, 28px, its name on one line.
    expect(await boxes()).toEqual(before);

    /**
     * The marks right after the name, inside the row: 10px round dots, each
     * overlapping the one before by 4px, ringed in the row's background.
     */
    const expectMarksInRow = async (name: string) => {
      const box = await row(name).boundingBox();
      const marks = await row(name).getByTestId("tag-marks").boundingBox();
      const text = await row(name).getByTestId("row-text").boundingBox();
      if (!box || !marks || !text) throw new Error("The row isn't visible.");
      expect(box.height).toBeCloseTo(28, 0);
      expect(text.height).toBeLessThanOrEqual(20.5);
      expect(marks.x).toBeCloseTo(text.x + text.width + 8, 0);
      expect(marks.y).toBeGreaterThanOrEqual(box.y);
      expect(marks.y + marks.height).toBeLessThanOrEqual(box.y + box.height);
      expect(marks.x + marks.width).toBeLessThanOrEqual(box.x + box.width - 8);
      const dots = await row(name).getByTestId("tag-dot").all();
      let previous: number | null = null;
      for (const each of dots) {
        expect(await each.evaluate(dotShape)).toEqual({
          width: 10,
          height: 10,
          round: true,
          filled: true,
          border: 1,
        });
        const x = (await each.boundingBox())?.x ?? 0;
        if (previous !== null) expect(x - previous).toBeCloseTo(6, 0);
        previous = x;
      }
    };
    await expectMarksInRow("Attention");
    await expectMarksInRow(long);
    // A long name gives way to the colours, not the other way round.
    expect(
      await row(long)
        .getByTestId("row-text")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);

    // Pointed at, the row's tooltip names its Tags; its description says them to a screen reader.
    const attention = row("Attention").getByTestId("open-document");
    await slideTo(window, row("Attention").getByTestId("row-text"));
    // The tooltip carries the file's name, with its extension, then the Tags.
    await expect(attention).toHaveAttribute(
      "title",
      /^Attention\nAttention\.\w+\nTags: Book, Contract, Paper, Report$/,
    );
    await expect(attention).toHaveAccessibleDescription("Tags: Book, Contract, Paper, Report");
    expect(await row("Attention").boundingBox()).toEqual(before[await indexOf(items, "Attention")]);
    // Pointed at, the row's actions have the dots' room; away, they're back, ringed in the sidebar's frame.
    await expect(row("Attention").getByTestId("tag-marks")).toBeHidden();
    await window.mouse.move(700, 400, { steps: 6 });
    await expect(row("Attention").getByTestId("tag-marks")).toBeVisible();
    await expect
      .poll(() =>
        row("Attention")
          .getByTestId("tag-dot")
          .nth(1)
          .evaluate((element) => getComputedStyle(element).boxShadow),
      )
      .toContain("rgb(244, 245, 247)");

    // Reached by keyboard, the row shows its Tags' names, each after its dot, under it.
    const tip = window.getByTestId("tag-names-tip");
    await expect(tip).toBeHidden();
    await tabIntoRow(window, attention);
    expect(await focusRingShows(window)).toBe(true);
    await expect(tip).toBeVisible();
    await expect(tip.getByTestId("tag-names-tip-tag")).toHaveText([
      "Book",
      "Contract",
      "Paper",
      "Report",
    ]);
    expect(
      await tip
        .getByTestId("tag-dot")
        .evaluateAll((all) => all.map((each) => each.getAttribute("data-colour"))),
    ).toEqual(["orange", "red", "purple", "blue"]);
    const rowBox = await row("Attention").boundingBox();
    const tipBox = await tip.boundingBox();
    if (!rowBox || !tipBox) throw new Error("The row or the tip isn't visible.");
    expect(tipBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height);
    // The row's actions have taken the dots' place, so the first dot sits under the name's start.
    await expect(row("Attention").getByTestId("tag-marks")).toBeHidden();
    const nameBox = await row("Attention").getByTestId("row-text").boundingBox();
    const dotBox = await tip.getByTestId("tag-dot").first().boundingBox();
    if (!nameBox || !dotBox) throw new Error("The name or the tip's first dot isn't visible.");
    expect(dotBox.x).toBeCloseTo(nameBox.x, 0);
    await screenshot(window, "row-marks-en");
    // Off the row, it goes; back, it comes; Esc puts it away.
    await window.keyboard.press("Tab");
    await expect(tip).toBeHidden();
    await window.keyboard.press("Shift+Tab");
    await expect(attention).toBeFocused();
    await expect(tip).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await expect(attention).toBeFocused();
    // A row without Tags has no tip.
    await tabIntoRow(window, row("Field notes").getByTestId("open-document"));
    await expect(tip).toBeHidden();

    // A narrow sidebar: still one 28px line each, the colours inside.
    await setSidebarWidth(window, 165);
    await expect
      .poll(async () => (await window.getByTestId("sidebar").boundingBox())?.width)
      .toBeCloseTo(165, 0);
    await expectMarksInRow("Attention");
    await expectMarksInRow(long);
    await setSidebarWidth(window, 248);
    await expect
      .poll(async () => (await window.getByTestId("sidebar").boundingBox())?.width)
      .toBeCloseTo(248, 0);

    // In Chinese.
    await setLanguage(window, "zh-CN");
    await expect(attention).toHaveAttribute(
      "title",
      "Attention\nAttention.txt\n标签：Book, Contract, Paper, Report",
    );
    await expect(attention).toHaveAccessibleDescription("标签：Book, Contract, Paper, Report");
    await tabIntoRow(window, attention);
    await expect(tip).toBeVisible();
    await screenshot(window, "row-marks-zh");
  } finally {
    await app.close();
  }
});

test("the Tag names shown for the keyboard go as soon as the arrow keys move on, and never cover the name of the row the focus is on, with the pointer resting under them", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1100, 760);
    await addTextDocuments(window, {
      "Ops standup notes.txt": "Stand-up: the pilot boards at dawn.",
      "Supplier review notes.txt": "Aldermoor Freight delivered on time.",
      "Board minutes.txt": "The board met in March.",
      "Q1 report.txt": "Quarterly report: sales grew.",
      "Field notes.txt": "Observations of tides.",
    });
    const items = window.getByTestId("document-list-item");
    const names = await items.getByTestId("row-text").allTextContents();
    // Two rows with Tags, one after the other, after one without.
    const [first, tagged, alsoTagged] = names;
    if (!first || !tagged || !alsoTagged) throw new Error("The sidebar lists too few Documents.");
    const wanted: Record<string, string[]> = {
      [tagged]: ["Notes", "Report"],
      [alsoTagged]: ["Report"],
    };
    await tagDocuments(window, wanted);
    const row = (name: string) => items.filter({ hasText: name });
    await expect(row(tagged).getByTestId("tag-dot")).toHaveCount(2);
    await expect(row(alsoTagged).getByTestId("tag-dot")).toHaveCount(1);
    expect(await items.getByTestId("row-text").allTextContents()).toEqual(names);

    // The pointer rests on the third row's name, where the second row's Tag names show.
    const under = await row(alsoTagged).getByTestId("row-text").boundingBox();
    if (!under) throw new Error("The third row isn't visible.");
    const pointer = { x: under.x + 10, y: under.y + under.height / 2 };
    await window.mouse.move(pointer.x, pointer.y, { steps: 6 });
    await tabIntoRow(window, row(first).getByTestId("open-document"));

    /** The row the focus is on, the Tag names shown, and whether they cover that row's name or the pointer. */
    const seen = () =>
      window.evaluate((at) => {
        const focused = document.activeElement?.closest('[data-testid="document-list-item"]');
        const name = focused?.querySelector('[data-testid="row-text"]');
        const tip = document.querySelector('[data-testid="tag-names-tip"]');
        const open = tip?.matches(":popover-open") === true;
        const nameBox = name?.getBoundingClientRect();
        const tipBox = tip?.getBoundingClientRect();
        const overlap = (a: DOMRect, b: DOMRect) =>
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return {
          focused: name?.textContent ?? null,
          tags: open
            ? Array.from(tip?.querySelectorAll('[data-testid="tag-names-tip-tag"]') ?? []).map(
                (each) => each.textContent,
              )
            : null,
          coversName: open && nameBox && tipBox ? overlap(nameBox, tipBox) : false,
          underPointer:
            open && tipBox
              ? at.x > tipBox.left &&
                at.x < tipBox.right &&
                at.y > tipBox.top &&
                at.y < tipBox.bottom
              : false,
        };
      }, pointer);
    /** Once the focus is on `name`'s row, at that moment, what shows. */
    const onRow = async (name: string) => {
      let now = await seen();
      await expect
        .poll(async () => {
          now = await seen();
          return now.focused;
        })
        .toBe(name);
      return now;
    };

    expect(await onRow(first)).toMatchObject({ tags: null });
    await window.keyboard.press("ArrowDown");
    // Under the row, over the next rows' names and the resting pointer, never its own name.
    expect(await onRow(tagged)).toEqual({
      focused: tagged,
      tags: ["Notes", "Report"],
      coversName: false,
      underPointer: true,
    });
    await window.keyboard.press("ArrowDown");
    // The focus has moved onto a name they covered: they've gone from it, to the new row's own.
    expect(await onRow(alsoTagged)).toMatchObject({ tags: ["Report"], coversName: false });
    for (const name of names.slice(3)) {
      await window.keyboard.press("ArrowDown");
      expect(await onRow(name)).toMatchObject({ tags: null });
    }
    for (const name of names.slice(0, -1).reverse()) {
      await window.keyboard.press("ArrowUp");
      expect(await onRow(name)).toMatchObject({
        tags: wanted[name] ?? null,
        coversName: false,
      });
    }
    await expect(window.getByTestId("tag-names-tip")).toBeHidden();
  } finally {
    await app.close();
  }
});

/** A dot's size, whether it is round, solid or hollow, and its edge's width. */
function dotShape(element: Element) {
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return {
    width: Math.round(box.width * 10) / 10,
    height: Math.round(box.height * 10) / 10,
    round: Number.parseFloat(style.borderTopLeftRadius) >= box.width / 2,
    filled: style.backgroundColor !== "rgba(0, 0, 0, 0)",
    border: Number.parseFloat(style.borderTopWidth),
  };
}

/** Where the row with this name is among `items`. */
async function indexOf(items: Locator, name: string): Promise<number> {
  const names = await items.getByTestId("row-text").allTextContents();
  return names.indexOf(name);
}
