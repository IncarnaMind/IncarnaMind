import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  decisionServer,
  dismissChatSetup,
  dragOnto,
  forceQuit,
  launchApp,
  leaveText,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * To review (#241): what Organize suggested and the User hasn't accepted. Driven as a person
 * would: the mouse slides to what it clicks, the keys are real key presses, and each step is read
 * back from the core as well as from the page. Set INCARNAMIND_SCREENSHOTS to a folder to save
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
  if (!SCREENSHOTS) return;
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

interface Placed {
  folder: string | null;
  suggested: boolean;
  source: "automatic" | "user";
}

async function placed(window: Page): Promise<Record<string, Placed>> {
  return (await coreOf(window)).evaluate(async (core) => {
    const [{ assignments, groups }, documents] = await Promise.all([
      core.getLibrary(),
      core.listDocuments(),
    ]);
    return Object.fromEntries(
      documents.map((document) => {
        const held = assignments.find((each) => each.documentId === document.id);
        return [
          document.name,
          {
            folder: groups.find((group) => group.id === held?.groupId)?.name ?? null,
            suggested: held?.suggested ?? false,
            source: held?.source ?? "automatic",
          },
        ];
      }),
    );
  });
}

/**
 * Eight invoices for Finance and four chapters for Thesis, in a Library with those Folders and
 * Archive, sorted by a local decision server so the suggestions wait in To review.
 */
async function sorted(
  window: Page,
  paths: string,
  port: number,
  { invoices = 8, chapters = 4, long = false } = {},
): Promise<void> {
  const files: string[] = [];
  if (long) {
    const path = join(paths, LONG_INVOICE);
    await writeFile(path, "Invoice 2026-99 for dredging the east basin. Total due: 9,900.");
    files.push(path);
  }
  for (let at = 1; at <= invoices; at++) {
    const path = join(paths, `Invoice ${String(at).padStart(2, "0")}.txt`);
    await writeFile(path, `Invoice 2026-${at} for consulting. Total due: ${at}00.`);
    files.push(path);
  }
  for (let at = 1; at <= chapters; at++) {
    const path = join(paths, `Chapter ${at}.txt`);
    await writeFile(path, `Chapter ${at} of the thesis on urban heat islands.`);
    files.push(path);
  }
  await addDocuments(window, files);
  await (await coreOf(window)).evaluate(async (core, url) => {
    for (const name of ["Finance", "Thesis", "Archive"]) {
      await core.createLibraryGroup({ name, description: `${name} documents` });
    }
    await core.saveLibrarySettings({
      classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
      automatic: false,
    });
  }, `http://127.0.0.1:${port}`);
  await window.getByTestId("open-library").click();
  await pointAndClick(window, window.getByTestId("library").getByTestId("library-organize"));
}

const LONG_INVOICE = "Invoice 99, dredging works at the Maasvlakte east basin, final account.txt";

const reviewOf = (window: Page) => window.getByTestId("library-review");
const reviewRow = (window: Page, name: string) =>
  reviewOf(window)
    .getByTestId("library-review-document")
    .filter({ has: window.getByRole("button", { name, exact: true }) });
const sectionOf = (window: Page, name: string) =>
  window.getByTestId("library-section").filter({
    has: window.locator('[data-testid="library-section-name"]', {
      hasText: new RegExp(`^${name}$`),
    }),
  });

/** The Documents To review lists, in the order it lists them (newest first, Folder by Folder). */
const listed = (window: Page) =>
  reviewOf(window)
    .getByTestId("library-review-document")
    .getByTestId("library-document-name")
    .allTextContents();

/** The row after this one in the list, as Enter on it leaves the focus there. */
async function rowAfter(window: Page, name: string): Promise<Locator> {
  const order = await listed(window);
  const next = order[order.indexOf(name) + 1];
  if (!next) throw new Error(`No row after ${name}.`);
  return reviewRow(window, next).locator("[data-row-main]");
}

const countOf = async (window: Page) =>
  Number(await reviewOf(window).getByTestId("library-section-count").first().textContent());

test("Organize sorts 12 Documents; the User accepts, moves, removes a Tag and turns one down, with the mouse and the keyboard, and ⌘Z takes each back", async () => {
  const { server } = await decisionServer((text) =>
    text.includes("invoice") ? "Finance" : "Thesis",
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await sorted(window, sources, (server.address() as AddressInfo).port);

    const review = reviewOf(window);
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "Sorted 12 Documents: 8 → Finance, 4 → Thesis",
    );
    await expect.poll(() => countOf(window)).toBe(12);
    expect(await placed(window)).toMatchObject({
      "Invoice 01": { folder: "Finance", suggested: true, source: "automatic" },
      "Chapter 1": { folder: "Thesis", suggested: true, source: "automatic" },
    });
    await screenshot(window, "to-review-closed");

    await pointAndClick(window, review.getByTestId("library-review-name"));
    const groups = review.getByTestId("library-review-group");
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toContainText("Finance · 8");
    await expect(groups.nth(1)).toContainText("Thesis · 4");
    const first = reviewRow(window, "Invoice 01");
    await expect(first.getByTestId("review-folder")).toContainText("Finance");
    await expect(first.getByTestId("review-accept")).toBeVisible();
    await screenshot(window, "to-review-open");

    await pointAndClick(window, first.getByTestId("review-accept"));
    await expect(first).toHaveCount(0);
    await expect.poll(() => countOf(window)).toBe(11);
    await expect(window.getByTestId("undo-line")).toContainText("Accepted “Invoice 01”");
    expect((await placed(window))["Invoice 01"]).toEqual({
      folder: "Finance",
      suggested: false,
      source: "user",
    });
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(first).toHaveCount(1);
    await expect.poll(() => countOf(window)).toBe(12);
    expect((await placed(window))["Invoice 01"]).toMatchObject({ suggested: true });
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(first).toHaveCount(0);
    expect((await placed(window))["Invoice 01"]).toMatchObject({ suggested: false });

    // Accept, with the keyboard: Enter on a row, and the focus goes on to the one after it.
    const third = reviewRow(window, "Invoice 03");
    const afterThird = await rowAfter(window, "Invoice 03");
    await third.locator("[data-row-main]").focus();
    await window.keyboard.press("Enter");
    await expect(third).toHaveCount(0);
    await expect(afterThird).toBeFocused();
    expect((await placed(window))["Invoice 03"]).toMatchObject({
      suggested: false,
      source: "user",
    });
    await window.keyboard.press("ControlOrMeta+z");
    await expect(third).toHaveCount(1);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(third).toHaveCount(0);

    const four = reviewRow(window, "Invoice 04");
    const five = reviewRow(window, "Invoice 05");
    await pointAt(window, four);
    await pointAndClick(window, four.getByTestId("confirm-document-tag"));
    await expect(four.getByTestId("tag-chip")).toHaveAttribute("data-source", "user");
    await pointAt(window, five);
    await pointAndClick(window, five.getByTestId("reject-document-tag"));
    await expect(five.getByTestId("tag-chip")).toHaveCount(0);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(five.getByTestId("tag-chip")).toHaveAttribute("data-needs-review", "true");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(five.getByTestId("tag-chip")).toHaveCount(0);

    const six = reviewRow(window, "Invoice 06");
    await dragOnto(
      window,
      six.getByRole("button", { name: "Invoice 06", exact: true }),
      sidebarFolder(window, "Archive"),
    );
    await expect(six).toHaveCount(0);
    expect((await placed(window))["Invoice 06"]).toEqual({
      folder: "Archive",
      suggested: false,
      source: "user",
    });
    await expect(window.getByTestId("undo-line")).toContainText("Moved “Invoice 06” to Archive");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(six).toHaveCount(1);
    expect((await placed(window))["Invoice 06"]).toMatchObject({
      folder: "Finance",
      suggested: true,
    });

    const seven = reviewRow(window, "Invoice 07");
    const afterSeven = await rowAfter(window, "Invoice 07");
    await seven.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Shift+m");
    const picker = window.getByTestId("move-to-picker");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.type("Arch");
    await window.keyboard.press("Enter");
    await expect(seven).toHaveCount(0);
    expect((await placed(window))["Invoice 07"]).toMatchObject({
      folder: "Archive",
      source: "user",
    });
    await expect(afterSeven).toBeFocused();

    const chapter = reviewRow(window, "Chapter 1");
    await pointAt(window, chapter);
    await pointAndClick(window, chapter.getByTestId("document-file-menu"));
    await pointAndClick(window, window.getByTestId("document.reject"));
    await expect(chapter).toHaveCount(0);
    expect((await placed(window))["Chapter 1"]).toEqual({
      folder: null,
      suggested: false,
      source: "automatic",
    });
    await expect(window.getByTestId("undo-line")).toContainText("Kept “Chapter 1” out of Thesis");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(chapter).toHaveCount(1);
    expect((await placed(window))["Chapter 1"]).toMatchObject({
      folder: "Thesis",
      suggested: true,
    });

    const chapterTwo = reviewRow(window, "Chapter 2");
    await chapterTwo.locator("[data-row-main]").focus();
    await window.keyboard.press("ContextMenu");
    const reject = window.getByTestId("document.reject");
    await expect(reject).toBeVisible();
    await reject.focus();
    await window.keyboard.press("Enter");
    await expect(chapterTwo).toHaveCount(0);
    expect((await placed(window))["Chapter 2"]).toMatchObject({ folder: null, suggested: false });

    const waiting = await countOf(window);
    expect(waiting).toBe(8);
    await reviewRow(window, "Invoice 08").locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(review).toHaveCount(0);
    await expect(window.getByTestId("undo-line")).toContainText("Accepted 8");
    const everything = await placed(window);
    expect(Object.values(everything).filter((each) => each.suggested)).toHaveLength(0);
    expect(everything).toMatchObject({
      "Invoice 08": { folder: "Finance", source: "user" },
      "Chapter 1": { folder: "Thesis", source: "user" },
      "Chapter 3": { folder: "Thesis", source: "user" },
      "Chapter 2": { folder: null, source: "automatic" },
    });
    await expect(window.getByTestId("library").locator("[data-tree-row]").first()).toBeFocused();
    // A Document the User put elsewhere since, by a change with no step, stays where they put it
    // when Accept all is taken back, and when it is done again.
    await (await coreOf(window)).evaluate(async (core) => {
      const documents = await core.listDocuments();
      const { groups } = await core.getLibrary();
      const moved = documents.find((each) => each.name === "Invoice 08");
      const archive = groups.find((each) => each.name === "Archive");
      if (!moved || !archive) throw new Error("No Document or Folder to move.");
      await core.assignDocumentGroup(moved.id, archive.id);
    });
    // The page has it before ⌘Z is pressed.
    await expect(sectionOf(window, "Archive").getByTestId("library-document")).toHaveCount(2);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(review).toBeVisible();
    await expect.poll(() => countOf(window)).toBe(7);
    expect((await placed(window))["Invoice 08"]).toMatchObject({
      folder: "Archive",
      suggested: false,
    });

    // Turned down once, a Folder isn't suggested for that Document again by the next Organize.
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(review).toHaveCount(0);
    const loose = window.getByTestId("library-section").filter({ hasText: "Not in a Folder" });
    await pointAndClick(window, loose.getByTestId("library-organize"));
    await expect(window.getByTestId("library-organizing")).toHaveCount(0);
    expect((await placed(window))["Chapter 2"]).toMatchObject({ folder: null, suggested: false });
    await expect(review).toHaveCount(0);
  } finally {
    server.close();
    await app.close();
  }
});

