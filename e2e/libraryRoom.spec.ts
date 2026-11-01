import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  launchApp,
  placeAssistant,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { LONG_NAME, openFullLibrary } from "./libraryFixture";

/*
 * The Library gives names their width and keeps its sentences in tooltips (#1192): Added goes first,
 * then Format, before a name is cut; the Organize line, a Folder's description, the Recently deleted
 * sentence and the Tag picker's legend are tooltips, and a Folder's description is in its Get info.
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

/** What `useFittingColumns` asks for: a name that fits in this, whole; a longer one, this much of it. */
const WORTH_ROOM = 320;
const LEAST_ROOM = 160;

/** What a name is cut by, at most, before the page gives up the chips instead: a few letters. */
const A_FEW_LETTERS = 24;

/**
 * The names of the rows on screen that have less room than they are asked for, by more than
 * `slack` px.
 */
function namesCut(library: Locator, slack = 0) {
  return library.evaluate(
    (root, [worth, least, extra]) =>
      [...root.querySelectorAll('[data-testid="library-document-name"]')]
        .filter((name) => {
          const box = name.getBoundingClientRect();
          const wanted = name.scrollWidth <= (worth ?? 0) ? name.scrollWidth : (least ?? 0);
          return box.width > 0 && box.height > 0 && name.clientWidth + 1 + (extra ?? 0) < wanted;
        })
        .map((name) => name.textContent),
    [WORTH_ROOM, LEAST_ROOM, slack],
  );
}

const NARROWEST = "added format narrowest";

/**
 * Whether no name is cut for want of room: or, with the page down to Tags in their narrowest
 * room and their chips, none is cut by more than a few letters.
 */
async function namesHaveRoom(library: Locator) {
  if ((await namesCut(library)).length === 0) return true;
  const hide = await library.locator("[data-hide]").getAttribute("data-hide");
  return hide === NARROWEST && (await namesCut(library, A_FEW_LETTERS)).length === 0;
}

/** The rows on screen that have Tags but no way to reach them: no chip shown and no Tags button. */
function rowsWithNoWayToTheirTags(library: Locator) {
  return library.evaluate((root) =>
    [...root.querySelectorAll('[data-testid="library-document"]')]
      .filter((row) => row.getBoundingClientRect().height > 0)
      .filter((row) => row.querySelector("[data-tag-id]"))
      .filter((row) => {
        const chip = [...row.querySelectorAll('[data-testid="tag-chip"]')].some(
          (each) => each.getBoundingClientRect().width > 0,
        );
        const button = row.querySelector<HTMLElement>('[data-testid="document-tags-menu"]');
        const box = button?.getBoundingClientRect();
        return !chip && (!button || !box || box.width === 0);
      })
      .map((row) => row.querySelector('[data-testid="library-document-name"]')?.textContent),
  );
}

