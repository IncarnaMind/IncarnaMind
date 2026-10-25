import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import type { MessageKey, MessageParams } from "../src/shared/i18n/types";
import {
  coreOf,
  createDataFolder,
  dismissChatSetup,
  dragOnto,
  launchApp,
  leaveText,
  leavingCopies,
  motionSettled,
  pointAt,
  removeDataFolder,
  scaleOf,
  setLanguage,
  setMotionSpeed,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * The one drag-and-drop layer (#229), as people use it with a slid mouse:
 * a Document dragged onto a Tag gets it, Library rows dragged onto a Folder
 * in the sidebar or a Folder's section move there, several at once with
 * their count in the drag's picture, each target saying what its drop would
 * do and lighting only for what it would take; Esc mid-drag cancels; each
 * drop is one ⌘Z; a drop nothing takes ends as the button is let go, its
 * picture fading there. Move to… does the same from the Library (finding a
 * Chinese Folder by its pinyin) and from ⌘K, and files dropped on the window
 * still reach the add. Set INCARNAMIND_SCREENSHOTS to a folder to also save
 * screenshots there.
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
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** What the core holds: each Mind's and Document's Folder, and each Document's Tags, by name. */
async function where(window: Page) {
  return (await coreOf(window)).evaluate(async (core: CoreBridge) => {
    const [minds, documents, library, tags] = await Promise.all([
      core.listMinds(),
      core.listDocuments(),
      core.getLibrary(),
      core.listTags(),
    ]);
    const folderName = (id: string | null | undefined) =>
      library.groups.find((group) => group.id === id)?.name ?? null;
    return {
      minds: Object.fromEntries(minds.map((mind) => [mind.title, folderName(mind.folderId)])),
      documents: Object.fromEntries(
        documents.map((document) => [
          document.name,
          folderName(library.assignments.find((each) => each.documentId === document.id)?.groupId),
        ]),
      ),
      tags: Object.fromEntries(
        documents.map((document) => [
          document.name,
          document.tags.flatMap((link) => tags.find((tag) => tag.id === link.tagId)?.name ?? []),
        ]),
      ),
    };
  });
}

async function undo(window: Page): Promise<void> {
  await leaveText(window);
  await window.keyboard.press("ControlOrMeta+z");
}

/** Keeps each drag picture the page makes, its name and count, for the test to read. */
const watchDragPictures = (window: Page) =>
  window.evaluate(() => {
    const seen: { name: string; count: string | null }[] = [];
    (globalThis as { dragPictures?: typeof seen }).dragPictures = seen;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const count =
            node instanceof HTMLElement && node.querySelector('[data-testid="drag-count"]');
          if (!(node instanceof HTMLElement) || !node.className.includes("-left-[2000px]"))
            continue;
          seen.push({
            name: node.querySelector("span")?.textContent ?? "",
            count: count ? count.textContent : null,
          });
        }
      }
    }).observe(document.body, { childList: true });
  });

const dragPictures = (window: Page) =>
  window.evaluate(
    () => (globalThis as { dragPictures?: { name: string; count: string | null }[] }).dragPictures,
  );

/** Holds a drag over `to` while `whileOver` looks, then cancels it with Esc before letting go. */
async function dragThenEscape(
  window: Page,
  from: Locator,
  to: Locator,
  whileOver: () => Promise<void>,
): Promise<void> {
  await pointAt(window, from);
  await window.mouse.down();
  const point = await pointAt(window, to);
  await window.mouse.move(point.x + 2, point.y);
  await whileOver();
  await window.keyboard.press("Escape");
  await window.mouse.up();
}

const documentRow = (window: Page, name: string) =>
  window.getByTestId("document-list-item").filter({ hasText: name });
const libraryRow = (library: Locator, name: string) =>
  library.getByTestId("library-document").filter({ hasText: name });
