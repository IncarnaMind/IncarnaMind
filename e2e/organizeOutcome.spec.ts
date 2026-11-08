import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  DECISION_FAILURE,
  decisionServer,
  dismissChatSetup,
  launchApp,
  leaveText,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sidebarFolder,
} from "./app";

/*
 * How Organize ended (#1928, #1569): on 40 Documents whose decision model can't place three, the
 * other 37 wait in the Review and nothing is filed before Confirm; each of the three says why in
 * its row, Not in a Folder's head counts them with Try again once nothing waits, and once all are
 * filed the Library's title line says so. In English and Chinese, at 900 and 1,600 pixels.
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

const section = (library: Locator, key: string) =>
  library.locator(`[data-testid="library-section"][data-section="${key}"]`);

async function forty(): Promise<string[]> {
  const files: string[] = [];
  for (let at = 1; at <= 20; at++) {
    const path = join(sources, `Invoice ${String(at).padStart(2, "0")}.txt`);
    await writeFile(path, `Invoice 2026-${at} for consulting. Total due: ${at}00.`);
    files.push(path);
  }
  for (let at = 1; at <= 17; at++) {
    const path = join(sources, `Report ${String(at).padStart(2, "0")}.txt`);
    await writeFile(path, `Report ${at}: quarterly results for region ${at}.`);
    files.push(path);
  }
  for (let at = 1; at <= 3; at++) {
    const path = join(sources, `Note ${at}.txt`);
    await writeFile(path, `unplaced fragment ${at}: notes with no clear subject.`);
    files.push(path);
  }
  return files;
}

const reviewOf = (window: Page) => window.getByTestId("organize-review");

/** A card in the Review by its Folder's name. */
const cardOf = (window: Page, name: string) =>
  window.getByTestId("organize-review-card").filter({
    has: window.getByTestId("organize-review-card-name").filter({
      hasText: new RegExp(`^${name}$`),
    }),
  });

/** How many Documents are in each Folder, by name, read through the core. */
const filedCounts = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const { groups, assignments } = await core.getLibrary();
    return Object.fromEntries(
      groups.map((group) => [
        group.name,
        assignments.filter((each) => each.groupId === group.id).length,
      ]),
    );
  });

/** Shows every row of a section that folds its list after the first ones. */
async function showAllIn(window: Page, list: Locator): Promise<void> {
  const more = list.getByTestId("library-show-all");
  if ((await more.count()) > 0) await pointAndClick(window, more);
}

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const toTop = (library: Locator) =>
  library.evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(":scope > div");
    if (scroller) scroller.scrollTop = 0;
  });

/** How many times ⌘K lists the command once these words are typed; Esc closes it. */
async function paletteLists(window: Page, id: string, words: string): Promise<number> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(words);
  const palette = window.getByTestId("palette");
  await expect(
    palette.locator('[data-testid="palette-item"], [data-testid="palette-empty"]').first(),
  ).toBeVisible();
  const count = await palette.locator(`[data-key="command:${id}"]`).count();
  await window.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  return count;
}

