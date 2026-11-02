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
  dragOnto,
  focusRingShows,
  launchApp,
  leaveText,
  removeDataFolder,
  setSidebarWidth,
  setWindowSize,
  sidebarFolder,
  tabTo,
  tagDocument,
  typeWithInputMethod,
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
    await expect(reports.getByTestId("browse-count")).toHaveText("3 · 3 suggested");
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
    // The row's button: its dot opens the colours, so the tree item is the one that opens the Tag.
    const openTag = (name: string) => byName(name).getByRole("treeitem");
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

/** The Tags' names in the core, in its order. */
const tagNames = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listTags()).map((tag) => tag.name);
  });

/** A Tag as the core holds it now. */
const tagNow = (window: Page, name: string) =>
  window.evaluate(async (wanted) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listTags()).find((tag) => tag.name === wanted) ?? null;
  }, name);

/** A Tag's row in the sidebar, found by the name it shows. */
const tagRow = (window: Page, name: string) =>
  window.getByTestId("sidebar-tag").filter({
    has: window.locator(':scope > div [data-testid="row-text"]', { hasText: name }),
  });

const documentRow = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });

/** Whether the section's +, its actions wrapper, is drawn: it shows on hover or focus, as in Notion. */
const plusOpacity = (window: Page) =>
  window
    .getByTestId("tags-add")
    .evaluate((element) => getComputedStyle(element.parentElement as HTMLElement).opacity);