test("To review holds at the narrowest window in Chinese, and accepts from the Folder's own row and from ⌘K", async () => {
  const { server } = await decisionServer((text) =>
    text.includes("invoice") ? "Finance" : "Thesis",
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 760);
    await sorted(window, sources, (server.address() as AddressInfo).port);

    const review = reviewOf(window);
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(review.getByTestId("library-review-name")).toHaveText("待确认");
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "已整理 12 个文档：8 个 → “Finance”，4 个 → “Thesis”",
    );
    await expect(review.getByTestId("library-review-accept-all")).toContainText("全部接受");
    await pointAndClick(window, review.getByTestId("library-review-name"));
    const row = reviewRow(window, "Invoice 08");
    await expect(row.getByTestId("review-accept")).toContainText("接受");
    await expect(row.getByTestId("review-folder")).toHaveAccessibleName(
      "“Invoice 08”推荐放进的文件夹：“Finance”。更改…",
    );
    await screenshot(window, "to-review-zh-900");

    const library = window.getByTestId("library");
    expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const box = async (target: Locator) => {
      const found = await target.boundingBox();
      if (!found) throw new Error("Not showing.");
      return found;
    };
    const [rowBox, nameBox, folderBox, acceptBox] = await Promise.all([
      box(row),
      box(row.getByTestId("library-document-name")),
      box(row.getByTestId("review-folder")),
      box(row.getByTestId("review-accept")),
    ]);
    expect(
      await row
        .getByTestId("library-document-name")
        .evaluate((name) => name.scrollWidth <= name.clientWidth),
    ).toBe(true);
    // The name isn't cut, whatever the columns give up for it, and nothing runs over its neighbour.
    expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(folderBox.x + 1);
    expect(folderBox.x + folderBox.width).toBeLessThanOrEqual(acceptBox.x + 1);
    expect(acceptBox.x + acceptBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    const head = await box(review.getByTestId("library-review-head"));
    expect(head.height).toBeLessThan(48);

    // On the Folder's own row, a check next to its "推荐" accepts it.
    const own = sectionOf(window, "Thesis").getByTestId("library-document").first();
    await expect(own.getByTestId("library-suggested")).toHaveText("推荐");
    await pointAt(window, own);
    await pointAndClick(window, own.getByTestId("library-accept-suggestion"));
    await expect(own.getByTestId("library-suggested")).toHaveCount(0);
    await expect(window.getByTestId("undo-line")).toContainText("已接受“Chapter 4”");
    await expect.poll(() => countOf(window)).toBe(11);

    await runCommand(window, "library.acceptSuggestions", "接受全部推荐的文件夹");
    await expect(review).toHaveCount(0);
    await expect(window.getByTestId("undo-line")).toContainText("已接受 11 个");
    expect(Object.values(await placed(window)).filter((each) => each.suggested)).toHaveLength(0);
  } finally {
    server.close();
    await app.close();
  }
});