test("Organize says which Documents it couldn't sort and why, files nothing before Confirm, and says when sorting is done", async () => {
  test.setTimeout(240_000);
  let failing = true;
  const { server } = await decisionServer(undefined, {
    failFor: (text) => failing && text.includes("unplaced"),
  });
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 900);
    await addDocuments(window, await forty());
    const port = (server.address() as AddressInfo).port;
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (const name of ["Finance", "Reports"])
        await core.createLibraryGroup({ name, description: `${name} documents` });
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: false,
      });
    }, `http://127.0.0.1:${port}`);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await pointAndClick(window, library.getByTestId("library-organize"));

    // The 37 it could place wait in the Review, in the Folders there are; the three it couldn't
    // aren't proposed anywhere, and nothing is filed yet.
    const review = reviewOf(window);
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(window.getByTestId("organize-review-will-move")).toHaveText(
      "37 Documents will move into 2 of your Folders. Nothing has moved yet.",
    );
    await expect(window.getByTestId("organize-review-card-name")).toHaveText([
      "Finance",
      "Reports",
    ]);
    await expect(cardOf(window, "Finance").getByTestId("organize-review-show-all")).toHaveText(
      "Show all 20",
    );
    await expect(cardOf(window, "Reports").getByTestId("organize-review-show-all")).toHaveText(
      "Show all 17",
    );
    await expect(window.getByTestId("organize-review-left-out-row")).toHaveCount(0);
    expect(await filedCounts(window)).toEqual({ Finance: 0, Reports: 0 });
    await screenshot(window, "organize-outcome-en-1600-review");
    await pointAndClick(window, window.getByTestId("organize-review-not-now"));
    await expect(review).toHaveCount(0);

    const reason = "Couldn’t organize";
    const loose = section(library, "not-in-a-folder");
    await showAllIn(window, loose);
    await expect(loose.getByTestId("library-document")).toHaveCount(40);
    await expect(loose.getByTestId("library-not-sorted")).toHaveCount(3);
    await expect(loose.getByTestId("library-not-sorted").first()).toContainText(reason);
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveAttribute(
      "title",
      "Organize couldn’t place this Document in a Folder",
    );
    await expect(
      loose.getByTestId("library-not-sorted").first().getByTestId("library-not-organized-retry"),
    ).toHaveText("Try again");
    // While the 37 wait, the Library's top offers their Review, not Not in a Folder's count.
    await expect(window.getByTestId("organize-waiting")).toHaveText(
      "37 Documents to confirm·Review",
    );
    await expect(loose.getByTestId("library-organize-failed")).toHaveCount(0);
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    await expect(sidebarFolder(window, "Finance").getByTestId("browse-count")).toHaveText("0");
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText("0");
    await toTop(library);
    await screenshot(window, "organize-outcome-en-1600");
    await screenshot(loose, "organize-outcome-en-1600-not-sorted");

    // The same at the narrowest window, then in Chinese.
    await setWindowSize(app, window, 900, 760);
    await expect(window.getByTestId("organize-waiting")).toHaveText(
      "37 Documents to confirm·Review",
    );
    await expect(loose.getByTestId("library-not-sorted").first()).toContainText(reason);
    await toTop(library);
    await screenshot(window, "organize-outcome-en-900");
    await screenshot(loose, "organize-outcome-en-900-not-sorted");
    await setLanguage(window, "zh-CN");
    await expect(loose.getByTestId("library-not-sorted").first()).toContainText("未能整理");
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveAttribute(
      "title",
      "“整理”未能把这个文档放入文件夹",
    );
    await expect(window.getByTestId("organize-waiting")).toContainText("37 个文档待确认");
    await toTop(library);
    await screenshot(window, "organize-outcome-zh-900");
    await screenshot(loose, "organize-outcome-zh-900-not-sorted");

    // Confirm files the 37; then Not in a Folder's head counts the three, with Try again, and ⌘K
    // offers Try again where it no longer offers the Review.
    await pointAndClick(window, window.getByTestId("organize-waiting-review"));
    await expect(review).toBeVisible();
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(review).toHaveCount(0);
    expect(await filedCounts(window)).toEqual({ Finance: 20, Reports: 17 });
    await expect(sidebarFolder(window, "Finance").getByTestId("browse-count")).toHaveText("20");
    const header = loose.getByTestId("library-organize-failed");
    await expect(header).toHaveText("3 个文档未整理 · 重试");
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    await expect(window.getByTestId("organize-waiting")).toHaveCount(0);
    expect(await paletteLists(window, "library.retryFailed", "重试“整理”")).toBe(1);
    expect(await paletteLists(window, "library.review", "查看建议的文件夹")).toBe(0);

    // Sorted once the model can place them: Try again proposes them, Confirm files them, and
    // the title line says all are sorted.
    failing = false;
    await pointAndClick(window, header.getByRole("button", { name: "重试" }));
    await expect(review).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId("organize-review-card-name")).toHaveText(["Reports"]);
    await expect(cardOf(window, "Reports").getByTestId("organize-review-row")).toHaveCount(3);
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(review).toHaveCount(0);
    await expect(window.getByTestId("library-sorted")).toHaveText("已全部整理");
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText("20");
    await screenshot(window, "organize-outcome-zh-sorted-900");
    await setWindowSize(app, window, 1600, 900);
    await expect(window.getByTestId("library-sorted")).toHaveText("已全部整理");
    await screenshot(window, "organize-outcome-zh-sorted-1600");
    await setLanguage(window, "en");
    await setWindowSize(app, window, 900, 760);
    await expect(window.getByTestId("library-sorted")).toHaveText("All sorted");
    await screenshot(window, "organize-outcome-en-sorted-900");
    await setWindowSize(app, window, 1600, 900);
    await expect(window.getByTestId("library-sorted")).toHaveText("All sorted");
    await screenshot(window, "organize-outcome-en-sorted-1600");

    // A Document the User moved to no Folder by hand is the User's decision, not Organize's: the
    // line stays, and its row isn't one Organize couldn't sort.
    await (await coreOf(window)).evaluate(async (core) => {
      const note = (await core.listDocuments()).find((each) => each.name === "Note 2");
      if (!note) throw new Error("No Document named Note 2.");
      await core.assignDocumentGroup(note.id, null);
    });
    await expect(window.getByTestId("library-sorted")).toHaveText("All sorted");
    const looseNow = section(library, "not-in-a-folder");
    await expect(looseNow.getByTestId("library-document")).toHaveCount(1);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);

    // A later run that fails for that Document leaves the User's choice standing: it is not
    // suddenly one Organize couldn't sort, in its row, Not in a Folder's head or the Review.
    failing = true;
    await (await coreOf(window)).evaluate(async (core) => {
      const note = (await core.listDocuments()).find((each) => each.name === "Note 2");
      if (!note) throw new Error("No Document named Note 2.");
      await core.classifyDocuments([note.id]);
    });
    await expect
      .poll(
        async () =>
          (await coreOf(window)).evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const note = (await core.listDocuments()).find((each) => each.name === "Note 2");
            const { assignments } = await core.getLibrary();
            const held = assignments.find((each) => each.documentId === note?.id);
            return [held?.source, held?.groupId, held?.status] as const;
          }),
        { timeout: 30_000 },
      )
      .toEqual(["user", null, "failed"]);
    await expect(window.getByTestId("library-sorted")).toHaveText("All sorted");
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveCount(0);
    await expect(window.getByTestId("organize-waiting")).toHaveCount(0);
    await expect(reviewOf(window)).toHaveCount(0);
    failing = false;

    // One Organize stopped short of, because tagging with AI is off where it is, is neither
    // sorted nor one it couldn't sort: the line goes, and no reason is invented for it.
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTaggingWithAi(null, false);
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: true,
        turnOn: true,
      });
    }, `http://127.0.0.1:${port}`);
    const stoppedPath = join(sources, "Note 4.txt");
    await writeFile(stoppedPath, "A note added while sorting with AI is off here.");
    await window.evaluate(async (path) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.addDocuments([path]);
    }, stoppedPath);
    await expect
      .poll(
        () =>
          window.evaluate(
            async () =>
              (
                await (
                  globalThis as unknown as { incarnamind: CoreBridge }
                ).incarnamind.listDocuments()
              ).filter((each) => each.status === "ready").length,
          ),
        { timeout: 30_000 },
      )
      .toBe(41);
    await expect(looseNow.getByTestId("library-document")).toHaveCount(2);
    await expect(window.getByTestId("library-sorted")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);

    // A failed assignment with no reason saved (Undo of an older change can put one back) still
    // says so, in its row and in Not in a Folder's head, rather than going quiet.
    await (await coreOf(window)).evaluate(async (core) => {
      const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
      const { assignments } = await core.getLibrary();
      const held = assignments.find((each) => each.documentId === note?.id);
      if (!note || !held) throw new Error("No Document named Note 1.");
      const { documentId: _id, tagging, ...after } = held;
      await core.restoreAssignment(
        note.id,
        {
          assignment: {
            groupId: null,
            source: "automatic",
            status: "failed",
            error: null,
            model: null,
          },
          tagging: null,
        },
        { assignment: after, tagging: tagging ?? null },
      );
    });
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveText(
      "1 Document not organized · Try again",
    );
    await expect(looseNow.getByTestId("library-not-sorted").first()).toContainText(reason);
    await expect(looseNow.getByTestId("library-not-sorted").first()).toHaveAttribute(
      "title",
      "Organize couldn’t place this Document in a Folder",
    );

    // A Document Organize filed by itself before it proposed (an earlier version did) whose
    // re-run fails says so in its row in that Folder, with Try again; Not in a Folder's head
    // doesn't count it, as it isn't one Organize couldn't place.
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: false,
      });
    }, `http://127.0.0.1:${port}`);
    await (await coreOf(window)).evaluate(async (core) => {
      const [documents, libraryNow] = await Promise.all([core.listDocuments(), core.getLibrary()]);
      const note = documents.find((each) => each.name === "Note 1");
      const reports = libraryNow.groups.find((each) => each.name === "Reports");
      const held = libraryNow.assignments.find((each) => each.documentId === note?.id);
      if (!note || !reports || !held) throw new Error("No Document or Folder to file it in.");
      const { documentId: _id, tagging, ...after } = held;
      await core.restoreAssignment(
        note.id,
        {
          assignment: {
            groupId: reports.id,
            source: "automatic",
            status: "classified",
            error: null,
            model: null,
          },
          tagging: null,
        },
        { assignment: after, tagging: tagging ?? null },
      );
    });
    failing = true;
    await (await coreOf(window)).evaluate(async (core) => {
      const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
      if (!note) throw new Error("No Document named Note 1.");
      await core.classifyDocuments([note.id]);
    });
    const noteNow = async () =>
      (await coreOf(window)).evaluate(async (core) => {
        const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
        const { assignments, groups } = await core.getLibrary();
        const held = assignments.find((each) => each.documentId === note?.id) ?? null;
        return {
          status: held?.status ?? null,
          error: held?.error ?? null,
          folder: groups.find((each) => each.id === held?.groupId)?.name ?? null,
        };
      });
    await expect
      .poll(noteNow, { timeout: 30_000 })
      .toMatchObject({ status: "failed", folder: "Reports" });
    expect(await noteNow()).toMatchObject({
      error: { kind: "provider", message: DECISION_FAILURE },
    });
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveCount(0);
    const reportsSection = library.getByTestId("library-section").filter({
      has: library.page().getByTestId("library-section-name").filter({ hasText: "Reports" }),
    });
    await showAllIn(window, reportsSection);
    const noteInReports = reportsSection.getByTestId("library-document").filter({
      has: window.getByRole("button", { name: "Note 1", exact: true }),
    });
    await expect(noteInReports.getByTestId("library-sort-failed")).toContainText(reason);
    await expect(noteInReports.getByTestId("library-sort-failed")).toHaveAttribute(
      "title",
      "Organize couldn’t place this Document in a Folder",
    );
    await expect(
      noteInReports.getByTestId("library-sort-failed").getByTestId("library-organize-failed-retry"),
    ).toHaveText("Try again");
    await expect(noteInReports.getByTestId("library-not-sorted")).toHaveCount(0);
    // Screenshots of the row's reason: no row selected by an earlier click, and the pointer off the rows.
    for (const box of await library.locator('[data-testid="library-select"]:checked').all())
      await box.uncheck();
    const shoot = async (name: string) => {
      await toTop(library);
      await pointAt(window, library.getByTestId("library-heading"));
      await screenshot(window, name);
      await screenshot(noteInReports, `${name}-row`);
    };
    await shoot("organize-outcome-en-1600-sort-failed");
    await setWindowSize(app, window, 900, 760);
    await shoot("organize-outcome-en-900-sort-failed");
    await setLanguage(window, "zh-CN");
    await expect(noteInReports.getByTestId("library-sort-failed")).toContainText("未能整理");
    await shoot("organize-outcome-zh-900-sort-failed");
    await setWindowSize(app, window, 1600, 900);
    await shoot("organize-outcome-zh-1600-sort-failed");
    await setLanguage(window, "en");

    // Its Try again reaches the model now: the row's reason goes, and it is still in Reports.
    failing = false;
    await pointAndClick(
      window,
      noteInReports.getByTestId("library-sort-failed").getByTestId("library-organize-failed-retry"),
    );
    await expect
      .poll(noteNow, { timeout: 30_000 })
      .toEqual({ status: "classified", error: null, folder: "Reports" });
    if ((await reviewOf(window).count()) > 0)
      await pointAndClick(window, window.getByTestId("organize-review-not-now"));
    await expect(library.getByTestId("library-sort-failed")).toHaveCount(0);
  } finally {
    server.close();
    await app.close();
  }
});

