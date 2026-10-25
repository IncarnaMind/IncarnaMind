import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { TYPE_AHEAD_MS } from "../src/renderer/src/treeNavigation";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  focusRingShows,
  launchApp,
  linkFolderFromSidebar,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSourceLocations,
  typeWithInputMethod,
} from "./app";

/*
 * The sidebar's tree by keyboard (docs/agents/interaction.md, rules 6 and 7):
 * one Tab stop, ↑ ↓ Home End to walk, → and ← to unfold, fold, step in and out,
 * Enter to open, F2 to rename, Space to peek, ⌘⌫ (Delete on Windows and Linux)
 * to move to Recently deleted with the undo line, and typing a name to jump to
 * it. Every step is a key press; each row says its role, level, state and
 * selection to a screen reader (the accessibility tree is read, not the markup).
 */

const LANGUAGES = ["en", "zh-CN"] as const;
type Language = (typeof LANGUAGES)[number];

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

interface Names {
  folders: readonly [string, string];
  mind: string;
  inFolder: readonly [string, string];
  loose: readonly [string, string];
}

const NAMES: Record<Language, Names> = {
  en: {
    folders: ["Finance", "Research"],
    mind: "Shortlist",
    inFolder: ["Board minutes", "Budget 2026"],
    loose: ["Field notes", "Tide tables"],
  },
  "zh-CN": {
    folders: ["研究", "财务"],
    mind: "候选清单",
    inFolder: ["董事会纪要", "预算表"],
    loose: ["实地笔记", "潮汐表"],
  },
};

/**
 * Two Folders, a Mind and two Documents in the first, and two Documents in no
 * Folder: the tree has every kind of row, at two levels.
 */
async function seed(window: Page, language: Language): Promise<Names> {
  const names = NAMES[language];
  const paths: string[] = [];
  for (const name of [...names.inFolder, ...names.loose]) {
    const path = join(sources, `${name}.txt`);
    await writeFile(path, `${name}: spring tides come twice a month.\n`);
    paths.push(path);
  }
  await addDocuments(window, paths);
  await (await coreOf(window)).evaluate(
    async (core, made) => {
      const first = await core.createLibraryGroup({ name: made.first, description: "" });
      await core.createLibraryGroup({ name: made.second, description: "" });
      for (const document of await core.listDocuments()) {
        if (made.inFirst.includes(document.name.replace(/\.txt$/, ""))) {
          await core.assignDocumentGroup(document.id, first.id);
        }
      }
      const mind = await core.createMind({ folderId: first.id });
      await core.renameMind(mind.id, made.mind);
    },
    {
      first: names.folders[0],
      second: names.folders[1],
      inFirst: [...names.inFolder],
      mind: names.mind,
    },
  );
  await setLanguage(window, language);
  await expect(
    window.getByTestId("library-folder").filter({ hasText: names.folders[0] }),
  ).toHaveAttribute("data-count", "2");
  await expect(window.getByTestId("not-in-a-folder")).toHaveAttribute("data-count", "2");
  return names;
}

/** A row of the tree, by its name (or its start, as a pattern), in any of its sections. */
const row = (window: Page, name: string | RegExp, { exact = false } = {}) =>
  window.getByTestId("sidebar-sections").getByRole("treeitem", { name, exact });

/** Every row of the tree, in its sections' order. */
const allRows = (window: Page) => window.getByTestId("sidebar-sections").getByRole("treeitem");

/**
 * Puts a preset Tag on a Document, through the core: the sidebar lists the Tags in use. A preset
 * is named in the language it was made in, so it goes by any of `tagNames`.
 */
async function tagWith(window: Page, documentName: string, tagNames: string[]): Promise<void> {
  await (await coreOf(window)).evaluate(
    async (core, wanted) => {
      const tag = (await core.listTags()).find((each) => wanted.tags.includes(each.name));
      const document = (await core.listDocuments()).find((each) =>
        each.name.startsWith(wanted.document),
      );
      if (!tag || !document) throw new Error("No such Tag or Document.");
      await core.addTagToDocuments([document.id], tag.id);
    },
    { document: documentName, tags: tagNames },
  );
}

/** The field a name is typed in, in the sidebar. */
const nameField = (window: Page) => window.getByTestId("sidebar").locator("input:not([type=file])");

