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
 * How Organize ended (#1928): on 40 Documents whose fake tagger can't place three, each says why
 * in its row and in To review, the Library's title line says how many are left and, once nothing
 * waits, that all are sorted, and a Folder's count in the sidebar says how many of its Documents
 * are only suggested, in English and Chinese, at 900 and 1,600 pixels.
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

const reviewOf = (window: Page) => window.getByTestId("library-review");

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const toTop = (library: Locator) =>
  library.evaluate((element) => {
    const scroller = element.querySelector<HTMLElement>(":scope > div");
    if (scroller) scroller.scrollTop = 0;
  });

test("Organize says which Documents it couldn't sort and why, when sorting is done, and how many are only suggested", async () => {
  test.setTimeout(180_000);
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

    const reason = `Not sorted: ${DECISION_FAILURE}`;
    const loose = section(library, "not-in-a-folder");
    const review = reviewOf(window);
    await expect(review.getByTestId("library-review-summary")).toHaveText(
      "Sorted 37 Documents: 20 → Finance, 17 → Reports, 3 not sorted",
      { timeout: 60_000 },
    );
    await expect(loose.getByTestId("library-document")).toHaveCount(3);
    await expect(loose.getByTestId("library-not-sorted")).toHaveCount(3);
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveText(reason);

    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("3 not sorted");
    await expect(library.getByTestId("library-review-not-sorted")).toHaveText("Review");
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    await expect(sidebarFolder(window, "Finance").getByTestId("browse-count")).toHaveText(
      "20 · 20 suggested",
    );
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText(
      "17 · 17 suggested",
    );

    await pointAndClick(window, review.getByTestId("library-review-name"));
    const unsorted = review.getByTestId("library-review-unsorted");
    await expect(unsorted.getByTestId("library-review-document")).toHaveCount(3);
    await expect(unsorted.getByTestId("library-not-sorted")).toHaveCount(3);
    await expect(unsorted.getByTestId("library-not-sorted").first()).toHaveText(reason);
    await expect(unsorted.getByTestId("review-accept")).toHaveCount(0);
    await toTop(library);
    await screenshot(window, "organize-outcome-en-1600");
    await screenshot(loose, "organize-outcome-en-1600-not-sorted");
    await screenshot(unsorted, "organize-outcome-en-1600-review-not-sorted");

    // The title line's Review opens To review at its head.
    await pointAndClick(window, review.getByTestId("library-review-name"));
    await expect(review.getByTestId("library-review-document")).toHaveCount(0);
    await pointAndClick(window, library.getByTestId("library-review-not-sorted"));
    // The first rows of each Folder, then all three it couldn't sort.
    await expect(review.getByTestId("library-review-document")).toHaveCount(19);
    await expect(review.getByTestId("library-review-name")).toBeFocused();
    // Enter opens a Document Organize couldn't sort: there is no Folder to accept for it.
    await unsorted
      .getByTestId("library-review-document")
      .first()
      .locator("[data-row-main]")
      .focus();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("viewer")).toBeVisible();
    await expect(review.getByTestId("library-review-document")).toHaveCount(19);
    await pointAndClick(
      window,
      window.locator('[role="tab"][data-kind="document"]').getByTestId("tab-close"),
    );
    await expect(window.getByTestId("viewer")).toHaveCount(0);
    await expect(library).toBeVisible();

    // The same at the narrowest window, then in Chinese.
    await setWindowSize(app, window, 900, 760);
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("3 not sorted");
    await expect(library.getByTestId("library-review-not-sorted")).toHaveText("Review");
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveText(reason);
    await toTop(library);
    await screenshot(window, "organize-outcome-en-900");
    await screenshot(loose, "organize-outcome-en-900-not-sorted");
    await setLanguage(window, "zh-CN");
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveText(
      `未能整理：${DECISION_FAILURE}`,
    );
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("3 个未整理");
    await expect(library.getByTestId("library-review-not-sorted")).toHaveText("查看");
    await expect(sidebarFolder(window, "Finance").getByTestId("browse-count")).toHaveText(
      "20 · 20 个推荐",
    );
    await expect(unsorted.getByTestId("library-not-sorted").first()).toHaveText(
      `未能整理：${DECISION_FAILURE}`,
    );
    await toTop(library);
    await screenshot(window, "organize-outcome-zh-900");
    await screenshot(loose, "organize-outcome-zh-900-not-sorted");
    await screenshot(unsorted, "organize-outcome-zh-900-review-not-sorted");

    await pointAndClick(window, review.getByTestId("library-review-accept-all"));
    await expect(review.getByTestId("library-review-document")).toHaveCount(3);
    await expect(review.getByTestId("library-review-accept-all")).toHaveCount(0);
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("3 个未整理");
    await expect(library.getByTestId("library-review-not-sorted")).toHaveText("查看");
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    await expect(sidebarFolder(window, "Finance").getByTestId("browse-count")).toHaveText("20");
    // ⌘K still reaches To review for what Organize couldn't sort.
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("待确认");
    await expect(
      window.getByTestId("palette").locator('[data-key="command:library.review"]'),
    ).toHaveCount(1);
    await window.keyboard.press("Escape");

    // Sorted once the tagger can place them: the three are suggested, then accepted, and nothing waits.
    failing = false;
    await pointAndClick(
      window,
      library.getByTestId("library-organize-failed").getByRole("button", { name: "重试" }),
    );
    await expect(review.getByTestId("library-review-unsorted")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(review.getByTestId("library-review-document")).toHaveCount(3);
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText(
      "20 · 3 个推荐",
    );
    await pointAndClick(window, review.getByTestId("library-review-accept-all"));
    await expect(reviewOf(window)).toHaveCount(0);
    await expect(window.getByTestId("library-sorted")).toHaveText("已全部整理");
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
    // suddenly one Organize couldn't sort, in its row, the title line or To review.
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
    await expect(window.getByTestId("library-not-sorted-count")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveCount(0);
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
    await expect(window.getByTestId("library-not-sorted-count")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);

    // A failed assignment with no reason saved (Undo of an older change can put one back) still
    // says so, in its row and in the title line, rather than going quiet.
    await (await coreOf(window)).evaluate(async (core) => {
      const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
      if (!note) throw new Error("No Document named Note 1.");
      await core.restoreAssignment(note.id, {
        groupId: null,
        source: "automatic",
        suggested: false,
        status: "failed",
        error: null,
        model: null,
      });
    });
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("1 not sorted");
    await expect(
      section(library, "not-in-a-folder").getByTestId("library-not-sorted").first(),
    ).toHaveText("Not sorted: the model gave no reason");

    // A suggestion that a re-run fails for, then turned down, is the User's decision: finishing it
    // settles the Document, so nothing calls it one Organize couldn't sort.
    await (await coreOf(window)).evaluate(async (core) => {
      const [documents, libraryNow] = await Promise.all([core.listDocuments(), core.getLibrary()]);
      const note = documents.find((each) => each.name === "Note 1");
      const reports = libraryNow.groups.find((each) => each.name === "Reports");
      if (!note || !reports) throw new Error("No Document or Folder to suggest.");
      await core.restoreAssignment(note.id, {
        groupId: reports.id,
        source: "automatic",
        suggested: true,
        status: "classified",
        error: null,
        model: null,
      });
    });
    // Automatic Organize is off (a cloud key's default): the Reject must settle the failed run
    // for the Document's own tagging, or the sidebar goes on saying it couldn't be tagged.
    await window.evaluate(async (url) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveLibrarySettings({
        classifier: { kind: "ollama", baseUrl: url, modelId: "tev1:0.8b" },
        automatic: false,
      });
    }, `http://127.0.0.1:${port}`);
    failing = true;
    await (await coreOf(window)).evaluate(async (core) => {
      const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
      if (!note) throw new Error("No Document named Note 1.");
      await core.classifyDocuments([note.id]);
    });
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
            const { assignments } = await core.getLibrary();
            const held = assignments.find((each) => each.documentId === note?.id);
            return [held?.status, held?.suggested] as const;
          }),
        { timeout: 30_000 },
      )
      .toEqual(["failed", true]);
    const noteRow = review
      .getByTestId("library-review-document")
      .filter({ has: window.getByRole("button", { name: "Note 1", exact: true }) });
    await expect(noteRow).toHaveCount(1);
    await expect(noteRow.getByTestId("library-sort-failed")).toHaveText(
      `Couldn’t sort again: ${DECISION_FAILURE}`,
    );
    const reportsSection = library.getByTestId("library-section").filter({
      has: library.page().getByTestId("library-section-name").filter({ hasText: "Reports" }),
    });
    if ((await reportsSection.getByTestId("library-show-all").count()) > 0)
      await pointAndClick(window, reportsSection.getByTestId("library-show-all"));
    const noteInReports = reportsSection.getByTestId("library-document").filter({
      has: window.getByRole("button", { name: "Note 1", exact: true }),
    });
    await expect(noteInReports.getByTestId("library-sort-failed")).toHaveText(
      `Couldn’t sort again: ${DECISION_FAILURE}`,
    );
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
    await expect(noteRow.getByTestId("library-sort-failed")).toHaveText(
      `未能再次整理：${DECISION_FAILURE}`,
    );
    await shoot("organize-outcome-zh-900-sort-failed");
    await setWindowSize(app, window, 1600, 900);
    await shoot("organize-outcome-zh-1600-sort-failed");
    await setLanguage(window, "en");
    await pointAt(window, noteRow);
    await pointAndClick(window, noteRow.getByTestId("document-file-menu"));
    await pointAndClick(window, window.getByTestId("document.reject"));
    // Settled by the renderer itself: the row, its reason and the re-run's line leave as the click
    // returns, before the core's list is read again.
    expect(await review.getByTestId("library-review-document").count()).toBe(0);
    expect(await window.getByTestId("library-not-sorted-count").count()).toBe(0);
    expect(await library.getByTestId("library-sort-failed").count()).toBe(0);
    expect(await looseNow.getByTestId("library-organize-failed").count()).toBe(0);
    expect(await looseNow.getByTestId("library-not-sorted").count()).toBe(0);
    await expect(window.getByTestId("undo-line")).toContainText("Kept “Note 1” out of Reports");
    await expect(window.getByTestId("library-not-sorted-count")).toHaveCount(0);
    await expect(library.getByTestId("library-review-unsorted")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);
    const noteNow = async () =>
      (await coreOf(window)).evaluate(async (core) => {
        const note = (await core.listDocuments()).find((each) => each.name === "Note 1");
        const { assignments, groups } = await core.getLibrary();
        const held = assignments.find((each) => each.documentId === note?.id) ?? null;
        return {
          held,
          tagging: note?.tagging ?? null,
          folder: groups.find((each) => each.id === held?.groupId)?.name ?? null,
        };
      });
    expect(await noteNow()).toMatchObject({
      held: { groupId: null, suggested: false, status: "classified", error: null },
      tagging: "tagged",
    });
    await expect(window.getByTestId("tagging-failed")).toHaveCount(0);
    // ⌘Z puts the Suggested Folder back as the failed re-run left it: reported, with Try again, and
    // still not one Organize couldn't sort, which takes no Folder. ⇧⌘Z turns it down again.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(noteRow).toHaveCount(1);
    await expect(noteRow.getByTestId("library-sort-failed")).toHaveText(
      `Couldn’t sort again: ${DECISION_FAILURE}`,
    );
    await expect(looseNow.getByTestId("library-organize-failed")).toContainText(
      "Organize couldn’t sort 1 Document",
    );
    await expect(library.getByTestId("library-not-sorted-count")).toHaveCount(0);
    await expect(library.getByTestId("library-review-unsorted")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText(
      "19 · 1 suggested",
    );
    expect(await noteNow()).toMatchObject({
      folder: "Reports",
      held: {
        suggested: true,
        status: "failed",
        error: { kind: "provider", message: DECISION_FAILURE },
      },
    });
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(noteRow).toHaveCount(0);
    await expect(library.getByTestId("library-sort-failed")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-organize-failed")).toHaveCount(0);
    await expect(window.getByTestId("library-not-sorted-count")).toHaveCount(0);
    await expect(looseNow.getByTestId("library-not-sorted")).toHaveCount(0);
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText("18");
    expect(await noteNow()).toMatchObject({
      held: { groupId: null, suggested: false, status: "classified", error: null },
    });
    failing = false;
  } finally {
    server.close();
    await app.close();
  }
});

