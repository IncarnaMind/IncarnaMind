import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askToChange,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  leaveText,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * A mark sits beside its own sentence, never at the top of the page (#2313):
 * an edit that replaces four paragraphs shows its "Was: …" line over each, the
 * old text hidden, and the checks those sentences keep must not fall to the
 * top while it waits, nor after it lands. The scripted model
 * (src/main/fakeChat/edit.ts) writes "rewrite it to be clearer" (写清楚) as a
 * new line in each paragraph, which waits for the User: it takes out most of
 * their own text. The fifth paragraph is left as it was, its mark beside its
 * own sentence throughout. Set INCARNAMIND_SCREENSHOTS to a folder to also
 * save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

// The four rewritten sentences are long enough that their new lines remove most of the selection,
// so the edit waits for the User; the fifth is left alone, its mark a control.
const TIDES = buildPdf([
  {
    lines: [
      "Spring and neap tides",
      "Spring tides happen at new moon and at full moon, as the tide tables say.",
    ],
  },
  {
    lines: [
      "Harbour times",
      "Harbours publish the times of high water every 12 months in the local press.",
    ],
  },
  {
    lines: [
      "Ferry timetable",
      "The ferry runs twice a day in summer across the harbour to the island.",
    ],
  },
  { lines: ["Storm warning", "Storms can raise the water by a metre along the harbour wall."] },
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
]);

const SENTENCES = [
  "Spring tides happen at new moon and at full moon, as the tide tables say.",
  "Harbours publish the times of high water every 12 months in the local press.",
  "The ferry runs twice a day in summer across the harbour to the island.",
  "Storms can raise the water by a metre along the harbour wall.",
  "The Moon raises two bulges of water on the Earth.",
];

/** Where each sentence's Citation marker stands in it: after the clause it quotes, inside the sentence. */
const CITED_UP_TO = ["at full moon", "every 12 months", "in summer", "by a metre", "on the Earth."];

/** The new line the scripted model writes in place of each of the four paragraphs it changes. */
const REWRITTEN = [
  "Gulls wheel over the quay at dawn.",
  "Boats rest on the mud at low water.",
  "Gulls circle buoy 2.",
  "Gulls circle buoy 3.",
];

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

/** Waits until nothing is moving, a mark's entrance included. */
const settle = async (window: Page) => {
  await motionSettled(window);
  await window.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );
  await window.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
};

const paragraphsOf = (editor: Locator) => editor.locator(":scope > p");

/** The check id of the mark a paragraph's sentence carries, from its marked span. */
const claimOf = (paragraph: Locator) =>
  paragraph.locator("[data-claim-check]").first().getAttribute("data-claim-check");

/**
 * The line boxes of a paragraph's visible text: the one holding a check's marked sentence, or the
 * one given. A run a waiting change hid draws none.
 */
const textLines = (target: Locator, claim: string | null) =>
  target.evaluate((element, id) => {
    const paragraph =
      id === null
        ? element
        : element.querySelector(`[data-claim-check="${CSS.escape(id)}"]`)?.closest("p");
    if (!paragraph) return [];
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    return [...range.getClientRects()]
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .map((rect) => ({ top: rect.top, bottom: rect.bottom }));
  }, claim);

/**
 * Every mark in the check gutter stands level with a line of the sentence it
 * checks, and none above the first block: the place the report saw them pile up.
 */
async function expectMarksBesideLines(window: Page, editor: Locator) {
  const first = await box(paragraphsOf(editor).first());
  const marks = window.getByTestId("margin-checks").getByTestId("claim-mark");
  const found = await marks.all();
  expect(found.length, "the Note keeps a mark to place").toBeGreaterThan(0);
  for (const [at, mark] of found.entries()) {
    const rect = await box(mark);
    const id = await mark.getAttribute("data-claim");
    const lines = id === null ? [] : await textLines(editor, id);
    expect
      .soft(rect.y, `mark ${at + 1} sits above the first block`)
      .toBeGreaterThanOrEqual(first.y - 2);
    expect
      .soft(
        lines.some((line) => rect.y >= line.top - 2 && rect.y <= line.bottom + 2),
        `mark ${at + 1} stands beside a line of its own sentence`,
      )
      .toBe(true);
  }
}

