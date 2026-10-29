import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  addDocuments,
  checkCard,
  useLocalChatModel as chooseScriptedModel,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  keptWords,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * A sentence with no Citation that no Document backs (#1554): its card offers Cut it, which takes
 * the whole sentence out with no model, and Keep as my view, beside the ways to look again; both
 * are in ⌘K, which agrees with the card on whether Search all Documents applies; each is one step
 * of Undo. The scripted model supports a sentence that shares three words with a line it was
 * handed (src/main/fakeChat/checks.ts).
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

const OWN = "Harbours publish the times of high water every week.";
const ELSEWHERE = "Penguins nest on the harbour cliffs every spring.";
const NOTHING = "Whales sing in the deep bay.";
const ALONE = "Seals rest on the sandbanks at low tide.";

const LANGUAGES = {
  en: {
    heading: "Needs a look · Not found",
    mark: "Sentence check: Needs a look · Not found",
    needLook: "2 claims need a look",
    cut: "Cut it",
    keep: "Keep as my view",
    searchAll: "Search all Documents",
    checkDocument: "Check against a Document…",
    findSources: "Find sources…",
    findSourcesSearch: "find sources",
    findSourcesFor: "Find sources for this sentence",
    searchWeb: "Search the web",
    remove: "Remove the mark",
    cutDone: "Cut the sentence",
    kept: "Kept as your view",
  },
  "zh-CN": {
    heading: "需要留意：未找到",
    mark: "句子核对：需要留意：未找到",
    needLook: "2 条说法需要留意",
    cut: "删除这句",
    keep: "保留为我的观点",
    searchAll: "搜索全部文档",
    checkDocument: "对照指定文档核对…",
    findSources: "查找资料…",
    findSourcesSearch: "查找资料",
    findSourcesFor: "为这句话查找资料",
    searchWeb: "联网搜索",
    remove: "移除标记",
    cutDone: "已删除这句",
    kept: "已保留为你的观点",
  },
} as const;

const IDS = {
  searchAll: "claim-search-all",
  checkDocument: "claim-check-document",
  cut: "claim-cut-sentence",
  keep: "claim-keep",
  searchWeb: "claim-search-web",
  remove: "claim-remove",
  menu: "check-menu",
  findSources: "check.findSources",
} as const;

/** The card's actions, in the order they are drawn; Find sources waits in its ⋯. */
const ORDER = [IDS.searchAll, IDS.checkDocument, IDS.cut, IDS.keep, IDS.searchWeb, IDS.remove];

/** Whether the first box sits inside the second. */
const inside = async (inner: Locator, outer: Locator) => {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  if (!a || !b) return false;
  return (
    a.x >= b.x - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y >= b.y - 1 &&
    a.y + a.height <= b.y + b.height + 1
  );
};

const wordsOf = (line: Locator) => line.evaluate((element) => (element.textContent ?? "").trim());

/** The Mind's cursor, as a position in its document. */
const cursorOf = (editor: Locator) =>
  editor.evaluate((dom) => (dom as unknown as { editor: Editor }).editor.state.selection.from);

/** Puts the cursor inside some of the Mind's words, as a click there would. */
const cursorIn = (editor: Locator, words: string) =>
  editor.evaluate((dom, wanted) => {
    const note = (dom as unknown as { editor: Editor }).editor;
    let at = -1;
    note.state.doc.descendants((node, pos) => {
      const index = node.isText ? (node.text?.indexOf(wanted) ?? -1) : -1;
      if (at < 0 && index >= 0) at = pos + index + 1;
    });
    note.chain().focus().setTextSelection(at).run();
  }, words);

/** Two Documents, a Mind of these paragraphs, checked, and the Mind looking in only one of them. */
async function launchedWithMind(
  paragraphs: readonly string[],
  firstWords: string,
  language: "en" | "zh-CN",
  width = 1440,
) {
  await writeFile(join(sources, "Harbour times.txt"), `${OWN}\n`);
  await writeFile(join(sources, "Seabirds.txt"), `${ELSEWHERE}\n`);
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
  await dismissChatSetup(window);
  await chooseScriptedModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(window, [join(sources, "Harbour times.txt"), join(sources, "Seabirds.txt")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, text] of paragraphs.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(text);
  }
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("@Harbour");
  await expect(window.getByTestId("scope-picker")).toBeVisible();
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("composer").getByTestId("scope-chip")).toHaveText(
    "Harbour times",
  );
  const lines = editor.locator(":scope > p");
  await slideSelect(window, lines.nth(0), firstWords, {
    line: lines.nth(paragraphs.length - 1),
    words: "tide.",
  });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
  const marks = window.getByTestId("claim-mark");
  const card = window.getByTestId("claim-card");
  const openCard = async (mark: Locator) => {
    await motionSettled(window);
    await pointAndClick(window, mark);
    await expect(card).toBeVisible();
  };
  const claimIds = () =>
    marks.evaluateAll((all) => all.map((each) => each.getAttribute("data-claim")));
  return { app, window, editor, lines, marks, card, openCard, claimIds };
}

