import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import type { MessageKey, MessageParams } from "../src/shared/i18n/types";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  leaveText,
  openPageMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
  typeWithInputMethod,
} from "./app";

/*
 * Move to… (#1249): the one picker behind it finds a Chinese Folder by its
 * pinyin ("caiwu") and the pinyin's initials ("cw"), as ⌘K does; a name no
 * Folder has is its last row, "New Folder “name”", and Enter makes that Folder
 * and moves the objects into it as one step that one ⌘Z takes back; a name a
 * Folder has never offers one. From a Mind by ⇧⌘M, a Mind's page, a Document's
 * Peek and the Library's selection, in English and Chinese.
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

const picker = (window: Page) => window.getByTestId("move-to-picker");
const options = (window: Page) => picker(window).getByTestId("move-to-option");
const field = (window: Page) => picker(window).getByTestId("move-to-search");
const undoMessage = (window: Page) => window.getByTestId("undo-message");
const mindRow = (window: Page, title: string) =>
  window.getByTestId("mind-row").filter({ hasText: title });
const documentRow = (window: Page, name: string) =>
  window
    .getByTestId("sidebar")
    .getByTestId("document-list-item")
    .filter({ has: window.getByTestId("row-text").getByText(name, { exact: true }) });

const folderNames = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getLibrary()).groups.map((group) => group.name);
  });

const folderOfMind = (window: Page, title: string): Promise<string | null> =>
  window.evaluate(async (name) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listMinds()).find((mind) => mind.title === name)?.folderId ?? null;
  }, title);

const folderOfDocument = (window: Page, name: string): Promise<string | null> =>
  window.evaluate(async (documentName) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const document = (await bridge.listDocuments()).find((each) => each.name === documentName);
    if (!document) throw new Error(`No Document named ${documentName}.`);
    const { assignments } = await bridge.getLibrary();
    return assignments.find((each) => each.documentId === document.id)?.groupId ?? null;
  }, name);

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`Move to… finds a Chinese Folder by pinyin and its initials, offers a Folder only for a name none has, and Enter makes it and moves in one ⌘Z (${language}, ${width}px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    for (const name of ["Budget", "Ledger"]) {
      await writeFile(join(sources, `${name}.txt`), `${name} for the harbour project.\n`);
    }
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 760);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
        for (const name of ["Finance", "财务"]) {
          await core.createLibraryGroup({ name, description: "" });
        }
        await core.createMind({ title: "Plan" });
      });
      await addDocuments(
        window,
        ["Budget", "Ledger"].map((name) => join(sources, `${name}.txt`)),
      );

      // A Mind, by ⇧⌘M: the pinyin and the initials find 财务, and a new Folder is the last row.
      await mindRow(window, "Plan").getByTestId("mind-list-item").focus();
      await window.keyboard.press("ControlOrMeta+Shift+KeyM");
      await expect(field(window)).toBeFocused();
      await expect(options(window)).toHaveText([t("library.unsorted"), "Finance", "财务"]);
      await window.keyboard.type("caiwu");
      await expect(options(window)).toHaveText(["财务", t("move.newFolder", { name: "caiwu" })]);
      await field(window).fill("cw");
      await expect(options(window)).toHaveText(["财务", t("move.newFolder", { name: "cw" })]);
      // A name a Folder has, in any case, or a row's own name, never offers a new Folder.
      await field(window).fill("finance");
      await expect(options(window)).toHaveText(["Finance"]);
      await field(window).fill("财务");
      await expect(options(window)).toHaveText(["财务"]);
      await field(window).fill(t("library.unsorted"));
      await expect(options(window)).toHaveText([t("library.unsorted")]);
      // A Chinese name typed through an input method: Enter while it composes creates nothing, and
      // the next Enter makes the Folder.
      await field(window).fill("");
      await typeWithInputMethod(window, field(window), "年报");
      await expect(picker(window)).toBeHidden();
      const yearReport = sidebarFolder(window, "年报");
      await expect(yearReport.getByTestId("mind-list-item")).toHaveText("Plan");
      await expect(undoMessage(window)).toHaveText(
        t("folder.made.one", { name: "年报", item: "Plan" }),
      );
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(yearReport).toHaveCount(0);
      // A name none has: the only row, last; Enter makes it and moves the Mind in.
      await mindRow(window, "Plan").getByTestId("mind-list-item").focus();
      await window.keyboard.press("ControlOrMeta+Shift+KeyM");
      await expect(field(window)).toBeFocused();
      await field(window).fill("Harbour");
      await expect(options(window)).toHaveText([t("move.newFolder", { name: "Harbour" })]);
      await window.keyboard.press("Enter");
      await expect(picker(window)).toBeHidden();
      const harbour = sidebarFolder(window, "Harbour");
      await expect(harbour.getByTestId("mind-list-item")).toHaveText("Plan");
      await expect(undoMessage(window)).toHaveText(
        t("folder.made.one", { name: "Harbour", item: "Plan" }),
      );
      expect(await folderNames(window)).toContain("Harbour");
      expect((await folderNames(window)).filter((name) => name === "Harbour")).toHaveLength(1);
      expect(await folderOfMind(window, "Plan")).not.toBeNull();
      // One ⌘Z takes both back: the move, and the Folder.
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(harbour).toHaveCount(0);
      expect(await folderNames(window)).not.toContain("Harbour");
      expect(await folderOfMind(window, "Plan")).toBeNull();
      // ⇧⌘Z does both again, and one ⌘Z takes them again.
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect(sidebarFolder(window, "Harbour").getByTestId("mind-list-item")).toHaveText(
        "Plan",
      );
      expect(await folderOfMind(window, "Plan")).not.toBeNull();
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(sidebarFolder(window, "Harbour")).toHaveCount(0);
      expect(await folderOfMind(window, "Plan")).toBeNull();

      // A Mind's page, from its ⋮: the same picker, and its create row makes the Folder with the Mind.
      await mindRow(window, "Plan").getByTestId("mind-list-item").click();
      const pageMenu = await openPageMenu(window);
      await pointAndClick(window, pageMenu.getByTestId("mind.moveTo"));
      await expect(field(window)).toBeFocused();
      await window.keyboard.type("caiwu");
      await expect(options(window)).toHaveText(["财务", t("move.newFolder", { name: "caiwu" })]);
      await field(window).fill("Boardpack");
      await expect(options(window)).toHaveText([t("move.newFolder", { name: "Boardpack" })]);
      await window.keyboard.press("Enter");
      await expect(undoMessage(window)).toHaveText(
        t("folder.made.one", { name: "Boardpack", item: "Plan" }),
      );
      expect(await folderOfMind(window, "Plan")).not.toBeNull();
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(sidebarFolder(window, "Boardpack")).toHaveCount(0);
      expect(await folderOfMind(window, "Plan")).toBeNull();

      // The Library's selection: pinyin again, then a name none has makes one Folder for both.
      await pointAndClick(window, window.getByTestId("open-library"));
      const library = window.getByTestId("library");
      const libraryRow = (name: string) =>
        library.getByTestId("library-document").filter({
          has: window.getByTestId("library-document-name").getByText(name, { exact: true }),
        });
      for (const name of ["Budget", "Ledger"]) {
        await pointAndClick(window, libraryRow(name).getByTestId("library-document-name"), {
          modifiers: ["ControlOrMeta"],
        });
      }
      const bar = library.getByTestId("library-selection");
      await expect(bar.getByRole("status")).toHaveText(t("library.selected", { count: 2 }));
      await pointAndClick(window, bar.locator('[data-command="document.moveTo"]'));
      await expect(field(window)).toBeFocused();
      await window.keyboard.type("caiwu");
      await expect(options(window)).toHaveText(["财务", t("move.newFolder", { name: "caiwu" })]);
      await field(window).fill("Ledger box");
      await expect(options(window)).toHaveText([t("move.newFolder", { name: "Ledger box" })]);
      await window.keyboard.press("Enter");
      await expect(undoMessage(window)).toHaveText(
        t("folder.made.documents", { name: "Ledger box", count: 2 }),
      );
      expect(await folderOfDocument(window, "Budget")).not.toBeNull();
      expect(await folderOfDocument(window, "Ledger")).not.toBeNull();
      await leaveText(window);
      await window.keyboard.press("ControlOrMeta+z");
      // The Undo reaches the core after the key: wait for the Folder it takes away, then read.
      await expect.poll(async () => (await folderNames(window)).includes("Ledger box")).toBe(false);
      expect(await folderOfDocument(window, "Budget")).toBeNull();
      expect(await folderOfDocument(window, "Ledger")).toBeNull();

      // A Document's Peek: the picker there offers the create row too, and one ⌘Z takes it back.
      const budget = documentRow(window, "Budget");
      await budget.getByTestId("open-document").focus();
      await window.keyboard.press("Space");
      const peek = window.getByTestId("peek");
      await expect(peek).toBeVisible();
      const peekFolder = peek.getByTestId("peek-folder");
      await window.keyboard.press("Tab");
      await expect(peekFolder.getByRole("button")).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(field(window)).toBeFocused();
      await window.keyboard.type("caiwu");
      await expect(options(window)).toHaveText(["财务", t("move.newFolder", { name: "caiwu" })]);
      await field(window).fill("Tidebox");
      await expect(options(window)).toHaveText([t("move.newFolder", { name: "Tidebox" })]);
      await window.keyboard.press("Enter");
      await expect(peekFolder).toHaveText("Tidebox");
      await expect(undoMessage(window)).toHaveText(
        t("folder.made.one", { name: "Tidebox", item: "Budget" }),
      );
      await window.keyboard.press("ControlOrMeta+z");
      await expect(peekFolder).toHaveText(t("library.unsorted"));
      expect(await folderNames(window)).not.toContain("Tidebox");
      await window.keyboard.press("Escape");
      await expect(peek).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`Move to… finds a Chinese Folder by either reading of a character (#1416, ${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 760);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await (await coreOf(window)).evaluate(async (core: CoreBridge) => {
        await core.createLibraryGroup({ name: "重命名", description: "" });
        await core.createMind({ title: "Plan" });
      });

      await mindRow(window, "Plan").getByTestId("mind-list-item").focus();
      await window.keyboard.press("ControlOrMeta+Shift+KeyM");
      await expect(field(window)).toBeFocused();
      for (const typed of ["chongming", "chongmingming", "cmm", "zhongming"]) {
        await field(window).fill(typed);
        await expect(options(window).first()).toHaveText("重命名");
      }
      await window.keyboard.press("Enter");
      await expect.poll(() => folderOfMind(window, "Plan")).not.toBeNull();
    } finally {
      await app.close();
    }
  });
}