test("the Tags heading's + makes a Tag in place, and a Tag renamed by double-click and F2 (safe with an input method) shows its new name on every Document that carries it, with Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.setViewportSize({ width: 1100, height: 760 });
    await addTextDocuments(window, {
      "Tides.txt": "Spring tides happen at new moon and at full moon.",
      "Moons.txt": "The Moon orbits the Earth once a month.",
      "Storms.txt": "North Sea storms come from the west.",
    });
    // A Tag in use, so the section is there: it and its + are hidden while no Tag is.
    await tagDocument(window, "Storms", "Report");
    const toggle = window.getByTestId("tags-toggle");
    const plus = window.getByTestId("tags-add");
    const newField = window.getByTestId("sidebar-tag-new-name");

    // At rest only the header's + shows; pointed at, the heading's + does, as in Notion.
    await window.mouse.move(700, 400, { steps: 4 });
    await expect.poll(() => plusOpacity(window)).toBe("0");
    await slideTo(window, toggle);
    await expect.poll(() => plusOpacity(window)).toBe("1");
    await slideAndClick(window, plus);

    // Named in place through a Chinese input method: its Enter only confirms the composition.
    await expect(newField).toBeFocused();
    await typeWithInputMethod(window, newField, "Thesis");
    const thesis = tagRow(window, "Thesis");
    await expect(thesis.getByTestId("row-text")).toHaveText("Thesis");
    await expect(thesis.getByTestId("browse-count")).toHaveText("0");
    await expect(thesis.getByRole("treeitem")).toBeFocused();
    expect(await tagNames(window)).toContain("Thesis");
    await expect(window.getByTestId("undo-message")).toHaveText("Created the Tag “Thesis”");

    // ⌘Z takes the new Tag away, into Recently deleted; ⇧⌘Z brings it back.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(thesis).toHaveCount(0);
    expect(await tagNames(window)).not.toContain("Thesis");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(thesis).toHaveCount(1);
    expect(await tagNames(window)).toContain("Thesis");

    // On two Documents, it counts them; then it renames where it is: a double-click, Enter saves.
    await tagDocuments(window, { Tides: ["Thesis"], Moons: ["Thesis"] });
    await expect(thesis.getByTestId("browse-count")).toHaveText("2");
    await thesis.getByTestId("row-text").dblclick();
    const field = window.getByTestId("sidebar-tags").getByRole("textbox");
    await expect(field).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(thesis.getByTestId("row-text")).toHaveText("Thesis");
    await expect(thesis.getByRole("treeitem")).toBeFocused();
    // F2, typed with an input method: 论文, shown on its row and on every Document that carries it.
    await window.keyboard.press("F2");
    await expect(field).toBeFocused();
    await typeWithInputMethod(window, field, "论文");
    const renamed = tagRow(window, "论文");
    await expect(renamed.getByTestId("browse-count")).toHaveText("2");
    expect(await tagNames(window)).toContain("论文");
    expect(await tagNames(window)).not.toContain("Thesis");
    await expect(
      documentRow(window, "Tides").getByTestId("open-document"),
    ).toHaveAccessibleDescription("Tags: 论文");
    await expect(
      documentRow(window, "Moons").getByTestId("open-document"),
    ).toHaveAccessibleDescription("Tags: 论文");
    // The Library the double-click opened shows its Documents through the Tag filter, under the
    // new name: on each Document, and on the filter itself.
    const library = window.getByTestId("library");
    const tagFilter = library.locator('[data-testid="library-filter"][data-facet="tag"]');
    await expect(tagFilter).toHaveText("Tags: 论文");
    const rows = library.getByTestId("library-document");
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all())
      await expect(row.getByTestId("tag-chip")).toHaveText("论文");

    // One Undo puts the old name back everywhere: the rows, the Documents and the filter.
    await window.getByTestId("undo-line").getByTestId("undo-action").click();
    await expect(tagRow(window, "Thesis")).toHaveCount(1);
    await expect(tagFilter).toHaveText("Tags: Thesis");
    for (const row of await rows.all())
      await expect(row.getByTestId("tag-chip")).toHaveText("Thesis");
    await expect(
      documentRow(window, "Tides").getByTestId("open-document"),
    ).toHaveAccessibleDescription("Tags: Thesis");

    // Folded, its rows are out of sight, and the heading's own menu still carries Manage Tags….
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(window.getByTestId("sidebar-tag")).toHaveCount(0);
    // By keyboard: the +, then the ⋯, both with their rings, then the menu's one item.
    await toggle.focus();
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("tags-add")).toBeFocused();
    await window.keyboard.press("Tab");
    const menuButton = window.getByTestId("tags-menu");
    await expect(menuButton).toBeFocused();
    expect(await focusRingShows(window)).toBe(true);
    await window.keyboard.press("Enter");
    const sectionMenu = window.getByTestId("tags-menu-items");
    await expect(sectionMenu).toBeVisible();
    const manage = sectionMenu.getByTestId("tags.manage");
    await expect(manage).toBeFocused();
    await expect(manage).toHaveAccessibleName("Manage Tags…");
    await window.keyboard.press("Enter");
    const tagsDialog = window.getByTestId("tags-dialog");
    await expect(tagsDialog).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(tagsDialog).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // In Chinese, the + and the section speak Chinese, and a name is checked in place too.
    await setLanguage(window, "zh-CN");
    await expect(toggle).toHaveText("标签");
    await expect(window.getByTestId("tags-add")).toHaveAccessibleName("新建标签");
    await expect(window.getByTestId("manage-tags-link")).toHaveAccessibleName("管理标签…");
    await tagRow(window, "Thesis").getByTestId("row-text").dblclick();
    await expect(field).toHaveValue("Thesis");
    await window.keyboard.press("Escape");

    // By keyboard: the + has the focus ring, Enter opens the field, Esc leaves no Tag.
    await window.mouse.move(700, 400, { steps: 4 });
    await toggle.focus();
    await window.keyboard.press("Tab");
    await expect(window.getByTestId("tags-add")).toBeFocused();
    expect(await focusRingShows(window)).toBe(true);
    await expect.poll(() => plusOpacity(window)).toBe("1");
    await window.keyboard.press("Enter");
    await expect(newField).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("sidebar-tag-new")).toHaveCount(0);
    await expect(window.getByTestId("tags-add")).toBeFocused();
    expect((await tagNames(window)).filter((name) => name === "")).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("a Tag made with the heading's + is still listed, with 0 Documents, after the app restarts", async () => {
  let { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await addTextDocuments(window, { "Tides.txt": "Spring tides happen at new moon." });
    // A preset Tag a Document carries, so the section is there.
    await tagDocument(window, "Tides", "Report");
    await window.getByTestId("tags-toggle").hover();
    await window.getByTestId("tags-add").click();
    await window.getByTestId("sidebar-tag-new-name").fill("Empty");
    await window.keyboard.press("Enter");
    await expect(tagRow(window, "Empty").getByTestId("browse-count")).toHaveText("0");
    expect(await tagNames(window)).toContain("Empty");

    await app.close();
    ({ app, window } = await launchApp(dataDir));
    await dismissChatSetup(window);
    // The core kept it, so the sidebar lists it: no Tag the User made is a phantom.
    expect(await tagNames(window)).toContain("Empty");
    await expect(tagRow(window, "Empty").getByTestId("browse-count")).toHaveText("0");
  } finally {
    await app.close();
  }
});