const tagRow = (window: Page, name: string) =>
  window.getByTestId("sidebar-tag").filter({ hasText: name });

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`Documents drag onto a Tag and Library rows onto a Folder, saying what the drop would do, with their count, one ⌘Z each; a refused target never lights, Esc cancels, and Move to… does the same from the Library and ⌘K (${language}, ${width}px)`, async () => {
    const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
    for (const name of ["Budget", "Ledger", "Survey"]) {
      await writeFile(join(sources, `${name}.txt`), `${name} for the harbour project.\n`);
    }
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, 760);
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await (await coreOf(window)).evaluate(
        async (core: CoreBridge, paths) => {
          for (const name of ["Finance", "Research", "财务"]) {
            await core.createLibraryGroup({ name, description: "" });
          }
          await core.createMind({ title: "Plan" });
          await core.addDocuments(paths);
          const survey = (await core.listDocuments()).find((each) => each.name === "Survey");
          // A new Library may start with it.
          const tag =
            (await core.listTags()).find((each) => each.name === "Contract") ??
            (await core.createTag({ name: "Contract" }));
          if (survey) await core.addTagToDocuments([survey.id], tag.id);
        },
        ["Budget", "Ledger", "Survey"].map((name) => join(sources, `${name}.txt`)),
      );
      await expect(window.getByTestId("document-list-item")).toHaveCount(3);
      const contract = tagRow(window, "Contract");
      await expect(contract).toBeVisible();
      const label = window.getByTestId("drop-label");
      const undoLine = window.getByTestId("undo-message");

      // A Document dragged onto a Tag: the Tag lights and says what the drop does; let go, it is
      // tagged, and ⌘Z takes it off.
      await dragOnto(
        window,
        documentRow(window, "Budget").getByTestId("row-text"),
        contract,
        async () => {
          await expect(contract).toHaveAttribute("data-drop-target", "true");
          await expect(label).toHaveText(t("drop.addTag", { tag: "Contract" }));
          await screenshot(window, `drag-onto-tag-${language}-${width}`);
        },
      );
      await expect(label).toHaveCount(0);
      await expect(contract).not.toHaveAttribute("data-drop-target", "true");
      await expect(undoLine).toHaveText(
        t("undo.tagAdded.one", { name: "Budget", tag: "Contract" }),
      );
      await expect.poll(async () => (await where(window)).tags.Budget).toEqual(["Contract"]);
      await undo(window);
      await expect.poll(async () => (await where(window)).tags.Budget).toEqual([]);

      // What a Tag would refuse never lights it: a Mind, and a Document that has it already.
      for (const refused of [
        window.getByTestId("mind-row").filter({ hasText: "Plan" }),
        documentRow(window, "Survey").getByTestId("row-text"),
      ]) {
        await dragOnto(window, refused, contract, async () => {
          await expect(contract).not.toHaveAttribute("data-drop-target", "true");
          await expect(label).toHaveCount(0);
        });
      }
      expect((await where(window)).minds.Plan).toBeNull();

      // Esc in mid-drag cancels: the Folder stops lighting and nothing moves.
      const finance = sidebarFolder(window, "Finance");
      await dragThenEscape(
        window,
        documentRow(window, "Budget").getByTestId("row-text"),
        finance.getByTestId("folder-row"),
        async () => {
          await expect(finance).toHaveAttribute("data-drop-target", "true");
          await expect(label).toHaveText(t("drop.moveTo", { folder: "Finance" }));
        },
      );
      await expect(finance).not.toHaveAttribute("data-drop-target", "true");
      await expect(label).toHaveCount(0);
      expect((await where(window)).documents.Budget).toBeNull();

      // Two Library rows selected and dragged onto a Folder in the sidebar: the picture says how many,
      // the Folder what the drop does; both move, the selection is done with, and ⌘Z puts them back.
      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      await expect(libraryRow(library, "Ledger")).toBeVisible();
      await window.keyboard.down("ControlOrMeta");
      for (const name of ["Budget", "Ledger"]) {
        await pointAt(window, libraryRow(library, name).getByTestId("library-document-name"));
        await window.mouse.down();
        await window.mouse.up();
      }
      await window.keyboard.up("ControlOrMeta");
      await expect(library.getByTestId("library-selection")).toBeVisible();
      await watchDragPictures(window);
      await dragOnto(
        window,
        libraryRow(library, "Budget").getByTestId("library-document-name"),
        finance.getByTestId("folder-row"),
        async () => {
          await expect(finance).toHaveAttribute("data-drop-target", "true");
          await expect(label).toHaveText(
            t("drop.moveTo.documents", { count: 2, folder: "Finance" }),
          );
          await screenshot(window, `drag-library-rows-${language}-${width}`);
        },
      );
      expect(await dragPictures(window)).toEqual([
        { name: t("library.count", { count: 2 }), count: "2" },
      ]);
      await expect(undoLine).toHaveText(t("move.done.documents", { count: 2, folder: "Finance" }));
      await expect(library.getByTestId("library-selection")).toHaveCount(0);
      await expect
        .poll(async () => (await where(window)).documents)
        .toMatchObject({ Budget: "Finance", Ledger: "Finance" });
      await undo(window);
      await expect
        .poll(async () => (await where(window)).documents)
        .toMatchObject({ Budget: null, Ledger: null });
      // Back in Not in a Folder, the rows are drawn there again before they are dragged.
      const loose = library.locator(
        '[data-testid="library-section"][data-section="not-in-a-folder"]',
      );
      await expect(loose).toHaveAttribute("data-count", "3");

      // A Library row onto a Folder's section on the page: its head takes the "into" box.
      const research = library
        .getByTestId("library-section")
        .filter({ has: window.getByTestId("library-section-name").filter({ hasText: "Research" }) })
        .getByTestId("library-section-head");
      await dragOnto(
        window,
        libraryRow(library, "Ledger").getByTestId("library-document-name"),
        research,
        async () => {
          await expect(research).toHaveAttribute("data-drop-target", "true");
          await expect(research).toHaveCSS("box-shadow", /inset/);
          await expect(label).toHaveText(t("drop.moveTo", { folder: "Research" }));
        },
      );
      await expect(undoLine).toHaveText(t("move.done", { name: "Ledger", folder: "Research" }));
      await expect.poll(async () => (await where(window)).documents.Ledger).toBe("Research");
      await undo(window);
      await expect.poll(async () => (await where(window)).documents.Ledger).toBeNull();
      await expect(loose).toHaveAttribute("data-count", "3");

      // Move to… from the Library, by keyboard on a selected row: the pinyin finds 财务.
      await window.keyboard.down("ControlOrMeta");
      for (const name of ["Budget", "Ledger"]) {
        await pointAt(window, libraryRow(library, name).getByTestId("library-document-name"));
        await window.mouse.down();
        await window.mouse.up();
      }
      await window.keyboard.up("ControlOrMeta");
      await libraryRow(library, "Budget").locator("[data-row-main]").focus();
      await window.keyboard.press("ControlOrMeta+Shift+KeyM");
      const picker = window.getByTestId("move-to-picker");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await window.keyboard.type("caiwu");
      await expect(picker.getByTestId("move-to-option")).toHaveText([
        "财务",
        t("move.newFolder", { name: "caiwu" }),
      ]);
      await window.keyboard.press("Enter");
      await expect(undoLine).toHaveText(t("move.done.documents", { count: 2, folder: "财务" }));
      await expect
        .poll(async () => (await where(window)).documents)
        .toMatchObject({ Budget: "财务", Ledger: "财务" });
      await undo(window);
      await expect
        .poll(async () => (await where(window)).documents)
        .toMatchObject({ Budget: null, Ledger: null });

      // Move to… from ⌘K, for the Mind in front.
      await window
        .getByTestId("mind-row")
        .filter({ hasText: "Plan" })
        .getByTestId("mind-list-item")
        .click();
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(t("mind.moveTo").replace("…", ""));
      await expect(window.getByTestId("palette-item").first()).toContainText(t("mind.moveTo"));
      await window.keyboard.press("Enter");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      await window.keyboard.type("Res");
      await window.keyboard.press("Enter");
      await expect(undoLine).toHaveText(t("move.done", { name: "Plan", folder: "Research" }));
      await expect.poll(async () => (await where(window)).minds.Plan).toBe("Research");
      await undo(window);
      await expect.poll(async () => (await where(window)).minds.Plan).toBeNull();

      // With the sidebar hidden, its row slid away, ⌘K's Move to… still opens in the window.
      await window.keyboard.press("ControlOrMeta+Backslash");
      await expect(window.getByTestId("sidebar-panel")).toHaveAttribute("data-hidden", "true");
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(t("mind.moveTo").replace("…", ""));
      await expect(window.getByTestId("palette-item").first()).toContainText(t("mind.moveTo"));
      await window.keyboard.press("Enter");
      await expect(picker.getByTestId("move-to-search")).toBeFocused();
      const shownAt = await picker.boundingBox();
      if (!shownAt) throw new Error("Move to… isn't showing.");
      expect(shownAt.x).toBeGreaterThanOrEqual(0);
      expect(shownAt.x + shownAt.width).toBeLessThanOrEqual(width);
      await window.keyboard.press("Escape");
      await expect(picker).toBeHidden();
      await window.keyboard.press("ControlOrMeta+Backslash");
    } finally {
      await app.close();
    }
  });
}