const inTree = (window: Page) =>
  window.evaluate(() => document.activeElement?.closest('[role="tree"]') != null);

/**
 * Notes where the focus is each time rows leave the tree, as soon as the page could take a key
 * (the app's own watch runs first): `focusAsRowsGo` reads the notes.
 */
const watchFocusAsRowsGo = (window: Page) =>
  window.evaluate(() => {
    const seen: boolean[] = [];
    const row = '[role="treeitem"]';
    new MutationObserver((records) => {
      const gone = records.some((record) =>
        Array.from(record.removedNodes).some(
          (node) => node instanceof Element && (node.matches(row) || node.querySelector(row)),
        ),
      );
      if (gone) seen.push(document.activeElement?.closest('[role="tree"]') != null);
    }).observe(document.body, { childList: true, subtree: true });
    (globalThis as unknown as { focusAsRowsGo: boolean[] }).focusAsRowsGo = seen;
  });

const focusAsRowsGo = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { focusAsRowsGo: boolean[] }).focusAsRowsGo);

/** From the Library row above the tree, Tab until the focus is in it, past the Folders heading's +. */
async function tabIntoTree(window: Page): Promise<void> {
  await window.getByTestId("open-library").focus();
  for (let step = 0; step < 12 && !(await inTree(window)); step++) {
    await window.keyboard.press("Tab");
  }
  expect(await inTree(window)).toBe(true);
}

/** Puts the focus back on a row as the keyboard does: Tab returns to the tree's one stop, the row last focused. */
async function tabBackTo(window: Page, target: Locator): Promise<void> {
  await target.focus();
  await window.keyboard.press("Shift+Tab");
  await window.keyboard.press("Tab");
  await expect(target).toBeFocused();
}

/** How many rows are in the Tab order, and how many other controls in the tree are. */
const tabStops = (window: Page) =>
  window.evaluate(() => {
    const stops = [...document.querySelectorAll('[role="tree"] *')].filter(
      (element) => element instanceof HTMLElement && element.tabIndex >= 0,
    );
    const rows = stops.filter((element) => element.getAttribute("role") === "treeitem");
    return { rows: rows.length, others: stops.length - rows.length };
  });

/**
 * The focused row has one ring (DESIGN.md, Focus): 2px, just inside the whole row and drawn by the
 * row, none on its main button; its actions sit inside it, clear of it, on the row's own fill.
 */
async function expectOneRing(window: Page): Promise<void> {
  await expect(async () => {
    const look = await window.evaluate(() => {
      const item = document.activeElement;
      const row = item?.closest(".group");
      if (!(item instanceof HTMLElement) || !row) return null;
      const probe = document.createElement("span");
      probe.style.color = "var(--color-accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const ring = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          drawn: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
          width: Number.parseFloat(style.outlineWidth),
          color: style.outlineColor,
          offset: Number.parseFloat(style.outlineOffset),
        };
      };
      const box = (element: Element) => element.getBoundingClientRect();
      const actions = row.querySelector(".row-actions");
      return {
        accent,
        focusVisible: item.matches(":focus-visible"),
        item: ring(item),
        row: ring(row),
        rowBox: box(row),
        itemBox: box(item),
        actionsBox: actions && box(actions),
        actionsFill: actions && getComputedStyle(actions).backgroundColor,
        rowFill: getComputedStyle(row).backgroundColor,
      };
    });
    if (!look) throw new Error("The focus isn't on a row's main button.");
    expect(look.focusVisible).toBe(true);
    expect(look.item.drawn, "the main button has no ring of its own").toBe(false);
    expect(look.row).toEqual({ drawn: true, width: 2, color: look.accent, offset: -2 });
    // The button is in the row, as tall as it, so the ring is the row's edge.
    expect(look.itemBox.top).toBeCloseTo(look.rowBox.top, 0);
    expect(look.itemBox.bottom).toBeCloseTo(look.rowBox.bottom, 0);
    expect(look.itemBox.left).toBeGreaterThanOrEqual(look.rowBox.left);
    if (look.actionsBox) {
      // The actions don't cover the ring, and their fill is the row's.
      expect(look.actionsBox.top).toBeGreaterThanOrEqual(look.rowBox.top + 2 - 0.5);
      expect(look.actionsBox.bottom).toBeLessThanOrEqual(look.rowBox.bottom - 2 + 0.5);
      expect(look.actionsBox.right).toBeLessThanOrEqual(look.rowBox.right - 2 + 0.5);
      expect(look.actionsFill).toBe(look.rowFill);
      expect(look.rowFill).not.toBe("rgba(0, 0, 0, 0)");
    }
  }).toPass();
}