test("deleting the last Document Organize couldn't sort leaves no line behind, and Undo brings it back", async () => {
  test.setTimeout(150_000);
  const { server } = await decisionServer(undefined, {
    failFor: (text) => text.includes("unplaced"),
  });
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 900);
    await writeFile(
      join(sources, "Invoice 1.txt"),
      "Invoice 2026-1 for consulting. Total due: 100.",
    );
    await writeFile(
      join(sources, "Note 1.txt"),
      "unplaced fragment 1: notes with no clear subject.",
    );
    await writeFile(
      join(sources, "Note 2.txt"),
      "unplaced fragment 2: notes with no clear subject.",
    );
    await addDocuments(window, [
      join(sources, "Invoice 1.txt"),
      join(sources, "Note 1.txt"),
      join(sources, "Note 2.txt"),
    ]);
    const port = (server.address() as AddressInfo).port;
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createLibraryGroup({ name: "Finance", description: "Finance documents" });
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: false,
      });
    }, `http://127.0.0.1:${port}`);
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await pointAndClick(window, library.getByTestId("library-organize"));
    // The Invoice's Folder waits in the Review; Confirm files it, and the two Notes are left.
    await expect(reviewOf(window)).toBeVisible({ timeout: 60_000 });
    await pointAndClick(window, window.getByTestId("organize-review-confirm"));
    await expect(reviewOf(window)).toHaveCount(0);

    const loose = section(library, "not-in-a-folder");
    const header = loose.getByTestId("library-organize-failed");
    await expect(header).toHaveText("2 Documents not organized · Try again");
    const rowNamed = (name: string) =>
      loose.getByTestId("library-document").filter({
        has: window.getByRole("button", { name, exact: true }),
      });
    const deleteRow = async (name: string) => {
      await pointAndClick(window, rowNamed(name).getByTestId("document-file-menu"));
      await pointAndClick(window, window.getByTestId("document.delete"));
    };

    await deleteRow("Note 1");
    await expect(header).toHaveText("1 Document not organized · Try again");
    await deleteRow("Note 2");
    // The last failure is gone: every line goes with it, including ⌘K's Try again.
    await expect(header).toHaveCount(0);
    await expect(loose.getByTestId("library-not-sorted")).toHaveCount(0);
    await expect(library.getByTestId("library-sorted")).toHaveText("All sorted");
    expect(await paletteLists(window, "library.retryFailed", "Try again on the Documents")).toBe(0);

    // The same at 900 px in Chinese, then Undo twice: each Document brings its state back.
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(library.getByTestId("library-sorted")).toHaveText("已全部整理");
    expect(await paletteLists(window, "library.retryFailed", "重试“整理”")).toBe(0);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(header).toHaveText("1 个文档未整理 · 重试");
    await expect(loose.getByTestId("library-not-sorted").first()).toContainText("未能整理");
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveAttribute(
      "title",
      "“整理”未能把这个文档放入文件夹",
    );
    expect(await paletteLists(window, "library.retryFailed", "重试“整理”")).toBe(1);
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(header).toHaveText("2 个文档未整理 · 重试");
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    await expect(loose.getByTestId("library-not-sorted")).toHaveCount(2);
  } finally {
    server.close();
    await app.close();
  }
});