test("To review comes and goes with what waits: none, one, a Document deleted meanwhile, Organize's Undo, and quitting halfway", async () => {
  const { server } = await decisionServer((text) =>
    text.includes("invoice") ? "Finance" : "Thesis",
  );
  const port = (server.address() as AddressInfo).port;
  const first = await launchApp(dataDir);
  let { app, window } = first;
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await sorted(window, sources, port, { invoices: 3, chapters: 1 });
    const review = reviewOf(window);
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "Sorted 4 Documents: 3 → Finance, 1 → Thesis",
    );

    await pointAndClick(window, review.getByTestId("library-review-undo"));
    await expect(review).toHaveCount(0);
    expect(Object.values(await placed(window)).filter((each) => each.suggested)).toHaveLength(0);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(review).toBeVisible();
    await expect.poll(() => countOf(window)).toBe(4);

    await pointAndClick(window, review.getByTestId("library-review-name"));
    await (await coreOf(window)).evaluate(async (core) => {
      const gone = (await core.listDocuments()).find((each) => each.name === "Invoice 01");
      if (gone) await core.deleteDocument(gone.id);
    });
    await expect(reviewRow(window, "Invoice 01")).toHaveCount(0);
    await expect.poll(() => countOf(window)).toBe(3);
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "Sorted 3 Documents: 2 → Finance, 1 → Thesis",
    );

    await forceQuit(app);
    ({ app, window } = await launchApp(dataDir));
    await window.getByTestId("open-library").click();
    await expect(reviewOf(window)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => countOf(window)).toBe(3);
    expect(Object.values(await placed(window)).filter((each) => each.suggested)).toHaveLength(3);

    await pointAndClick(window, reviewOf(window).getByTestId("library-review-name"));
    await pointAndClick(window, reviewRow(window, "Chapter 1").getByTestId("review-accept"));
    await expect(reviewOf(window).getByTestId("library-review-undo")).toHaveCount(0);
    await expect(reviewOf(window).getByTestId("library-review-summary")).toHaveText(
      "Sorted 2 Documents: 2 → Finance",
    );

    await pointAndClick(window, reviewRow(window, "Invoice 02").getByTestId("review-accept"));
    await pointAndClick(window, reviewRow(window, "Invoice 03").getByTestId("review-accept"));
    await expect(reviewOf(window)).toHaveCount(0);
    await forceQuit(app);
    ({ app, window } = await launchApp(dataDir));
    await window.getByTestId("open-library").click();
    await expect(window.getByTestId("library-heading")).toBeVisible();
    await expect(reviewOf(window)).toHaveCount(0);
    expect(await placed(window)).toMatchObject({
      "Invoice 02": { folder: "Finance", suggested: false, source: "user" },
      "Chapter 1": { folder: "Thesis", suggested: false, source: "user" },
    });
  } finally {
    server.close();
    await app.close();
  }
});

