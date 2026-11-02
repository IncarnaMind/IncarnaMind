import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setWindowSize,
  sidebarFolder,
  tagDocument,
} from "./app";

/*
 * Every name renames where it is shown (docs/agents/interaction.md, rule 1):
 * a Document in the viewer's header and the Library's row, a Folder in the
 * Library's heading, a Tag in the sidebar, a Mind in its tab. No dialog opens,
 * and the core holds the new name. A double-click renames the row the first
 * click hit, even when the list moved under the pointer between the clicks.
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

const documentNames = async (window: Page) =>
  (await (await coreOf(window)).evaluate((core) => core.listDocuments())).map((each) => each.name);

async function writeTexts(...names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const path = join(sources, `${name}.txt`);
      await writeFile(path, `${name} notes.\n`);
      return path;
    }),
  );
}

/** Esc keeps the old name; Enter on a blank or the same name changes nothing. */
async function cancels(window: Page, field: Locator, shown: Locator, name: string) {
  await expect(field).toBeFocused();
  await window.keyboard.type("Not this");
  await window.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(shown).toHaveText(name);
}

test("a Document renames in its Library row and in the viewer's header, by double-click, F2 and the menu, with no dialog", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await addDocuments(window, await writeTexts("Tides"));
    await window.getByTestId("open-library").click();

    // The Library's row: F2 (a click opens the Document, so a double-click can't stay here).
    const row = window.getByTestId("library-document");
    const name = row.getByTestId("library-document-name");
    await row.locator("[data-row-main]").focus();
    await window.keyboard.press("F2");
    const field = row.getByRole("textbox");
    await cancels(window, field, name, "Tides");
    await expect(row.locator("[data-row-main]")).toBeFocused();
    await window.keyboard.press("F2");
    await field.fill("Tide tables");
    await window.keyboard.press("Enter");
    await expect(name).toHaveText("Tide tables");
    await expect.poll(() => documentNames(window)).toEqual(["Tide tables"]);
    await expect(window.getByRole("dialog")).toHaveCount(0);

    // Its menu's Rename.
    await row.hover();
    await row.getByTestId("document-file-menu").click();
    await row.getByTestId("document.rename").click();
    await expect(field).toBeFocused();
    await field.fill("Tide notes");
    await window.keyboard.press("Enter");
    await expect(name).toHaveText("Tide notes");

    // The viewer's header: open it, then double-click its name, or press F2 on it.
    await name.click();
    const title = window.getByTestId("viewer-header").getByTestId("viewer-title");
    await expect(title).toHaveText("Tide notes");
    await title.dblclick();
    const header = window.getByTestId("viewer-title-rename");
    await expect(header).toBeFocused();
    await header.fill("Tide log");
    await window.keyboard.press("Enter");
    await expect(title).toHaveText("Tide log");
    await title.focus();
    await window.keyboard.press("F2");
    await expect(header).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(title).toHaveText("Tide log");
    await expect.poll(() => documentNames(window)).toEqual(["Tide log"]);
  } finally {
    await app.close();
  }
});

