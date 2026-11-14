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
 * A sentence whose check found a Passage its Citation doesn't hold reads Supported, not yet cited
 * (#3019): the check writes nothing into the Note, the card is the Supported card with the grey
 * ring and its own line, the check card has one row for these sentences with Add all on it, in
 * view as the check ends, and the badge names them. Add as Citation on the card or Add all on the
 * row shows the ✓ at once, each one Undo, changing the Note and nothing else, and the Citation
 * added says the check found it. The scripted model (src/main/fakeChat/checks.ts) backs a sentence
 * with the line of a Document that shares the most words with it, and finds unsupported one that
 * shares none. Set INCARNAMIND_SCREENSHOTS to a folder to save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string, part?: Locator) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  const path = join(SCREENSHOTS, `${name}.png`);
  await (part ? part.screenshot({ path }) : window.screenshot({ path }));
};

const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen at the first and last quarter moons.";
const HARBOUR = "Harbours publish the times of high water every year.";
const TIDES = ["# Tides", "", SPRING, "", NEAP, "", HARBOUR, ""].join("\n");
const FERRY = "The ferry leaves the quay before dawn.";

const WORDS = {
  en: {
    heading: "Supported, not yet cited",
    line: "This passage backs the sentence, but the sentence doesn’t cite it yet.",
    row: "2 supported, not yet cited",
    addAll: "Add all",
    badge: "2 not yet cited",
    found: "Found by a check of this sentence",
    mixed: {
      look: "1 needs a look",
      supported: "1 supported",
      waiting: "1 supported, not yet cited",
    },
    mixedBadge: "1 needs a look",
    add: "Add",
  },
  "zh-CN": {
    heading: "有依据，尚未引用",
    line: "这个段落支持这句话，但尚未添加为引用。",
    row: "2 句有依据，尚未引用",
    addAll: "全部添加",
    badge: "2 句尚未引用",
    found: "核对这句话时找到",
    mixed: { look: "1 句需要留意", supported: "1 句有依据", waiting: "1 句有依据，尚未引用" },
    mixedBadge: "需要留意 1 处",
    add: "添加",
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

/** Writes each sentence with a Citation of the Spring line, which says something else for most. */
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

/** Where the caret is, as the paragraph it is in and its place there, and how far the Note is scrolled. */
const caretAndScroll = (window: Page) =>
  window.getByTestId("mind-editor").evaluate((dom) => {
    const { selection } = (dom as unknown as { editor: Editor }).editor.state;
    return {
      paragraph: selection.$head.index(0),
      offset: selection.$head.parentOffset,
      scroll: dom.closest(".mind-scroller")?.scrollTop ?? null,
    };
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

async function launched() {
  await writeFile(join(sources, "Tides.md"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  return { app, window };
}

/** The window in `language` at `width`, Tides added, and a new Note open. */
async function aNewNote(
  { app, window }: Awaited<ReturnType<typeof launched>>,
  language: "en" | "zh-CN",
  width: number,
) {
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await addDocuments(window, [join(sources, "Tides.md")]);
  await newMind(window);
}

/**
 * Waits until a row of the check card sits whole inside the card's body, as one scrolled out of
 * it or cut by its foot would not (#3019). The fade the foot draws is part of what shows: a body
 * of a title and one row has no room for the row above it.
 */
async function shownInBody(panel: Locator, row: Locator) {
  const body = panel.locator(".check-card-body");
  await expect
    .poll(
      async () => {
        const [inner, outer] = await Promise.all([row.boundingBox(), body.boundingBox()]);
        if (!inner || !outer) return "not drawn";
        return inner.y >= outer.y - 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5
          ? "inside"
          : `row ${inner.y}..${inner.y + inner.height}, body ${outer.y}..${outer.y + outer.height}`;
      },
      { message: "the row is inside the visible body" },
    )
    .toBe("inside");
}

/** Check in the check card, which stays open while the check runs and after it ends. */
async function checkFromCard(window: Page) {
  const card = await checkCard(window);
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  await expect(card.getByTestId("card-foot-stop")).toHaveCount(0, { timeout: 30_000 });
  return card;
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`a sentence Supported, not yet cited gets its ✓ only by the User's click, one at a time or all together, each one Undo (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    const opened = await launched();
    const { app, window } = opened;
    await useLocalChatModel(window);
    await aNewNote(opened, language, width);
    const lines = await writeNote(window, [NEAP, HARBOUR]);
    await expect(lines.nth(1)).toContainText("Harbours publish");
    const before = await noteText(window);

    // The check: nothing written into the Note, no ✓ beside the Citation whose words don't say it,
    // and the row in view as the check ends, with the card left open.
    const panel = await checkFromCard(window);
    await expect(marks(window)).toHaveCount(2);
    await expect(marks(window).and(window.locator('[data-check="not-checked"]'))).toHaveCount(2);
    for (const index of [0, 1]) {
      await expect(marks(window).nth(index)).toHaveAttribute("data-addable", "true");
      await expect(marks(window).nth(index)).toHaveAttribute(
        "aria-label",
        new RegExp(words.heading),
      );
    }
    expect(await noteText(window)).toEqual(before);
    const row = panel.getByTestId("health-notYetCited");
    await expect(row).toContainText(words.row);
    await shownInBody(panel, row);
    await expect(row.getByTestId("found-passages-add")).toHaveText(words.addAll);
    await expect(panel.getByTestId("health-toCheck")).toHaveCount(0);
    await expect(panel.getByTestId("health-supported")).toHaveCount(0);
    await screenshot(window, `${language}-panel`);
    await window.keyboard.press("Escape");
    const badge = window.getByTestId("check-badge");
    await expect(badge).toHaveAttribute("data-state", "not-yet-cited");
    await expect(badge).toContainText(words.badge);
    await screenshot(window, `${language}-page`);
    await screenshot(window, `${language}-badge`, badge);

    // One at a time: Add as Citation on the card, the ✓ at once, and Undo takes it back.
    const card = await openCard(window, marks(window).nth(0));
    await expect(card.getByTestId("claim-badge")).toHaveText(words.heading);
    await expect(card.getByTestId("claim-not-yet-cited")).toHaveText(words.line);
    await expect(card.getByTestId("claim-quote")).toHaveText(NEAP);
    await expect(card.getByTestId("claim-checked-by")).toBeVisible();
    await expect(card.getByTestId("claim-checked-in")).toBeVisible();
    await expect(card.getByTestId("claim-limit")).toBeVisible();
    await expect(card.getByTestId("claim-check-again")).toHaveCount(0);
    await expect(card.getByTestId("claim-add-citation")).toHaveClass(
      /citation-card-action--primary/,
    );
    await screenshot(window, `${language}-card`);
    await pointAndClick(window, card.getByTestId("claim-add-citation"));
    await expect(marks(window).nth(0)).toHaveAttribute("data-check", "supported");
    await expect(window.getByTestId("viewer")).toHaveCount(0);
    await expect(lines.nth(0).getByTestId("citation")).toHaveCount(2);
    expect((await noteText(window))[0]).toBe(`${NEAP.slice(0, -1)}[${SPRING}][${NEAP}].`);
    await screenshot(window, `${language}-added`);
    await undoInNote(window);
    await expect(marks(window).nth(0)).toHaveAttribute("data-check", "not-checked");
    expect(await noteText(window)).toEqual(before);

    // All together from the row: the Note changes and nothing else, and one Undo takes all back.
    const where = await caretAndScroll(window);
    const again = await checkCard(window);
    await pointAndClick(window, again.getByTestId("found-passages-add"));
    await expect(marks(window).and(window.locator('[data-check="supported"]'))).toHaveCount(2);
    await expect(again.getByTestId("health-notYetCited")).toHaveCount(0);
    await expect(window.getByTestId("viewer")).toHaveCount(0);
    expect(await caretAndScroll(window)).toEqual(where);
    // Each before its sentence's stop, beside the Citation the writer gave it.
    expect((await noteText(window)).slice(0, 2)).toEqual([
      `${NEAP.slice(0, -1)}[${SPRING}][${NEAP}].`,
      `${HARBOUR.slice(0, -1)}[${SPRING}][${HARBOUR}].`,
    ]);
    await screenshot(window, `${language}-all-added`);
    await window.keyboard.press("Escape");

    // The Citation added says the check found it.
    await pointAndClick(window, lines.nth(0).getByTestId("citation").nth(1));
    await expect(window.getByTestId("citation-found-by-check")).toHaveText(words.found);
    await screenshot(window, `${language}-citation-card`);
    await window.keyboard.press("Escape");

    await undoInNote(window);
    await expect(marks(window).and(window.locator('[data-check="not-checked"]'))).toHaveCount(2);
    expect(await noteText(window)).toEqual(before);
    await app.close();
  });

  test(`a Note with a ✓, a sentence that needs a look and one not yet cited shows a row each, and its badge says what presses most (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const opened = await launched();
    const { app, window } = opened;
    await useLocalChatModel(window);
    await aNewNote(opened, language, width);
    const lines = await writeNote(window, [SPRING, FERRY, NEAP]);
    await expect(lines.nth(2)).toContainText("Neap tides");

    const panel = await checkFromCard(window);
    await expect(panel.getByTestId("health-look")).toContainText(words.mixed.look);
    await expect(panel.getByTestId("health-supported")).toContainText(words.mixed.supported);
    const row = panel.getByTestId("health-notYetCited");
    await expect(row).toContainText(words.mixed.waiting);
    await expect(row.getByTestId("found-passages-add")).toHaveText(words.add);
    await shownInBody(panel, row);
    await expect(panel.getByTestId("health-toCheck")).toHaveCount(0);
    await screenshot(window, `${language}-mixed`);
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("check-badge")).toContainText(words.mixedBadge);
    await app.close();
  });
  test(`a check that ends with nothing left shows its summary in the card it opened with (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const opened = await launched();
    const { app, window } = opened;
    await useLocalChatModel(window);
    await aNewNote(opened, language, width);
    await writeNote(window, [SPRING]);

    // The card opened with a row for the sentence to check; the check ends with no row for what is
    // left, and its summary at the top of the body is brought into view (#3019).
    const panel = await checkFromCard(window);
    const summary = panel.getByTestId("health-all-checked");
    await expect(summary).toBeVisible();
    await shownInBody(panel, summary);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const width of [900, 1440]) {
    test(`the check card keeps its height through the check's end, with the row of sentences not yet cited scrolled into its body (${language}, ${width}px)`, async () => {
      test.setTimeout(180_000);
      const words = WORDS[language];
      const opened = await launched();
      const { app, window } = opened;
      await useLocalChatModel(window);
      await aNewNote(opened, language, width);
      await writeNote(window, [NEAP, HARBOUR]);

      // The card opens before the check, and is still open when it ends: what the end brings
      // lands in the card's body, not in a taller card (#2313), and is brought into view (#3019).
      const panel = await checkCard(window);
      const before = await panel.boundingBox();
      if (!before) throw new Error("The card isn't drawn.");
      await pointAndClick(window, panel.getByTestId("badge-check-mind"));
      await expect(panel.getByTestId("card-foot-stop")).toHaveCount(0, { timeout: 30_000 });
      const row = panel.getByTestId("health-notYetCited");
      await expect(row).toContainText(words.row);
      await shownInBody(panel, row);
      const ended = await panel.boundingBox();
      if (!ended) throw new Error("The card went at the check's end.");
      expect(ended.height).toBeCloseTo(before.height, 0);
      expect(ended.y).toBeCloseTo(before.y, 0);
      await app.close();
    });
  }
}
