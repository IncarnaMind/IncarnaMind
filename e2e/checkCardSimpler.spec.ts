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
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  openCardMenu,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The check card shows one thing to decide, and the rest waits behind a click (#2869): one
 * verdict; the sentence once, with the part that needs a look marked in it; that part's reason and
 * one quote with its Location; the card's two buttons and its one ⋯; the parts that are fine
 * folded into one line at the foot, which Show opens in place and Hide folds; one "Checked by me"
 * that signs every Citation of the sentence; and how the check was made under About this check.
 * The checks are written into the page, so no model is involved.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const REPORT = buildPdf([
  { lines: ["Northwind Retail Q3 2026 results", "Underlying EBITDA was 96 million."] },
  { lines: ["Summary", "Underlying EBITDA: 96 million"] },
  { lines: ["Stores", "We continued to open new stores across the north of England."] },
]);

const WORDS = {
  en: {
    fact: "Underlying EBITDA was £96 million in the third quarter",
    stores: "the group opened 14 new stores",
    joined: (fact: string, stores: string) => `${fact}, and ${stores}.`,
    contradicted: "Underlying EBITDA was £118 million in the third quarter",
    says: "The Document gives £96 million, not £118 million.",
    long: "Across the north of England, through a quarter in which the weather was poor and footfall fell in most of its regions while its rivals closed shops,",
    quotes: [
      "Underlying EBITDA was £96 million, against £118 million a year earlier.",
      "Underlying EBITDA: £96 million",
      "We continued to open new stores across the north of England.",
    ],
    reason: "The Document says new stores opened this quarter, but gives no number.",
    page: (number: number) => `p. ${number}`,
  },
  "zh-CN": {
    fact: "第三季度基础 EBITDA 为 9,600 万英镑",
    stores: "公司同期新开了 14 家门店",
    joined: (fact: string, stores: string) => `${fact}，${stores}。`,
    contradicted: "第三季度基础 EBITDA 为 1.18 亿英镑",
    says: "文档写的是 9,600 万英镑，不是 1.18 亿英镑。",
    long: "在英格兰北部，这个季度天气不好，大部分地区的客流都在下降，竞争对手也在关店，",
    quotes: [
      "基础 EBITDA 为 9,600 万英镑，上年同期为 1.18 亿英镑。",
      "基础 EBITDA：9,600 万英镑",
      "本季度继续在英格兰北部开设新店。",
    ],
    reason: "文档提到本季度新开门店，但没有写数量。",
    page: (number: number) => `第 ${number} 页`,
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

const CHECKED_AT = "2026-11-14T09:30:00.000Z";

type Words = (typeof WORDS)[keyof typeof WORDS];

/** The report added, a Note open, and the window as wide as asked. */
async function launched(language: "en" | "zh-CN", width: number) {
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
  const quote = (id: string, text: string, page: number) => ({
    id,
    passageId: `passage-${id}`,
    documentId: report.id,
    documentName: "Northwind Retail · Q3 2026 results",
    contentHash: report.contentHash,
    pageFrom: page,
    pageTo: page,
    location: null,
    quote: text,
    check: "found",
    checkReason: null,
  });
  return { app, window, quote };
}

const part = (
  text: string,
  words: string,
  verdict: string,
  evidence: object[],
  more: Record<string, unknown> = {},
) => {
  const start = text.indexOf(words);
  return {
    span: { start, end: start + words.length },
    kind: "fact",
    verdict,
    evidence,
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    versions: [],
    excluded: [],
    citedCaseUnchecked: false,
    citedCaseFound: false,
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    checkedAt: CHECKED_AT,
    ...more,
  };
};

const claimCheck = (id: string, state: string, text: string, extra: Record<string, unknown>) => ({
  type: "claimCheck",
  attrs: {
    id,
    request: "check-1",
    action: "check-against-documents",
    state,
    text,
    evidence: null,
    says: null,
    unsupported: null,
    calculation: null,
    reason: null,
    detail: null,
    providerId: "anthropic",
    modelId: "claude-haiku-5-5",
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    checkedAt: CHECKED_AT,
    ...extra,
  },
});

async function write(window: Page, paragraphs: object[][]) {
  await window.getByTestId("mind-editor").evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.setContent(content);
    },
    { type: "doc", content: paragraphs.map((content) => ({ type: "paragraph", content })) },
  );
}

/** The card's words a person sees: nothing a screen reader alone is told. */
const seen = (card: Locator) =>
  card.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll('.sr-only, [role="menu"], .claim-quote-menu'))
      hidden.remove();
    return copy.textContent ?? "";
  });

const count = (text: string, words: string) => text.split(words).length - 1;