/** The words a User can read in the Library as it stands: the text in view, not what scrolls below. */
function wordsOnScreen(library: Locator, language: string) {
  return library.evaluate((root, locale) => {
    const view = root.getBoundingClientRect();
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let words = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (!text.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const seen = [...range.getClientRects()].some(
        (box) =>
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > view.top &&
          box.top < view.bottom &&
          box.right > view.left &&
          box.left < view.right,
      );
      if (seen) words += [...segmenter.segment(text)].filter((part) => part.isWordLike).length;
    }
    return words;
  }, language);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`at 1,100 px no name is cut for want of room, Added and Format go first, and their words stay in the tooltip (${language})`, async () => {
    const { app, window } = await launchLibrary(language);
    const library = window.getByTestId("library");
    await setWindowSize(app, window, 1100, 900);

    // With the assistant beside the page, and with it folded: the narrow page gives names the room.
    for (const folded of [false, true]) {
      await placeAssistant(window, { folded });
      await expect.poll(() => namesHaveRoom(library), { message: `folded: ${folded}` }).toBe(true);
    }

    // Wide, Added and Format are there.
    const first = library.getByTestId("library-document").first();
    await setWindowSize(app, window, 1600, 900);
    await expect(first.getByTestId("library-document-format")).toBeVisible();
    await expect(first.getByTestId("library-document-added")).toBeVisible();

    // Narrow again, with the assistant beside the page: Added and Format have gone first, and
    // every row with Tags keeps a way to them, a chip or the Tags button.
    await setWindowSize(app, window, 1100, 900);
    await placeAssistant(window, { folded: false });
    await expect(first).toBeVisible();
    await expect(first.getByTestId("library-document-added")).toBeHidden();
    await expect(first.getByTestId("library-document-format")).toBeHidden();
    await expect.poll(() => rowsWithNoWayToTheirTags(library)).toEqual([]);

    // With a Document open beside the page there is no room for chips and names both: the chips go.
    await placeAssistant(window, { folded: true });
    await pointAndClick(window, library.getByTestId("library-document-name").first());
    await expect(window.getByTestId("viewer")).toBeVisible();
    await expect(first).toBeVisible();
    await expect(first.getByTestId("library-document-added")).toBeHidden();
    await expect(first.getByTestId("library-document-format")).toBeHidden();
    await expect(library.locator('[data-testid="tag-chip"]:visible')).toHaveCount(0);

    // What they said is the name's tooltip.
    const tip = await first.locator("[data-row-main]").getAttribute("title");
    expect(tip).toContain(
      ((await first.getByTestId("library-document-format").textContent()) ?? "").trim(),
    );
    expect(tip).toContain(
      ((await first.getByTestId("library-document-added").textContent()) ?? "").trim(),
    );
    await app.close();
  });

  test(`the Library at 1,440 px shows about 200 words at most (${language})`, async () => {
    const { app, window } = await launchLibrary(language);
    await setWindowSize(app, window, 1440, 900);
    const library = window.getByTestId("library");
    expect(await wordsOnScreen(library, language)).toBeLessThanOrEqual(200);
    await app.close();
  });

  test(`the Organize line, a Folder's description and the Recently deleted sentence are tooltips, and the description is in the Folder's Get info (${language})`, async () => {
    const { app, window } = await launchLibrary(language);
    await setWindowSize(app, window, 1440, 900);
    const library = window.getByTestId("library");
    const words = TIPS[language];

    // Organize is a button; what it does is its tooltip.
    await expect(library.getByTestId("library-organize-explain")).toHaveCount(0);
    await expect(library.getByTestId("library-organize")).toHaveAttribute("title", words.organize);

    // A Folder's description is not a line on the page: it shows pointing at the head, and in Get info.
    const head = library.getByTestId("library-section-head").filter({
      has: window.getByTestId("library-section-name").getByText("Board", { exact: true }),
    });
    await expect(head).not.toContainText(words.board);
    await expect(head).toHaveAttribute("title", words.board);
    await pointAndClick(window, head, { button: "right" });
    await pointAndClick(window, window.getByTestId("file.info").filter({ visible: true }));
    const info = window.getByTestId("info-panel");
    await expect(info.getByTestId("info-name")).toHaveText("Board");
    await expect(info.getByTestId("info-description")).toHaveText(words.board);
    await expect(info.getByTestId("info-summary")).toHaveText(words.documents);
    await window.keyboard.press("Escape");
    await expect(info).toHaveCount(0);

    // From the keyboard: ⌘I on the focused head.
    await head.getByTestId("library-section-name").focus();
    await window.keyboard.press("ControlOrMeta+i");
    await expect(window.getByTestId("info-panel").getByTestId("info-description")).toHaveText(
      words.board,
    );
    await window.keyboard.press("Escape");

    // Recently deleted: its sentence is its head's tooltip, and Empty is in the head.
    const deleted = window.getByTestId("recently-deleted");
    await deleted.scrollIntoViewIfNeeded();
    const deletedHead = deleted.getByTestId("deleted-section-head");
    await pointAndClick(window, deletedHead.getByTestId("deleted-heading"));
    await expect(deletedHead).toHaveAttribute("title", words.deleted);
    await expect(deleted).not.toContainText(words.deleted);
    await expect(deletedHead.getByTestId("deleted-empty")).toBeVisible();
    await app.close();
  });

  test(`the Tag picker has no legend of keys, and each mark says what it is (${language})`, async () => {
    const { app, window } = await launchLibrary(language);
    await setWindowSize(app, window, 1440, 900);
    const library = window.getByTestId("library");
    const register = library.getByTestId("library-document").filter({
      has: window.getByTestId("library-document-name").getByText("Risk register", { exact: true }),
    });
    await pointAndClick(window, register.getByTestId("tag-chip").first());
    const picker = register.getByTestId("document-tags-popover");
    await expect(picker.getByTestId("tag-picker-input")).toBeFocused();
    await expect(picker.getByTestId("tag-picker-keys")).toHaveCount(0);
    // A Tag on the Document has its check, which explains itself; no description line is cut under a name.
    const on = picker.locator('[data-testid="tag-option"][data-coverage="all"]').first();
    await expect(on.locator("[title]").first()).toHaveAttribute("title", TIPS[language].markOn);
    await expect(on.locator(".truncate")).toHaveCount(1);
    await app.close();
  });
}

/** Puts four Tags with long names on the Document with the long name, so its row has the most to fit. */
async function tagTheLongName(window: Page) {
  await window.evaluate(async (name) => {
    const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const doc = (await api.listDocuments()).find((each) => each.name === name);
    if (!doc) throw new Error("The long name is not in the Library.");
    for (const tag of [
      "Regulatory filings",
      "Audit committee",
      "Second review",
      "Board evidence",
    ]) {
      const made = await api.createTag({ name: tag, description: "" });
      await api.addDocumentTag(doc.id, made.id);
    }
  }, LONG_NAME);
}