/** The mark of the fifth paragraph, which the edit leaves alone, level with its sentence. */
async function expectControlMark(window: Page, editor: Locator) {
  const paragraph = paragraphsOf(editor).nth(4);
  const id = await claimOf(paragraph);
  expect(id, "the fifth sentence keeps its check").toBeTruthy();
  const mark = window.getByTestId("margin-checks").locator(`[data-claim="${id}"]`);
  await expect(mark, "the unchanged sentence keeps its mark").toHaveCount(1);
  const rect = await box(mark);
  const lines = await textLines(paragraph, null);
  expect
    .soft(
      lines.some((line) => rect.y >= line.top - 2 && rect.y <= line.bottom + 2),
      "the unchanged sentence's mark is level with a line of its sentence",
    )
    .toBe(true);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`an edit that rewrites four paragraphs keeps every mark beside a line, never above the first block, at 1,440 and 900 px (${language})`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const cite = (page: number, quote: string) => ({
      type: "citation",
      attrs: {
        passageId: `passage-${page}`,
        documentId: tides?.id,
        documentName: "Tides",
        contentHash: tides?.contentHash,
        pageFrom: page,
        pageTo: page,
        location: null,
        quote,
        check: "found",
        checkReason: null,
      },
    });

    /** A paragraph: its sentence, its Citation marker after the clause it quotes. */
    const citedSentence = (sentence: string, upTo: string, page: number) => {
      const end = sentence.indexOf(upTo) + upTo.length;
      if (end < upTo.length) throw new Error(`“${upTo}” isn't in “${sentence}”.`);
      const content: object[] = [
        { type: "text", text: sentence.slice(0, end) },
        cite(page, SENTENCES[page - 1] ?? ""),
      ];
      const rest = sentence.slice(end);
      if (rest !== "") content.push({ type: "text", text: rest });
      return { type: "paragraph", content };
    };

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      SENTENCES.map((sentence, at) => citedSentence(sentence, CITED_UP_TO[at] ?? "", at + 1)),
    );
    const paragraphs = paragraphsOf(editor);
    await expect(paragraphs.nth(4)).toContainText(SENTENCES[4] ?? "");

    // Every sentence checked against the Document its Citation quotes.
    await slideSelect(window, paragraphs.first(), "Spring tides", {
      line: paragraphs.nth(4),
      words: "the Earth.",
    });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("margin-checks").getByTestId("claim-mark");
    await expect(marks).toHaveCount(5, { timeout: 60_000 });
    await expect(
      window.locator('[data-testid="claim-mark"][data-check="checking"]'),
      "every mark has its verdict",
    ).toHaveCount(0, { timeout: 60_000 });
    await settle(window);
    await expectMarksBesideLines(window, editor);

    // Four paragraphs rewritten: each shows its new line whole, its old text one "Was: …" line
    // above it, and the change waits for the User.
    await slideSelect(window, paragraphs.first(), "Spring tides", {
      line: paragraphs.nth(3),
      words: "harbour wall.",
    });
    await askToChange(window, language === "en" ? "rewrite it to be clearer" : "写清楚");
    const line = editor.getByTestId("applied-line");
    await expect(
      editor.getByTestId("change-was-line"),
      "one Was line per rewritten paragraph",
    ).toHaveCount(4, { timeout: 60_000 });
    await expect(line.getByTestId("applied-apply")).toBeVisible();
    await expect(paragraphs.nth(0).locator("ins.proposal-insert")).toHaveText(REWRITTEN[0] ?? "");
    await settle(window);

    // While it waits, at both widths: every checked sentence keeps its mark, each beside a line
    // of its own sentence, and none above the first block.
    const rechecks = window.locator('[data-testid="claim-mark"][data-check="needs-recheck"]');
    await screenshot(window, `marks-during-edit-${language}-1440`);
    await expect(marks, "every checked sentence keeps a mark while the edit waits").toHaveCount(5);
    await expectMarksBesideLines(window, editor);
    await expectControlMark(window, editor);

    await setWindowSize(app, window, 900, 900);
    await settle(window);
    await screenshot(window, `marks-during-edit-${language}-900`);
    await expect(marks).toHaveCount(5);
    await expectMarksBesideLines(window, editor);
    await expectControlMark(window, editor);

    // Discard takes the waiting change away: the old sentences return with their five checks.
    await pointAndClick(window, line.getByTestId("applied-discard"));
    await expect(editor.getByTestId("change-was-line")).toHaveCount(0, { timeout: 60_000 });
    await settle(window);
    await expect(marks).toHaveCount(5);
    await expect(rechecks).toHaveCount(0);
    await expectMarksBesideLines(window, editor);
    await expectControlMark(window, editor);

    // Asked again and applied: each new line carries its replaced sentence's check, four needing a
    // re-check, beside the new words.
    await slideSelect(window, paragraphs.first(), "Spring tides", {
      line: paragraphs.nth(3),
      words: "harbour wall.",
    });
    await askToChange(window, language === "en" ? "rewrite it to be clearer" : "写清楚");
    await expect(editor.getByTestId("change-was-line")).toHaveCount(4, { timeout: 60_000 });
    await expect(line.getByTestId("applied-apply")).toBeVisible();
    await settle(window);
    await pointAndClick(window, line.getByTestId("applied-apply"));
    await expect(paragraphs.nth(0)).toHaveText(REWRITTEN[0] ?? "", { timeout: 60_000 });
    await expect(paragraphs.nth(4)).toContainText(SENTENCES[4] ?? "");
    await expect(editor.getByTestId("change-was-line")).toHaveCount(0);
    await settle(window);
    await screenshot(window, `marks-after-edit-${language}-900`);
    await expect(marks, "every check keeps a mark after Apply").toHaveCount(5);
    await expect(rechecks, "four checks need a re-check after Apply").toHaveCount(4);
    await expectMarksBesideLines(window, editor);
    await expectControlMark(window, editor);

    await setWindowSize(app, window, 1440, 900);
    await settle(window);
    await screenshot(window, `marks-after-edit-${language}-1440`);
    await expect(marks).toHaveCount(5);
    await expect(rechecks).toHaveCount(4);
    await expectMarksBesideLines(window, editor);
    await expectControlMark(window, editor);

    // Undo takes the applied change away too: the old sentences return with their five checks.
    await leaveText(window);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs.nth(0)).toContainText(
      "Spring tides happen at new moon and at full moon",
      { timeout: 60_000 },
    );
    await expect(paragraphs.nth(0)).not.toContainText(REWRITTEN[0] ?? "");
    await settle(window);
    await expect(marks).toHaveCount(5);
    await expect(rechecks).toHaveCount(0);
    await expectMarksBesideLines(window, editor);
    await expectControlMark(window, editor);
    await app.close();
  });
}