test("a first move takes the tagging it settles, and a retag between Undo and Redo stands through both", async () => {
  test.setTimeout(180_000);
  let failing = false;
  const { server } = await decisionServer(undefined, { delayMs: 12_000, failFor: () => failing });
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, 1600, 900);
    const port = (server.address() as AddressInfo).port;
    const briefNow = async () =>
      (await coreOf(window)).evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const brief = (await core.listDocuments()).find((each) => each.name === "Brief 1");
        const { assignments, groups } = await core.getLibrary();
        const held = assignments.find((each) => each.documentId === brief?.id) ?? null;
        return {
          held,
          tagging: brief?.tagging ?? null,
          taggingError: brief?.taggingError ?? null,
          folder: groups.find((each) => each.id === held?.groupId)?.name ?? null,
        };
      });

    // Tagging with AI runs by itself, and no Folder exists yet, so Organize has no assignment for it.
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createTag({ name: "Bills", description: "Bills and invoices" });
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: true,
        turnOn: true,
      });
    }, `http://127.0.0.1:${port}`);
    await writeFile(join(sources, "Brief 1.txt"), "Brief 1 about the harbour budget.");
    await addDocuments(window, [join(sources, "Brief 1.txt")]);
    await expect.poll(async () => (await briefNow()).tagging, { timeout: 30_000 }).toBe("tagging");
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createLibraryGroup({ name: "Finance", description: "Money." });
    });

    // The first move settles the tagging the tagger had going, and the change carries it.
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const loose = section(library, "not-in-a-folder");
    const row = loose.getByTestId("library-document").filter({
      has: window.getByRole("button", { name: "Brief 1", exact: true }),
    });
    await expect(row).toHaveCount(1);
    await pointAt(window, row);
    await pointAndClick(window, row.getByTestId("document-file-menu"));
    await pointAndClick(
      window,
      window
        .getByTestId("document-file-actions")
        .filter({ visible: true })
        .getByTestId("document.moveTo"),
    );
    const picker = window.getByTestId("move-to-picker");
    await expect(picker.getByTestId("move-to-search")).toBeFocused();
    await window.keyboard.type("Finance");
    await window.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect.poll(async () => (await briefNow()).folder, { timeout: 30_000 }).toBe("Finance");
    expect(await briefNow()).toMatchObject({ tagging: "waiting-for-provider" });
    await expect(window.getByTestId("undo-line")).toContainText("Moved “Brief 1” to Finance");
    await setLanguage(window, "zh-CN");
    await expect(window.getByTestId("undo-line")).toContainText("已将“Brief 1”移动到“Finance”");
    await setLanguage(window, "en");

    // ⌘Z gives back the place it had and the tagging the move took.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await briefNow()).held, { timeout: 30_000 }).toBeNull();
    await expect.poll(async () => (await briefNow()).tagging, { timeout: 30_000 }).toBe("tagging");

    // The User asks for a retag while the Document is in no Folder, and its provider fails.
    failing = true;
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const brief = (await core.listDocuments()).find((each) => each.name === "Brief 1");
      if (!brief) throw new Error("No Document named Brief 1.");
      await core.retagDocuments([brief.id]);
    });
    await expect.poll(async () => (await briefNow()).tagging, { timeout: 60_000 }).toBe("failed");

    // ⇧⌘Z gives the Folder back, and leaves the newer retag alone: it is later work.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(async () => (await briefNow()).folder, { timeout: 30_000 }).toBe("Finance");
    expect(await briefNow()).toMatchObject({
      tagging: "failed",
      taggingError: { message: DECISION_FAILURE },
    });

    // ⌘Z again: what the Redo stored leaves the retag standing through that Undo too.
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await briefNow()).held, { timeout: 30_000 }).toBeNull();
    expect(await briefNow()).toMatchObject({
      tagging: "failed",
      taggingError: { message: DECISION_FAILURE },
    });
    failing = false;
  } finally {
    server.close();
    await app.close();
  }
});
