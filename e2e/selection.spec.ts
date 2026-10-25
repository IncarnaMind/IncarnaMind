import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  clickEditItem,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * One way to select (docs/agents/interaction.md, rule 6): in the sidebar and
 * in the Library a click opens and selects just that item, ⌘-click or Ctrl-click
 * adds or removes, Shift-click extends from the anchor, ⌘A selects everything
 * in view, Esc clears, and Shift+↑ and Shift+↓ extend. The same journey runs
 * in both places, with the mouse slid onto each row.
 */

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

const NAMES = ["Tides", "Currents", "Waves", "Estuaries", "Reefs"];

async function addFiveDocuments(window: Page): Promise<void> {
  const paths = [];
  for (const name of NAMES) {
    const path = join(sources, `${name}.txt`);
    await writeFile(path, `${name} are a part of the sea.\n`);
    paths.push(path);
  }
  await addDocuments(window, paths);
}

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** A place with Documents in rows: how to find its rows, what a click goes on, and what it says is selected. */
interface Place {
  name: "sidebar" | "library";
  rows(window: Page): Locator;
  target(row: Locator): Locator;
  /** The row's button, which takes the keys. */
  main(row: Locator): Locator;
  /** What a screen reader hears. */
  announced(window: Page): Locator;
  said: Record<"en" | "zh-CN", (count: number) => string>;
}

const PLACES: Place[] = [
  {
    name: "sidebar",
    rows: (window) => window.getByTestId("sidebar").getByTestId("document-list-item"),
    target: (row) => row.getByTestId("open-document"),
    main: (row) => row.getByTestId("open-document"),
    announced: (window) => window.getByTestId("sidebar-selection"),
    said: { en: (count) => `${count} selected`, "zh-CN": (count) => `已选 ${count} 项` },
  },
  {
    name: "library",
    rows: (window) => window.getByTestId("library").getByTestId("library-document"),
    target: (row) => row.getByTestId("library-document-name"),
    main: (row) => row.locator("[data-row-main]"),
    announced: (window) => window.getByTestId("library-selection").getByRole("status"),
    said: { en: (count) => `${count} selected`, "zh-CN": (count) => `已选 ${count} 个` },
  },
];

/** What says a row is selected: its tree item in the sidebar, the row itself in the Library. */
const marked = (row: Locator) => row.getByRole("treeitem").or(row.and(row.page().getByRole("row")));

async function expectSelected(rows: Locator, selected: number[]): Promise<void> {
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    await expect(marked(rows.nth(index)), `row ${index}`).toHaveAttribute(
      "aria-selected",
      selected.includes(index) ? "true" : "false",
    );
  }
}

const withKey = { modifiers: ["ControlOrMeta"] } as const;
const withShift = { modifiers: ["Shift"] } as const;

for (const language of ["en", "zh-CN"] as const) {
  for (const place of PLACES) {
    test(`in the ${place.name}, a click opens, ⌘-click and Shift-click select, ⌘A selects all, Esc clears and Shift+↓ extends (${language})`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await setWindowSize(app, window, 1400, 800);
        await dismissChatSetup(window);
        await addFiveDocuments(window);
        await setLanguage(window, language);
        if (place.name === "library") await window.getByTestId("open-library").click();
        const rows = place.rows(window);
        await expect(rows).toHaveCount(NAMES.length);
        const tabs = window.getByTestId("tab-title");
        await expectSelected(rows, []);

        // A click opens it and selects just that one.
        await pointAndClick(window, place.target(rows.nth(1)));
        await expectSelected(rows, [1]);
        const opened = await tabs.count();

        // ⌘-click adds a row, and opens nothing.
        await pointAndClick(window, place.target(rows.nth(3)), withKey);
        await expectSelected(rows, [1, 3]);
        await expect(tabs).toHaveCount(opened);
        await expect(place.announced(window)).toContainText(place.said[language](2));

        // ⌘-click on a selected row takes it out.
        await pointAndClick(window, place.target(rows.nth(1)), withKey);
        await expectSelected(rows, [3]);

        // Shift-click extends from the last one clicked, and opens nothing.
        await pointAndClick(window, place.target(rows.nth(3)));
        await expectSelected(rows, [3]);
        const tabsNow = await tabs.count();
        await pointAndClick(window, place.target(rows.nth(0)), withShift);
        await expectSelected(rows, [0, 1, 2, 3]);
        await expect(tabs).toHaveCount(tabsNow);
        await expect(place.announced(window)).toContainText(place.said[language](4));

        // ⌘A, with the focus in the list, selects everything in view.
        await window.keyboard.press("ControlOrMeta+a");
        await expectSelected(rows, [0, 1, 2, 3, 4]);
        await expect(place.announced(window)).toContainText(place.said[language](5));

        // Esc clears.
        await window.keyboard.press("Escape");
        await expectSelected(rows, []);

        // A click, then Shift+↓ and Shift+↑ extend, with the focus following.
        await pointAndClick(window, place.target(rows.nth(1)));
        await place.main(rows.nth(1)).focus();
        await window.keyboard.press("Shift+ArrowDown");
        await expectSelected(rows, [1, 2]);
        await expect(place.main(rows.nth(2))).toBeFocused();
        await window.keyboard.press("Shift+ArrowDown");
        await expectSelected(rows, [1, 2, 3]);
        await expect(place.announced(window)).toContainText(place.said[language](3));
        await window.keyboard.press("Shift+ArrowUp");
        await expectSelected(rows, [1, 2]);

        // A plain arrow moves the focus and leaves the selection.
        await window.keyboard.press("ArrowDown");
        await expect(place.main(rows.nth(3))).toBeFocused();
        await expectSelected(rows, [1, 2]);
      } finally {
        await app.close();
      }
    });
  }
}

