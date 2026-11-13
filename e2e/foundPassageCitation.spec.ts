import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A Passage a check found that the sentence's Citation doesn't hold becomes a Citation only by the
 * User's click (#3019): the check writes nothing into the Note, the sentence shows no ✓ until the
 * Passage is among its Citations, Add as Citation on its card shows the ✓ at once, the check's
 * result line adds all of them as one Undo, and the Citation added says the check found it. The
 * scripted model (src/main/fakeChat/checks.ts) backs a sentence with the line of a Document that
 * shares the most words with it. Set INCARNAMIND_SCREENSHOTS to a folder to save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at the first and last quarter moons.";
const HARBOUR = "Harbours publish the times of high water every year.";
const TIDES = ["# Tides", "", SPRING, "", NEAP, "", HARBOUR, ""].join("\n");

const WORDS = {
  en: {
    neap: "Neap tides happen at the first and last quarter moons.",
    harbour: "Harbours publish the times of high water every year.",
    check: "Check",
    notChecked: "Not checked",
    supported: "Supported",
    add: "Add as Citation",
    line: "2 passages found, not yet cited",
    addAll: "Add all",
    found: "Found by a check of this sentence",
    hidden: "Verdict hidden: the quote that backs this sentence isn’t among its Citations.",
  },
  "zh-CN": {
    neap: "Neap tides happen at the first and last quarter moons.",
    harbour: "Harbours publish the times of high water every year.",
    check: "核对",
    notChecked: "未核对",
    supported: "有依据",
    add: "添加为引用",
    line: "找到 2 个段落，尚未引用",
    addAll: "全部添加",
    found: "核对这句话时找到",
    hidden: "不显示结论：支持这句话的引文不在它现有的引用里。",
  },
} as const;

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

/** Writes each sentence with a Citation of the Spring line, which says something else. */
async function writeNote(window: Page, sentences: readonly string[]) {
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const tides = documents.find((each) => each.name === "Tides");
  const content = sentences.map((sentence) => ({
    type: "paragraph",
    content: [
      { type: "text", text: sentence.slice(0, -1) },
      {
        type: "citation",
        attrs: {
          documentId: tides?.id,
          documentName: "Tides",
          contentHash: tides?.contentHash,
          quote: SPRING,
          check: "found",
          checkReason: null,
        },
      },
      { type: "text", text: "." },
    ],
  }));
  const editor = window.getByTestId("mind-editor");
  await editor.evaluate((dom, blocks) => {
    (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, blocks);
  }, content);
  return editor.locator(":scope > p");
}

/** The Note's text, each Citation as its quote in brackets: what a check must leave as it is. */
const noteText = (window: Page) =>
  window.getByTestId("mind-editor").evaluate((dom) => {
    const lines: string[] = [];
    (dom as unknown as { editor: Editor }).editor.state.doc.forEach((block) => {
      let line = "";
      block.forEach((node) => {
        line += node.isText ? (node.text ?? "") : `[${String(node.attrs.quote)}]`;
      });
      lines.push(line);
    });
    return lines;
  });

const marks = (window: Page) => window.getByTestId("claim-mark");

async function openCard(window: Page, mark: Locator) {
  await motionSettled(window);
  await pointAndClick(window, mark);
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  return card;
}

/** ⌘Z in the Note, its caret put back in the text first, as the User does after a card closes. */
async function undoInNote(window: Page) {
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor.locator(":scope > p").last());
  await focusSettled(window, editor);
  await window.keyboard.press("ControlOrMeta+z");
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a found Passage becomes a Citation only by the User's click, one at a time or all together, each one Undo (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.md"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    await addDocuments(window, [join(sources, "Tides.md")]);
    await newMind(window);
    const lines = await writeNote(window, [words.neap, words.harbour]);
    await expect(lines.nth(1)).toContainText("Harbours publish");
    const before = await noteText(window);

    // The check: nothing written into the Note, and no ✓ beside the Citation whose words don't say it.
    await window.getByTestId("mind-tab").first().click({ button: "right" });
    await pointAndClick(window, window.getByRole("menuitem", { name: words.check, exact: true }));
    await checkCard(window);
    await expect(marks(window)).toHaveCount(2);
    await expect(marks(window).and(window.locator('[data-check="not-checked"]'))).toHaveCount(2);
    for (const index of [0, 1])
      await expect(marks(window).nth(index)).toHaveAttribute("data-addable", "true");
    expect(await noteText(window)).toEqual(before);
    // Opened while the check ran, the card kept that height: opened again, it fits its result.
    await window.keyboard.press("Escape");
    const badgeCard = await checkCard(window);
    await expect(badgeCard.getByTestId("found-passages-line")).toContainText(words.line);
    await screenshot(window, `found-checked-${language}`);
    await window.keyboard.press("Escape");

    // One at a time: Add as Citation on the card, the ✓ at once, and Undo takes it back.
    const card = await openCard(window, marks(window).nth(0));
    await expect(card.getByTestId("claim-badge")).toHaveText(words.notChecked);
    await expect(card.getByTestId("claim-reason")).toContainText(words.hidden);
    await expect(card.getByTestId("claim-quote")).toHaveText(NEAP);
    await expect(card.getByTestId("claim-add-citation")).toHaveClass(
      /citation-card-action--primary/,
    );
    await screenshot(window, `found-card-${language}`);
    await pointAndClick(window, card.getByTestId("claim-add-citation"));
    await expect(marks(window).nth(0)).toHaveAttribute("data-check", "supported");
    await expect(lines.nth(0).getByTestId("citation")).toHaveCount(2);
    expect((await noteText(window))[0]).toBe(`${words.neap.slice(0, -1)}[${SPRING}][${NEAP}].`);
    await screenshot(window, `found-added-${language}`);

    // The Citation added says the check found it.
    await pointAndClick(window, lines.nth(0).getByTestId("citation").nth(1));
    await expect(window.getByTestId("citation-found-by-check")).toHaveText(words.found);
    await screenshot(window, `found-citation-card-${language}`);
    await window.keyboard.press("Escape");

    await undoInNote(window);
    await expect(marks(window).nth(0)).toHaveAttribute("data-check", "not-checked");
    await expect(lines.nth(0).getByTestId("citation")).toHaveCount(1);
    expect(await noteText(window)).toEqual(before);

    // All together from the check's result line: one Undo takes all of them back.
    const again = await checkCard(window);
    await pointAndClick(window, again.getByTestId("found-passages-add"));
    await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(2);
    await expect(again.getByTestId("found-passages-line")).toHaveCount(0);
    // Each before its sentence's stop, beside the Citation the writer gave it.
    expect((await noteText(window)).slice(0, 2)).toEqual([
      `${words.neap.slice(0, -1)}[${SPRING}][${NEAP}].`,
      `${words.harbour.slice(0, -1)}[${SPRING}][${HARBOUR}].`,
    ]);
    await screenshot(window, `found-all-added-${language}`);
    await window.keyboard.press("Escape");
    await undoInNote(window);
    await expect(marks(window).and(window.locator('[data-check="not-checked"]'))).toHaveCount(2);
    expect(await noteText(window)).toEqual(before);
    await app.close();
  });
}
