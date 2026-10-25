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
  pointAndClick,
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

/** A section of the Library page by its key, which the language never changes: a Folder's id, or not-in-a-folder. */
const section = (library: Locator, key: string) =>
  library.locator(`[data-testid="library-section"][data-section="${key}"]`);

/** 20 invoices for Finance, 17 reports for Reports, and three the fake tagger refuses. */
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

/** The Library page back at its head, where the title line shows. */
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

    // The title line says what is left, not that sorting is done, and Review goes to it.
    await expect(library.getByTestId("library-not-sorted-count")).toHaveText("3 not sorted");
    await expect(library.getByTestId("library-review-not-sorted")).toHaveText("Review");
    await expect(library.getByTestId("library-sorted")).toHaveCount(0);
    // A Folder's count says how many of its Documents are only suggested.
    await expect(sidebarFolder(window, "Finance").getByTestId("browse-count")).toHaveText(
      "20 · 20 suggested",
    );
    await expect(sidebarFolder(window, "Reports").getByTestId("browse-count")).toHaveText(
      "17 · 17 suggested",
    );

    // To review holds what waits, then what Organize couldn't sort, with the same reason.
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

    // Accept all leaves the three it couldn't sort, and the title line says so.
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
  } finally {
    server.close();
    await app.close();
  }
});