async function launchedWithFourSentences(language: "en" | "zh-CN", width = 1440) {
  const mind = await launchedWithMind(
    [`${OWN} ${ELSEWHERE} ${NOTHING}`, ALONE],
    "Harbours publish",
    language,
    width,
  );
  const { marks } = mind;
  await expect(marks).toHaveCount(4);
  await expect(marks.nth(0)).toHaveAttribute("data-check", "supported");
  for (const index of [1, 2, 3]) {
    await expect(marks.nth(index)).toHaveAttribute("data-check", "unsupported");
  }
  return mind;
}

/** The first paragraph as the Mind holds it: its text, and a footnote as "[its words]". */
const paragraphOf = (editor: Locator) =>
  editor.evaluate((dom) => {
    let text = "";
    (dom as unknown as { editor: Editor }).editor.state.doc.child(0).forEach((child) => {
      text += child.isText ? (child.text ?? "") : `[${child.textContent}]`;
    });
    return text;
  });

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

  test(`a sentence nothing backs and that cites nothing: Cut it takes it out, Keep as my view keeps it, each with Undo, from its card and from ⌘K (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window, editor, lines, marks, card, openCard, claimIds } =
      await launchedWithFourSentences(language);
    const undoLine = window.getByTestId("undo-line");
    const undo = async () => {
      await focusSettled(window, editor);
      await window.keyboard.press("ControlOrMeta+z");
    };
    const allFour = `${OWN} ${ELSEWHERE} ${NOTHING}`;
    const ids = await claimIds();

    // The card: where it looked, then the actions in their order, each inside it at both widths.
    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 900);
      await openCard(marks.nth(2));
      // Headed by what the check found: nothing, which is about the search, not the sentence (#1608).
      await expect(marks.nth(2)).toHaveAccessibleName(words.mark);
      await expect(card.getByTestId("claim-badge")).toHaveText(words.heading);
      if (SCREENSHOTS) {
        await motionSettled(window);
        await window.screenshot({ path: join(SCREENSHOTS, `not-found-${language}-${width}.png`) });
      }
      const shown = await card
        .locator(".citation-card-actions button")
        .evaluateAll((all) => all.map((each) => each.getAttribute("data-testid")));
      expect(shown).toEqual(ORDER);
      await expect(card.getByTestId(IDS.searchAll)).toHaveText(words.searchAll);
      await expect(card.getByTestId(IDS.checkDocument)).toHaveText(words.checkDocument);
      await expect(card.getByTestId(IDS.cut)).toHaveText(words.cut);
      await expect(card.getByTestId(IDS.keep)).toHaveText(words.keep);
      await expect(card.getByTestId(IDS.searchWeb)).toHaveText(words.searchWeb);
      await expect(card.getByTestId(IDS.remove)).toHaveText(words.remove);
      await expect(card.getByTestId(IDS.cut)).not.toHaveClass(/citation-card-action--primary/);
      await expect(card.getByTestId("claim-cut")).toHaveCount(0);
      for (const id of ORDER) expect(await inside(card.getByTestId(id), card)).toBe(true);
      // Find sources waits in the card's ⋯, with no button: the Mind cites no paper or book.
      await expect(card.getByTestId("claim-find-sources")).toHaveCount(0);
      await expect(card.getByTestId(IDS.findSources)).not.toBeVisible();
      await pointAndClick(window, card.getByTestId(IDS.menu));
      await expect(card.getByTestId(IDS.findSources)).toHaveText(words.findSources);
      await expect(card.getByTestId(IDS.findSources)).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(card.getByTestId(IDS.findSources)).not.toBeVisible();
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    }
    await setWindowSize(app, window, 1440, 900);

    // Cut it: the sentence goes at once with the space that kept it from its neighbour, the card
    // closes, the Mind keeps the focus, and one ⌘Z brings back the words, the mark and the cursor.
    await clickEndOf(window, lines.nth(1));
    const cursor = await cursorOf(editor);
    await openCard(marks.nth(2));
    await pointAndClick(window, card.getByTestId(IDS.cut));
    await expect.poll(() => wordsOf(lines.nth(0))).toBe(`${OWN} ${ELSEWHERE}`);
    await expect(marks).toHaveCount(3);
    await expect(card).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(undoLine).toContainText(words.cutDone);
    await undo();
    await expect.poll(() => wordsOf(lines.nth(0))).toBe(allFour);
    await expect(marks).toHaveCount(4);
    expect(await claimIds()).toEqual(ids);
    await expect(marks.nth(2)).toHaveAttribute("data-check", "unsupported");
    expect(await cursorOf(editor)).toBe(cursor);
    // Redo does it again as one step, and Undo takes it back again.
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => wordsOf(lines.nth(0))).toBe(`${OWN} ${ELSEWHERE}`);
    await expect(marks).toHaveCount(3);
    await undo();
    await expect.poll(() => wordsOf(lines.nth(0))).toBe(allFour);
    await expect(marks).toHaveCount(4);

    // From ⌘K, in a sentence that is its whole paragraph: the paragraph goes too; Undo, from the line, brings it back.
    await clickEndOf(window, lines.nth(1));
    await runCommand(window, "check.cutSentence", words.cut);
    await expect(lines).toHaveCount(1);
    await expect(marks).toHaveCount(3);
    await expect(undoLine).toContainText(words.cutDone);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(lines).toHaveCount(2);
    await expect.poll(() => wordsOf(lines.nth(1))).toBe(ALONE);
    await expect(marks).toHaveCount(4);
    expect(await claimIds()).toEqual(ids);

    // Keep as my view: the mark and its wash go, the words stay, and ⌘Z brings the mark back.
    await openCard(marks.nth(2));
    await pointAndClick(window, card.getByTestId(IDS.keep));
    await expect(marks).toHaveCount(3);
    await expect(undoLine).toContainText(words.kept);
    await expect.poll(() => wordsOf(lines.nth(0))).toBe(allFour);
    await undo();
    await expect(marks).toHaveCount(4);
    await expect(marks.nth(2)).toHaveAttribute("data-check", "unsupported");

    // From ⌘K: the sentence is the User's own view, stored with its words, and no longer counted.
    await clickEndOf(window, lines.nth(0));
    await runCommand(window, "check.keepAsView", words.keep);
    await expect(marks).toHaveCount(3);
    expect(await keptWords(editor)).toEqual([NOTHING]);
    await expect.poll(() => wordsOf(lines.nth(0))).toBe(allFour);
    await expect((await checkCard(window)).getByTestId("health-unsupported")).toContainText(
      words.needLook,
    );
    await app.close();
  });

  test(`⌘K offers Cut it, Keep as my view and Search all Documents only in such a sentence, and agrees with its card on whether the check looked in less than every Document (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window, editor, marks, card, openCard } =
      await launchedWithFourSentences(language);

    /** Whether ⌘K lists a command under its label, with the cursor where it is. */
    const listed = async (id: string, label: string) => {
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(label);
      const palette = window.getByTestId("palette");
      await expect(palette.getByTestId("palette-searching")).toHaveCount(0);
      await expect(
        palette.getByTestId("palette-item").or(palette.getByTestId("palette-empty")).first(),
      ).toBeVisible();
      const found = (await palette.locator(`[data-key="command:${id}"]`).count()) > 0;
      await window.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      return found;
    };
    const commands = [
      ["check.cutSentence", words.cut],
      ["check.keepAsView", words.keep],
      ["check.searchAllDocuments", words.searchAll],
    ] as const;
    const listedHere = async () => {
      const here: boolean[] = [];
      for (const [id, label] of commands) here.push(await listed(id, label));
      return here;
    };

    // In a sentence a Document supports, none of the three.
    await cursorIn(editor, OWN);
    expect(await listedHere()).toEqual([false, false, false]);

    // Find sources is in ⌘K for this sentence, named for it, and not in one the Documents support.
    const findSourcesListed = async () => {
      await window.keyboard.press("ControlOrMeta+k");
      await expect(window.getByTestId("palette-search")).toBeFocused();
      await window.keyboard.type(words.findSourcesSearch);
      const palette = window.getByTestId("palette");
      await expect(palette.getByTestId("palette-searching")).toHaveCount(0);
      await expect(
        palette.getByTestId("palette-item").or(palette.getByTestId("palette-empty")).first(),
      ).toBeVisible();
      const item = palette.locator('[data-key="command:check.findSources"]');
      const found = (await item.count()) > 0;
      if (found) await expect(item).toContainText(words.findSourcesFor);
      await window.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
      return found;
    };
    expect(await findSourcesListed()).toBe(false);
    await cursorIn(editor, NOTHING);
    expect(await findSourcesListed()).toBe(true);
    await cursorIn(editor, OWN);

    // In one the check looked for in only the Mind's scope, all three, as the card has them.
    await cursorIn(editor, NOTHING);
    expect(await listedHere()).toEqual([true, true, true]);
    await openCard(marks.nth(2));
    await expect(card.getByTestId(IDS.searchAll)).toBeVisible();
    await expect(card.getByTestId(IDS.cut)).toBeVisible();
    await expect(card.getByTestId(IDS.keep)).toBeVisible();
    await window.keyboard.press("Escape");

    // Search all Documents from ⌘K finds it elsewhere, as the card's does.
    await cursorIn(editor, ELSEWHERE);
    await runCommand(window, "check.searchAllDocuments", words.searchAll);
    await expect(marks.nth(1)).toHaveAttribute("data-check", "supported");

    // Searched in every Document and still not found: the card and ⌘K both stop offering it,
    // and both keep Cut it and Keep as my view.
    await cursorIn(editor, NOTHING);
    await runCommand(window, "check.searchAllDocuments", words.searchAll);
    await expect(marks.nth(2)).toHaveAttribute("data-check", "unsupported");
    await expect(marks.nth(2)).toHaveAttribute("data-claim", /.+/);
    await openCard(marks.nth(2));
    await expect(card.getByTestId(IDS.searchAll)).toHaveCount(0);
    await expect(card.getByTestId(IDS.cut)).toBeVisible();
    await expect(card.getByTestId(IDS.keep)).toBeVisible();
    await window.keyboard.press("Escape");
    await cursorIn(editor, NOTHING);
    expect(await listedHere()).toEqual([true, true, false]);
    await app.close();
  });
}