test("at 900 px a row with a long name and four Tags is no wider than the page", async () => {
  const { app, window } = await launchLibrary("en");
  const library = window.getByTestId("library");
  await tagTheLongName(window);
  await setWindowSize(app, window, 900, 900);
  const more = library.getByTestId("library-show-all");
  while ((await more.count()) > 0) await more.first().click();
  const row = library.getByTestId("library-document").filter({
    has: window.getByTestId("library-document-name").getByText(LONG_NAME.slice(0, 30)),
  });
  await expect(row.getByTestId("tag-chip")).not.toHaveCount(0);
  await expect
    .poll(() =>
      library.evaluate((root) => {
        const page = root.querySelector<HTMLElement>("[data-hide]");
        return page ? page.scrollWidth - page.clientWidth : -1;
      }),
    )
    .toBe(0);
  await app.close();
});

test("the page fits its names again when its width or a name changes, and not for what is only pointed at, selected or opened", async () => {
  const { app, window } = await launchLibrary("en");
  const library = window.getByTestId("library");
  await setWindowSize(app, window, 1100, 900);
  await window.evaluate(() => {
    const page = document.querySelector("[data-hide]");
    const writes: number[] = [];
    (globalThis as unknown as { fitWrites: number[] }).fitWrites = writes;
    if (!page) throw new Error("No page.");
    new MutationObserver((records) => writes.push(records.length)).observe(page, {
      attributes: true,
      attributeFilter: ["data-hide"],
    });
  });
  const writes = () =>
    window.evaluate(() =>
      (globalThis as unknown as { fitWrites: number[] }).fitWrites.reduce((a, b) => a + b, 0),
    );

  const row = library.getByTestId("library-document").first();
  await pointAndClick(window, row.getByTestId("library-document-name"), { button: "right" });
  await window.keyboard.press("Escape");
  await pointAndClick(window, row.getByTestId("document-tags"));
  await window.keyboard.press("Escape");
  await window.keyboard.press("ArrowDown");
  await window.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  expect(await writes()).toBe(0);

  await setWindowSize(app, window, 1500, 900);
  await expect.poll(writes).toBeGreaterThan(0);
  await app.close();
});

test("a Tag name too long for the picker is cut, and its tooltip reads it whole", async () => {
  const { app, window } = await launchLibrary("en");
  const library = window.getByTestId("library");
  await setWindowSize(app, window, 1440, 900);
  const name = "Quarterly regulatory filings and the evidence kept for the audit committee";
  await window.evaluate(async (tag) => {
    const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await api.createTag({ name: tag, description: "" });
  }, name);
  const register = library.getByTestId("library-document").filter({
    has: window.getByTestId("library-document-name").getByText("Risk register", { exact: true }),
  });
  await pointAndClick(window, register.getByTestId("tag-chip").first());
  const option = register.getByTestId("document-tags-popover").getByTestId("tag-option").filter({
    hasText: "Quarterly regulatory",
  });
  await option.scrollIntoViewIfNeeded();
  await expect(option).toHaveAttribute("title", name);
  await app.close();
});

test("a Folder holds the same number of Documents in the Library, in ⌘K and in Get info, though one in it was deleted", async () => {
  const { app, window } = await launchLibrary("en");
  const library = window.getByTestId("library");
  await setWindowSize(app, window, 1440, 900);
  await window.evaluate(async () => {
    const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const doc = (await api.listDocuments()).find((each) => each.name === "Risk register");
    if (doc) await api.deleteDocument(doc.id);
  });
  const head = library.getByTestId("library-section-head").filter({
    has: window.getByTestId("library-section-name").getByText("Board", { exact: true }),
  });
  await expect(head.getByTestId("library-section-count")).toHaveText("8");

  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("Board");
  await expect(
    window.locator('[data-testid="palette-item"][data-kind="folder"]').filter({ hasText: "Board" }),
  ).toContainText("8 Documents");
  await window.keyboard.press("Escape");

  await pointAndClick(window, head, { button: "right" });
  await pointAndClick(window, window.getByTestId("file.info").filter({ visible: true }));
  await expect(window.getByTestId("info-panel").getByTestId("info-summary")).toHaveText(
    "8 Documents",
  );
  await app.close();
});

const TIPS = {
  en: {
    organize: "Suggests a Folder and Tags for each Document. You decide.",
    board: "Minutes, board packs and resolutions",
    deleted: "Kept here for 30 days, then deleted for good. Files on disk aren’t touched.",
    documents: "9 Documents",
    markOn: "on this Document",
  },
  "zh-CN": {
    organize: "为每个文档建议文件夹和标签，由你决定。",
    board: "Minutes, board packs and resolutions",
    deleted: "删除的内容保留 30 天，之后彻底删除。磁盘上的文件不受影响。",
    documents: "9 个文档",
    markOn: "已添加到此文档",
  },
} as const;

async function launchLibrary(language: "en" | "zh-CN") {
  const launched = await launchApp(dataDir);
  await openFullLibrary(launched.window, sources);
  await setLanguage(launched.window, language);
  return launched;
}
