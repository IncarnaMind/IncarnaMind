import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setGroupBeside,
  setLanguage,
  setWindowSize,
  sizeMind,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * Sentences that start on one line (#2277): their check marks stand side by side
 * on that line, in reading order, 4px apart, each level with the sentence it
 * checks and the first 8px after the measure — a Chinese paragraph, where short
 * sentences share a line. A wider mark (the ✓+ of a Passage that can become the
 * Citation) starts the row by its own width. At 760px a mark that would pass the
 * pane's edge goes under the line's first mark, 4px below. Under 760px nothing
 * changes: the marks stand in the text after their sentences. Asserted by
 * relation, never by pixel.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

const FIRST = "潮汐由月球引起。";
const SECOND = "潮水每天涨落两次。";
const THIRD = "海水被月亮吸引。";
const PARAGRAPH = `${FIRST}${SECOND}${THIRD}`;

/** A supported sentence, whose mark carries its +, beside an unsupported one. */
const PAIR = "Spring tides happen at full moon. Unicorns graze outside.";

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
const textColumn = (editor: Locator) =>
  editor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return { x: rect.left + left, width: rect.width - left - right };
  });

/** The editor's first paragraph: the checked sentences' own line. */
const paragraphOf = (editor: Locator) => editor.locator(":scope > p").first();

/** Waits until nothing is moving, a mark's entrance included: it slides in 4px while it plays. */
const settle = async (window: Page) => {
  await motionSettled(window);
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
};

const screenshot = async (window: Page, name: string) => {
  if (!SHOTS) return;
  await settle(window);
  await window.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** Waits until every mark has its verdict: no mark is still checking. */
const marksDone = (window: Page) =>
  expect(window.locator('[data-testid="claim-mark"][data-check="checking"]')).toHaveCount(0, {
    timeout: 60_000,
  });

/** Checks a paragraph's sentences as one selection, through the selection menu, as a person would. */
async function check(window: Page, editor: Locator, text: string) {
  await slideSelect(window, paragraphOf(editor), text);
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
  );
}