/** Nothing in the card reaches past its edge, and the card is inside the window. */
async function nothingClipped(window: Page, card: Locator) {
  const reach = await card.evaluate((element) => {
    const edge = element.getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>("p, button, li, span")]
      .filter((each) => each.checkVisibility() && !each.closest('[role="menu"], .sr-only'))
      .map((each) => ({
        over: each.getBoundingClientRect().right - edge.right,
        cut: each.scrollWidth - each.clientWidth,
        clamped: each.classList.contains("claim-card-sentence"),
      }))
      .filter(({ over, cut, clamped }) => over > 1 || (!clamped && cut > 1));
  });
  expect(reach).toEqual([]);
  const box = await card.boundingBox();
  const size = window.viewportSize();
  if (!box || !size) throw new Error("The card isn't laid out.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
}

/** The sentence of two parts, the second found nowhere, citing the first's Passage. */
async function twoParts(
  window: Page,
  words: Words,
  quote: (id: string, text: string, page: number) => object,
) {
  const text = words.joined(words.fact, words.stores);
  const [ebitda, summary, stores] = [
    quote("q-ebitda", words.quotes[0], 1),
    quote("q-summary", words.quotes[1], 2),
    quote("q-stores", words.quotes[2], 3),
  ];
  const mark = claimCheck("two-parts", "unsupported", text, {
    unsupported: { reason: null, covered: words.fact, uncovered: words.stores },
    parts: [
      part(text, words.fact, "supported", [ebitda, summary]),
      part(text, words.stores, "unsupported", [stores], {
        unsupported: { reason: words.reason, covered: null, uncovered: null, found: true },
      }),
    ],
  });
  const at = words.fact.length;
  await write(window, [
    [
      { type: "text", text: text.slice(0, at), marks: [mark] },
      { type: "citation", attrs: { ...ebitda, id: "cited-ebitda" } },
      { type: "text", text: text.slice(at), marks: [mark] },
    ],
  ]);
  return text;
}

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  const t = (key: MessageKey, params?: Record<string, string | number>) =>
    translate(language, key, params);

  test(`a sentence in two parts, one unsupported: one verdict, the part marked, its reason and one quote, two buttons, one ⋯, the other part behind Show (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const { app, window, quote } = await launched(language, width);
    const text = await twoParts(window, words, quote);
    const card = window.getByTestId("claim-card");
    await pointAndClick(window, window.getByTestId("claim-mark"));
    await expect(card).toHaveAttribute("data-check", "unsupported");
    await motionSettled(window);

    // One verdict line, at the top; no part repeats it.
    await expect(card.locator(".citation-badge")).toHaveCount(1);
    await expect(card.getByTestId("claim-badge")).toHaveText(t("claim.state.unsupported"));
    const rows = card.getByTestId("claim-part");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).not.toContainText(t("claim.why.unsupported"));
    // The sentence once, its unsupported part marked in the verdict's colours, the rest in meta ink.
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${text}”`);
    const mark = card.getByTestId("claim-sentence-mark");
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText(words.stores);
    await expect(mark).toHaveAttribute("data-tone", "unsupported");
    expect(await mark.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("-2px");
    const shown = await seen(card);
    expect(count(shown, words.stores)).toBe(1);
    expect(count(shown, words.fact)).toBe(1);
    // Its reason in one sentence, and one quote with its Location.
    await expect(rows.first().getByTestId("claim-part-reason")).toHaveText(words.reason);
    const receipts = card.getByTestId("claim-part-receipt");
    await expect(receipts).toHaveCount(1);
    await expect(receipts.first().getByTestId("claim-part-citation")).toHaveText(words.quotes[2]);
    await expect(receipts.first().locator(".claim-part-source")).toContainText(words.page(3));
    // Two buttons, the fix first, and one ⋯.
    const buttons = card.locator(".citation-card-actions button");
    await expect(buttons).toHaveCount(2);
    expect(await buttons.evaluateAll((all) => all.map((each) => each.dataset.testid))).toEqual([
      "claim-cut",
      "claim-keep",
    ]);
    await expect(card.getByTestId("check-menu")).toHaveCount(1);
    // The supported part folds into one line at the foot.
    await expect(card.getByTestId("claim-parts-folded")).toHaveText(
      `${t("claim.parts.folded.one")} · ${t("opinions.show")}`,
    );
    // No status line: how it was checked is under ⋯, and "Already cited" is a number.
    for (const line of ["claim-checked-in", "claim-checked-by", "claim-limit"])
      await expect(card.getByTestId(line)).toHaveCount(0);
    await expect(card.getByText(t("claim.alreadyCited"), { exact: true })).toHaveCount(0);
    await nothingClipped(window, card);
    await screenshot(window, `simpler-two-parts-${language}-${width}`);

    // A screen reader is told each part's verdict and reason, in the sentence's order, folded or not.
    await expect(card.getByTestId("claim-parts-read").locator("li")).toHaveText([
      `“${words.fact}” · ${t("claim.state.supported")}`,
      `“${words.stores}” · ${t("claim.why.unsupported")} · ${words.reason}`,
    ]);

    // Show opens the supported part in place with each of its quotes, and Hide folds it, from the
    // keyboard, the focus staying on the control pressed.
    const show = card.getByTestId("claim-parts-show");
    await show.focus();
    for (const round of [1, 2]) {
      await window.keyboard.press("Enter");
      await expect(show).toBeFocused();
      await expect(show).toHaveText(t("claim.parts.hide"));
      await expect(rows).toHaveCount(2);
      await expect(receipts).toHaveCount(3);
      // Marked in the sentence in its own colour while open; its words aren't written again.
      await expect(card.getByTestId("claim-sentence-mark")).toHaveCount(2);
      await expect(card.getByTestId("claim-sentence-mark").first()).toHaveAttribute(
        "data-tone",
        "found",
      );
      expect(count(await seen(card), words.fact)).toBe(1);
      // The quote it cites already carries its number; the other offers Add as Citation.
      await expect(rows.nth(1).getByTestId("claim-part-already-chip")).toHaveText("1");
      await expect(rows.nth(1).getByTestId("claim-part-add-citation")).toHaveText(
        t("claim.addAsCitation"),
      );
      if (round === 1) {
        await nothingClipped(window, card);
        await screenshot(window, `simpler-shown-${language}-${width}`);
      }
      await window.keyboard.press("Enter");
      await expect(show).toBeFocused();
      await expect(show).toHaveText(t("opinions.show"));
      await expect(rows).toHaveCount(1);
    }

    // One "Checked by me": it signs every Citation of the sentence and opens the folded part in the
    // same press; a second press takes it back.
    const sign = card.getByTestId("sign-off-toggle");
    await expect(sign).toHaveCount(1);
    await expect(sign).toHaveText(t("signOff.action"));
    await pointAndClick(window, sign);
    await expect(sign).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(2);
    await expect(window.getByTestId("undo-line")).toContainText(
      t("signOff.addedCount", { count: 3 }),
    );
    await expect(card.getByTestId("sign-off-line")).toHaveCount(0);
    await screenshot(window, `simpler-signed-${language}-${width}`);
    await pointAndClick(window, sign);
    await expect(sign).toHaveAttribute("aria-pressed", "false");
    // A quote's own menu still signs it alone, and that quote says so.
    await pointAndClick(window, receipts.first(), { button: "right" });
    await pointAndClick(
      window,
      window.getByRole("menuitemcheckbox", { name: t("signOff.action") }),
    );
    await expect(receipts.first().getByTestId("sign-off-line")).toHaveAttribute(
      "data-state",
      "checked",
    );
    await expect(sign).toHaveAttribute("aria-pressed", "false");

    // About this check, under ⋯: where it looked, the model and the time; the arrow keys reach it.
    const menu = await openCardMenu(window, card);
    const about = menu.getByRole("group", { name: t("claim.about") });
    await expect(about.getByTestId("claim-checked-in")).toHaveText(
      t("claim.checkedIn", { scope: t("composer.scope.all") }),
    );
    await expect(about.getByTestId("claim-checked-by")).toContainText("Haiku");
    await window.keyboard.press("End");
    await expect(menu.getByTestId("claim-about-lines")).toBeFocused();
    await nothingClipped(window, card);
    await screenshot(window, `simpler-about-${language}-${width}`);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await app.close();
  });

  test(`two parts that need a look are each marked, with their reasons, in the sentence's order; a long sentence keeps its mark in view (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const { app, window, quote } = await launched(language, width);
    const text = words.joined(words.contradicted, words.stores);
    const long = `${words.long}${words.joined(words.fact, words.stores)}`;
    const both = claimCheck("both", "contradicted", text, {
      parts: [
        part(text, words.contradicted, "contradicted", [quote("q-ebitda", words.quotes[0], 1)], {
          says: words.says,
        }),
        part(text, words.stores, "unsupported", [quote("q-stores", words.quotes[2], 3)], {
          unsupported: { reason: words.reason, covered: null, uncovered: null, found: true },
        }),
      ],
    });
    const far = claimCheck("long", "unsupported", long, {
      parts: [
        part(long, words.fact, "supported", [quote("q-fact", words.quotes[0], 1)]),
        part(long, words.stores, "unsupported", [quote("q-far", words.quotes[2], 3)], {
          unsupported: { reason: words.reason, covered: null, uncovered: null, found: true },
        }),
      ],
    });
    await write(window, [
      [{ type: "text", text, marks: [both] }],
      [{ type: "text", text: long, marks: [far] }],
    ]);
    const card = window.getByTestId("claim-card");
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(2);

    await pointAndClick(window, marks.first());
    // The verdict is the worst of them.
    await expect(card.getByTestId("claim-badge")).toHaveText(t("claim.state.contradicted"));
    const sentenceMarks = card.getByTestId("claim-sentence-mark");
    await expect(sentenceMarks).toHaveText([words.contradicted, words.stores]);
    expect(await sentenceMarks.evaluateAll((all) => all.map((each) => each.dataset.tone))).toEqual([
      "contradicted",
      "unsupported",
    ]);
    const rows = card.getByTestId("claim-part");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByTestId("claim-part-reason")).toHaveText(words.says);
    await expect(rows.nth(1).getByTestId("claim-part-reason")).toHaveText(words.reason);
    await expect(card.getByTestId("claim-part-receipt")).toHaveCount(2);
    await expect(card.getByTestId("claim-parts-folded")).toHaveCount(0);
    await nothingClipped(window, card);
    await screenshot(window, `simpler-two-looks-${language}-${width}`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    // A long sentence: the two-line cut starts it later, after "…", so its mark stays in view.
    await pointAndClick(window, marks.nth(1));
    const sentence = card.getByTestId("claim-sentence");
    await expect(sentence).toContainText("…");
    const [line, marked] = await Promise.all([
      sentence.boundingBox(),
      card.getByTestId("claim-sentence-mark").boundingBox(),
    ]);
    if (!line || !marked) throw new Error("The sentence isn't laid out.");
    expect(marked.y + marked.height).toBeLessThanOrEqual(line.y + line.height + 1);
    expect(
      await sentence.evaluate((element) => {
        const height = Number.parseFloat(getComputedStyle(element).lineHeight);
        return Math.round(element.getBoundingClientRect().height / height);
      }),
    ).toBeLessThanOrEqual(2);
    await screenshot(window, `simpler-long-${language}-${width}`);
    await app.close();
  });

  test(`a sentence whose every part is supported: the verdict, the sentence, one quote, its Location with its number and a count of more, and nothing else (${language}, ${width}px)`, async () => {
    test.setTimeout(180_000);
    const words = WORDS[language];
    const { app, window, quote } = await launched(language, width);
    const text = `${words.fact}${language === "en" ? "." : "。"}`;
    const ebitda = quote("q-ebitda", words.quotes[0], 1);
    const fine = claimCheck("fine", "supported", text, {
      parts: [
        part(text, words.fact, "supported", [ebitda, quote("q-summary", words.quotes[1], 2)]),
      ],
    });
    await write(window, [
      [
        { type: "text", text: text.slice(0, -1), marks: [fine] },
        { type: "citation", attrs: { ...ebitda, id: "cited-ebitda" } },
        { type: "text", text: text.slice(-1), marks: [fine] },
      ],
    ]);
    const card = window.getByTestId("claim-card");
    await pointAndClick(window, window.getByTestId("claim-mark"));
    await expect(card.getByTestId("claim-badge")).toHaveText(t("claim.state.supported"));
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${text}”`);
    await expect(card.getByTestId("claim-sentence-mark")).toHaveCount(0);
    const receipts = card.getByTestId("claim-part-receipt");
    await expect(receipts).toHaveCount(1);
    await expect(receipts.first().getByTestId("claim-part-already-chip")).toHaveText("1");
    const more = receipts.first().getByTestId("claim-part-more");
    await expect(more).toHaveText(t("claim.parts.more", { count: "1" }));
    // No part list, no status line, no button: one "Checked by me" for its Citations.
    await expect(card.getByTestId("claim-parts-folded")).toHaveCount(0);
    await expect(card.locator(".citation-card-actions")).toHaveCount(0);
    for (const line of ["claim-checked-in", "claim-checked-by", "claim-limit", "claim-reason"])
      await expect(card.getByTestId(line)).toHaveCount(0);
    await expect(card.getByTestId("sign-off-toggle")).toHaveCount(1);
    await nothingClipped(window, card);
    await screenshot(window, `simpler-fine-${language}-${width}`);
    // The count opens the other quote, and folds it again, keeping the focus.
    await more.focus();
    await window.keyboard.press("Enter");
    await expect(receipts).toHaveCount(2);
    await expect(more).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(receipts).toHaveCount(1);
    // Its limit is said where the check is explained: About this check.
    const menu = await openCardMenu(window, card);
    await expect(menu.getByTestId("claim-limit")).toHaveText(t("claim.limit"));
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await focusSettled(window, window.getByTestId("mind-editor"));
    await app.close();
  });
}