test("files dropped on the window still reach the add, through the layer, with its overlay while over it", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    const card = window.getByTestId("tab-groups");
    await card.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["x"], "Notes.txt", { type: "text/plain" }));
      for (const type of ["dragenter", "dragover"]) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
      (globalThis as { heldDrop?: DataTransfer }).heldDrop = transfer;
    });
    await expect(window.getByTestId("drop-overlay")).toBeVisible();
    await card.evaluate((element) => {
      const transfer = (globalThis as { heldDrop?: DataTransfer }).heldDrop;
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect(window.getByTestId("drop-overlay")).toHaveCount(0);
    // A File made in the page has no path on disk, so the add says it skipped it, by name.
    await expect(window.getByTestId("skipped-files")).toContainText("Notes.txt");
  } finally {
    await app.close();
  }
});

async function pictureLeaving(window: Page, row: Locator, into: boolean): Promise<boolean> {
  const box = await row.boundingBox();
  if (!box) return false;
  return (await leavingCopies(window)).some(
    (copy) =>
      copy.opacity < 1 &&
      scaleOf(copy.transform) < 1 === into &&
      copy.box.left < box.x + box.width &&
      copy.box.left + copy.box.width > box.x &&
      copy.box.top < box.y + box.height &&
      copy.box.top + copy.box.height > box.y,
  );
}