/** What is typed within a pause of the last key joins it: tried again, a pause later, until the letters stand alone. */
const afterAPause = (attempt: () => Promise<void>) =>
  expect(attempt).toPass({ intervals: [TYPE_AHEAD_MS + 200], timeout: 15_000 });

/** Types a name, which jumps to `jumpsTo`. */
const typeName = (window: Page, typed: string, jumpsTo: Locator) =>
  afterAPause(async () => {
    await window.keyboard.type(typed);
    await expect(jumpsTo).toBeFocused({ timeout: 300 });
  });

/** A key that types a character the keyboard hasn't (a Chinese one), pressed on the focused row. */
const typeCharacter = (focused: Locator, key: string, jumpsTo: Locator) =>
  afterAPause(async () => {
    await focused.dispatchEvent("keydown", { key, bubbles: true, cancelable: true });
    await expect(jumpsTo).toBeFocused({ timeout: 300 });
  });

for (const language of LANGUAGES) {
  test(`the tree is one Tab stop with a visible ring, and each row says its level, state and selection (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1400, 800);
      await dismissChatSetup(window);
      const names = await seed(window, language);
      const tree = window
        .getByTestId("folders-section")
        .getByRole("tree", { name: translate(language, "library.groups") });
      const loose = window
        .getByTestId("not-in-a-folder")
        .getByRole("tree", { name: translate(language, "library.unsorted") });
      await expect(tree).toHaveAttribute("aria-multiselectable", "true");
      await expect(loose).toHaveAttribute("aria-multiselectable", "true");

      // One row is in the Tab order, and none of the buttons that sit beside the rows.
      expect(await tabStops(window)).toEqual({ rows: 1, others: 0 });
      await tabIntoTree(window);
      const first = row(window, names.folders[0]);
      await expect(first).toBeFocused();
      expect(await focusRingShows(window)).toBe(true);
      // The next Tab leaves the tree, and Shift+Tab comes back to the same row.
      await window.keyboard.press("Tab");
      expect(await inTree(window)).toBe(false);
      await window.keyboard.press("Shift+Tab");
      await expect(first).toBeFocused();
      expect(await tabStops(window)).toEqual({ rows: 1, others: 0 });

      // Unfold the first Folder, walk to its Documents, and select both with Shift+↓.
      await expect(first).toHaveAttribute("aria-expanded", "false");
      await window.keyboard.press("ArrowRight");
      await expect(first).toHaveAttribute("aria-expanded", "true");
      await window.keyboard.press("ArrowDown");
      await expect(row(window, names.mind)).toBeFocused();
      await window.keyboard.press("ArrowDown");
      await window.keyboard.press("Shift+ArrowDown");
      expect(await focusRingShows(window)).toBe(true);
      expect(await tabStops(window)).toEqual({ rows: 1, others: 0 });

      const [boardMinutes, budget] = names.inFolder;
      const documents = `(${boardMinutes}|${budget})`;
      const looseNames = `(${names.loose.join("|")})`;
      await expect(tree).toMatchAriaSnapshot(`
        - tree:
          - treeitem /^${names.folders[0]}/ [expanded] [level=1]
          - treeitem /^${names.mind}/ [level=2]
          - treeitem /^${documents}/ [level=2] [selected]
          - treeitem /^${documents}/ [level=2] [selected]
          - treeitem /^${names.folders[1]}/ [level=1]
      `);
      await expect(loose).toMatchAriaSnapshot(`
        - tree:
          - treeitem /^${looseNames}/ [level=1]
          - treeitem /^${looseNames}/ [level=1]
      `);
      await expect(row(window, names.folders[1])).toHaveAttribute("aria-expanded", "false");
      await expect(row(window, names.mind)).toHaveAttribute("aria-selected", "false");
    } finally {
      await app.close();
    }
  });
}

for (const language of LANGUAGES) {
  for (const width of [900, 1600]) {
    test(`the focused row of every kind has one ring just inside the whole row, with its fill under the actions (${language}, ${width}px)`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await setWindowSize(app, window, width, 800);
        await dismissChatSetup(window);
        const names = await seed(window, language);
        const document = row(window, new RegExp(`^(${names.inFolder.join("|")})`)).first();

        // A Folder, a Mind, and a Document, which is also open and selected.
        await tabIntoTree(window);
        await expectOneRing(window);
        await window.keyboard.press("ArrowRight");
        await window.keyboard.press("ArrowDown");
        await expect(row(window, names.mind)).toBeFocused();
        await expectOneRing(window);
        await window.keyboard.press("ArrowDown");
        await expect(document).toBeFocused();
        await expectOneRing(window);
        await window.keyboard.press("Enter");
        await expect(document).toHaveAttribute("aria-selected", "true");
        await tabBackTo(window, document);
        await expectOneRing(window);

        // A Tag, in the Tags section.
        await tagWith(window, names.loose[0] ?? "", ["Report", "报告"]);
        await tabBackTo(window, row(window, /^Report|^报告/).first());
        await expectOneRing(window);
      } finally {
        await app.close();
      }
    });
  }
}

test("↑ ↓ Home and End walk the rows, → and ← unfold, fold, step in and step out, in Folders and in Not in a Folder", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    const names = await seed(window, "en");
    const finance = row(window, names.folders[0]);
    const research = row(window, names.folders[1]);
    const shortlist = row(window, names.mind);
    const rows = allRows(window);

    await tabIntoTree(window);
    await expect(finance).toBeFocused();
    await expect(rows).toHaveCount(4);

    // ↓ and ↑ move one row, from section to section; End and Home go to the last and the first.
    await window.keyboard.press("ArrowDown");
    await expect(research).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(rows.nth(2)).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(research).toBeFocused();
    await window.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    await window.keyboard.press("Home");
    await expect(finance).toBeFocused();
    // ↑ from the first row goes on to Library and Search above the tree, and ↓ comes back.
    await window.keyboard.press("ArrowUp");
    await expect(window.getByTestId("open-library")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(window.getByTestId("sidebar-search")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowDown");
    await expect(finance).toBeFocused();

    // → unfolds a Folder and stays on it; → again steps into it, to its first row, a level deeper.
    await window.keyboard.press("ArrowRight");
    await expect(finance).toHaveAttribute("aria-expanded", "true");
    await expect(finance).toBeFocused();
    await expect(rows).toHaveCount(7);
    await window.keyboard.press("ArrowRight");
    await expect(shortlist).toBeFocused();
    await expect(shortlist).toHaveAttribute("aria-level", "2");
    // A row with nothing in it has nowhere to step in.
    await window.keyboard.press("ArrowRight");
    await expect(shortlist).toBeFocused();
    // ← on a row steps out to its Folder; ← on an open Folder folds it; on a closed one, nothing.
    await window.keyboard.press("ArrowLeft");
    await expect(finance).toBeFocused();
    await window.keyboard.press("ArrowLeft");
    await expect(finance).toHaveAttribute("aria-expanded", "false");
    await expect(rows).toHaveCount(4);
    await window.keyboard.press("ArrowLeft");
    await expect(finance).toBeFocused();

    // A Folder with nothing in it opens and closes too, and Enter does the same.
    await window.keyboard.press("ArrowDown");
    await expect(research).toBeFocused();
    await window.keyboard.press("ArrowRight");
    await expect(research).toHaveAttribute("aria-expanded", "true");
    await window.keyboard.press("ArrowRight");
    await expect(research).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(research).toHaveAttribute("aria-expanded", "false");

    // Not in a Folder's rows are at the top level, under its heading: ← and → have nowhere to go.
    await window.keyboard.press("ArrowDown");
    await expect(rows.nth(2)).toBeFocused();
    await expect(rows.nth(2)).toHaveAttribute("aria-level", "1");
    await window.keyboard.press("ArrowLeft");
    await expect(rows.nth(2)).toBeFocused();
    await window.keyboard.press("ArrowRight");
    await expect(rows.nth(2)).toBeFocused();

    // Shift+↓ selects from the focused row down, and a plain arrow moves without changing it.
    await window.keyboard.press("Shift+ArrowDown");
    await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(rows.nth(3)).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("ArrowUp");
    await expect(rows.nth(2)).toBeFocused();
    await expect(rows.nth(3)).toHaveAttribute("aria-selected", "true");
  } finally {
    await app.close();
  }
});

test("a Linked folder is one row of the tree, reached by the arrows: → and ← leave it as it is, and Enter opens the Library", async () => {
  const library = join(sources, "Library");
  for (const file of ["root.txt", "A/top.txt", "A/B/mid.txt"]) {
    await mkdir(dirname(join(library, file)), { recursive: true });
    await writeFile(join(library, file), `${file}: spring tides come twice a month.\n`);
  }
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await linkFolderFromSidebar(app, window, library);
    await showSourceLocations(window);
    const section = window.getByTestId("linked-folders-section");
    const linked = section.getByRole("treeitem", { name: /^Library/ });
    await expect(section.getByRole("treeitem")).toHaveCount(1);
    await expect(linked).toHaveAttribute("aria-level", "1");
    await expect(linked).not.toHaveAttribute("aria-expanded");
    // Its files are rows of Not in a Folder.
    await expect(
      window.getByTestId("not-in-a-folder").getByRole("treeitem", { name: /^(root|top|mid)/ }),
    ).toHaveCount(3);

    // From the Documents in Not in a Folder, ↓ goes on into the Linked folders section.
    await tabIntoTree(window);
    for (
      let step = 0;
      step < 8 && !(await linked.evaluate((item) => item === document.activeElement));
      step++
    ) {
      await window.keyboard.press("ArrowDown");
    }
    await expect(linked).toBeFocused();
    await expectOneRing(window);
    for (const key of ["ArrowRight", "ArrowLeft"]) {
      await window.keyboard.press(key);
      await expect(linked).toBeFocused();
      await expect(section.getByRole("treeitem")).toHaveCount(1);
    }
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("library")).toBeVisible();
  } finally {
    await app.close();
  }
});

for (const language of LANGUAGES) {
  test(`typing the first letters of a name jumps to the next row that starts with them (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1400, 800);
      await dismissChatSetup(window);
      const names = await seed(window, language);
      const finance = row(window, names.folders[0]);
      const research = row(window, names.folders[1]);
      const [firstLoose, secondLoose] = names.loose;
      const [boardMinutes, budget] = names.inFolder;
      const shortlist = row(window, names.mind);

      await tabIntoTree(window);
      await window.keyboard.press("ArrowRight");
      await expect(finance).toHaveAttribute("aria-expanded", "true");
      await expect(row(window, boardMinutes)).toBeVisible();

      if (language === "en") {
        // One letter goes to the next row that starts with it, whatever its case; it wraps round.
        await typeName(window, "t", row(window, secondLoose));
        await typeName(window, "r", research);
        await typeName(window, "s", shortlist);
        // The same letter twice goes on to the next that starts with it.
        await typeName(window, "ff", finance);
        // Several letters typed together name the row they spell: "fie" is Field notes, not Finance.
        await typeName(window, "fie", row(window, firstLoose));
        // Another letter, typed before the pause is over, goes on spelling the name: "bot" is no row.
        await typeName(window, "bo", row(window, boardMinutes));
        await window.keyboard.type("t");
        await expect(row(window, boardMinutes)).toBeFocused();
        // A pause starts a new name.
        await typeName(window, "t", row(window, secondLoose));
        // Space is Peek's, never a letter of the name: it peeks at the Document just jumped to.
        await typeName(window, "bu", row(window, budget));
        await window.keyboard.press("Space");
        await expect(window.getByTestId("peek-name")).toHaveText(budget);
        await window.keyboard.press("Escape");
        await expect(window.getByTestId("peek")).toHaveCount(0);
        await expect(row(window, budget)).toBeFocused();
        // A name no row starts with leaves the focus where it is.
        await window.keyboard.type("q");
        await expect(row(window, budget)).toBeFocused();
      } else {
        // A Chinese name is found by the pinyin of its characters, as ⌘K does, ...
        await typeName(window, "chao", row(window, secondLoose));
        await typeName(window, "cai", research);
        await typeName(window, "yan", finance);
        await typeName(window, "shi", row(window, firstLoose));
        await typeName(window, "dong", row(window, boardMinutes));
        await typeName(window, "hou", shortlist);
        await typeName(window, "yu", row(window, budget));
        // ... and by the characters themselves, as they show: a key that types one of them.
        await row(window, boardMinutes).focus();
        await typeCharacter(row(window, boardMinutes), "潮", row(window, secondLoose));
        await typeCharacter(row(window, secondLoose), "财", research);
      }

      // While an input method composes, its keys are its own: nothing moves.
      const here = row(window, names.folders[0]);
      await here.focus();
      for (const press of [
        { key: "r", isComposing: true },
        { key: "Process", keyCode: 229 },
      ]) {
        await here.dispatchEvent("keydown", { ...press, bubbles: true, cancelable: true });
        await expect(here).toBeFocused();
      }

      // In a name being renamed, letters are the name's: the field keeps the focus and the rows stay.
      await row(window, secondLoose).focus();
      await window.keyboard.press("F2");
      const field = nameField(window);
      await expect(field).toBeFocused();
      await window.keyboard.type("zz");
      await expect(field).toHaveValue(/zz$/);
      await expect(field).toBeFocused();
      await window.keyboard.press("Escape");
      await expect(field).toHaveCount(0);
      await expect(row(window, secondLoose)).toBeFocused();
    } finally {
      await app.close();
    }
  });
}