test("Cut it and Keep as my view are reached and run with the keyboard alone: ⌘K lists them in the sentence, Enter runs one, the Mind keeps the focus, and ⌘Z takes it back", async () => {
  test.setTimeout(180_000);
  const { app, window, editor, lines, marks, card } = await launchedWithFourSentences("en");

  // Enter on a mark opens its card, and Esc closes it with the caret back in the text.
  const caret = await cursorOf(editor);
  await marks.nth(2).focus();
  await window.keyboard.press("Enter");
  await expect(card).toBeVisible();
  await expect(card.getByTestId(IDS.cut)).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await cursorOf(editor)).toBe(caret);

  const palette = window.getByTestId("palette");
  await clickEndOf(window, lines.nth(0));
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Cut it");
  const cut = palette.locator('[data-key="command:check.cutSentence"]');
  await expect(cut).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect.poll(() => wordsOf(lines.nth(0))).toBe(`${OWN} ${ELSEWHERE}`);
  await expect(marks).toHaveCount(3);
  await expect(editor).toBeFocused();
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => wordsOf(lines.nth(0))).toBe(`${OWN} ${ELSEWHERE} ${NOTHING}`);
  await expect(marks).toHaveCount(4);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Keep as my view");
  await expect(palette.locator('[data-key="command:check.keepAsView"]')).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await window.keyboard.press("Enter");
  await expect(marks).toHaveCount(3);
  await expect(editor).toBeFocused();
  await app.close();
});

