import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { type MessageKey, translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  markShownFor,
  motionSettled,
  newMind,
  openCardMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * A decision model's Mark rests on the Passage it confirmed (#3118). Its card shows the Passage's
 * line as a quote only where the model is sure that line alone settles the sentence. Otherwise
 * the card names the Document and the place, which opens, and shows no quote; nothing offers to
 * write that line into a Citation; and a Citation the sentence already has there is still named.
 * The checks are written into the page, so no model is involved.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const LINES = {
  ebitda: "Underlying EBITDA was 96 million.",
  stores: "The group opened 14 new stores in the quarter.",
  staff: "Store staff numbers rose to 5,200 by September.",
};

const REPORT = buildPdf([
  { lines: ["Northwind Retail Q3 2026 results", LINES.ebitda] },
  { lines: ["Stores", LINES.stores, LINES.staff] },
]);

const WORDS = {
  en: {
    sure: "Underlying EBITDA was 96 million in the quarter.",
    resting: "Fourteen stores opened in the quarter.",
    cited: "By September the stores employed 5,200 people.",
    page: "p. 2",
  },
  "zh-CN": {
    sure: "本季度基础 EBITDA 为 9,600 万。",
    resting: "本季度新开了 14 家门店。",
    cited: "截至九月，门店员工有 5,200 人。",
    page: "第 2 页",
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

const CHECKED_AT = "2026-11-15T09:30:00.000Z";
const BY = { providerId: "openrouter", modelId: "perplexity/pplx-decider-v1.2" };

/** A one-part Supported Mark of the decision model on `text`, backed by `evidence`. */
const supported = (id: string, text: string, evidence: object, rests: boolean) => ({
  type: "claimCheck",
  attrs: {
    id,
    request: "check-1",
    action: "check-against-documents",
    state: "supported",
    text,
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    ...BY,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: CHECKED_AT,
    parts: [
      {
        span: { start: 0, end: text.length },
        kind: "fact",
        verdict: "supported",
        evidence: [evidence],
        says: null,
        unsupported: null,
        calculation: null,
        reason: null,
        detail: null,
        versions: [],
        excluded: [],
        citedCaseUnchecked: false,
        citedCaseFound: false,
        ...BY,
        checkedAt: CHECKED_AT,
        ...(rests && { restsOnPassage: true }),
      },
    ],
  },
});

/** Nothing in the card reaches past its edge, and the card is inside the window. */
async function nothingClipped(window: Page, card: Locator) {
  const reach = await card.evaluate((element) => {
    const edge = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>("p, button, li, span")]
      .filter(
        (each) =>
          each.checkVisibility({ visibilityProperty: true }) &&
          !each.closest('[role="menu"], .sr-only'),
      )
      .map((each) => ({
        what: `${each.tagName} ${each.dataset.testid ?? each.className}`,
        over: each.getBoundingClientRect().right - edge.right,
        cut: each.scrollWidth - each.clientWidth,
        clamped: each.classList.contains("claim-card-sentence"),
      }))
      .filter(({ over, cut, clamped }) => over > 1 || (!clamped && cut > 1));
  });
  expect(reach).toEqual([]);
  const box = await card.boundingBox();
  if (!box) throw new Error("The card isn't laid out.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(await window.evaluate(() => globalThis.innerWidth));
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  test(`a Mark that rests on its Passage shows no quote: its place is named and opens, nothing writes its line, and the Citation already there is named (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Northwind Retail Q3 2026 results.pdf"), REPORT);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await chooseScriptedModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    await addDocuments(window, [join(sources, "Northwind Retail Q3 2026 results.pdf")]);
    const [report] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    if (!report) throw new Error("The report wasn't added.");
    await newMind(window);
    const line = (id: string, text: string, page: number) => ({
      id,
      passageId: `passage-${id}`,
      documentId: report.id,
      documentName: "Northwind Retail Q3 2026 results",
      contentHash: report.contentHash,
      pageFrom: page,
      pageTo: page,
      location: null,
      quote: text,
      check: "found",
      checkReason: null,
    });
    const marks = {
      sure: supported("sure", words.sure, line("l-ebitda", LINES.ebitda, 1), false),
      resting: supported("resting", words.resting, line("l-stores", LINES.stores, 2), true),
      cited: supported("cited", words.cited, line("l-staff", LINES.staff, 2), true),
    };
    await window.getByTestId("mind-editor").evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.setContent(content);
      },
      {
        type: "doc",
        content: [
          [{ type: "text", text: words.sure, marks: [marks.sure] }],
          [{ type: "text", text: words.resting, marks: [marks.resting] }],
          [
            { type: "text", text: words.cited, marks: [marks.cited] },
            { type: "citation", attrs: { ...line("c-staff", LINES.staff, 2), id: "cited-staff" } },
          ],
        ].map((content) => ({ type: "paragraph", content })),
      },
    );
    const mark = (id: string) => window.locator(`[data-testid="claim-mark"][data-claim="${id}"]`);
    const card = window.getByTestId("claim-card");
    const open = async (id: keyof typeof marks) => {
      await markShownFor(window, mark(id));
      await pointAndClick(window, mark(id));
      await expect(card).toBeVisible();
      await expect(card.getByTestId("claim-sentence")).toHaveText(`“${words[id]}”`);
      await motionSettled(window);
    };
    const close = async () => {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
    };

    // The page offers its "+" only where a line may become a Citation.
    await expect(mark("sure")).toHaveAttribute("data-addable", "true");
    for (const id of ["resting", "cited"])
      await expect(mark(id)).not.toHaveAttribute("data-addable", "true");

    // Sure of its line alone: the line is the quote, and it can be added as a Citation.
    await open("sure");
    await expect(card.getByTestId("claim-quote")).toHaveText(LINES.ebitda);
    await expect(card.getByTestId("claim-add-citation")).toHaveText(t("claim.addAsCitation"));
    await expect(card.getByTestId("claim-open-place")).toHaveCount(0);
    await screenshot(window, `resting-sure-${language}-${width}`);
    await close();

    // Already cited there: the Citation's number is named, and still no quote.
    await open("cited");
    await expect(card.getByTestId("claim-already-chip")).toHaveText("1");
    await expect(card.getByTestId("claim-quote")).toHaveCount(0);
    await expect(card).not.toContainText(LINES.staff);
    await expect(card.getByTestId("claim-open-place")).toHaveText(t("citation.open.page"));
    await expect(card.getByTestId("claim-add-citation")).toHaveCount(0);
    await nothingClipped(window, card);
    await screenshot(window, `resting-already-cited-${language}-${width}`);
    await close();

    // Resting on its Passage: no quote anywhere on the card, the Document and the place, and Open.
    await open("resting");
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-quote")).toHaveCount(0);
    await expect(card.getByTestId("claim-open-quote")).toHaveCount(0);
    await expect(card).not.toContainText(LINES.stores);
    const where = card.getByTestId("claim-where");
    await expect(where.getByTestId("claim-source")).toContainText("Northwind Retail");
    await expect(where.getByTestId("claim-source")).toContainText(words.page);
    await expect(card.getByTestId("claim-add-citation")).toHaveCount(0);
    await expect(card.getByTestId("claim-already-chip")).toHaveCount(0);
    const openPlace = card.getByTestId("claim-open-place");
    await expect(openPlace).toHaveText(t("citation.open.page"));
    await nothingClipped(window, card);
    await screenshot(window, `resting-no-quote-${language}-${width}`);
    // Its ⋯ offers nothing that writes a Citation either, and still opens the page first.
    const menu = await openCardMenu(window, card);
    await expect(menu.getByRole("menuitem").first()).toHaveAttribute("data-testid", "claim-open");
    await expect(menu.getByText(t("claim.addAsCitation"), { exact: true })).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    // The keyboard reaches Open, and it opens the Document at the stored line.
    await openPlace.focus();
    await expect(openPlace).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(
      window.getByTestId("viewer").locator('[data-page-number="2"] [data-quote-highlight]').first(),
    ).toBeVisible();
    await app.close();
  });
}