test("Enter opens a row, Space peeks at a Document, F2 renames in place and Esc gives it up, with no mouse", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    const names = await seed(window, "en");
    const finance = row(window, names.folders[0]);
    const tree = window.getByTestId("sidebar-sections");

    await tabIntoTree(window);
    // Enter on a Folder opens it in place; the focus stays.
    await window.keyboard.press("Enter");
    await expect(finance).toHaveAttribute("aria-expanded", "true");
    await expect(finance).toBeFocused();

    // Space peeks at a Document without opening the viewer; Esc puts it away and the row keeps the focus.
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowDown");
    const target = tree.getByRole("treeitem", { name: /^(Board minutes|Budget 2026)/ }).first();
    await expect(target).toBeFocused();
    const targetName = (await target.getByTestId("row-text").textContent()) ?? "";
    await window.keyboard.press("Space");
    await expect(window.getByTestId("peek-name")).toHaveText(targetName);
    await expect(window.getByTestId("viewer")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("peek")).toHaveCount(0);
    await expect(target).toBeFocused();

    // Enter opens it in the viewer, beside the Mind, and selects just that row.
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("viewer")).toBeVisible();
    await expect(target).toHaveAttribute("aria-selected", "true");

    // F2 renames in place: Esc gives it up; an input method's Enter doesn't save; Enter does.
    await tabBackTo(window, target);
    await window.keyboard.press("F2");
    const field = nameField(window);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(targetName);
    await window.keyboard.type("Not this");
    await window.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(target.getByTestId("row-text")).toHaveText(targetName);
    await expect(target).toBeFocused();
    await window.keyboard.press("F2");
    await expect(field).toBeFocused();
    await typeWithInputMethod(window, field, "新名称");
    const renamed = row(window, "新名称");
    await expect(renamed).toBeFocused();
    await expect(field).toHaveCount(0);
    await expect(window.getByRole("dialog")).toHaveCount(0);

    // A Folder renames the same way, and a Mind opens on Enter.
    await finance.focus();
    await window.keyboard.press("F2");
    await expect(field).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(finance).toBeFocused();
    await row(window, names.mind).focus();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("tab-title").filter({ hasText: names.mind })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("⌘⌫ (Delete on Windows and Linux) moves the row to Recently deleted with the undo line, the focus goes on to the next row, and ⌘Z brings it back, twice and for a selection", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    const names = await seed(window, "en");
    const [firstLoose, secondLoose] = names.loose;
    const line = window.getByTestId("undo-message");
    const rows = allRows(window);
    const loose = (name: string) => row(window, name);

    // Four rows: the two Folders and the two Documents in none; End is on the last.
    await tabIntoTree(window);
    await window.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    const count = await rows.count();

    // One row: it goes, the line says so, and the focus is on a row, not lost.
    const last = rows.last();
    const lastName = (await last.getByTestId("row-text").textContent()) ?? "";
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(rows).toHaveCount(count - 1);
    await expect(line).toHaveText(translate("en", "object.deleted", { name: lastName }));
    await expect.poll(() => inTree(window)).toBe(true);
    expect(await focusRingShows(window)).toBe(true);
    await expect(rows.last()).toBeFocused();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(rows).toHaveCount(count);
    await expect(line).toHaveCount(0);

    // The platform's own key, twice: each row goes in turn, and each is its own step of Undo.
    // The focus is on a row the moment each goes, so a key pressed straight after reaches the tree.
    const key = process.platform === "darwin" ? "Meta+Backspace" : "Delete";
    await watchFocusAsRowsGo(window);
    await window.keyboard.press("End");
    await window.keyboard.press(key);
    await expect(rows).toHaveCount(count - 1);
    await expect.poll(() => inTree(window)).toBe(true);
    await window.keyboard.press(key);
    await expect(rows).toHaveCount(count - 2);
    const seen = await focusAsRowsGo(window);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(false);
    await expect(line).toBeVisible();
    await expect(rows.last()).toBeFocused();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(rows).toHaveCount(count - 1);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(rows).toHaveCount(count);

    // A held key deletes one row only: the press does, its repeats don't.
    await expect(row(window, names.folders[1])).toBeFocused();
    await window.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(rows).toHaveCount(count - 1);
    await expect.poll(() => inTree(window)).toBe(true);
    await rows.last().dispatchEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      ...(process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true }),
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    // Once the core has answered what was asked of it before.
    await (await coreOf(window)).evaluate((core) => core.listDocuments());
    await expect(rows).toHaveCount(count - 1);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(rows).toHaveCount(count);

    // Several selected with Shift+↑: one line for all of them, and one Undo.
    await window.keyboard.press("End");
    await window.keyboard.press("Shift+ArrowUp");
    await expect(loose(firstLoose)).toHaveAttribute("aria-selected", "true");
    await expect(loose(secondLoose)).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(rows).toHaveCount(count - 2);
    await expect(line).toHaveText(translate("en", "object.deleted.documents", { count: 2 }));
    await window.keyboard.press("ControlOrMeta+z");
    await expect(rows).toHaveCount(count);

    // A Folder, and a Mind in another: each by its own row, with the same line.
    await row(window, names.folders[1]).focus();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(row(window, names.folders[1])).toHaveCount(0);
    await expect(line).toHaveText(translate("en", "object.deleted", { name: names.folders[1] }));
    await window.keyboard.press("ControlOrMeta+z");
    await expect(row(window, names.folders[1])).toHaveCount(1);
    await row(window, names.folders[0]).focus();
    await window.keyboard.press("ArrowRight");
    await window.keyboard.press("ArrowDown");
    await expect(row(window, names.mind)).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(row(window, names.mind)).toHaveCount(0);
    await expect(line).toHaveText(translate("en", "object.deleted", { name: names.mind }));
    await window.keyboard.press("ControlOrMeta+z");
    await expect(row(window, names.mind)).toHaveCount(1);

    // A Tag, in the Tags section, once a Document has it.
    await tagWith(window, firstLoose ?? "", ["Slides"]);
    const slides = row(window, /^Slides/);
    await slides.focus();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(slides).toHaveCount(0);
    await expect(line).toHaveText(translate("en", "object.deleted", { name: "Slides" }));
    await window.keyboard.press("ControlOrMeta+z");
    await expect(slides).toHaveCount(1);

    // In a field it is the field's: ⌘⌫ deletes a word of the name, not the row.
    await loose(firstLoose).focus();
    await window.keyboard.press("F2");
    const field = nameField(window);
    await expect(field).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Backspace");
    await expect(field).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(loose(firstLoose)).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("an empty sidebar has no row to stop at, and the keys of the tree do nothing there", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 700);
    await dismissChatSetup(window);
    await expect(allRows(window)).toHaveCount(0);
    expect(await tabStops(window)).toEqual({ rows: 0, others: 0 });
    await window.getByTestId("open-library").focus();
    for (const press of ["Tab", "Tab", "Tab", "ArrowDown", "Home", "End", "t", "Delete"]) {
      await window.keyboard.press(press);
      expect(await inTree(window)).toBe(false);
    }
    await expect(window.getByRole("alert")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