test("Home says how many wait and opens them, and a Folder suggested for a Document that is then turned down isn't offered again", async () => {
  const { server } = await decisionServer(
    (text) => (text.includes("invoice") ? "Finance" : "Thesis"),
    { delayMs: 3000 },
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await newMind(window, { title: true });
    await window.keyboard.type("Notes");
    await sorted(window, sources, (server.address() as AddressInfo).port, {
      invoices: 2,
      chapters: 0,
    });
    // Organize takes a while, and the User goes on writing: its line, from another tab, offers Review.
    await newMind(window, { title: true });
    await window.keyboard.type("Second");
    await expect(window.getByTestId("library")).toBeHidden();
    await expect(window.getByTestId("undo-line")).toContainText(
      "Organize suggested a Folder for 2 Documents",
      { timeout: 30_000 },
    );
    await pointAndClick(window, window.getByTestId("undo-review"));
    await expect(reviewOf(window).getByTestId("library-review-document")).toHaveCount(2);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("Home");
    await window.keyboard.press("Enter");
    await pointAndClick(window, window.getByTestId("home-need-suggestions"));
    await expect(reviewOf(window).getByTestId("library-review-document")).toHaveCount(2);
    await expect(reviewOf(window).getByTestId("library-review-name")).toBeFocused();

    // Accepted from ⌘K and taken back, then both turned down at once, from the menu of a selection.
    await runCommand(window, "library.acceptSuggestions", "Accept all suggested Folders");
    await expect(reviewOf(window)).toHaveCount(0);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(reviewOf(window)).toBeVisible();
    const rows = reviewOf(window).getByTestId("library-review-document");
    await rows.first().locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("ContextMenu");
    const reject = window.getByTestId("document.reject");
    await expect(reject).toContainText("Not these Folders");
    await reject.focus();
    await window.keyboard.press("Enter");
    await expect(reviewOf(window)).toHaveCount(0);
    expect(Object.values(await placed(window)).map((each) => each.folder)).toEqual([null, null]);

    const loose = window.getByTestId("library-section").filter({ hasText: "Not in a Folder" });
    await pointAndClick(window, loose.getByTestId("library-organize"));
    await expect(window.getByTestId("library-organizing")).toHaveCount(0, { timeout: 30_000 });
    expect(Object.values(await placed(window)).map((each) => each.folder)).toEqual([null, null]);
    await expect(reviewOf(window)).toHaveCount(0);

    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(reviewOf(window)).toBeVisible();
    expect(Object.values(await placed(window))).toEqual([
      { folder: "Finance", suggested: true, source: "automatic" },
      { folder: "Finance", suggested: true, source: "automatic" },
    ]);
  } finally {
    server.close();
    await app.close();
  }
});

