import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, Document as CoreDocument } from "../src/core/api";
import {
  addDocuments,
  capture,
  createDataFolder,
  dismissChatSetup,
  film,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * Use the Document's wording (#2605): a Citation whose quote differs from the page only in the
 * kind of its quotation marks offers, under the two texts, the page's own words. One click puts
 * them in the sentence, marks the Citation found (a text match), shows the Undo line, and checks
 * the sentence again, so the verdict is the check's. One Undo brings the sentence back exactly.
 * Set INCARNAMIND_SCREENSHOTS and INCARNAMIND_RECORDING to folders to keep the pictures and film.
 */
const POLICY = "# Policy\n\nSection 4: the vendor’s “soft weight” rule applies to 4 orders.\n";
const SENTENCE = "The policy says “the vendor’s ‘soft weight’ rule applies to 4 orders”";
const WORDS = "the vendor’s ‘soft weight’ rule applies to 4 orders";
const PAGE = "the vendor’s “soft weight” rule applies to 4 orders";
const WITH_PAGE_MARKS = "The policy says “the vendor’s “soft weight” rule applies to 4 orders”";

const LANGUAGES = {
  en: {
    action: "Use the Document’s wording",
    used: "Used the Document’s wording",
    undo: "Undo",
    inAnswer: "In the Answer",
  },
  "zh-CN": {
    action: "改用文档原文",
    used: "已改用文档原文",
    undo: "撤销",
    inAnswer: "回答中",
  },
} as const;

/** The sentence's check, as an Answer added to a note leaves it: not checked yet. */
const CLAIM = {
  id: "claim-one",
  request: "request-one",
  action: "check-against-documents",
  state: "not-checked",
  reason: "failed",
  detail: null,
  providerId: "ollama",
  modelId: "local-model",
  text: SENTENCE,
  evidence: null,
  says: null,
  unsupported: null,
  calculation: null,
  citedCaseUnchecked: false,
  citedCaseFound: false,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-01-01T00:00:00.000Z",
};

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

/** A note whose one sentence quotes the page with the other kind of marks inside. */
async function noteQuotingPolicy(
  window: Page,
): Promise<{ line: Locator; documentId: string | undefined }> {
  await writeFile(join(sources, "Policy.md"), POLICY);
  await addDocuments(window, [join(sources, "Policy.md")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const policy = documents.find((each: CoreDocument) => each.name === "Policy");
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: SENTENCE,
            marks: [{ type: "claimCheck", attrs: CLAIM }],
          },
          {
            type: "citation",
            attrs: {
              passageId: "passage-1",
              documentId: policy?.id,
              documentName: "Policy",
              contentHash: policy?.contentHash,
              pageFrom: 1,
              pageTo: 1,
              location: null,
              quote: PAGE,
              check: "not-found",
              checkReason: "quoted-words-not-on-pages",
              quotedWords: {
                answer: [{ text: WORDS, found: false }],
                closest: [
                  { text: "Section 4: ", found: false },
                  { text: PAGE, found: true },
                  { text: ".", found: false },
                ],
                documentWording: PAGE,
              },
            },
          },
        ],
      },
    ],
  );
  const line = editor.locator(":scope > p").first();
  await expect(line.getByTestId("citation")).toHaveAttribute("data-check", "not-found");
  return { line, documentId: policy?.id };
}

/** The words of a line, without its Citations' markers. */
const wordsOf = (line: Locator) =>
  line.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const citation of copy.querySelectorAll('[data-testid="citation"]')) citation.remove();
    return (copy.textContent ?? "").trim();
  });

/** Records every state the sentence's mark showed, so a Checking… between verdicts is seen, not timed. */
function watchMark(window: Page): Promise<void> {
  return window.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { markStates?: string[] }).markStates = seen;
    const record = () => {
      const mark = document.querySelector('[data-testid="claim-mark"]');
      const state = mark?.getAttribute("data-check");
      if (state && !seen.includes(state)) seen.push(state);
    };
    record();
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-check"],
    });
  });
}

