import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import { wordFile } from "../tests/helpers/word";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  importWordFile,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setGroupBeside,
  setLanguage,
  setWindowSize,
  sizeMind,
  sizeNote,
  slideSelect,
  useLocalChatModel,
  wordsBox,
} from "./app";

/*
 * The Mind's column at every width (DESIGN.md, Layout, Mind column): the text
 * keeps a 40px gutter on both sides; the checks stand in the right margin, each
 * mark's left edge 8px after the measure, down to 760px, and under 760px they
 * move into the text 4px after their sentence's last word, so the right gutter
 * stays empty. What stands beside the text — the block handle and a Question's
 * fold chevron — is placed from the text edge, never the pane's. Asserted by
 * relation; the sizes are the column's, not the window's.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const WIDTHS = [1100, 900, 760, 759, 600, 480] as const;

/** A folder to save the column at 1100, 760, 600 and 480px in, when one is given. */
const SHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't visible.");
  return found;
}

/** The editor's text column: its box reaches over the left margin, its padding keeps the text edge. */
function textColumn(editor: Locator) {
  return editor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return { x: rect.left + left, width: rect.width - left - right };
  });
}

const near = (actual: number, expected: number, tolerance: number) =>
  Math.abs(actual - expected) <= tolerance;

/** The Note's own edges: the scroller the page scrolls in, which the foot's badge floats over. */
const paneOf = (window: Page) => window.getByTestId("mind-scroller");