test("a Folder renames in its section of the Library, and a Tag in the sidebar: a name another has merges them, a blank one changes nothing", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await (await coreOf(window)).evaluate(async (core) => {
      await core.createLibraryGroup({ name: "Finance", description: "Invoices" });
      await core.createTag({ name: "Tides" });
      await core.createTag({ name: "Moons" });
    });
    await addDocuments(window, await writeTexts("Tides", "Waves"));
    await tagDocument(window, "Tides", "Tides");
    await tagDocument(window, "Tides", "Moons");
    await tagDocument(window, "Waves", "Tides");

    // The Folder's section in the Library: its name, by double-click and by F2.
    await sidebarFolder(window, "Finance").getByTestId("folder-row").click({ button: "right" });
    await window.getByTestId("folder.open").click();
    const head = window.getByTestId("library").getByTestId("library-section-head").first();
    const name = head.getByTestId("library-section-name");
    await expect(name).toHaveText("Finance");
    await name.dblclick();
    const field = window.getByTestId("library-section-rename");
    await cancels(window, field, name, "Finance");
    // The double-click left the section as it was: open.
    await expect(head).toHaveAttribute("data-open", "true");
    await name.focus();
    await window.keyboard.press("F2");
    await field.fill("Accounts");
    await window.keyboard.press("Enter");
    await expect(name).toHaveText("Accounts");
    await expect(name).toBeFocused();
    await expect(sidebarFolder(window, "Accounts")).toHaveCount(1);
    await expect(window.getByRole("dialog")).toHaveCount(0);

    // A Tag, by F2 and by double-click.
    const tags = window.getByTestId("sidebar-tag");
    const tides = tags.filter({ hasText: "Tides" });
    await tides.getByRole("treeitem").first().focus();
    await window.keyboard.press("F2");
    const tagField = tags.getByRole("textbox");
    await cancels(window, tagField, tides.getByTestId("row-text"), "Tides");
    await expect(tides.getByRole("treeitem").first()).toBeFocused();

    // A blank name, and the same name, change nothing.
    await window.keyboard.press("F2");
    await tagField.fill("   ");
    await window.keyboard.press("Enter");
    await expect(tides.getByTestId("row-text")).toHaveText("Tides");
    await expect(window.getByRole("alert")).toHaveCount(0);

    // A name another Tag has merges the two, as Bear and Apple Notes do: its Documents follow, and
    // one Undo brings it back, with its Documents' links.
    const moons = tags.filter({ hasText: "Moons" });
    await expect(tides.getByRole("treeitem").first()).toBeFocused();
    await window.keyboard.press("F2");
    await tagField.fill("Moons");
    await window.keyboard.press("Enter");
    await expect(tides).toHaveCount(0);
    await expect(moons.getByTestId("browse-count")).toHaveText("2");
    await expect(window.getByTestId("undo-message")).toHaveText("Merged “Tides” into Moons");
    const merged = await (await coreOf(window)).evaluate(async (core) =>
      (await core.listTags()).map((tag) => tag.name).sort(),
    );
    expect(merged).toContain("Moons");
    expect(merged).not.toContain("Tides");
    await window.getByTestId("undo-line").getByTestId("undo-action").click();
    await expect(tides).toHaveCount(1);
    await expect(moons.getByTestId("browse-count")).toHaveText("1");

    await tides.getByTestId("row-text").dblclick();
    await tagField.fill("Spring tides");
    await window.keyboard.press("Enter");
    await expect(tags.getByTestId("row-text").filter({ hasText: "Spring tides" })).toHaveCount(1);
    await expect(window.getByTestId("tags-dialog")).toBeHidden();
    const names = await (await coreOf(window)).evaluate(async (core) =>
      (await core.listTags()).map((tag) => tag.name).sort(),
    );
    expect(names).toContain("Spring tides");
    expect(names).toContain("Moons");
    expect(names).not.toContain("Tides");

    // Each rename is one step of Undo.
    await window.getByTestId("undo-line").getByTestId("undo-action").click();
    await expect(tags.getByTestId("row-text").filter({ hasText: /^Tides$/ })).toHaveCount(1);

    // Its menu's Rename.
    await moons.getByTestId("row-text").click({ button: "right" });
    await moons.getByTestId("tag.rename").click();
    await expect(tagField).toBeFocused();
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("a double-click renames the row the first click hit, even when the list moved under the pointer", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await addDocuments(window, await writeTexts("Alpha", "Beta"));
    const rows = window.getByTestId("document-list-item");
    const alpha = rows.filter({ has: window.getByTestId("row-text").filter({ hasText: "Alpha" }) });
    const point = await alpha.getByTestId("row-text").boundingBox();
    if (!point) throw new Error("Alpha isn't laid out.");
    const x = point.x + 10;
    const y = point.y + point.height / 2;

    // The first click moves the list up one row, as opening something can: Beta is under the pointer.
    await rows
      .first()
      .locator("xpath=..")
      .evaluate((list) => {
        document.addEventListener(
          "click",
          () => {
            (list as HTMLElement).style.transform = "translateY(-28px)";
          },
          { once: true },
        );
      });
    await window.mouse.move(x, y);
    await window.mouse.click(x, y);
    // A few frames on, as a person's second click is.
    await window.evaluate(async () => {
      for (let frame = 0; frame < 4; frame++) {
        await new Promise((done) => requestAnimationFrame(done));
      }
    });
    await window.mouse.click(x, y);
    const field = rows.getByRole("textbox");
    await expect(field).toHaveValue("Alpha");
  } finally {
    await app.close();
  }
});

test("a Mind renames in its tab by double-click and F2, and Enter that confirms an input method's composition doesn't save", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await newMind(window);
    await nameMind(window, "Shortlist");
    const tab = window.getByTestId("tab-title");
    await tab.dblclick();
    const field = window.getByTestId("tab-rename");
    await expect(field).toBeFocused();
    await field.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await expect(field).toBeVisible();
    await field.fill("Reading list");
    await window.keyboard.press("Enter");
    await expect(tab).toHaveText("Reading list");
  } finally {
    await app.close();
  }
});

test("a Mind renamed in the sidebar keeps the focus on it when its new name moves it up, even when frames come late", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 700);
    await dismissChatSetup(window);
    await (await coreOf(window)).evaluate(async (core) => {
      for (const title of ["Alpha", "Bravo", "Charlie"]) await core.createMind({ title });
    });
    const rows = window.getByTestId("mind-row");
    const item = (title: string) => rows.filter({ hasText: title }).getByTestId("mind-list-item");
    await expect(rows).toHaveText([/Charlie/, /Bravo/, /Alpha/]);
    await item("Bravo").focus();

    // Frames come only when the test lets them, as on a slow computer: the list has moved before the next one.
    type Frames = { one(): void; rest(): void };
    await window.evaluate(() => {
      const held: FrameRequestCallback[] = [];
      const real = globalThis.requestAnimationFrame;
      const run = () => {
        for (const callback of held.splice(0)) callback(performance.now());
      };
      globalThis.requestAnimationFrame = (callback) => held.push(callback);
      (globalThis as unknown as { frames: Frames }).frames = {
        one: run,
        rest() {
          while (held.length > 0) run();
          globalThis.requestAnimationFrame = real;
        },
      };
    });
    const frames = (which: keyof Frames) =>
      window.evaluate(
        (name) => (globalThis as unknown as { frames: Frames }).frames[name](),
        which,
      );

    await window.keyboard.press("F2");
    const field = window.getByTestId("mind-rename");
    await expect(field).toBeFocused();
    await frames("one");
    await field.fill("Budget");
    await window.keyboard.press("Enter");
    await expect(rows).toHaveText([/Budget/, /Charlie/, /Alpha/]);
    await frames("rest");

    await expect(item("Budget")).toBeFocused();
    await expect(item("Charlie")).not.toBeFocused();
  } finally {
    await app.close();
  }
});