const markStates = (window: Page) =>
  window.evaluate(() => (window as unknown as { markStates: string[] }).markStates);

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];
  for (const width of [1600, 1100]) {
    test(`a quote that differs only in its marks offers the page's words under both texts, and its one click, Undo and check work (${language}, ${width}px)`, async () => {
      test.setTimeout(180_000);
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await setWindowSize(app, window, width, 900);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      const { line, documentId } = await noteQuotingPolicy(window);

      const citation = line.getByTestId("citation");
      await pointAndClick(window, citation.getByTestId("citation-chip"));
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await motionSettled(window);
      // The two texts: the Answer's words, and the page's nearest.
      const inAnswer = card.getByTestId("citation-answer-words");
      await expect(inAnswer).toContainText(words.inAnswer);
      await expect(inAnswer.locator("blockquote")).toContainText("‘soft weight’");
      await expect(card.getByTestId("citation-closest-words")).toBeVisible();
      // One action, under both texts, inside the card and the window.
      const action = card.getByTestId("citation-use-document-wording");
      await expect(action).toHaveText(words.action);
      const [actionBox, closestBox, cardBox] = await Promise.all([
        action.boundingBox(),
        card.getByTestId("citation-closest-words").boundingBox(),
        card.boundingBox(),
      ]);
      expect(actionBox && closestBox && actionBox.y >= closestBox.y).toBe(true);
      expect(cardBox && cardBox.x >= 0 && cardBox.x + cardBox.width <= width).toBe(true);
      await capture(window, `document-wording-card-${language}-${width}`);

      await watchMark(window);
      const clicked = async () => {
        await pointAndClick(window, action);
        // The Citation is found by the text match; the sentence has the page's marks.
        await expect(citation).toHaveAttribute("data-check", "found");
        await expect.poll(() => wordsOf(line)).toBe(WITH_PAGE_MARKS);
        // The undo line says what was done, with Undo.
        const undoLine = window.getByTestId("undo-line");
        await expect(undoLine.getByTestId("undo-message")).toHaveText(words.used);
        await expect(undoLine.getByTestId("undo-action")).toHaveText(words.undo);
      };
      if (language === "en" && width === 1600) await film(window, clicked);
      else await clicked();
      // The sentence was checked again: it showed Checking… and took the check's verdict.
      await expect.poll(() => markStates(window)).toContain("checking");
      await expect.poll(() => markStates(window)).toContain("supported");
      await motionSettled(window);
      await capture(window, `document-wording-done-${language}-${width}`);

      // One Undo brings the sentence and its Citation back exactly.
      await pointAndClick(window, window.getByTestId("undo-action"));
      await expect.poll(() => wordsOf(line)).toBe(SENTENCE);
      await expect(citation).toHaveAttribute("data-check", "not-found");
      await expect(citation).toHaveAttribute("data-reason", "quoted-words-not-on-pages");

      // A Document removed after that: the card can't check it, and offers no wording.
      if (language === "en" && width === 1600) {
        await window.evaluate(async (id) => {
          if (!id) return;
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.deleteDocument(id);
        }, documentId);
        await expect(citation).toHaveAttribute("data-check", "cant-check");
        await citation.getByTestId("citation-chip").focus();
        await expect(card).toBeVisible();
        await expect(card.getByTestId("citation-use-document-wording")).toHaveCount(0);
        await expect(card.getByTestId("citation-closest-words")).toHaveCount(0);
      }
    });
  }
}

test("the action is reachable by the keyboard, and Enter takes it", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  const { line } = await noteQuotingPolicy(window);
  const citation = line.getByTestId("citation");
  await pointAndClick(window, citation.getByTestId("citation-chip"));
  const card = window.getByTestId("citation-card");
  const action = card.getByTestId("citation-use-document-wording");
  await expect(action).toBeVisible();
  // Space on the marker goes into the open card, and Enter presses the action.
  await citation.getByTestId("citation-chip").focus();
  await window.keyboard.press("Space");
  await expect(action).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect.poll(() => wordsOf(line)).toBe(WITH_PAGE_MARKS);
});
