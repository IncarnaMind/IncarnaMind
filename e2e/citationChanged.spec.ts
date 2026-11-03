import { mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CitationLocation, CoreBridge } from "../src/core/api";
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
 * the old; where the words at its place changed, the card shows them as they
 * changed. Where the text at the Location is unchanged, it says so, and is
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

/** The fixed past days each version was made, so the viewer's and the card's dates are asserted literally. */
const MADE_A = new Date("2026-10-20T12:00:00Z");
const CHANGED_B = new Date("2026-10-21T12:00:00Z");
const CHANGED_C = new Date("2026-10-22T12:00:00Z");
const CHANGED_D = new Date("2026-10-23T12:00:00Z");

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

/** When the file at `path` was last changed, as the indexed Document has it, through the core's bridge. */
const modifiedAtOf = (window: Page, path: string) =>
  window.evaluate(async (wanted) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listDocuments()).find((each) => each.path === wanted)?.modifiedAt ?? null;
  }, path);

/** Writes a version of the file, dates it as changed that day, and waits until it is indexed. */
async function writeVersion(
  window: Page,
  path: string,
  text: string,
  moment: Date,
  before: string,
): Promise<string> {
  await writeFile(path, text);
  await utimes(path, moment, moment);
  await expect.poll(() => contentHashOf(window, path), { timeout: 15_000 }).not.toBe(before);
  await expect
    .poll(
      async () => {
        const at = await modifiedAtOf(window, path);
        return at === null ? null : new Date(at).getTime();
      },
      { timeout: 15_000 },
    )
    .toBe(moment.getTime());
  const after = await contentHashOf(window, path);
  if (after === undefined) throw new Error("The new version isn't indexed.");
  return after;
}

/**
 * Waits until the page of the Answer's first Citation is saved (#133), which the
 * cited version shows: its picture is drawn in the background after the Answer.
 */
async function waitForSavedPage(window: Page, answer: Locator): Promise<void> {
  const [place] = await answer.getByTestId("assistant-answer-text").evaluate((dom) => {
    const found: {
      documentId: string | null;
      contentHash: string | null;
      pageFrom: number | null;
      pageTo: number | null;
      location: CitationLocation | null;
    }[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (found.length > 0 || node.type.name !== "citation") return;
      const { documentId, contentHash, pageFrom, pageTo, location } = node.attrs;
      found.push({
        documentId: typeof documentId === "string" ? documentId : null,
        contentHash: typeof contentHash === "string" ? contentHash : null,
        pageFrom: typeof pageFrom === "number" ? pageFrom : null,
        pageTo: typeof pageTo === "number" ? pageTo : null,
        location: typeof location === "object" ? location : null,
      });
    });
    return found;
  });
  if (!place) throw new Error("The Citation has no place.");
  const { documentId, contentHash, pageFrom, pageTo, location } = place;
  if (!documentId || !contentHash) throw new Error("The Citation has no place.");
  await expect
    .poll(
      () =>
        window.evaluate(
          async (input) => {
            const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            return (await bridge.readCitedPage(input)) !== null;
          },
          { documentId, contentHash, pageFrom, pageTo, location },
        ),
      { timeout: 60_000, message: "the cited page is saved" },
    )
    .toBe(true);
}

/** The version each Citation of the Answer stores: what it quotes. */
const storedVersions = (answer: Locator) =>
  answer.getByTestId("assistant-answer-text").evaluate((dom) => {
    const versions: string[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name === "citation" && typeof node.attrs.contentHash === "string") {
        versions.push(node.attrs.contentHash);
      }
    });
    return versions;
  });

