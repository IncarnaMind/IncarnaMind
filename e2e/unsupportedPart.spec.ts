import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * A cited sentence's Unsupported card says what its Citations support and what
 * they don't, and never that it didn't find the sentence, which a sentence
 * with no Citation keeps. The scripted model (src/main/fakeChat/checks.ts)
 * finds the sentences listed in `PARTLY` partly supported, and gives a
 * sentence that says "no reason" no reason.
 */
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

const QUOTE_ONE = "QN methods are much faster than GD algorithms";
const QUOTE_TWO = "First-order methods converge more slowly";
const HARBOURS =
  "Harbours publish the times of high water every 12 months, creating a scaling constraint.";
const NO_REASON = "Penguins nest on the harbour cliffs, with no reason.";
const UNCITED = "Penguins nest on the harbour cliffs.";

const LANGUAGES = {
  en: {
    width: 1440,
    owner:
      "The tutorial discusses the trade-off between training speed, robustness and memory needs: experiments usually show quasi-Newton methods are faster than gradient descent; first-order methods are usually more robust but slower.",
    first: "The tutorial discusses",
    covers:
      "Your Citations support the speed comparison, not the parts about memory and robustness.",
    coversOne:
      "Your Citation supports the harbour times, not the parts about the scaling constraint.",
    nothing: "I didn’t find this in “All Documents”.",
    noReason: "The check gave no reason",
    checkAgain: "Check again",
    open: (number: number) => `Open citation ${number}`,
  },
  "zh-CN": {
    width: 900,
    owner:
      "教程讨论了训练速度、鲁棒性和内存需求之间的权衡：已有实验通常显示，拟牛顿方法比梯度下降更快；一阶优化方法通常更加稳健，但速度较慢。",
    first: "教程讨论了",
    covers: "引用支持速度比较，但不支持内存和鲁棒性的部分。",
    coversOne: "引用支持the harbour times，但不支持the scaling constraint的部分。",
    nothing: "未在“全部文档”中找到。",
    noReason: "核对没有给出原因",
    checkAgain: "重新核对",
    open: (number: number) => `打开引用 ${number}`,
  },
} as const;