test("a Tag's menu, from a right-click, its ⋯ and the context-menu key, recolours, describes, merges, renames and deletes it, each with Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.setViewportSize({ width: 1200, height: 800 });
    await addTextDocuments(window, {
      "Tides.txt": "Spring tides happen at new moon.",
      "Moons.txt": "The Moon orbits the Earth.",
      "Storms.txt": "North Sea storms come from the west.",
    });
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const report = await core.createTag({
        name: "Findings",
        description: "Findings and summaries.",
      });
      const drafts = await core.createTag({ name: "Sketches" });
      for (const document of await core.listDocuments()) {
        const tagId =
          document.name === "Storms"
            ? drafts.id
            : document.name === "Tides" || document.name === "Moons"
              ? report.id
              : null;
        if (tagId) await core.addDocumentTag(document.id, tagId);
      }
    });
    const report = tagRow(window, "Findings");
    const sketches = tagRow(window, "Sketches");
    await expect(report.getByTestId("browse-count")).toHaveText("2");
    await expect(sketches.getByTestId("browse-count")).toHaveText("1");
    const colourNow = async (name: string) => (await tagNow(window, name))?.colour;
    const before = await colourNow("Findings");
    const other = before === "teal" ? "red" : "teal";
    const undoMessage = window.getByTestId("undo-message");
    const menu = report.getByTestId("tag-actions");

    // The dot, clicked, opens the eight colours in place; the chosen one is ringed.
    await slideAndClick(window, report.getByTestId("tag-dot-button"));
    const dotMenu = report.getByTestId("tag-colour-menu");
    await expect(dotMenu).toBeVisible();
    await expect(dotMenu.getByTestId("tag-colour-choice")).toHaveCount(8);
    await slideAndClick(
      window,
      dotMenu.locator(`[data-testid="tag-colour-choice"][data-colour="${other}"]`),
    );
    await expect.poll(() => colourNow("Findings")).toBe(other);
    await expect(report.getByTestId("tag-dot-button").getByTestId("tag-dot")).toHaveAttribute(
      "data-colour",
      other,
    );
    await expect(undoMessage).toHaveText("Changed the Tag “Findings”");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => colourNow("Findings")).toBe(before);

    // The menu has the same colours in its own row, in the shared order: Open · its own actions ·
    // Rename · Delete, each with a name for a screen reader.
    await slideTo(window, report.getByTestId("row-text"));
    await report.getByTestId("tag-menu").click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toHaveAccessibleName("Open");
    await expect(menu.getByTestId("tag.colour")).toHaveAccessibleName("Color");
    await expect(menu.getByTestId("tag.editDescription")).toHaveAccessibleName("Edit description…");
    await expect(menu.getByTestId("tag.merge")).toHaveAccessibleName("Merge into…");
    await expect(menu.getByTestId("tag.rename")).toHaveAccessibleName(/^Rename/);
    await expect(menu.getByTestId("tag.delete")).toHaveAccessibleName("Delete");
    await menu.locator(`[data-testid="tag-colour-choice"][data-colour="${before}"]`).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => colourNow("Findings")).toBe(before);
    // Already that colour: nothing changed, so nothing to take back.
    await expect(undoMessage).toHaveCount(0);

    // Edit description… opens the Tag's form in Manage Tags; Save changes it, with Undo.
    await slideTo(window, report.getByTestId("row-text"));
    await report.getByTestId("tag-menu").click();
    await menu.getByTestId("tag.editDescription").click();
    const dialog = window.getByTestId("tags-dialog");
    await expect(dialog).toBeVisible();
    // The row's own field, before the New Tag form's at the dialog's foot.
    const description = dialog.getByTestId("tag-description-input").first();
    await expect(description).toHaveValue("Findings and summaries.");
    await description.fill("Findings, summaries and invoices.");
    await dialog.getByTestId("save-tag").first().click();
    await expect(dialog.getByText("Findings, summaries and invoices.")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await tagNow(window, "Findings"))?.description)
      .toBe("Findings, summaries and invoices.");
    await expect(undoMessage).toHaveText("Changed the Tag “Findings”");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => (await tagNow(window, "Findings"))?.description)
      .toBe("Findings and summaries.");

    // A rename onto another Tag's name in Manage Tags merges too, and keeps the Tag kept's own
    // description and colour: the form sends them back unchanged, not as edits.
    await slideTo(window, sketches.getByTestId("row-text"));
    await sketches.getByTestId("tag-menu").click();
    await sketches.getByTestId("tag.editDescription").click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("tag-name-input").first().fill("Findings");
    await dialog.getByTestId("save-tag").first().click();
    await expect.poll(() => tagNames(window)).not.toContain("Sketches");
    await expect
      .poll(async () => (await tagNow(window, "Findings"))?.description)
      .toBe("Findings and summaries.");
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(undoMessage).toHaveText("Merged “Sketches” into Findings");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sketches).toHaveCount(1);

    // Merge into… merges it into another Tag from the same dialog; one Undo brings it back.
    await slideTo(window, sketches.getByTestId("row-text"));
    await sketches.getByTestId("tag-menu").click();
    await sketches.getByTestId("tag.merge").click();
    await expect(dialog).toBeVisible();
    const target = (await tagNow(window, "Findings"))?.id ?? "";
    await dialog.getByTestId("merge-target").selectOption(target);
    await dialog.getByTestId("confirm-merge-tag").click();
    await expect(dialog.getByTestId("tag-row").filter({ hasText: "Sketches" })).toHaveCount(0);
    await expect.poll(() => tagNames(window)).not.toContain("Sketches");
    await expect(report.getByTestId("browse-count")).toHaveText("3");
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(undoMessage).toHaveText("Merged “Sketches” into Findings");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(sketches).toHaveCount(1);
    await expect(sketches.getByTestId("browse-count")).toHaveText("1");

    // Rename from the menu, in place.
    await slideTo(window, report.getByTestId("row-text"));
    await report.getByTestId("tag-menu").click();
    await report.getByTestId("tag.rename").click();
    const field = window.getByTestId("sidebar-tags").getByRole("textbox");
    await expect(field).toHaveValue("Findings");
    await field.fill("Results");
    await window.keyboard.press("Enter");
    await expect(tagRow(window, "Results")).toHaveCount(1);
    await expect.poll(() => tagNames(window)).toContain("Results");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(tagRow(window, "Findings")).toHaveCount(1);

    // Delete asks nothing: it goes to Recently deleted, with Undo.
    await slideTo(window, report.getByTestId("row-text"));
    await report.getByTestId("tag-menu").click();
    await report.getByTestId("tag.delete").click();
    await expect(report).toHaveCount(0);
    await expect.poll(() => tagNames(window)).not.toContain("Findings");
    await expect(undoMessage).toHaveText("Moved “Findings” to Recently deleted");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(report).toHaveCount(1);
    await expect(report.getByTestId("browse-count")).toHaveText("2");

    // By keyboard: the context-menu key opens the same menu, the colours are items in it, and
    // picking one works with the focus ring showing.
    await report.getByRole("treeitem").focus();
    await window.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    const open = menu.getByRole("menuitem").first();
    await expect(open).toHaveAccessibleName("Open");
    await expect(open).toBeFocused();
    await window.keyboard.press("ArrowDown");
    const red = menu.getByRole("menuitemradio", { name: "Red" });
    await expect(red).toBeFocused();
    expect(await focusRingShows(window)).toBe(true);
    const chosen = before === "red" ? "blue" : "red";
    for (
      let step = 0;
      step < ["red", "orange", "yellow", "green", "teal", "blue"].indexOf(chosen);
      step++
    )
      await window.keyboard.press("ArrowDown");
    const colourItem = menu.getByRole("menuitemradio", {
      name: chosen === "blue" ? "Blue" : "Red",
    });
    await expect(colourItem).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect.poll(() => colourNow("Findings")).toBe(chosen);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => colourNow("Findings")).toBe(before);
  } finally {
    await app.close();
  }
});