test("a selection is one per place: moving to the other clears it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    const [sidebar, library] = PLACES;
    if (!sidebar || !library) throw new Error("The places are missing.");
    const inSidebar = sidebar.rows(window);
    await pointAndClick(window, sidebar.target(inSidebar.nth(0)));
    await pointAndClick(window, sidebar.target(inSidebar.nth(2)), withKey);
    await expectSelected(inSidebar, [0, 2]);

    await window.getByTestId("open-library").click();
    const inLibrary = library.rows(window);
    await expect(inLibrary).toHaveCount(NAMES.length);
    // What the sidebar selected isn't the Library's.
    await expectSelected(inLibrary, []);
    await pointAndClick(window, library.target(inLibrary.nth(4)), withKey);
    await expectSelected(inLibrary, [4]);
    await expectSelected(inSidebar, []);
    await expect(window.getByTestId("sidebar-selection")).toHaveText("");
  } finally {
    await app.close();
  }
});

test("Esc in the Library clears what the sidebar holds, its footer with its rows", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    const [sidebar, library] = PLACES;
    if (!sidebar || !library) throw new Error("The places are missing.");
    const inSidebar = sidebar.rows(window);
    await pointAndClick(window, sidebar.target(inSidebar.nth(0)));
    await pointAndClick(window, sidebar.target(inSidebar.nth(2)), withKey);
    await pointAndClick(window, sidebar.target(inSidebar.nth(3)), withKey);
    const footer = window.getByTestId("sidebar-selection");
    await expect(footer).toHaveText("3 selected · Esc clears");

    await window.getByTestId("open-library").click();
    const inLibrary = library.rows(window);
    await expect(inLibrary).toHaveCount(NAMES.length);
    await library.main(inLibrary.nth(1)).focus();
    await window.keyboard.press("Escape");
    await expectSelected(inSidebar, []);
    await expect(footer).toHaveText("");
    await expectSelected(inLibrary, []);
  } finally {
    await app.close();
  }
});

/** Holds the system's open dialog open, as the User would, until `answerDialog` picks `path`. */
const holdOpenDialog = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, picked) => {
    const held: { asked: number; answer: () => void } = { asked: 0, answer: () => undefined };
    (globalThis as { heldDialog?: typeof held }).heldDialog = held;
    dialog.showOpenDialog = (() =>
      new Promise((resolve) => {
        held.asked += 1;
        held.answer = () => resolve({ canceled: false, filePaths: [picked] });
      })) as unknown as typeof dialog.showOpenDialog;
  }, path);

const dialogsAsked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { heldDialog?: { asked: number } }).heldDialog?.asked ?? 0);

const answerDialog = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { heldDialog?: { answer(): void } }).heldDialog?.answer());

/**
 * Stands in for the first responder a system dialog takes on macOS: records the actions the menu
 * sends it, and carries none of them out.
 */
const holdFirstResponder = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const sent: string[] = [];
    (globalThis as { firstResponderActions?: string[] }).firstResponderActions = sent;
    Menu.sendActionToFirstResponder = ((action: string) => {
      sent.push(action);
    }) as typeof Menu.sendActionToFirstResponder;
  });

const responderActions = (app: ElectronApplication) =>
  app.evaluate(
    () => (globalThis as { firstResponderActions?: string[] }).firstResponderActions ?? [],
  );