test("deleting the last Document Organize couldn't sort leaves no Review behind, and Undo brings it back", async () => {
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
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("2 not sorted", {
      timeout: 60_000,
    });
    // Only Organize's failures keep To review: the Invoice's suggested Folder is accepted.
    await pointAndClick(window, reviewOf(window).getByTestId("library-review-accept-all"));
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("2 not sorted");

    const loose = section(library, "not-in-a-folder");
    const rowNamed = (name: string) =>
      loose.getByTestId("library-document").filter({
        has: window.getByRole("button", { name, exact: true }),
      });
    const deleteRow = async (name: string) => {
      await pointAndClick(window, rowNamed(name).getByTestId("document-file-menu"));
      await pointAndClick(window, window.getByTestId("document.delete"));
    };

    await deleteRow("Note 1");
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("1 not sorted");
    await expect(reviewOf(window)).toHaveAttribute("data-count", "1");
    await deleteRow("Note 2");
    // The last failure is gone: every line goes with it, including ⌘K's Show To review.
    await expect(library.getByTestId("library-not-sorted-count")).toHaveCount(0);
    await expect(reviewOf(window)).toHaveCount(0);
    await expect(loose.getByTestId("library-organize-failed")).toHaveCount(0);
    await expect(library.getByTestId("library-sorted")).toHaveText("All sorted");
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("review");
    await expect(
      window.getByTestId("palette").locator('[data-key="command:library.review"]'),
    ).toHaveCount(0);
    await window.keyboard.press("Escape");

    // The same at 900 px in Chinese, then Undo twice: each Document brings its state back.
    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 760);
    await expect(library.getByTestId("library-sorted")).toHaveText("已全部整理");
    await window.keyboard.press("ControlOrMeta+k");
    await window.keyboard.type("待确认");
    await expect(
      window.getByTestId("palette").locator('[data-key="command:library.review"]'),
    ).toHaveCount(0);
    await window.keyboard.press("Escape");
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("1 个未整理");
    await expect(reviewOf(window)).toHaveAttribute("data-count", "1");
    await expect(library.getByTestId("library-review-not-sorted")).toHaveText("查看");
    await expect(loose.getByTestId("library-not-sorted").first()).toHaveText(
      `未能整理：${DECISION_FAILURE}`,
    );
    await window.keyboard.press("ControlOrMeta+z");
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("2 个未整理");
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    await expect(loose.getByTestId("library-not-sorted")).toHaveCount(2);
  } finally {
    server.close();
    await app.close();
  }
});