test("Cut it in a paragraph with footnotes takes out exactly the sentence, its outline is over its words, and Undo puts it back", async () => {
  test.setTimeout(180_000);
  const FIRST = "See p. 4.";
  const SECOND = "See p. 9.";
  const { app, window, editor, marks, card, openCard } = await launchedWithMind(
    [`${ELSEWHERE}^[${FIRST}] ${NOTHING}^[${SECOND}] ${ALONE}`],
    "Penguins nest",
    "en",
  );
  await expect(marks).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    await expect(marks.nth(index)).toHaveAttribute("data-check", "unsupported");
  }
  const whole = `${ELSEWHERE}[${FIRST}] ${NOTHING}[${SECOND}] ${ALONE}`;
  expect(await paragraphOf(editor)).toBe(whole);

  // The last sentence follows two footnotes: its outline is over its words, not earlier.
  await openCard(marks.nth(2));
  const wash = editor.locator(".claim-wash").filter({ hasText: ALONE });
  const spanOf = (boxes: Locator) =>
    boxes.evaluateAll((all) => {
      const rects = all.flatMap((each) => [...each.getClientRects()]);
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
        top: Math.min(...rects.map((rect) => rect.top)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
      };
    });
  const [over, under] = [await spanOf(window.getByTestId("claim-outline")), await spanOf(wash)];
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    expect(Math.abs(over[edge] - under[edge])).toBeLessThan(4);
  }
  await pointAndClick(window, card.getByTestId("claim-cut-sentence"));
  await expect.poll(() => paragraphOf(editor)).toBe(`${ELSEWHERE}[${FIRST}] ${NOTHING}[${SECOND}]`);
  await expect(marks).toHaveCount(2);
  await expect(window.getByTestId("undo-line")).toContainText("Cut the sentence");
  await focusSettled(window, editor);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => paragraphOf(editor)).toBe(whole);
  await expect(marks).toHaveCount(3);

  // The sentence between the footnotes goes with its own footnote and nothing else.
  await cursorIn(editor, NOTHING);
  await runCommand(window, "check.cutSentence", "Cut it");
  await expect.poll(() => paragraphOf(editor)).toBe(`${ELSEWHERE}[${FIRST}] ${ALONE}`);
  await expect(marks).toHaveCount(2);
  await focusSettled(window, editor);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => paragraphOf(editor)).toBe(whole);

  // The first one, with its footnote, from its card.
  await openCard(marks.nth(0));
  await pointAndClick(window, card.getByTestId("claim-cut-sentence"));
  await expect.poll(() => paragraphOf(editor)).toBe(`${NOTHING}[${SECOND}] ${ALONE}`);
  await focusSettled(window, editor);
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => paragraphOf(editor)).toBe(whole);
  await app.close();
});
