import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  linkFolderFromSidebar,
  motionSettled,
  newMind,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A Citation made before its Document changed (#99, first slice): its card and
 * the viewer that opens from it say the Document changed after it was cited,
 * and look for its quote in the new version without presenting the new text as
 * the old. Where the text at the Location is unchanged, it says so, and is
 * never silent about the change.
 */

const VERSION_A = [
  "# Versioned source",
  "",
  "Version A: the approved refurbishment budget is GBP 80,000.",
  "",
  "Approved on 14 October 2026.",
  "",
].join("\n");

const VERSION_B = [
  "# Versioned source",
  "",
  "Version B: the approved refurbishment budget is GBP 65,000.",
  "",
  "Approved on 21 October 2026.",
  "",
  "This supersedes Version A.",
  "",
].join("\n");

/** The quoted line, unchanged, under another heading. */
const VERSION_C = [
  "# Versioned source",
  "",
  "Version B: the approved refurbishment budget is GBP 65,000.",
  "",
  "# Budget",
  "",
  "Version A: the approved refurbishment budget is GBP 80,000.",
  "",
].join("\n");

/** The quoted line back at its Location, with only another line changed. */
const VERSION_D = [
  "# Versioned source",
  "",
  "Version A: the approved refurbishment budget is GBP 80,000.",
  "",
  "Approved on 14 October 2026.",
  "",
  "Reviewed on 1 November 2026.",
  "",
].join("\n");

const QUESTION = "What refurbishment budget was approved, and when?";

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** The version of the Document at `path` that is indexed, through the core's bridge. */
const contentHashOf = (window: Page, path: string) =>
  window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).find((each) => each.path === wanted)?.contentHash;
  }, path);

/** The version each Citation of the Answer stores: what it quotes. */
const storedVersions = (answer: Locator) =>
  answer.getByTestId("assistant-answer-text").evaluate((dom) => {
    const versions: (string | null)[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name === "citation") versions.push(node.attrs.contentHash);
    });
    return versions;
  });

test("a Citation's card and viewer say its Document changed, and its quote is looked for in the new version", async () => {
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  const note = join(library, "Versioned note.md");
  await writeFile(note, VERSION_A);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  try {
    await linkFolderFromSidebar(app, window, library);
    await expectReadyDocuments(window, 1);
    await newMind(window);
    await pointAndClick(window, window.getByTestId("mind-editor"));

    const answer = await askInAssistant(window, QUESTION);
    const chip = answer.getByTestId("citation-chip");
    await expect(chip).toHaveAttribute("data-check", "found");
    const cited = await storedVersions(answer);
    expect(cited).toEqual([await contentHashOf(window, note)]);

    const card = window.getByTestId("citation-card");
    const changed = window.getByTestId("citation-changed");
    const changedQuote = window.getByTestId("citation-changed-quote");
    const hideCard = async () => {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    };
    const showCard = async () => {
      if ((await card.count()) > 0) await hideCard();
      await window.mouse.move(0, 0);
      await pointAt(window, chip);
      await expect(card).toBeVisible();
    };

    // Before the Document changes, the card says nothing about a change, and its Open shows the quote.
    await showCard();
    await expect(card.getByTestId("citation-badge")).toContainText("§ Versioned source");
    await expect(changed).toHaveCount(0);
    await screenshot(window, "card-before-en");
    await card.getByTestId("citation-open").click();
    await expect(card).toHaveCount(0);
    const viewer = window.getByTestId("viewer");
    const notice = viewer.getByTestId("viewer-citation-changed");
    await expect(notice).toHaveCount(0);
    await expect(viewer.locator("[data-quote-highlight]")).toHaveText(
      "Version A: the approved refurbishment budget is GBP 80,000.",
    );
    await screenshot(window, "viewer-before-en");

    // The same file on disk, edited: indexed again as a new version. The Citation keeps the one it quotes.
    await writeFile(note, VERSION_B);
    await expect.poll(() => contentHashOf(window, note), { timeout: 15_000 }).not.toBe(cited[0]);
    const versionB = await contentHashOf(window, note);
    expect(await storedVersions(answer)).toEqual(cited);

    // The open viewer says so, never showing the new text as the old.
    await expect(notice).toContainText("The Document changed after this was cited.");
    await expect(notice).toContainText("Its quote is no longer in the new version.");
    await expect(viewer.getByTestId("viewer-text")).toContainText("GBP 65,000");
    await expect(viewer.locator("[data-quote-highlight]")).toHaveCount(0);
    await screenshot(window, "viewer-after-en");

    // The card says the same, and its Open says it too.
    await showCard();
    await expect(changed).toContainText("The Document changed after this was cited.");
    await expect(changedQuote).toHaveText("Its quote is no longer in the new version.");
    await screenshot(window, "card-after-en");
    await card.getByTestId("citation-open").click();
    await expect(card).toHaveCount(0);
    await expect(notice).toContainText("Its quote is no longer in the new version.");

    // In Chinese, both say it too.
    await setLanguage(window, "zh-CN");
    await expect(notice).toContainText("此文档在被引用后有改动。新版本中已找不到这条引文。");
    await showCard();
    await expect(changed).toContainText("此文档在被引用后有改动。");
    await expect(changedQuote).toHaveText("新版本中已找不到这条引文。");
    await screenshot(window, "card-after-zh");
    await hideCard();
    await screenshot(window, "viewer-after-zh");
    await setLanguage(window, "en");
    await showCard();

    // The quoted line, unchanged, now under another heading: found, and the card says where.
    await writeFile(note, VERSION_C);
    await expect.poll(() => contentHashOf(window, note), { timeout: 15_000 }).not.toBe(versionB);
    await showCard();
    await expect(changed).toContainText("The Document changed after this was cited.");
    await expect(changedQuote).toHaveText("Its quote is now at § Budget.");
    await card.getByTestId("citation-open").click();
    await expect(notice).toContainText("Its quote is now at § Budget.");
    const washed = viewer.locator("[data-quote-highlight]");
    await expect(washed).toHaveText("Version A: the approved refurbishment budget is GBP 80,000.");

    // The card holds at a narrow window.
    await setWindowSize(app, window, 980, 820);
    await showCard();
    await expect(changedQuote).toHaveText("Its quote is now at § Budget.");
    await screenshot(window, "card-narrow-en");
    const versionC = await contentHashOf(window, note);
    // A merged window shows the Mind's group: bring the Document's tab to the front.
    await window.getByRole("tab", { name: "Versioned note" }).click();
    await expect(viewer.getByTestId("viewer-text")).toBeVisible();

    // The quoted line back at its Location, with only another line changed: the Document
    // changed, so both still say it, and the quote is still where it was.
    await writeFile(note, VERSION_D);
    await expect.poll(() => contentHashOf(window, note), { timeout: 15_000 }).not.toBe(versionC);
    await expect(viewer.getByTestId("viewer-text")).toContainText("Reviewed on 1 November 2026");
    await expect(viewer.locator("[data-quote-highlight]")).toHaveText(
      "Version A: the approved refurbishment budget is GBP 80,000.",
    );
    await expect(notice).toContainText(
      "The Document changed after this was cited. The quote is still here.",
    );
    await showCard();
    await expect(changed).toContainText("The Document changed after this was cited.");
    await expect(changedQuote).toHaveText("The quote is still here.");
    await screenshot(window, "card-still-here-en");
  } finally {
    await app.close();
  }
});