for (const [language, label] of [
  ["en", "Accept"],
  ["zh-CN", "接受"],
] as const) {
  test(`To review keeps every name whole when the page is narrow beside the viewer, with Folder and Accept under it (${language})`, async () => {
    const { server } = await decisionServer((text) =>
      text.includes("invoice") ? "Finance" : "Thesis",
    );
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      if (language === "zh-CN") await setLanguage(window, "zh-CN");
      await setWindowSize(app, window, 1440, 900);
      await sorted(window, sources, (server.address() as AddressInfo).port, {
        invoices: 2,
        chapters: 1,
        long: true,
      });
      const review = reviewOf(window);
      await expect(review).toBeVisible({ timeout: 30_000 });
      await pointAndClick(window, review.getByTestId("library-review-name"));
      const long = reviewRow(window, LONG_INVOICE.replace(".txt", ""));
      await pointAndClick(window, long.locator("[data-row-main]"));
      await expect(window.getByTestId("viewer")).toBeVisible();
      const library = window.getByTestId("library");
      await expect.poll(async () => (await library.boundingBox())?.width ?? 0).toBeLessThan(500);
      await screenshot(window, `to-review-narrow-${language}`);

      expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const box = async (target: Locator) => {
        const found = await target.boundingBox();
        if (!found) throw new Error("Not showing.");
        return found;
      };
      for (const row of await review.getByTestId("library-review-document").all()) {
        const [rowBox, name, folder, accept] = await Promise.all([
          box(row),
          box(row.getByTestId("library-document-name")),
          box(row.getByTestId("review-folder")),
          box(row.getByTestId("review-accept")),
        ]);
        // The name has the first line to itself, never squeezed to nothing.
        expect(name.width).toBeGreaterThan(50);
        expect(
          await row
            .getByTestId("library-document-name")
            .evaluate((each) => each.scrollWidth <= each.clientWidth || each.clientWidth > 200),
        ).toBe(true);
        expect(folder.y).toBeGreaterThan(name.y + name.height - 1);
        expect(accept.y).toBeGreaterThan(name.y + name.height - 1);
        expect(folder.x + folder.width).toBeLessThanOrEqual(accept.x + 1);
        expect(accept.x + accept.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
        expect(name.x + name.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
      }
      await expect(long.getByTestId("review-accept")).toContainText(label);
      // Accept still works from there.
      await pointAndClick(window, long.getByTestId("review-accept"));
      await expect(long).toHaveCount(0);
    } finally {
      server.close();
      await app.close();
    }
  });
}

test("⌘↵ accepts nothing while a search hides To review, and ⌘K doesn't offer Accept all then", async () => {
  const { server } = await decisionServer((text) =>
    text.includes("invoice") ? "Finance" : "Thesis",
  );
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1440, 900);
    await sorted(window, sources, (server.address() as AddressInfo).port);
    const review = reviewOf(window);
    await expect(review).toBeVisible({ timeout: 30_000 });
    const waiting = async () =>
      Object.values(await placed(window)).filter((each) => each.suggested).length;
    // Organize's run lands one Document at a time; wait until all twelve are suggested.
    await expect.poll(waiting, { timeout: 30_000 }).toBe(12);

    // The search shows one Document and hides the head, with the other eleven suggestions.
    const library = window.getByTestId("library");
    await pointAndClick(window, library.getByTestId("library-search"));
    await window.keyboard.type("Chapter 1");
    await expect(review).toHaveCount(0);
    await expect(library.getByTestId("library-document")).toHaveCount(1);
    await window.keyboard.press("ArrowDown");
    await expect(library.getByTestId("library-document").locator("[data-row-main]")).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(window.getByTestId("undo-line")).not.toContainText("Accepted");
    expect(await waiting()).toBe(12);
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("Accept all");
    await expect(window.getByTestId("palette")).toBeVisible();
    await expect(
      window.getByTestId("palette").locator('[data-key="command:library.acceptSuggestions"]'),
    ).toHaveCount(0);
    await window.keyboard.press("Escape");

    // With the search cleared, the head is back and the key works on what it shows.
    await pointAndClick(window, library.getByTestId("library-search-clear"));
    await expect(review).toBeVisible();
    await review.getByTestId("library-review-name").focus();
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(window.getByTestId("undo-line")).toContainText("Accepted 12");
    expect(await waiting()).toBe(0);
  } finally {
    server.close();
    await app.close();
  }
});