// The layer reads navigator.platform as a drag moves, so a test can run the macOS path anywhere.
const reportPlatform = (window: Page, platform: string) =>
  window.evaluate((value) => {
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => value,
      configurable: true,
    });
  }, platform);

const watchDragOver = (window: Page) =>
  window.evaluate(() => {
    const seen = globalThis as { dragOverTaken?: boolean };
    globalThis.addEventListener("dragover", (event) =>
      setTimeout(() => {
        seen.dragOverTaken = event.defaultPrevented;
      }),
    );
  });

const dragOverTaken = (window: Page) =>
  window.evaluate(() => (globalThis as { dragOverTaken?: boolean }).dragOverTaken);

for (const [system, platform] of [
  ["macOS", "MacIntel"],
  ["Windows and Linux", "Win32"],
] as const) {
  const macOS = platform === "MacIntel";
  test(`on ${system}, a drop nothing takes ${macOS ? "ends as the button is let go, its picture fading where it was" : "stays refused, with no picture fading"}, for each kind of row in the sidebar and the Library; one a Folder takes still moves`, async () => {
    await writeFile(join(sources, "Budget.txt"), "Budget for the harbour project.\n");
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1200, 760);
      await dismissChatSetup(window);
      await reportPlatform(window, platform);
      await watchDragOver(window);
      await (await coreOf(window)).evaluate(
        async (core: CoreBridge, path) => {
          await core.createLibraryGroup({ name: "内部文件 Archive", description: "" });
          const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
          const plan = await core.createMind({ title: "Plan" });
          await core.moveToFolder({ mindIds: [plan.id], folderId: finance.id });
          await core.addDocuments([path]);
          const [budget] = await core.listDocuments();
          // A new Library may start with it; the sidebar lists a Tag once a Document has it.
          const tag =
            (await core.listTags()).find((each) => each.name === "Contract") ??
            (await core.createTag({ name: "Contract" }));
          if (budget) await core.addTagToDocuments([budget.id], tag.id);
        },
        join(sources, "Budget.txt"),
      );
      await expect(documentRow(window, "Budget")).toBeVisible();
      await expect(window.locator("html")).toHaveAttribute("data-motion", "on");
      // Slowed, so the test sees the picture leave; it waits for it to settle, not for a time.
      await setMotionSpeed(window, 0.1);
      const label = window.getByTestId("drop-label");
      const loose = window.getByTestId("not-in-a-folder");
      const archive = sidebarFolder(window, "内部文件 Archive");
      const finance = sidebarFolder(window, "Finance");

      await dragOnto(
        window,
        documentRow(window, "Budget").getByTestId("row-text"),
        archive.getByTestId("folder-row"),
        async () => {
          await expect(archive).toHaveAttribute("data-drop-target", "true");
          await expect(label).toHaveText(
            translate("en", "drop.moveTo", { folder: "内部文件 Archive" }),
          );
        },
      );
      await expect
        .poll(() => pictureLeaving(window, archive.getByTestId("folder-row"), true))
        .toBe(true);
      await expect
        .poll(async () => (await where(window)).documents.Budget)
        .toBe("内部文件 Archive");
      await expect(loose).toHaveCount(0);
      await finance.getByTestId("folder-row").click();
      await expect(window.getByTestId("mind-row").filter({ hasText: "Plan" })).toBeVisible();
      const before = await where(window);

      await window.getByTestId("open-library").click();
      const library = window.getByTestId("library");
      await expect(libraryRow(library, "Budget")).toBeVisible();
      const openTabs = await window.getByRole("tab").allTextContents();
      const archiveHead = library
        .getByTestId("library-section")
        .filter({
          has: window.getByTestId("library-section-name").filter({ hasText: "内部文件 Archive" }),
        })
        .getByTestId("library-section-head");
      const contract = tagRow(window, "Contract");
      const refused: [Locator, Locator, Locator][] = [
        [
          documentRow(window, "Budget").getByTestId("row-text"),
          archive.getByTestId("folder-row"),
          archive,
        ],
        [window.getByTestId("mind-row").filter({ hasText: "Plan" }), contract, contract],
        [
          libraryRow(library, "Budget").getByTestId("library-document-name"),
          archiveHead,
          archiveHead,
        ],
      ];
      // A refused target never lights or says anything, and letting go changes nothing.
      for (const [index, [from, onto, lit]] of refused.entries()) {
        await motionSettled(window);
        await dragOnto(window, from, onto, async () => {
          await expect(loose).toBeVisible();
          await expect(lit).not.toHaveAttribute("data-drop-target", "true");
          await expect(label).toHaveCount(0);
        });
        if (macOS) {
          await expect.poll(() => pictureLeaving(window, onto, false)).toBe(true);
          await screenshot(window, `refused-drop-fading-${platform}-${index}`);
          await expect(loose).toHaveCount(0);
        } else {
          expect(await leavingCopies(window)).toEqual([]);
        }
        await motionSettled(window);
        expect(await leavingCopies(window)).toEqual([]);
        expect(await where(window)).toEqual(before);
        expect(await window.getByRole("tab").allTextContents()).toEqual(openTabs);
        await expect.poll(() => dragOverTaken(window)).toBe(macOS);
        await screenshot(window, `refused-drop-settled-${platform}-${index}`);
      }
    } finally {
      await app.close();
    }
  });
}