// The system keeps a key from the window behind its dialog (Playwright's keys go round it), but
// macOS still runs the menu's items: there ⌘A is the Edit menu's Select All (#1515).
test("while a system file dialog is open, the menu's Select All doesn't reach the window behind it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    const [sidebar] = PLACES;
    if (!sidebar) throw new Error("The sidebar is missing.");
    const rows = sidebar.rows(window);
    const chosen = rows.nth(1);
    await pointAndClick(window, sidebar.target(chosen));
    const name = (await chosen.getByTestId("row-text").textContent()) ?? "";
    const selected = window
      .getByTestId("sidebar")
      .getByRole("treeitem", { selected: true })
      .getByTestId("row-text");
    await expect(selected).toHaveText([name]);
    const picked = join(sources, "Lagoons.txt");
    await writeFile(picked, "Lagoons are a part of the sea.\n");
    await holdOpenDialog(app, picked);
    await holdFirstResponder(app);

    await window.keyboard.press("ControlOrMeta+o");
    await expect.poll(() => dialogsAsked(app)).toBe(1);
    await clickEditItem(app, "edit.selectAll");
    // Answered after the menu, so the Document it adds shows once the window would have had it.
    await answerDialog(app);
    await expect(window.getByTestId("library-row-count")).toHaveText(String(NAMES.length + 1));
    await expect(selected).toHaveText([name]);
    const footer = window.getByTestId("sidebar-selection");
    await expect(footer).toHaveText("");

    // Once the dialog has closed, the menu reaches the window again.
    await clickEditItem(app, "edit.selectAll");
    await expect(selected).toHaveCount(await rows.count());
    await expect(footer).toHaveText(`${await rows.count()} selected · Esc clears`);
  } finally {
    await app.close();
  }
});

// macOS sends ⌘A in an Open sheet to the sheet's own file list, as any Mac app does. The held
// dialog stands in for the sheet: the action is recorded, and the window behind stays as it was (#1707).
test("on macOS, Select All while a system file dialog is open goes to the first responder", async () => {
  test.skip(
    process.platform !== "darwin",
    "Only macOS sends the menu's Select All to the first responder.",
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    const [sidebar] = PLACES;
    if (!sidebar) throw new Error("The sidebar is missing.");
    const rows = sidebar.rows(window);
    const chosen = rows.nth(1);
    await pointAndClick(window, sidebar.target(chosen));
    const name = (await chosen.getByTestId("row-text").textContent()) ?? "";
    const selected = window
      .getByTestId("sidebar")
      .getByRole("treeitem", { selected: true })
      .getByTestId("row-text");
    await expect(selected).toHaveText([name]);

    const picked = join(sources, "Lagoons.txt");
    await writeFile(picked, "Lagoons are a part of the sea.\n");
    await holdOpenDialog(app, picked);
    await holdFirstResponder(app);
    await window.keyboard.press("ControlOrMeta+o");
    await expect.poll(() => dialogsAsked(app)).toBe(1);

    await clickEditItem(app, "edit.selectAll");
    await expect.poll(() => responderActions(app)).toEqual(["selectAll:"]);
    // The window behind the sheet keeps its selection and says nothing.
    await answerDialog(app);
    await expect(window.getByTestId("library-row-count")).toHaveText(String(NAMES.length + 1));
    await expect(selected).toHaveText([name]);
    await expect(window.getByTestId("sidebar-selection")).toHaveText("");

    // Once the sheet is gone, Select All is the window's own again.
    await clickEditItem(app, "edit.selectAll");
    await expect(selected).toHaveCount(await rows.count());
    await expect(window.getByTestId("sidebar-selection")).toHaveText(
      `${await rows.count()} selected · Esc clears`,
    );
  } finally {
    await app.close();
  }
});

