import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  assistantAnswers,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  paintOf,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  tokenColor,
  useLocalChatModel,
} from "./app";

/*
 * The margin holds one mark per sentence, its verdict (#1112); a Citation's own state shows on
 * its marker in the text: neutral when its quote is found, warning when it isn't, error when the
 * Document now says otherwise. Colour is never the only signal: every state but found has its
 * icon on the marker ("?" for a quote that isn't there, never the "!" of an unsupported sentence). One page holds a supported sentence, an unsupported one with two found
 * Citations, a contradicted one, a supported one whose Citation isn't found, and two unchecked
 * ones: a quote that isn't found, and a Citation to a Document that is gone (can't check). The
 * scripted model (src/main/fakeChat/checks.ts) gives the verdicts.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = {
  supported: "Spring tides happen at new and full moon.",
  unsupported:
    "Harbours publish the times of high water every 12 months, and a scaling constraint applies.",
  contradicted: "Harbours publish the times of high water every 6 months.",
  supportedMissing: "Spring tides come at new moon and full moon, say the tide tables.",
  notFound: "The Moon raises two bulges of water on the Earth.",
  cantCheck: "A source that was deleted said the Earth has two bulges.",
  checking: "A check of this one is still on its way.",
};

const LANGUAGES = {
  en: {
    found: /Quote found/,
    notFound: /Quote not found/,
    contradicted: /Contradicted/,
    cantCheck: /Can’t check/,
    marks: [
      "Supported",
      "Needs a look · Unsupported",
      "Needs a look · Contradicted",
      "Supported",
    ].map((state) => `Sentence check: ${state}`),
    health: { found: "3 Citations found", notFound: "2 Citations not found" },
  },
  "zh-CN": {
    found: /已在.*找到引文/,
    notFound: /未在.*找到引文/,
    contradicted: /与文档矛盾/,
    cantCheck: /无法核对/,
    marks: ["有依据", "需要留意：无依据", "需要留意：与文档矛盾", "有依据"].map(
      (state) => `句子核对：${state}`,
    ),
    health: { found: "3 处引用已找到", notFound: "2 处引用未找到" },
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

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't visible.");
  return found;
}

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];
  test(`a sentence has one mark in the margin, its verdict, and a Citation's state shows on its marker, at 1,440 and 900 px (${language})`, async () => {
    test.setTimeout(180_000);
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
    const cite = (
      page: number,
      quote: string,
      check: string,
      checkReason: string | null = null,
    ) => ({
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
        check,
        checkReason,
      },
    });
    const text = (value: string) => ({ type: "text", text: value });
    const paragraph = (...content: object[]) => ({ type: "paragraph", content });
    const springQuote = "Spring tides happen at new moon and at full moon.";
    const harbourQuote = "Harbours publish the times of high water every 12 months.";

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        paragraph(text(SENTENCES.supported), cite(2, springQuote, "found")),
        paragraph(
          text(SENTENCES.unsupported),
          cite(3, harbourQuote, "found"),
          cite(3, harbourQuote, "found"),
        ),
        paragraph(text(SENTENCES.contradicted), cite(3, harbourQuote, "contradicted")),
        paragraph(
          text(SENTENCES.supportedMissing),
          cite(2, "Neap tides pull the sea out.", "not-found", "quote-not-on-pages"),
        ),
        paragraph(
          text(SENTENCES.notFound),
          cite(2, "Neap tides pull the sea out.", "not-found", "quote-not-on-pages"),
        ),
        paragraph(text(SENTENCES.checking), cite(2, springQuote, "checking")),
        paragraph(text(SENTENCES.cantCheck), {
          ...cite(1, "Two bulges.", "found"),
          attrs: {
            ...cite(1, "Two bulges.", "found").attrs,
            documentId: "deleted-document",
            contentHash: "deleted-hash",
          },
        }),
      ],
    );
    const lines = editor.locator(":scope > p");
    const [supported, unsupported, contradicted, supportedMissing, notFound, checking, cantCheck] =
      [0, 1, 2, 3, 4, 5, 6].map((at) => lines.nth(at));
    if (
      !supported ||
      !unsupported ||
      !contradicted ||
      !supportedMissing ||
      !notFound ||
      !checking ||
      !cantCheck
    )
      throw new Error("No page.");

    // The first four sentences are checked; the last two are left alone.
    await slideSelect(window, supported, "Spring tides", {
      line: supportedMissing,
      words: "tide tables.",
    });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(4);
    for (const [at, check] of ["supported", "unsupported", "contradicted", "supported"].entries()) {
      await expect(marks.nth(at)).toHaveAttribute("data-check", check);
      await expect(marks.nth(at)).toHaveAccessibleName(words.marks[at] ?? "");
    }

    const margin = window.getByTestId("margin-checks");
    const [neutral, neutralInk, metaInk, warningWash, warning, errorWash, error] =
      await Promise.all(
        [
          "--color-chip",
          "--color-ink-secondary",
          "--color-ink-meta",
          "--color-warning-wash",
          "--color-warning",
          "--color-danger-wash",
          "--color-danger",
        ].map((token) => tokenColor(window, token)),
      );
    const iconOf = (marker: Locator) => marker.locator(".citation-marker-icon");

    for (const width of [1440, 900]) {
      await setWindowSize(app, window, width, 900);
      await window.mouse.move(2, 2);
      await motionSettled(window);
      // 900 px is under the 760px fold: the Mind's margins narrow, and nothing else changes.
      const folded = (await box(window.locator(".mind-column"))).width < 760;
      expect(folded, `a ${width}px window folds the Mind`).toBe(width === 900);

      // The margin holds the four sentences' marks, none for a Citation, and none for the
      // sentences that were never checked; each is level with its sentence.
      await expect(margin.getByRole("button")).toHaveCount(4);
      const column = await editor.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { right: rect.right - Number.parseFloat(style.paddingRight) };
      });
      const checked = [supported, unsupported, contradicted, supportedMissing];
      for (const [at, line] of checked.entries()) {
        const [mark, sentence] = [await box(marks.nth(at)), await box(line)];
        const middle = mark.y + mark.height / 2;
        expect
          .soft(middle, `mark ${at + 1} is level with its sentence`)
          .toBeGreaterThanOrEqual(sentence.y);
        expect
          .soft(middle, `mark ${at + 1} is level with its sentence`)
          .toBeLessThanOrEqual(sentence.y + sentence.height);
        expect
          .soft(mark.x, `mark ${at + 1} is right of the text`)
          .toBeGreaterThanOrEqual(column.right - 1);
      }
      for (const line of [notFound, checking, cantCheck]) {
        const unchecked = await box(line);
        for (const mark of await marks.all()) {
          const rect = await box(mark);
          const middle = rect.y + rect.height / 2;
          expect
            .soft(
              middle < unchecked.y || middle > unchecked.y + unchecked.height,
              "no mark by an unchecked sentence",
            )
            .toBe(true);
        }
      }

      // Found: the neutral chip with no icon, under a supported and an unsupported sentence
      // alike: the sentence's verdict never changes its Citations' markers.
      const found = [
        supported.getByTestId("citation-chip"),
        ...(await unsupported.getByTestId("citation-chip").all()),
      ];
      expect(found).toHaveLength(3);
      for (const marker of found) {
        await expect(marker).toHaveAttribute("data-check", "found");
        await expect(marker).toHaveAccessibleName(words.found);
        expect(await paintOf(marker)).toEqual({ background: neutral, color: neutralInk });
        await expect(iconOf(marker)).toBeHidden();
      }

      // Not found, in a sentence found supported and in one nobody checked: warning on its wash
      // with its "?", and nothing in the margin for it.
      for (const line of [supportedMissing, notFound]) {
        const missing = line.getByTestId("citation-chip");
        await expect(missing).toHaveAttribute("data-check", "not-found");
        await expect(missing).toHaveAccessibleName(words.notFound);
        expect(await paintOf(missing)).toEqual({ background: warningWash, color: warning });
        await expect(iconOf(missing)).toBeVisible();
      }

      // The Document now says otherwise: error on a light red wash, with its "≠".
      const says = contradicted.getByTestId("citation-chip");
      await expect(says).toHaveAttribute("data-check", "contradicted");
      await expect(says).toHaveAccessibleName(words.contradicted);
      expect(await paintOf(says)).toEqual({ background: errorWash, color: error });
      await expect(iconOf(says)).toBeVisible();

      // Can't check: the neutral chip with its dash, so it never reads as found.
      const unreadable = cantCheck.getByTestId("citation-chip");
      await expect(unreadable).toHaveAttribute("data-check", "cant-check");
      await expect(unreadable).toHaveAccessibleName(words.cantCheck);
      expect(await paintOf(unreadable)).toEqual({ background: neutral, color: neutralInk });
      await expect(iconOf(unreadable)).toBeVisible();

      // Checking: the neutral chip with its dot, still, as no check of the User's is running.
      const waiting = checking.getByTestId("citation-chip");
      await expect(waiting).toHaveAttribute("data-check", "checking");
      expect(await paintOf(waiting)).toEqual({ background: neutral, color: metaInk });
      await expect(iconOf(waiting)).toBeVisible();
      expect(await iconOf(waiting).evaluate((icon) => icon.getAnimations().length)).toBe(0);

      // Each state has a shape of its own, so colour is never the only signal.
      const shapes = await Promise.all(
        [notFound, contradicted, cantCheck, checking].map((line) =>
          iconOf(line.getByTestId("citation-chip")).innerHTML(),
        ),
      );
      expect(new Set(shapes).size).toBe(4);
      await screenshot(window, `one-mark-${language}-${width}`);
    }

    // A marker opens its Citation's card; a margin mark opens its sentence's check card.
    await pointAndClick(window, notFound.getByTestId("citation-chip"));
    await expect(window.getByTestId("citation-card")).toHaveAttribute("data-check", "not-found");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("citation-card")).toHaveCount(0);
    await pointAndClick(window, marks.nth(1));
    await expect(window.getByTestId("claim-card")).toHaveAttribute("data-check", "unsupported");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("claim-card")).toHaveCount(0);

    // The health card counts every Citation, whatever its sentence's verdict, and each row goes
    // round them, the caret just after the marker, never selecting it.
    const caret = () =>
      editor.evaluate((dom) => {
        const { view } = (dom as unknown as { editor: Editor }).editor;
        const { $from, empty } = view.state.selection;
        return { empty, block: $from.index(0), after: $from.nodeBefore?.attrs.check ?? null };
      });
    const card = await checkCard(window);
    await expect(card.getByTestId("health-found")).toContainText(words.health.found);
    await expect(card.getByTestId("health-notFound")).toContainText(words.health.notFound);
    const next = async (part: "found" | "notFound") =>
      pointAndClick(window, (await checkCard(window)).getByTestId(`health-${part}`));
    await next("notFound");
    await expect.poll(caret).toEqual({ empty: true, block: 3, after: "not-found" });
    await next("notFound");
    await expect.poll(caret).toEqual({ empty: true, block: 4, after: "not-found" });
    await next("notFound");
    await expect.poll(caret).toEqual({ empty: true, block: 3, after: "not-found" });
    await next("found");
    await expect.poll(caret).toEqual({ empty: true, block: 0, after: "found" });
    // Two Citations side by side: each is reached.
    await next("found");
    await expect.poll(caret).toEqual({ empty: true, block: 1, after: "found" });
    const first = await editor.evaluate(
      (dom) => (dom as unknown as { editor: Editor }).editor.state.selection.from,
    );
    await next("found");
    await expect.poll(caret).toEqual({ empty: true, block: 1, after: "found" });
    expect(
      await editor.evaluate(
        (dom) => (dom as unknown as { editor: Editor }).editor.state.selection.from,
      ),
    ).toBe(first + 1);
    await app.close();
  });
}

test("a Citation's dot breathes only while the Answer that checks it is being written", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  // Asked "slowly", the Answer is written word by word, its Citations checking until it ends.
  await window.keyboard.type("When do spring tides happen? slowly");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  const breathing = () =>
    window.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect instanceof KeyframeEffect &&
              animation.effect.target?.closest(".citation-marker") !== null,
          ).length,
    );
  await expect.poll(breathing, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(answer.getByTestId("citation-chip").first()).toHaveAttribute("data-check", "found");
  await expect.poll(breathing).toBe(0);
  await app.close();
});