/** Whether the first box fits within the second's width. */
const fitsWithin = async (inner: Locator, outer: Locator) => {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  if (!a || !b) return false;
  return a.x >= b.x - 1 && a.x + a.width <= b.x + b.width + 1;
};

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];
  test(`a cited sentence's Unsupported card says what its Citations support and what they don't, says when no reason was given, and a sentence with no Citation keeps its line (${language}, ${words.width}px)`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Tutorial one.md"), `# One\n\n${QUOTE_ONE} in practice.\n`);
    await writeFile(join(sources, "Tutorial two.md"), `# Two\n\n${QUOTE_TWO} than QN methods.\n`);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, words.width, 900);
    await addDocuments(window, [
      join(sources, "Tutorial one.md"),
      join(sources, "Tutorial two.md"),
    ]);
    const documents = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const cite = (name: string, quote: string) => {
      const document = documents.find((each) => each.name === name);
      return {
        type: "citation",
        attrs: {
          passageId: "passage-1",
          documentId: document?.id,
          documentName: name,
          contentHash: document?.contentHash,
          pageFrom: 1,
          pageTo: 1,
          location: null,
          quote,
          check: "found",
          checkReason: null,
        },
      };
    };
    const paragraph = (...content: object[]) => ({ type: "paragraph", content });
    const text = (value: string) => ({ type: "text", text: value });

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        paragraph(
          text("Quasi-Newton methods approximate the Hessian."),
          cite("Tutorial one", QUOTE_ONE),
        ),
        paragraph(
          text(words.owner),
          cite("Tutorial one", QUOTE_ONE),
          cite("Tutorial two", QUOTE_TWO),
        ),
        paragraph(text(HARBOURS), cite("Tutorial one", QUOTE_ONE)),
        paragraph(text(NO_REASON), cite("Tutorial two", QUOTE_TWO)),
        paragraph(text(UNCITED)),
      ],
    );
    const lines = editor.locator(":scope > p");
    const marks = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");
    /** Opens a mark's card once the marks have settled in the margin. */
    const openCard = async (mark: Locator) => {
      await motionSettled(window);
      await pointAndClick(window, mark);
      await expect(card).toBeVisible();
    };

    await slideSelect(window, lines.nth(1), words.first, { line: lines.nth(4), words: "cliffs." });
    await pointAndClick(
      window,
      window.getByTestId("selection-menu").getByTestId("selection-action-check-against-documents"),
    );
    await expect(marks).toHaveCount(4);
    for (const index of [0, 1, 2, 3]) {
      await expect(marks.nth(index)).toHaveAttribute("data-check", "unsupported");
    }

    // Two Citations: what they support and what they don't, then each quote with its Citation's chip.
    await openCard(marks.nth(0));
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-covers")).toHaveText(words.covers);
    await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
    const rows = card.getByTestId("claim-cited");
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId("claim-cited-quote")).toHaveText(`“${QUOTE_ONE}”`);
    await expect(rows.last().getByTestId("claim-cited-quote")).toHaveText(`“${QUOTE_TWO}”`);
    await expect(card.getByTestId("claim-cited-chip")).toHaveText(["2", "3"]);
    await expect(rows.first()).toHaveAccessibleName(words.open(2));
    await expect(rows.last()).toHaveAccessibleName(words.open(3));
    // Both rows are laid out alike: the chip follows its quote on the quote's first line, inside the card.
    for (const row of await rows.all()) {
      expect(await fitsWithin(row, card)).toBe(true);
      const quote = await row.getByTestId("claim-cited-quote").boundingBox();
      const chip = await row.getByTestId("claim-cited-chip").boundingBox();
      expect(chip?.x ?? 0).toBeGreaterThanOrEqual((quote?.x ?? 0) + (quote?.width ?? 0));
      expect(chip?.y ?? 0).toBeLessThan((quote?.y ?? 0) + 18);
    }
    // Its fixes (e2e/unsupportedFixes.spec.ts).
    await expect(card.getByTestId("claim-cut")).toBeVisible();
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    // Its check searched every Document already: nothing more to search.
    await expect(card.getByTestId("claim-search-all")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // One Citation says "Citation", not "Citations".
    await openCard(marks.nth(1));
    await expect(card.getByTestId("claim-covers")).toHaveText(words.coversOne);
    await expect(card.getByTestId("claim-cited-chip")).toHaveText("4");
    await expect(card.getByTestId("claim-cited")).toHaveAccessibleName(words.open(4));
    await window.keyboard.press("Escape");

    // No reason comes back: the card says so, and Check again checks the sentence again.
    await openCard(marks.nth(2));
    const noReason = card.getByTestId("claim-no-reason");
    await expect(noReason).toContainText(words.noReason);
    await expect(card.getByTestId("claim-no-reason-check")).toHaveText(words.checkAgain);
    await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
    await expect(card.getByTestId("claim-covers")).toHaveCount(0);
    await expect(card.getByTestId("claim-cited-quote")).toHaveText(`“${QUOTE_TWO}”`);
    // With no part named there is nothing to cut.
    await expect(card.getByTestId("claim-cut")).toHaveCount(0);
    await expect(card.getByTestId("claim-keep")).toBeVisible();
    expect(await fitsWithin(noReason, card)).toBe(true);
    const before = await marks.nth(2).getAttribute("data-claim");
    await pointAndClick(window, card.getByTestId("claim-no-reason-check"));
    await expect(marks.nth(2)).not.toHaveAttribute("data-claim", before ?? "");
    await expect(marks.nth(2)).toHaveAttribute("data-check", "unsupported");

    // A sentence with no Citation keeps its line.
    await openCard(marks.nth(3));
    await expect(card.getByTestId("claim-nothing")).toHaveText(words.nothing);
    await expect(card.getByTestId("claim-covers")).toHaveCount(0);
    await expect(card.getByTestId("claim-no-reason")).toHaveCount(0);
    await expect(card.getByTestId("claim-cited")).toHaveCount(0);
    await window.keyboard.press("Escape");

    // A Citation's quote opens its Document.
    await openCard(marks.nth(0));
    await pointAndClick(window, card.getByTestId("claim-cited-quote").last());
    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("viewer")).toBeVisible();
    await app.close();
  });
}