for (const language of ["en", "zh-CN"] as const) {
  test(`three Chinese sentences on one line put their marks side by side, level with it, and all move into the text under 760px (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1400, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    await sizeMind(app, window, 1100);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [{ type: "paragraph", content: [{ type: "text", text: PARAGRAPH }] }],
    );
    await check(window, editor, PARAGRAPH);
    const marks = window.getByTestId("margin-checks").getByTestId("claim-mark");
    await expect(marks).toHaveCount(3, { timeout: 60_000 });
    await marksDone(window);

    // The shots come first, so a run on the column before this change still records the "before".
    for (const width of [1100, 760, 700]) {
      await sizeMind(app, window, width);
      await screenshot(window, `margin-marks-${language}-${width}`);
    }

    // At 1100px all three sentences start on the paragraph's one line: their marks are level with
    // it and with each other, side by side in reading order, 4px apart.
    await sizeMind(app, window, 1100);
    await settle(window);
    const text = await textColumn(editor);
    const line = await box(paragraphOf(editor));
    const layer = await box(window.getByTestId("margin-checks"));
    expect
      .soft(layer.x, "the margin layer starts at the measure's right edge")
      .toBeGreaterThanOrEqual(text.x + text.width - 2);
    expect
      .soft(layer.x, "the margin layer starts at the measure's right edge")
      .toBeLessThanOrEqual(text.x + text.width + 2);
    const opening = await box(marks.nth(0));
    const row = [opening, await box(marks.nth(1)), await box(marks.nth(2))];
    for (const [at, mark] of row.entries()) {
      const middle = mark.y + mark.height / 2;
      expect
        .soft(middle, `mark ${at + 1} is level with the sentence's first line`)
        .toBeGreaterThanOrEqual(line.y - 1);
      expect
        .soft(middle, `mark ${at + 1} is level with the sentence's first line`)
        .toBeLessThanOrEqual(line.y + line.height + 1);
    }
    for (const [at, mark] of row.entries()) {
      const previous = row[at - 1];
      if (!previous) continue;
      // Each starts 4px after the one before it, by that mark's own rendered width.
      const gap = mark.x - (previous.x + previous.width);
      expect
        .soft(gap, `mark ${at + 1} stands 4px after the one before`)
        .toBeGreaterThanOrEqual(4 - 1.5);
      expect
        .soft(gap, `mark ${at + 1} stands 4px after the one before`)
        .toBeLessThanOrEqual(4 + 1.5);
      expect
        .soft(Math.abs(mark.y - previous.y), `mark ${at + 1} keeps the line`)
        .toBeLessThanOrEqual(1);
    }
    expect
      .soft(opening.x, "the first mark's left edge is 8px after the measure")
      .toBeGreaterThanOrEqual(layer.x + 8 - 1);
    expect
      .soft(opening.x, "the first mark's left edge is 8px after the measure")
      .toBeLessThanOrEqual(layer.x + 8 + 1);
    // A mark on a line with another shows no label beside it: its short label is its tooltip.
    const label = await marks.nth(1).getAttribute("aria-label");
    expect(label, "a mark names its sentence").toBeTruthy();
    expect(await marks.nth(1).getAttribute("title"), "its short label is its tooltip").toBe(label);
    expect((await marks.nth(1).innerText()).trim()).not.toContain(label ?? "");

    // The column's own threshold, about 805px: just under it two marks stack, just above they sit
    // side by side. Both widths change the pane alone, with no edit, so the marks must be placed
    // again by the pane's own width; each mark still ends 8px inside the pane.
    await sizeMind(app, window, 800);
    await settle(window);
    const paneAt800 = await box(window.getByTestId("mind-scroller"));
    const stacked = [await box(marks.nth(0)), await box(marks.nth(1)), await box(marks.nth(2))];
    expect
      .soft(stacked[1]?.y, "just under the threshold the second mark goes under the first")
      .toBeGreaterThanOrEqual((stacked[0]?.y ?? 0) + (stacked[0]?.height ?? 18) - 1);
    expect
      .soft(stacked[1]?.x, "under the line's first mark")
      .toBeLessThanOrEqual((stacked[0]?.x ?? 0) + 1);
    for (const mark of stacked)
      expect
        .soft(
          paneAt800.x + paneAt800.width - ((mark?.x ?? 0) + (mark?.width ?? 0)),
          "a mark ends at least 8px inside the pane",
        )
        .toBeGreaterThanOrEqual(8 - 1);
    await sizeMind(app, window, 810);
    await settle(window);
    const pair = [await box(marks.nth(0)), await box(marks.nth(1))];
    expect
      .soft(
        Math.abs((pair[1]?.y ?? 0) - (pair[0]?.y ?? 0)),
        "just above the threshold they share a line",
      )
      .toBeLessThanOrEqual(1);
    const pairGap = (pair[1]?.x ?? 0) - ((pair[0]?.x ?? 0) + (pair[0]?.width ?? 0));
    expect
      .soft(pairGap, "the second mark stands 4px after the first")
      .toBeGreaterThanOrEqual(4 - 1.5);
    expect.soft(pairGap, "the second mark stands 4px after the first").toBeLessThanOrEqual(4 + 1.5);
    expect
      .soft((await box(marks.nth(2))).y, "the third goes under them")
      .toBeGreaterThan((pair[0]?.y ?? 0) + (pair[0]?.height ?? 18) - 1);

    // At 760px the pane's margin is 40px: the second mark would pass its edge, so it goes under
    // the line's first, 4px below, and the third under the second. All keep the first's left.
    // A column that rounds to 759px would fold instead, so it is sized just above the fold then.
    await sizeMind(app, window, 760);
    if ((await box(window.locator(".mind-column"))).width < 760) await sizeMind(app, window, 761);
    await settle(window);
    const pane = await box(window.getByTestId("mind-scroller"));
    const narrow = [await box(marks.nth(0)), await box(marks.nth(1)), await box(marks.nth(2))];
    for (const mark of narrow)
      expect
        .soft(
          pane.x + pane.width - (mark.x + mark.width),
          "a mark ends at least 8px inside the pane",
        )
        .toBeGreaterThanOrEqual(8 - 1);
    for (const [at, mark] of narrow.entries()) {
      const above = narrow[at - 1];
      if (!above) continue;
      expect
        .soft(mark.x - above.x, `mark ${at + 1} stands under the line's first mark`)
        .toBeLessThanOrEqual(1);
      expect
        .soft(mark.y - above.y, `mark ${at + 1} stands under the one before`)
        .toBeGreaterThanOrEqual(above.height + 4 - 1);
      expect
        .soft(mark.y - above.y - above.height, `mark ${at + 1} stands 4px below it`)
        .toBeLessThanOrEqual(4 + 2);
    }

    // Under 760px nothing changes: every mark stands in the text, after its sentence.
    await sizeMind(app, window, 700);
    await settle(window);
    const folded = await textColumn(editor);
    const inline = [await box(marks.nth(0)), await box(marks.nth(1)), await box(marks.nth(2))];
    for (const [at, mark] of inline.entries()) {
      await expect(marks.nth(at)).toHaveClass(/claim-mark--inline/);
      expect.soft(mark.x, `mark ${at + 1} stands in the text`).toBeGreaterThanOrEqual(folded.x - 1);
      expect
        .soft(mark.x + mark.width, `mark ${at + 1} ends in the text`)
        .toBeLessThanOrEqual(folded.x + folded.width + 1);
    }

    // A Note split beside another group, then a 1,100px window with the assistant open: wherever
    // the marks stand, each stays after the text edge and inside its pane.
    await sizeMind(app, window, 900);
    await setGroupBeside(window, true);
    for (const step of ["split", "assistant"] as const) {
      if (step === "assistant") {
        await setGroupBeside(window, false);
        await setWindowSize(app, window, 1100, 900);
      }
      await settle(window);
      await expect(window.getByTestId("assistant")).toBeVisible();
      const edge = await textColumn(editor);
      const view = await box(window.getByTestId("mind-scroller"));
      for (const mark of await marks.all()) {
        const rect = await box(mark);
        expect
          .soft(rect.x, `${step}: a mark starts after the text edge`)
          .toBeGreaterThanOrEqual(edge.x - 1);
        expect
          .soft(rect.x + rect.width, `${step}: a mark ends inside the pane`)
          .toBeLessThanOrEqual(view.x + view.width + 0.5);
      }
      await screenshot(window, `margin-marks-${language}-${step}`);
    }
    await app.close();
  });
}