test("a Citation's card says its Document changed, and its viewer opens the version it was made from", async () => {
  const library = join(sources, "Library");
  await mkdir(library, { recursive: true });
  const note = join(library, "Versioned note.md");
  await writeFile(note, VERSION_A);
  await utimes(note, MADE_A, MADE_A);
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
    const [citedVersion] = cited;
    if (citedVersion === undefined) throw new Error("The Citation stores no version.");
    await waitForSavedPage(window, answer);

    const card = window.getByTestId("citation-card");
    const changed = window.getByTestId("citation-changed");
    const changedQuote = window.getByTestId("citation-changed-quote");
    const changedDate = window.getByTestId("citation-changed-date");
    const changedWords = window.getByTestId("citation-changed-words");
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
    const versionB = await writeVersion(window, note, VERSION_B, CHANGED_B, citedVersion);
    expect(await storedVersions(answer)).toEqual(cited);

    // The open viewer shows the version the Citation was made from, marked as cited (#2159):
    // the page saved then, so how it looked, with its quote washed where it stood.
    await expect(notice).toHaveCount(0);
    const citedView = viewer.getByTestId("viewer-cited");
    const asCited = viewer.getByTestId("viewer-as-cited");
    const says = viewer.getByTestId("viewer-cited-says");
    await expect(asCited).toContainText("As cited, 20 Oct 2026");
    await expect(viewer.getByTestId("viewer-cited-page")).toBeVisible();
    await expect(viewer.getByTestId("viewer-cited-text-only")).toHaveCount(0);
    await expect(citedView.locator("[data-quote-highlight]").first()).toBeVisible();
    await expect(says).toContainText("Version A: the approved refurbishment budget is GBP 80,000.");
    await expect(says).not.toContainText("GBP 65,000");
    await screenshot(window, "viewer-as-cited-en");

    // Its one action opens the current version, at the same place, which still says the Document changed.
    await viewer.getByTestId("viewer-open-current").click();
    await expect(asCited).toHaveCount(0);
    await expect(notice).toContainText("The Document changed after this was cited.");
    await expect(viewer.getByTestId("viewer-text")).toContainText("GBP 65,000");
    await expect(viewer.locator("[data-quote-highlight]")).toHaveCount(0);
    await screenshot(window, "viewer-current-en");

    // The card names the day and shows the cited words as they changed; its Open opens the cited version again.
    await showCard();
    await expect(changedDate).toHaveText("This Document changed on 21 Oct 2026.");
    await expect(changed).toContainText("The cited words changed in the new version:");
    await expect(changedWords.locator("del")).toHaveText(["A", "80,000"]);
    await expect(changedWords.locator("ins")).toHaveText(["B", "65,000"]);
    await screenshot(window, "card-after-en");
    await card.getByTestId("citation-open").click();
    await expect(card).toHaveCount(0);
    await expect(asCited).toContainText("As cited, 20 Oct 2026");
    await expect(viewer.getByTestId("viewer-cited-says")).toContainText("GBP 80,000");

    // In Chinese, both say it too.
    await setLanguage(window, "zh-CN");
    await expect(asCited).toContainText("引用时，2026年10月20日");
    await expect(viewer.getByTestId("viewer-cited-page")).toBeVisible();
    await expect(viewer.getByTestId("viewer-cited-text-only")).toHaveCount(0);
    await expect(viewer.getByTestId("viewer-cited-says")).toContainText("GBP 80,000");
    await showCard();
    await expect(changedDate).toHaveText("此文档已于 2026年10月21日 更新。");
    await expect(changed).toContainText("引文在新版本中有改动：");
    await expect(changedWords.locator("ins")).toHaveText(["B", "65,000"]);
    await screenshot(window, "card-after-zh");
    await hideCard();
    await screenshot(window, "viewer-as-cited-zh");
    await setLanguage(window, "en");
    await showCard();

    const versionC = await writeVersion(window, note, VERSION_C, CHANGED_C, versionB);
    await showCard();
    await expect(changedDate).toHaveText("This Document changed on 22 Oct 2026.");
    await expect(changedWords.locator("ins")).toHaveText(["B", "65,000"]);
    await expect(changedQuote).toHaveCount(0);
    await card.getByTestId("citation-open").click();
    await expect(asCited).toContainText("As cited, 20 Oct 2026");
    await expect(citedView.locator("[data-quote-highlight]").first()).toBeVisible();
    await expect(viewer.getByTestId("viewer-cited-says")).toContainText("GBP 80,000");
    await expect(viewer.getByTestId("viewer-cited-says")).not.toContainText("GBP 65,000");

    // The card holds at a narrow window.
    await setWindowSize(app, window, 980, 820);
    await showCard();
    await expect(changedWords.locator("ins")).toHaveText(["B", "65,000"]);
    await screenshot(window, "card-narrow-en");
    // A merged window shows the Mind's group: bring the Document's tab to the front.
    await window.getByRole("tab", { name: "Versioned note" }).click();
    await expect(citedView).toBeVisible();

    // The quoted line back at its Location, with only another line changed: the card says the
    // quote is still here, and the current version, opened from the bar, shows it where it was.
    await writeVersion(window, note, VERSION_D, CHANGED_D, versionC);
    await expect(asCited).toContainText("As cited, 20 Oct 2026");
    await expect(viewer.getByTestId("viewer-cited-says")).toContainText("GBP 80,000");
    await showCard();
    await expect(changedDate).toHaveText("This Document changed on 23 Oct 2026.");
    await expect(changed).toContainText("The Document changed after this was cited.");
    await expect(changedQuote).toHaveText("The quote is still here.");
    await screenshot(window, "card-still-here-en");
    await hideCard();
    await viewer.getByTestId("viewer-open-current").click();
    await expect(viewer.getByTestId("viewer-text")).toContainText("Reviewed on 1 November 2026");
    await expect(viewer.getByTestId("viewer-citation-changed")).toContainText(
      "The quote is still here.",
    );
    await expect(viewer.locator("[data-quote-highlight]")).toHaveText(
      "Version A: the approved refurbishment budget is GBP 80,000.",
    );
    await screenshot(window, "viewer-current-still-here-en");
  } finally {
    await app.close();
  }
});