test("a list scrolls while a drag rests near its edge", async () => {
  await writeFile(join(sources, "Budget.txt"), "Budget for the harbour project.\n");
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1200, 560);
    await dismissChatSetup(window);
    await (await coreOf(window)).evaluate(
      async (core: CoreBridge, path) => {
        for (let n = 1; n <= 30; n++) {
          await core.createLibraryGroup({
            name: `Folder ${String(n).padStart(2, "0")}`,
            description: "",
          });
        }
        await core.addDocuments([path]);
      },
      join(sources, "Budget.txt"),
    );
    const tree = window.getByTestId("sidebar-tree");
    await expect(sidebarFolder(window, "Folder 30")).toHaveCount(1);
    // At the foot of the list, where Not in a Folder holds the Document, then up to its top edge.
    await tree.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    const bottom = await tree.evaluate((element) => element.scrollTop);
    expect(bottom).toBeGreaterThan(0);
    const box = await tree.boundingBox();
    if (!box) throw new Error("The sidebar isn't showing.");
    await pointAt(window, documentRow(window, "Budget").getByTestId("row-text"));
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await window.mouse.move(box.x + box.width / 2, box.y + 6, { steps: 8 });
    await expect
      .poll(() => tree.evaluate((element) => element.scrollTop), { timeout: 5000 })
      .toBeLessThan(bottom);
    await window.keyboard.press("Escape");
    await window.mouse.up();
  } finally {
    await app.close();
  }
});
