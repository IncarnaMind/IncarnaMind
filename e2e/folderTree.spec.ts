import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  dragOnto,
  launchApp,
  nameMind,
  newMind,
  openSteps,
  pointAt,
  removeDataFolder,
  sidebarFolder,
} from "./app";

/*
 * Folders are projects (#111): the sidebar's one tree lists each Folder's
 * Minds above its Documents, and Not in a Folder holds the rest. A Folder
 * opens in place; a Mind made in it asks within it; Minds move by their
 * menu or by dragging, with Undo; a Folder renames in place; deleting one
 * moves its Minds out. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots of the sidebar there.
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

const bridge = (window: Page) => ({
  createFolder: (name: string) =>
    window.evaluate(
      async (folderName) =>
        (
          await (
            globalThis as unknown as { incarnamind: CoreBridge }
          ).incarnamind.createLibraryGroup({ name: folderName, description: "" })
        ).id,
      name,
    ),
  file: (documentName: string, folderId: string | null) =>
    window.evaluate(
      async ({ name, folder }) => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const document = (await core.listDocuments()).find((each) => each.name === name);
        if (!document) throw new Error(`No Document named ${name}.`);
        await core.assignDocumentGroup(document.id, folder);
      },
      { name: documentName, folder: folderId },
    ),
});

const notInAFolder = (window: Page) => window.getByTestId("not-in-a-folder");
const mindRow = (window: Page, title: string) =>
  window.getByTestId("mind-row").filter({ hasText: title });

test("each Folder lists its Minds above its Documents and opens in place; a Mind made in it asks within it, resolved when asked", async () => {
  await writeFile(
    join(sources, "Tide tables.txt"),
    "Neap tides are the smallest of the month.\nSpring tides happen at new moon and at full moon.\n",
  );
  await writeFile(
    join(sources, "Spring menu.txt"),
    "Spring tides happen when the market sells mussels.\n",
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    const ocean = await bridge(window).createFolder("Ocean research");
    await window.evaluate(
      async (paths) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.addDocuments(paths),
      [join(sources, "Tide tables.txt"), join(sources, "Spring menu.txt")],
    );
    await expect(
      window.locator('[data-testid="document-list-item"][data-status="ready"]'),
    ).toHaveCount(2);
    await bridge(window).file("Tide tables", ocean);

    // One tree: the Folder, closed, with its count; Not in a Folder, which searches everything.
    const folder = sidebarFolder(window, "Ocean research");
    await expect(folder).toHaveAttribute("data-expanded", "false");
    await expect(folder.getByTestId("browse-count")).toHaveText("1");
    await expect(notInAFolder(window)).toContainText("Not in a Folder");
    await expect(window.getByTestId("not-in-a-folder-section-heading")).toHaveAttribute(
      "title",
      "Searches everything",
    );
    await expect(
      notInAFolder(window).getByTestId("document-list-item").getByTestId("row-text"),
    ).toHaveText("Spring menu");

    // Clicked, the Folder opens in place: the main area stays as it was.
    await expect(window.getByTestId("mind-none-open")).toBeVisible();
    await pointAt(window, folder.getByTestId("folder-row"));
    await window.mouse.down();
    await window.mouse.up();
    await expect(folder).toHaveAttribute("data-expanded", "true");
    await expect(folder.getByTestId("folder-row")).toHaveAttribute("aria-expanded", "true");
    await expect(folder.getByTestId("document-list-item").getByTestId("row-text")).toHaveText(
      "Tide tables",
    );
    await expect(window.getByTestId("mind-none-open")).toBeVisible();
    await expect(window.getByTestId("library")).toHaveCount(0);

    // "New note here", from its menu (a right-click, as in Finder): listed in the Folder,
    // above its Documents, and open.
    await folder.getByTestId("folder-row").click({ button: "right" });
    await folder.getByTestId("folder.newMind").click();
    await nameMind(window, "Tide questions");
    const listed = folder.locator(":scope > ul > li");
    await expect(listed.first()).toHaveAttribute("data-testid", "mind-row");
    await expect(listed.first()).toContainText("Tide questions");
    await expect(listed.nth(1)).toHaveAttribute("data-testid", "document-list-item");
    await screenshot(window, "folder-tree");

    // Its Questions start with the Folder as their Search scope: a chip that says so.
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.press("ControlOrMeta+j");
    const composer = window.getByTestId("composer");
    const chip = composer.getByTestId("scope-chip");
    await expect(chip).toHaveText("Ocean research");
    await expect(chip).toHaveAttribute("data-own", "true");
    await expect(chip).toHaveAttribute(
      "title",
      "Searches this Folder’s 1 Document. Remove it to search every Document.",
    );
    await window.keyboard.type("When do spring tides happen?");
    await window.keyboard.press("Enter");
    const answers = assistantAnswers(window);
    await expect(answers.first()).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answers.first().getByTestId("answer-steps")).toContainText(
      "Searched Ocean research ·",
    );
    await expect(answers.first().getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      /^Citation 1: Tide tables/,
    );

    // Filed out and in since, the Folder is searched as it is when asked.
    await bridge(window).file("Tide tables", null);
    await bridge(window).file("Spring menu", ocean);
    await expect(folder.getByTestId("document-list-item").getByTestId("row-text")).toHaveText(
      "Spring menu",
    );
    await composer.getByTestId("composer-input").click();
    await window.keyboard.type("When do spring tides happen, again?");
    await window.keyboard.press("Enter");
    await expect(answers.nth(1)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answers.nth(1).getByTestId("citation-chip")).toHaveAttribute(
      "aria-label",
      // Each Answer in the assistant numbers its own Citations.
      /^Citation 1: Spring menu/,
    );

    // Its × takes the Folder out: every Document is searched.
    await chip.getByTestId("scope-chip-remove").click();
    await expect(composer.getByTestId("composer-scope-all")).toBeVisible();
    await composer.getByTestId("composer-input").click();
    await window.keyboard.type("When do spring tides happen, anywhere?");
    await window.keyboard.press("Enter");
    const third = answers.nth(2);
    await expect(third).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(third.getByTestId("answer-steps")).toContainText("Searched All Documents ·");
    await expect((await openSteps(window, third)).getByTestId("answer-step-found")).toContainText(
      "2 passages found",
    );

    // Clicked again, the Folder closes in place.
    await folder.getByTestId("folder-row").click();
    await expect(folder).toHaveAttribute("data-expanded", "false");
    await expect(folder.getByTestId("mind-row")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a Mind moves by its menu, by the keyboard and by dragging, each with Undo; a Folder renames in place; a deleted Folder's Minds go to Not in a Folder", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await bridge(window).createFolder("Finance");
    await bridge(window).createFolder("Research");
    await newMind(window);
    await nameMind(window, "Shortlist");
    const shortlist = mindRow(window, "Shortlist");
    await expect(notInAFolder(window).getByTestId("mind-list-item")).toHaveText("Shortlist");
    const finance = sidebarFolder(window, "Finance");
    const research = sidebarFolder(window, "Research");
    const undoLine = window.getByTestId("undo-line");

    // ↑ and ↓ move through the tree's rows: the Folders, then the Mind in Not in a Folder.
    await finance.getByTestId("folder-row").focus();
    await window.keyboard.press("ArrowDown");
    await expect(research.getByTestId("folder-row")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(shortlist.getByTestId("mind-list-item")).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(research.getByTestId("folder-row")).toBeFocused();

    // Its menu's "Move to…": a Folder picker with a field to find one.
    await shortlist.hover();
    await shortlist.getByTestId("mind-menu").click();
    const actions = shortlist.getByTestId("mind-actions");
    // In the shared order, each with its shortcut.
    await expect(actions.getByRole("menuitem")).toHaveText([
      /^Open$/,
      /^Open in new tab$/,
      /^Outline(⌥⌘L|Ctrl\+Alt\+L)$/,
      /^Export…$/,
      /^Export AI use statement$/,
      /^Export check record…$/,
      /^History$/,
      /^Check this note$/,
      /^Tie out figures$/,
      /^Check for contradictions$/,
      /^Citation style…$/,
      /^Style…$/,
      /^Make this a Skill$/,
      /^Move to…(⇧⌘M|Ctrl\+Shift\+M)$/,
      /^New Folder with this note(⌃⌘N)?$/,
      /^RenameF2$/,
      /^Delete$/,
    ]);
    await actions.getByTestId("mind.moveTo").click();
    const picker = window.getByTestId("move-to-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await expect(picker.getByTestId("move-to-option")).toHaveText([
      "Not in a Folder",
      "Finance",
      "Research",
    ]);
    await window.keyboard.type("fin");
    // A name no Folder has exactly is offered as a new Folder too, after those it finds.
    await expect(picker.getByTestId("move-to-option")).toHaveText(["Finance", "New Folder “fin”"]);
    await window.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    // In Finance, which opens to show it, and a line to take it back.
    await expect(finance.getByTestId("mind-list-item")).toHaveText("Shortlist");
    await expect(notInAFolder(window).getByTestId("mind-row")).toHaveCount(0);
    await expect(undoLine.getByTestId("undo-message")).toHaveText("Moved “Shortlist” to Finance");
    // ⌘Z (Ctrl+Z), outside a text field, takes it back.
    await window.keyboard.press("ControlOrMeta+z");
    await expect(notInAFolder(window).getByTestId("mind-list-item")).toHaveText("Shortlist");
    await expect(undoLine.getByTestId("undo-message")).toHaveCount(0);

    // By the keyboard alone: Shift+F10 on the row, down past Outline, the exports, the AI use
    // statement, History, Check this note, Tie out figures, Check for contradictions, Citation style…, Style… and
    // Make this a Skill to Move to…, type, Enter. The row's ⋯ is not a Tab stop.
    await shortlist.getByTestId("mind-list-item").focus();
    await window.keyboard.press("Tab");
    await expect(shortlist.getByTestId("mind-menu")).not.toBeFocused();
    await window.keyboard.press("Shift+Tab");
    await expect(shortlist.getByTestId("mind-list-item")).toBeFocused();
    await window.keyboard.press("Shift+F10");
    await expect(actions.getByTestId("mind.open")).toBeFocused();
    for (let step = 0; step < 13; step++) await window.keyboard.press("ArrowDown");
    await expect(actions.getByTestId("mind.moveTo")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.type("res");
    await window.keyboard.press("Enter");
    await expect(research.getByTestId("mind-list-item")).toHaveText("Shortlist");
    await undoLine.getByTestId("undo-action").click();
    await expect(notInAFolder(window).getByTestId("mind-list-item")).toHaveText("Shortlist");

    // ⇧⌘M (Ctrl+Shift+M) on the row opens the same picker; Esc closes it, moving nothing.
    await shortlist.getByTestId("mind-list-item").focus();
    await window.keyboard.press("ControlOrMeta+Shift+KeyM");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(shortlist.getByTestId("mind-list-item")).toBeFocused();
    await expect(notInAFolder(window).getByTestId("mind-list-item")).toHaveText("Shortlist");

    // Dragged with the mouse onto a Folder, which lights up while it's over it.
    await dragOnto(
      window,
      shortlist.getByTestId("row-text"),
      research.getByTestId("folder-row"),
      async () => {
        await expect(research).toHaveAttribute("data-drop-target", "true");
        await expect(finance).not.toHaveAttribute("data-drop-target", "true");
      },
    );
    await expect(research).not.toHaveAttribute("data-drop-target", "true");
    await expect(research.getByTestId("mind-list-item")).toHaveText("Shortlist");
    await expect(undoLine.getByTestId("undo-message")).toHaveText("Moved “Shortlist” to Research");
    await screenshot(window, "folder-tree-moved");

    // Research holds no Document yet, so the Mind's next Question searches every Document, and the
    // chip's title says why (#1359).
    const editor = window.getByTestId("mind-editor");
    await editor.click();
    await window.keyboard.press("ControlOrMeta+j");
    const composer = window.getByTestId("composer");
    const all = composer.getByTestId("composer-scope-all");
    await expect(all).toHaveAttribute("title", /^“Research” has no Documents yet/);
    await window.keyboard.type("What do my notes say?");
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).first();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });

    // A Folder renames in place, as in Finder: a double-click, Enter saves; F2 on its
    // row, Esc changes nothing.
    await research.getByTestId("folder-row").dblclick();
    // (While it is typed, the row has no name to find it by.)
    const field = window.getByTestId("folder-rename-field");
    await expect(field).toBeFocused();
    await field.fill("Research notes");
    await field.press("Enter");
    const renamed = sidebarFolder(window, "Research notes");
    await expect(renamed.getByTestId("folder-row").getByTestId("row-text")).toHaveText(
      "Research notes",
    );
    // Open as before the double-click.
    await expect(renamed).toHaveAttribute("data-expanded", "true");
    await expect(all).toHaveAttribute("title", /^“Research notes” has no Documents yet/);
    for (const key of ["F2"]) {
      await renamed.getByTestId("folder-row").focus();
      await window.keyboard.press(key);
      await expect(window.getByTestId("folder-rename-field")).toBeFocused();
      await window.keyboard.type("Not this");
      await window.keyboard.press("Escape");
      await expect(renamed.getByTestId("folder-row").getByTestId("row-text")).toHaveText(
        "Research notes",
      );
      await expect(renamed.getByTestId("folder-row")).toBeFocused();
    }

    // Its menu, in the shared order; Delete asks nothing: the Folder goes to Recently deleted.
    await renamed.getByTestId("folder-row").click({ button: "right" });
    const folderActions = renamed.getByTestId("folder-actions");
    await expect(folderActions.getByRole("menuitem")).toHaveText([
      /^Open in the Library$/,
      /^New note here$/,
      /^New Folder(⇧⌘N|Ctrl\+Shift\+N)$/,
      /^Organize this Folder$/,
      /^Edit description…$/,
      /^Sort by…$/,
      /^RenameF2$/,
      /^Get info(⌘I|Ctrl\+I)$/,
      /^Delete$/,
    ]);
    await folderActions.getByTestId("folder.delete").click();
    await expect(window.getByTestId("undo-message")).toHaveText(
      "Moved “Research notes” to Recently deleted",
    );

    // Its Mind is Not in a Folder now: it searches everything; the Answer asked, which had no
    // Documents to search in the Folder, read the Mind it was asked from (#748).
    await expect(renamed).toHaveCount(0);
    await expect(notInAFolder(window).getByTestId("mind-list-item")).toHaveText("Shortlist");
    await expect(composer.getByTestId("composer-scope-all")).toBeVisible();
    await expect(answer.getByTestId("answer-steps-line")).toHaveText("Read “Shortlist”");

    // In Chinese, the same tree.
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: "zh-CN" },
      }),
    );
    await expect(notInAFolder(window)).toContainText("不在文件夹中");
    await expect(window.getByTestId("not-in-a-folder-section-heading")).toHaveAttribute(
      "title",
      "搜索全部文档",
    );
    await screenshot(window, "folder-tree-zh");
  } finally {
    await app.close();
  }
});