/** Waits until the checks are drawn, where the column's width puts them. */
async function marksIn(window: Page, count: number) {
  await expect(window.getByTestId("margin-checks").getByTestId("claim-mark")).toHaveCount(count);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the Mind's column keeps its 40px gutters and its checks follow the text edge at every width (${language})`, async () => {
    test.setTimeout(300_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1400, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    await newMind(window);
    await sizeMind(app, window, 1100);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Reading notes: tides" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Spring tides come at new moon and at full moon." },
            {
              type: "citation",
              attrs: {
                passageId: "passage-2",
                documentId: tides?.id,
                documentName: "Tides",
                contentHash: tides?.contentHash,
                pageFrom: 2,
                pageTo: 2,
                location: null,
                quote: "Spring tides happen at new moon and at full moon.",
                check: "found",
                checkReason: null,
              },
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Unicorns graze on the harbour wall." }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "What they are" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Twice a month at the new moon" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Neap tides fall in between" }],
                },
              ],
            },
          ],
        },
      ],
    );
    // A check on two sentences: one the Documents support, one they don't, so the badge has a look to count.
    const [first, second] = [
      editor.locator(":scope > p").nth(0),
      editor.locator(":scope > p").nth(1),
    ];
    await slideSelect(window, first, "Spring tides", { line: second, words: "harbour wall." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    await expect(window.getByTestId("claim-mark")).toHaveCount(2, { timeout: 60_000 });
    await expect(window.getByTestId("check-badge")).toBeVisible({ timeout: 60_000 });
    const finishedBadge = window.getByTestId("check-badge");
    // The check finishes before any shot: no mark is still checking, and the badge says its state.
    await expect(window.locator('[data-testid="claim-mark"][data-check="checking"]')).toHaveCount(
      0,
      {
        timeout: 60_000,
      },
    );
    await expect(finishedBadge).toHaveAttribute("data-state", "needs-look", { timeout: 60_000 });
    // Resizing the Note across the 760px fold, both ways, never changes what its checks say.
    for (const across of [800, 700, 800]) {
      await sizeMind(app, window, across);
      await expect(finishedBadge).toHaveAttribute("data-state", "needs-look");
      await expect(finishedBadge.locator(".check-badge-words")).toContainText(
        language === "en" ? "needs a look" : "需要留意",
      );
    }

    const column = window.locator(".mind-column");
    const badge = window.getByTestId("check-badge");
    const citation = editor.getByTestId("citation-chip").first();

    for (const width of WIDTHS) {
      await sizeMind(app, window, width);
      await motionSettled(window);
      const pane = await box(paneOf(window));
      const columnBox = await box(column);
      expect(near(columnBox.width, width, 1), `the column is ${width}px wide`).toBe(true);
      const folded = columnBox.width < 760;
      await marksIn(window, 2);

      // The text edge: at least 40px from the pane's edge on both sides, folded or not.
      const text = await textColumn(editor);
      expect.soft(text.x - pane.x, `${width}: the left gutter`).toBeGreaterThanOrEqual(40 - 0.5);
      expect
        .soft(pane.x + pane.width - (text.x + text.width), `${width}: the right gutter`)
        .toBeGreaterThanOrEqual(40 - 0.5);
      expect
        .soft((await box(first)).x, `${width}: a paragraph starts at the text edge`)
        .toBeGreaterThanOrEqual(text.x - 1);
      expect
        .soft((await box(first)).x, `${width}: a paragraph starts at the text edge`)
        .toBeLessThanOrEqual(text.x + 1);
      // A check's room never makes a line of its own: two paragraphs stand the same 16px apart at every width.
      const gap = (await box(second)).y - ((await box(first)).y + (await box(first)).height);
      expect.soft(gap, `${width}: the paragraph gap`).toBeGreaterThanOrEqual(12);
      expect.soft(gap, `${width}: the paragraph gap`).toBeLessThanOrEqual(20);

      // The checks: in the margin, each left edge 8px after the measure, down to 760px;
      // under 760px in the text, 4px after the sentence's last word or Citation marker.
      const marks = window.getByTestId("margin-checks").getByTestId("claim-mark");
      if (folded) {
        // The room the sentence keeps is the mark's own rendered width plus 4px, and no more.
        const room = await first
          .locator(".claim-inline-room")
          .first()
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight));
        const markWidth = (await box(marks.first())).width;
        expect(Math.abs(room - (markWidth + 4)), `${width}: the mark's room`).toBeLessThanOrEqual(
          1,
        );
        // The first sentence ends with its Citation pill; the second with its last word.
        const pill = await box(editor.getByTestId("citation").first());
        const end = await wordsBox(second, "wall.");
        const anchors = [
          { right: pill.x + pill.width, middle: pill.y + pill.height / 2 },
          { right: end.right, middle: end.y },
        ];
        for (const [at, anchor] of anchors.entries()) {
          const mark = await box(marks.nth(at));
          expect
            .soft(mark.x, `${width}: a mark is in the text`)
            .toBeGreaterThanOrEqual(text.x - 0.5);
          expect
            .soft(mark.x + mark.width, `${width}: a mark ends in the text`)
            .toBeLessThanOrEqual(text.x + text.width + 0.5);
          expect
            .soft(mark.x - anchor.right, `${width}: a mark stands 4px after its sentence`)
            .toBeGreaterThanOrEqual(4 - 1.5);
          expect
            .soft(mark.x - anchor.right, `${width}: a mark stands 4px after its sentence`)
            .toBeLessThanOrEqual(4 + 1.5);
          expect
            .soft(
              Math.abs(mark.y + mark.height / 2 - anchor.middle),
              `${width}: a mark is on its line`,
            )
            .toBeLessThanOrEqual(14);
        }
      } else {
        // The layer's left edge is the measure's right edge: each mark's left edge stands 8px after it.
        const layerBox = await box(window.getByTestId("margin-checks"));
        expect
          .soft(layerBox.x, `${width}: the margin layer starts at the measure's right edge`)
          .toBeGreaterThanOrEqual(text.x + text.width - 2);
        expect
          .soft(layerBox.x, `${width}: the margin layer starts at the measure's right edge`)
          .toBeLessThanOrEqual(text.x + text.width + 2);
        for (const mark of await window
          .getByTestId("margin-checks")
          .getByTestId("claim-mark")
          .all()) {
          const rect = await box(mark);
          expect
            .soft(rect.x - layerBox.x, `${width}: a mark's left edge is 8px after the measure`)
            .toBeGreaterThanOrEqual(6);
          expect
            .soft(rect.x - layerBox.x, `${width}: a mark's left edge is 8px after the measure`)
            .toBeLessThanOrEqual(10);
          expect
            .soft(rect.x + rect.width, `${width}: a mark is inside the pane`)
            .toBeLessThanOrEqual(pane.x + pane.width + 0.5);
        }
      }

      // Headings share the text edge; a list keeps its markers inside the text column.
      for (const heading of [editor.locator(":scope > h1"), editor.locator(":scope > h2")]) {
        const headingBox = await box(heading);
        expect
          .soft(headingBox.x, `${width}: a heading at the text edge`)
          .toBeGreaterThanOrEqual(text.x - 1);
        expect
          .soft(headingBox.x, `${width}: a heading at the text edge`)
          .toBeLessThanOrEqual(text.x + 1);
      }
      const item = editor.locator(":scope > ul > li > p").first();
      const itemBox = await box(item);
      expect
        .soft(itemBox.x, `${width}: the list item's 48px indent`)
        .toBeGreaterThanOrEqual(text.x + 48 - 1);
      expect
        .soft(itemBox.x, `${width}: the list item's 48px indent`)
        .toBeLessThanOrEqual(text.x + 48 + 1);
      expect
        .soft(itemBox.x - 24, `${width}: the bullet is inside the text column`)
        .toBeGreaterThan(pane.x);
      expect
        .soft(itemBox.x + itemBox.width, `${width}: the list item ends in the text`)
        .toBeLessThanOrEqual(text.x + text.width + 0.5);

      // The block handle stands 4px before the text, and steps in to a list item's bullet.
      const handle = window.getByTestId("block-handle");
      await first.hover();
      await expect(handle).toBeVisible();
      const handleBox = await box(handle);
      expect
        .soft(text.x - (handleBox.x + handleBox.width), `${width}: the handle's gap to the text`)
        .toBeGreaterThanOrEqual(4 - 1);
      expect
        .soft(text.x - (handleBox.x + handleBox.width), `${width}: the handle's gap to the text`)
        .toBeLessThanOrEqual(4 + 1);
      expect
        .soft(handleBox.x + handleBox.width, `${width}: the handle covers no text`)
        .toBeLessThanOrEqual(text.x);
      await item.hover();
      await expect(handle).toBeVisible();
      const listHandle = await box(handle);
      expect
        .soft(
          itemBox.x - 24 - (listHandle.x + listHandle.width),
          `${width}: the handle's gap to the bullet`,
        )
        .toBeGreaterThanOrEqual(-0.5);
      expect
        .soft(
          itemBox.x - 24 - (listHandle.x + listHandle.width),
          `${width}: the handle's gap to the bullet`,
        )
        .toBeLessThanOrEqual(4 + 0.5);
      expect
        .soft(listHandle.x + listHandle.width, `${width}: the handle covers no list text`)
        .toBeLessThanOrEqual(itemBox.x);

      if (SHOTS && [1100, 760, 600, 480].includes(width)) {
        await motionSettled(window);
        await window.screenshot({ path: join(SHOTS, `margins-${language}-${width}.png`) });
      }

      // Nothing scrolls sideways at any width.
      expect
        .soft(
          await paneOf(window).evaluate((element) => element.scrollWidth - element.clientWidth),
          `${width}: the page doesn't scroll sideways`,
        )
        .toBeLessThanOrEqual(1);

      // A Citation's badge opens inside the window; the check badge stands under the marks,
      // never nearer than 16px to the pane's edge.
      await pointAndClick(window, citation);
      const card = window.getByTestId("citation-card");
      await expect(card.getByTestId("citation-badge")).toBeVisible();
      await motionSettled(window);
      const view = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const cardBox = await box(card.locator(".citation-card"));
      expect.soft(cardBox.x, `${width}: the Citation card's left`).toBeGreaterThanOrEqual(0);
      expect.soft(cardBox.y, `${width}: the Citation card's top`).toBeGreaterThanOrEqual(0);
      expect
        .soft(cardBox.x + cardBox.width, `${width}: the Citation card's right`)
        .toBeLessThanOrEqual(view.width + 0.5);
      expect
        .soft(cardBox.y + cardBox.height, `${width}: the Citation card's foot`)
        .toBeLessThanOrEqual(view.height + 0.5);
      await window.keyboard.press("Escape");
      await expect(window.getByTestId("citation-card")).toHaveCount(0);
      await setGroupBeside(window, false);

      await expect(badge).toBeVisible();
      const badgeBox = await box(badge);
      const fromRight = pane.x + pane.width - (badgeBox.x + badgeBox.width);
      expect
        .soft(fromRight, `${width}: the badge is at least 16px from the pane's right`)
        .toBeGreaterThanOrEqual(16 - 0.5);
      expect
        .soft(pane.y + pane.height - (badgeBox.y + badgeBox.height), `${width}: the badge's foot`)
        .toBeGreaterThanOrEqual(16 - 1);
      expect
        .soft((await badge.innerText()).length, `${width}: the badge counts`)
        .toBeGreaterThan(0);
      if (!folded)
        expect
          .soft(fromRight, `${width}: the badge stands under the check column`)
          .toBeGreaterThanOrEqual(Math.max(16, (columnBox.width - 784) / 2) - 24);
    }

    // The badge's label follows the Note pane, not the window: kept at 480 and dropped at 399, with
    // a Document beside the Note, as in a split window.
    await setWindowSize(app, window, 1600, 900);
    await setGroupBeside(window, true);
    await sizeNote(app, window, 480);
    const badgeWords = badge.locator(".check-badge-words");
    const page = window.locator(".mind-tab-page");
    const paneWidth = async () => (await page.boundingBox())?.width ?? 0;
    expect(await paneWidth(), "a Note at about 480px").toBeGreaterThanOrEqual(430);
    await expect(badgeWords, "the label at a 480px Note").toBeVisible();
    // The boundary under 400px: the rule is the Note pane's own width, here held at 390.
    await page.evaluate(() => {
      const element = document.querySelector(".mind-tab-page") as HTMLElement;
      element.style.width = "390px";
      element.style.flex = "none";
    });
    const narrow = await paneWidth();
    expect(narrow, "a Note under 400px").toBeLessThan(400);
    await expect(badgeWords, `no label under a 400px Note (${narrow}px)`).toBeHidden();
    await expect(badge.locator(".check-badge-short")).toBeVisible();
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Question's fold chevron and its Block handle meet at the text edge at every width (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await mindWrittenBefore(window, "Tides", [
      { note: "Spring tides follow the Moon." },
      { question: "When do spring tides happen?", answer: "At new moon and at full moon." },
    ]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Tides" }).click();
    const editor = window.getByTestId("mind-editor");
    await expect(editor.getByTestId("answer")).toHaveAttribute("data-status", "done");
    const question = editor.getByTestId("question");
    const fold = question.getByTestId("question-fold");
    const handle = window.getByTestId("block-handle");

    for (const width of WIDTHS) {
      await sizeMind(app, window, width);
      await motionSettled(window);
      const pane = await box(paneOf(window));
      const text = await textColumn(editor);
      const foldBox = await box(fold);
      expect.soft(foldBox.width, `${width}: the chevron's width`).toBeGreaterThanOrEqual(16 - 0.5);
      expect.soft(foldBox.width, `${width}: the chevron's width`).toBeLessThanOrEqual(16 + 0.5);
      expect
        .soft(foldBox.x + foldBox.width, `${width}: the chevron ends at the text edge`)
        .toBeGreaterThanOrEqual(text.x - 1);
      expect
        .soft(foldBox.x + foldBox.width, `${width}: the chevron ends at the text edge`)
        .toBeLessThanOrEqual(text.x + 1);
      // Moving away first makes the handle pick the Question again after a resize, not the last block.
      await window.mouse.move(2, 2);
      await question.locator(".question-text").hover();
      await expect(handle).toBeVisible();
      await expect
        .poll(async () => {
          const [shown, chevron] = [await box(handle), await box(fold)];
          return Math.abs(shown.x + shown.width - chevron.x);
        })
        .toBeLessThanOrEqual(1);
      const handleBox = await box(handle);
      expect
        .soft(handleBox.x + handleBox.width, `${width}: the handle meets the chevron`)
        .toBeGreaterThanOrEqual(foldBox.x - 1);
      await expect(question.locator(".question-spark")).toHaveCSS("opacity", "0");
      // Both fit the 40px gutter with room to spare, the handle's 20px reaching 36px left of the text.
      expect
        .soft(handleBox.x - pane.x, `${width}: the handle stays inside the gutter`)
        .toBeGreaterThanOrEqual(4 - 1);
      expect
        .soft(foldBox.x - pane.x, `${width}: the chevron stays inside the gutter`)
        .toBeGreaterThanOrEqual(4 - 1);
      const start = await wordsBox(question, "When");
      expect.soft(start.left, `${width}: the Question's text`).toBeGreaterThanOrEqual(text.x - 1);
    }
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a Word-look Note keeps its own narrow rule: no text under 11px and no sideways scroll (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await importWordFile(
      app,
      window,
      sources,
      "Tides.docx",
      wordFile({
        body: [
          `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Spring tides</w:t></w:r></w:p>`,
          `<w:p><w:r><w:t>The Moon raises two bulges of water on the Earth, and spring tides come at new moon and at full moon, when the Sun and the Moon pull in line.</w:t></w:r></w:p>`,
          `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Harbour times</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>High water, every 12 months</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
        ].join(""),
      }),
    );
    const editor = frontMind(window).getByTestId("mind-editor");
    await expect(editor).toBeVisible();

    for (const width of WIDTHS) {
      await sizeMind(app, window, width);
      await motionSettled(window);
      const pane = await box(paneOf(window));
      const text = await textColumn(editor);
      expect
        .soft(text.x - pane.x, `${width}: the Word page's left gutter`)
        .toBeGreaterThanOrEqual(40 - 0.5);
      expect
        .soft(pane.x + pane.width - (text.x + text.width), `${width}: the Word page's right gutter`)
        .toBeGreaterThanOrEqual(40 - 0.5);
      // The page zooms to fit its width; the file's body is never drawn under 11px.
      const sizes = await editor.evaluate((element) =>
        [...element.querySelectorAll(":scope > p, :scope > h1, td p")]
          .map((each) => Number.parseFloat(getComputedStyle(each).fontSize))
          .filter((size) => Number.isFinite(size)),
      );
      expect(sizes.length, `${width}: the Word file's text`).toBeGreaterThan(0);
      expect
        .soft(Math.min(...sizes), `${width}: no Word text under 11px`)
        .toBeGreaterThanOrEqual(11 - 0.5);
      expect
        .soft(
          await paneOf(window).evaluate((element) => element.scrollWidth - element.clientWidth),
          `${width}: a Word-look page doesn't scroll sideways`,
        )
        .toBeLessThanOrEqual(1);
    }
    await app.close();
  });
}

test("a Chinese sentence's mark stays with its last character at 480 and 600px, and no line starts with a mark", async () => {
  test.setTimeout(240_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "zh-CN");
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await sizeMind(app, window, 480);

  // A Chinese sentence whose last character ends within its mark's room of the measure's edge.
  let count = 40;
  for (let tries = 0; tries < 40; tries++) {
    await editor.evaluate((dom, chars) => {
      (dom as unknown as { editor: Editor }).editor.commands.setContent({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: `${"潮".repeat(chars)}。` }] },
        ],
      });
    }, count);
    const gap = await editor.evaluate((dom) => {
      const element = dom as HTMLElement;
      const paragraph = element.querySelector(":scope > p") as HTMLElement;
      const walker = element.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
      const node = texts.at(-1) as Text;
      const range = document.createRange();
      range.setStart(node, node.data.length - 1);
      range.setEnd(node, node.data.length);
      const style = getComputedStyle(element);
      const right = element.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
      return right - range.getBoundingClientRect().right;
    });
    if (gap >= 0 && gap < 23) break;
    count += gap >= 23 ? 1 : -1;
    if (count < 5) count = 5;
  }
  const line = editor.locator(":scope > p").first();
  await expect(line).toHaveText(/^潮+。$/);

  // One check of the Note, from its badge: the sentence the Documents don't support takes a mark.
  await pointAndClick(window, window.getByTestId("check-badge-open"));
  const card = window.getByTestId("check-card");
  await pointAndClick(window, card.getByTestId("badge-check-mind"));
  await pointAndClick(window, card.getByTestId("mind-check-ask").getByTestId("mind-check-check"));
  const marks = window.getByTestId("margin-checks").getByTestId("claim-mark");
  await expect(marks).toHaveCount(1, { timeout: 60_000 });
  await expect(window.locator('[data-testid="claim-mark"][data-check="checking"]')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(window.getByTestId("check-badge")).toHaveAttribute("data-state", "needs-look", {
    timeout: 60_000,
  });
  await window.keyboard.press("Escape");

  for (const width of [480, 600]) {
    await sizeMind(app, window, width);
    await motionSettled(window);
    const text = await textColumn(editor);
    const last = await line.evaluate((paragraph) => {
      const walker = paragraph.ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
      const node = texts.at(-1) as Text;
      const range = document.createRange();
      range.setStart(node, node.data.length - 1);
      range.setEnd(node, node.data.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const mark = await box(marks.first());
    const middle = mark.y + mark.height / 2;
    // The mark keeps its last character's line, after it, and is never at a line's start.
    expect
      .soft(mark.x, `${width}: the mark after the last character`)
      .toBeGreaterThanOrEqual(last.right - 2);
    expect.soft(mark.x, `${width}: no mark begins a line`).toBeGreaterThan(text.x + 1);
    expect
      .soft(Math.abs(middle - (last.top + last.bottom) / 2), `${width}: the mark's line`)
      .toBeLessThanOrEqual(3);
    expect
      .soft(mark.x + mark.width, `${width}: the mark ends in the text`)
      .toBeLessThanOrEqual(text.x + text.width + 1);
    expect
      .soft(last.right, `${width}: the last character stays in the text`)
      .toBeLessThanOrEqual(text.x + text.width + 1);
    if (SHOTS) {
      await motionSettled(window);
      await window.screenshot({ path: join(SHOTS, `cjk-mark-${width}.png`) });
    }
  }
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  test(`480px: a Question's handle meets its chevron, and the handle on item 10 shares the list's room (${language})`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await mindWrittenBefore(window, "Tides", [
      { note: "Spring tides follow the Moon." },
      {
        question: language === "en" ? "When do spring tides happen?" : "大潮什么时候出现？",
        answer: "At new moon and at full moon.",
      },
    ]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Tides" }).click();
    const editor = window.getByTestId("mind-editor");
    await expect(editor.getByTestId("answer")).toHaveAttribute("data-status", "done");
    await editor.evaluate(
      (dom, content) => {
        const note = (dom as unknown as { editor: Editor }).editor;
        // Right after the first Note, so the list is its own block before the Question.
        const first = note.state.doc.firstChild;
        note.commands.insertContentAt(first?.nodeSize ?? note.state.doc.content.size, content);
      },
      [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: Array.from({ length: 12 }, (_, at) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: `Item ${at + 1}` }] }],
          })),
        },
      ],
    );
    await sizeMind(app, window, 480);
    const question = editor.getByTestId("question");
    const handle = window.getByTestId("block-handle");
    if (SHOTS) {
      await window.mouse.move(2, 2);
      await question.locator(".question-text").hover();
      await expect(handle).toBeVisible();
      await motionSettled(window);
      await window.screenshot({ path: join(SHOTS, `question-handle-480-${language}.png`) });
    }
    const item = editor.locator("ol > li").nth(9);
    const itemText_ = item.locator(":scope > p").first();
    const room = await item.evaluate((li) => {
      const value = Number.parseFloat(getComputedStyle(li).getPropertyValue("--marker-room"));
      return Number.isFinite(value) ? value : 0;
    });
    expect(room, "item 10's room is wider than 24px").toBeGreaterThan(0);
    await window.mouse.move(2, 2);
    await itemText_.hover();
    const itemLine = await box(itemText_);
    await window.mouse.move(itemLine.x + 30, itemLine.y + itemLine.height / 2, { steps: 4 });
    await expect
      .poll(async () => {
        const shown = await box(handle);
        return Math.abs(shown.y + shown.height / 2 - (itemLine.y + itemLine.height / 2));
      })
      .toBeLessThanOrEqual(16);
    await expect(handle).toBeVisible();
    const handleBox = await box(handle);
    const itemBox = await box(itemText_);
    const markerLeft = itemBox.x - 24 - room;
    expect(
      Math.abs(markerLeft - 4 - (handleBox.x + handleBox.width)),
      "the handle stands 4px before item 10's number",
    ).toBeLessThanOrEqual(1.5);
    if (SHOTS) {
      await motionSettled(window);
      await window.screenshot({ path: join(SHOTS, `list-10-handle-480-${language}.png`) });
    }
    await app.close();
  });
}