test("a wider ✓+ starts its row by its own width, its neighbour 4px after it and on its line", async () => {
  test.setTimeout(180_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1400, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await sizeMind(app, window, 1100);
  const editor = window.getByTestId("mind-editor");
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [{ type: "paragraph", content: [{ type: "text", text: PAIR }] }],
  );
  await check(window, editor, PAIR);
  const marks = window.getByTestId("margin-checks").getByTestId("claim-mark");
  await expect(marks).toHaveCount(2, { timeout: 60_000 });
  await marksDone(window);
  // The first mark's Passage can become its Citation, so it draws wider with its +.
  await expect(marks.nth(0)).toHaveAttribute("data-addable", "true");
  await expect(marks.nth(1)).not.toHaveAttribute("data-addable");
  await settle(window);
  const plus = await box(marks.nth(0));
  const plain = await box(marks.nth(1));
  expect.soft(plus.width, "the flagged mark is wider than a plain ✓").toBeGreaterThan(19 + 1);
  expect.soft(plain.y - plus.y, "the two marks share the line's top").toBeLessThanOrEqual(1);
  const gap = plain.x - (plus.x + plus.width);
  expect.soft(gap, "the plain mark stands 4px after the wider one").toBeGreaterThanOrEqual(4 - 1.5);
  expect.soft(gap, "the plain mark stands 4px after the wider one").toBeLessThanOrEqual(4 + 1.5);
  await screenshot(window, "margin-marks-plus-1100");
  await app.close();
});