test("two Documents dragged from the Library onto a Tag get it, with the count and one Undo, and Manage Tags… lists every Tag with its count and description", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await window.setViewportSize({ width: 1300, height: 800 });
    await addTextDocuments(window, {
      "Budget.txt": "Budget for the harbour survey.",
      "Ledger.txt": "The ledger of the harbour survey.",
      "Survey.txt": "The survey of the harbour.",
    });
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const contract = await core.createTag({
        name: "Agreements",
        description: "Agreements and their terms.",
      });
      const survey = (await core.listDocuments()).find((each) => each.name === "Survey");
      if (survey) await core.addDocumentTag(survey.id, contract.id);
    });
    const agreements = tagRow(window, "Agreements");
    await expect(agreements.getByTestId("browse-count")).toHaveText("1");
    const label = window.getByTestId("drop-label");
    const undoMessage = window.getByTestId("undo-message");

    // Manage Tags…, at the end of the section, lists every Tag with its count and description.
    await slideAndClick(window, window.getByTestId("manage-tags-link"));
    const dialog = window.getByTestId("tags-dialog");
    await expect(dialog).toBeVisible();
    const row = dialog.getByTestId("tag-row").filter({ hasText: "Agreements" });
    await expect(row.getByText("Agreements and their terms.")).toBeVisible();
    await expect(row.getByTestId("tag-count")).toHaveText("1 Document");
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Two Library rows chosen, dragged onto the Tag: it lights only while it accepts, says what the
    // drop does, and both get it, with one Undo that takes it off both.
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const libraryRow = (name: string) =>
      library.getByTestId("library-document").filter({ hasText: name });
    await expect(libraryRow("Ledger")).toBeVisible();
    await window.keyboard.down("ControlOrMeta");
    for (const name of ["Budget", "Ledger"]) {
      const nameBox = libraryRow(name).getByTestId("library-document-name");
      await slideTo(window, nameBox);
      await window.mouse.down();
      await window.mouse.up();
    }
    await window.keyboard.up("ControlOrMeta");
    await expect(library.getByTestId("library-selection")).toBeVisible();
    await dragOnto(
      window,
      libraryRow("Budget").getByTestId("library-document-name"),
      agreements,
      async () => {
        await expect(agreements).toHaveAttribute("data-drop-target", "true");
        await expect(label).toHaveText("Add the Tag Agreements to 2 Documents");
      },
    );
    await expect(label).toHaveCount(0);
    await expect(agreements).not.toHaveAttribute("data-drop-target", "true");
    await expect(undoMessage).toHaveText("Tagged 2 Documents Agreements");
    const carried = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const contract = (await core.listTags()).find((each) => each.name === "Agreements");
      return (await core.listDocuments())
        .filter((document) => document.tags.some((link) => link.tagId === contract?.id))
        .map((document) => document.name)
        .sort();
    });
    expect(carried).toEqual(["Budget", "Ledger", "Survey"]);
    await expect(agreements.getByTestId("browse-count")).toHaveText("3");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(agreements.getByTestId("browse-count")).toHaveText("1");

    // Manage Tags… from the keyboard: its focus ring shows, Enter opens the full list.
    await window.mouse.move(700, 400, { steps: 4 });
    await tabTo(window, window.getByTestId("manage-tags-link"));
    expect(await focusRingShows(window)).toBe(true);
    await window.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await window.keyboard.press("Escape");

    // In Chinese the menu keeps its own words.
    await setLanguage(window, "zh-CN");
    await expect(window.getByTestId("manage-tags-link")).toHaveText("管理标签…");
    await expect(agreements.getByTestId("tag-dot-button")).toHaveAccessibleName(
      "“Agreements”的颜色",
    );
    await slideTo(window, agreements.getByTestId("row-text"));
    await agreements.getByTestId("tag-menu").click();
    const menu = agreements.getByTestId("tag-actions");
    await expect(menu.getByTestId("tag.colour")).toHaveAccessibleName("颜色");
    await expect(menu.getByTestId("tag.editDescription")).toHaveAccessibleName("编辑描述…");
    await expect(menu.getByTestId("tag.merge")).toHaveAccessibleName("合并到…");
    await expect(menu.getByTestId("tag.rename")).toHaveAccessibleName(/^重命名/);
    await expect(menu.getByTestId("tag.delete")).toHaveAccessibleName("删除");
    await window.keyboard.press("Escape");
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