test("the right-click menu and the Library's bar offer the same commands for the selection, each with its count", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    await window.getByTestId("open-library").click();
    const [, library] = PLACES;
    if (!library) throw new Error("The Library is missing.");
    const rows = library.rows(window);
    await expect(rows).toHaveCount(NAMES.length);
    await pointAndClick(window, library.target(rows.nth(0)));
    await pointAndClick(window, library.target(rows.nth(1)), withKey);
    await pointAndClick(window, library.target(rows.nth(3)), withKey);
    await expect(library.announced(window)).toHaveText("3 selected");

    // The bar names the commands for all three.
    const bar = window.getByTestId("library-selection");
    const ask = bar.locator('[data-command="document.ask"]');
    await expect(ask).toHaveText("Ask about these 3 Documents");

    // The right-click menu on a selected row has them too, and not what opens or renames one.
    await pointAndClick(window, library.target(rows.nth(1)), { button: "right" });
    const menu = window.getByTestId("document-file-actions").filter({ visible: true });
    await expect(menu.getByTestId("document.ask")).toHaveText("Ask about these 3 Documents");
    await expect(menu.getByTestId("document.startMind")).toHaveText(
      "Start a Mind from these 3 Documents",
    );
    await expect(menu.getByTestId("document.tags")).toBeVisible();
    await expect(menu.getByTestId("document.open")).toHaveCount(0);
    await expect(menu.getByTestId("document.rename")).toHaveCount(0);

    // Tags… from the menu opens the picker for all three.
    await menu.getByTestId("document.tags").click();
    await expect(
      window.getByTestId("selection-tags-popover").filter({ visible: true }),
    ).toHaveAttribute("aria-label", "Tags of 3 Documents");
    await window.keyboard.press("Escape");

    // A row that isn't selected has its own menu, for itself alone.
    await pointAndClick(window, library.target(rows.nth(4)), { button: "right" });
    const own = window.getByTestId("document-file-actions").filter({ visible: true });
    await expect(own.getByTestId("document.ask")).toHaveText("Ask about this Document");
    await expect(own.getByTestId("document.open")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a Mind and a Document select together in the sidebar", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    await newMind(window);
    await nameMind(window, "Shortlist");
    const sidebar = window.getByTestId("sidebar");
    const mind = sidebar.getByTestId("mind-row");
    const documents = sidebar.getByTestId("document-list-item");
    await pointAndClick(window, mind.getByTestId("mind-list-item"));
    await pointAndClick(window, documents.nth(2).getByTestId("open-document"), withKey);
    await expect(marked(mind)).toHaveAttribute("aria-selected", "true");
    await expect(marked(documents.nth(2))).toHaveAttribute("aria-selected", "true");
    await expect(sidebar.getByTestId("sidebar-selection")).toHaveText("2 selected · Esc clears");

    // ⌘A takes every row of every kind in the tree.
    await window.keyboard.press("ControlOrMeta+a");
    await expect(sidebar.getByTestId("sidebar-selection")).toHaveText("6 selected · Esc clears");
    await window.keyboard.press("Escape");
    await expect(sidebar.getByTestId("sidebar-selection")).toHaveText("");
  } finally {
    await app.close();
  }
});

test("with the focus in the note or the composer, ⌘A selects text and not rows", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addFiveDocuments(window);
    await newMind(window);
    await nameMind(window, "Shortlist");
    const rows = PLACES[0]?.rows(window);
    if (!rows) throw new Error("The sidebar is missing.");
    const target = (index: number) => rows.nth(index).getByTestId("open-document");
    await pointAndClick(window, target(0));
    await pointAndClick(window, target(1), withKey);
    await expectSelected(rows, [0, 1]);

    // In the note.
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.type("Tides and currents");
    await window.keyboard.press("ControlOrMeta+a");
    expect(await window.evaluate(() => globalThis.getSelection()?.toString())).toContain(
      "Tides and currents",
    );
    await expectSelected(rows, [0, 1]);

    // In the composer.
    const input = window.getByTestId("composer").getByTestId("composer-input");
    await input.click();
    await window.keyboard.type("What are tides?");
    await window.keyboard.press("ControlOrMeta+a");
    expect(
      await input.evaluate((field) => {
        const text = field as HTMLTextAreaElement;
        return text.value.slice(text.selectionStart ?? 0, text.selectionEnd ?? 0);
      }),
    ).toBe("What are tides?");
    await expectSelected(rows, [0, 1]);

    // And Esc in the composer leaves the rows' selection alone too.
    await window.keyboard.press("Escape");
    await expectSelected(rows, [0, 1]);
  } finally {
    await app.close();
  }
});

for (const place of PLACES) {
  test(`in the ${place.name}, a double-click renames the row it hit, and a ⌘-click or Shift-click never renames or opens`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1400, 800);
      await dismissChatSetup(window);
      await addFiveDocuments(window);
      if (place.name === "library") await window.getByTestId("open-library").click();
      const rows = place.rows(window);
      await expect(rows).toHaveCount(NAMES.length);
      const field = rows.locator("input:not([type=checkbox])");
      const tabs = window.getByTestId("tab-title");
      const opened = await tabs.count();

      // Two ⌘-clicks, however close, add the row and take it out again: no field, nothing opened.
      await pointAt(window, place.target(rows.nth(2)));
      await place.target(rows.nth(2)).dblclick({ modifiers: ["ControlOrMeta"] });
      await expectSelected(rows, []);
      await expect(field).toHaveCount(0);
      await expect(tabs).toHaveCount(opened);

      // Two Shift-clicks the same.
      await pointAndClick(window, place.target(rows.nth(0)));
      await expectSelected(rows, [0]);
      const tabsNow = await tabs.count();
      await place.target(rows.nth(2)).dblclick({ modifiers: ["Shift"] });
      await expectSelected(rows, [0, 1, 2]);
      await expect(field).toHaveCount(0);
      await expect(tabs).toHaveCount(tabsNow);

      // A double-click renames the row it hit, and leaves just that one selected.
      await pointAt(window, place.target(rows.nth(3)));
      await place.target(rows.nth(3)).dblclick();
      await expect(field).toHaveCount(1);
      await expect(field).toBeFocused();
      await window.keyboard.press("Escape");
      await expect(field).toHaveCount(0);
      await expectSelected(rows, [3]);
    } finally {
      await app.close();
    }
  });
}
