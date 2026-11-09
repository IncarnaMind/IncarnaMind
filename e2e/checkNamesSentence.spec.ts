import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { formatDateTime } from "../src/shared/dates";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  sizeMind,
  tokenColor,
  useLocalChatModel,
} from "./app";

/*
 * Every sentence check says which sentence it is about (#1621): its card opens with the sentence in
 * quotation marks, the sentence is outlined while the card is open, the mark sits on the sentence's
 * first line, and Next in the Mind's health card ends where a click on the mark does; a verdict's card
 * ends naming what checked it (#1667). The checks are written into the page, so no model is involved.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const SENTENCES = {
  en: {
    supported:
      "Spring tides happen at new moon and at full moon, when the Sun, the Moon and the Earth line up, and harbours along the whole coast publish the times of high water for every day of the year.",
    unsupported: "Staff may work from home two days a week.",
    contradicted: "The agreement says the facilities end in 2027.",
    notChecked: "The model was not able to check this one.",
    recheck: "Gulls circle the pier at dusk.",
    recheckWas: "Gulls circled the pier at dusk.",
    cited: "Harbours publish times of high water every 12 months.",
    besideChecked: "Spring tides rise twice a day.",
    besideUnchecked: "Gulls fly inland at dawn.",
    twoModels: ["Harbours publish the times of high water", "print them for sailors"],
  },
  "zh-CN": {
    supported:
      "春潮发生在新月和满月，那时太阳、月球和地球排成一线，沿岸所有港口每年都会公布每一天的高潮时间，让船员能在离开码头之前很早就计划好每一次出海，保证每一条船都按时回港。",
    unsupported: "员工每周可以在家办公两天。",
    contradicted: "协议规定这些贷款在 2027 年到期。",
    notChecked: "模型这次没能核对这一句。",
    recheck: "海鸥黄昏时在码头上空盘旋。",
    recheckWas: "海鸥黄昏时曾在码头上空盘旋。",
    cited: "港口每 12 个月公布一次高潮时间。",
    besideChecked: "春潮每天涨两次。",
    besideUnchecked: "海鸥天亮时飞往内陆。",
    twoModels: ["港口公布高潮时间", "为船员印发"],
  },
} as const;

const KINDS = ["supported", "unsupported", "contradicted", "not-checked", "needs-recheck"] as const;

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

const CHECKED_AT = "2026-10-22T09:00:00.000Z";

const checked = (id: string, state: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  text,
  marks: [
    {
      type: "claimCheck",
      attrs: {
        id,
        request: "check-1",
        action: "check-against-documents",
        state,
        text,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: CHECKED_AT,
        ...extra,
      },
    },
  ],
});
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

const HAIKU = { providerId: null, modelId: "claude-haiku-5-5" };
/** What a verdict card's last line says checked it (#1667), the time as the dates module writes it. */
const CHECKED_BY = {
  en: (when: string) => `Checked with Claude Haiku 5.5, ${when}`,
  "zh-CN": (when: string) => `由 Claude Haiku 5.5 核对，${when}`,
} as const;
const CHECKED_BY_TWO = {
  en: (when: string) => `Checked with Claude Haiku 5.5 and Claude Sonnet 5.5, ${when}`,
  "zh-CN": (when: string) => `由 Claude Haiku 5.5 和 Claude Sonnet 5.5 核对，${when}`,
} as const;
const EARLIER = "2026-10-22T08:40:00.000Z";
/** A model a User added under their own, long name: wider than the card. */
const LONG_NAME =
  "harbour office contract review model fine tuned on leases loans and charters edition two";
/** The same with no space to wrap at. */
const LONG_TOKEN =
  "harbour-office-contract-review-model-fine-tuned-on-leases-loans-and-charters-edition-two";

/** The window's own clock, so the line is expected as the app writes it on any machine. */
const clockOf = (window: Page) =>
  window.evaluate(() => {
    const { hourCycle, timeZone } = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
    }).resolvedOptions();
    return { twelveHour: hourCycle === "h11" || hourCycle === "h12", timeZone };
  });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("The element isn't visible.");
  return found;
}

for (const language of ["en", "zh-CN"] as const) {
  const words = SENTENCES[language];
  test(`each check card names its sentence and outlines it while open; Next opens a sentence's card (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const passage = {
      passageId: "passage-1",
      documentId: tides?.id,
      documentName: "Tides",
      contentHash: tides?.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Harbours publish the times of high water every 12 months.",
      check: "found",
      checkReason: null,
    };

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        paragraph(
          checked("check-1", "supported", words.supported, { evidence: passage, ...HAIKU }),
        ),
        paragraph(checked("check-2", "unsupported", words.unsupported, HAIKU)),
        paragraph(
          checked("check-3", "contradicted", words.contradicted, {
            evidence: passage,
            says: "The agreement says the facilities end on 14 February 2029.",
            ...HAIKU,
          }),
        ),
        paragraph(
          checked("check-4", "not-checked", words.notChecked, { reason: "refused", ...HAIKU }),
        ),
        paragraph({
          ...checked("check-5", "supported", words.recheckWas, { evidence: passage, ...HAIKU }),
          text: words.recheck,
        }),
        paragraph(checked("check-6", "supported", words.cited, { evidence: passage }), {
          type: "citation",
          attrs: passage,
        }),
        // A checked claim and one not checked yet, starting on the same line (#1941).
        paragraph(
          checked("check-7", "supported", words.besideChecked, { evidence: passage }),
          { type: "text", text: " " },
          checked("check-8", "not-checked", words.besideUnchecked, { reason: "refused" }),
        ),
      ],
    );
    const marks = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");
    const outlined = window.getByTestId("claim-outline");
    const paragraphOf = (sentence: string) =>
      editor.locator(":scope > p").filter({ hasText: sentence });
    // The boxes of the outline are one to a line of the paragraph's words, and enclose them.
    const outlinesWords = async (paragraph: Locator) => {
      const words = await paragraph.evaluate((element) => {
        // The sentence's words are its text, not the room a folded Mind keeps for its check mark.
        const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
        const range = document.createRange();
        range.setStart(texts[0] as Text, 0);
        const last = texts.at(-1) as Text;
        range.setEnd(last, last.data.length);
        const rect = range.getBoundingClientRect();
        const tops = Array.from(range.getClientRects(), (each) => Math.round(each.top));
        return { ...rect.toJSON(), lines: new Set(tops).size };
      });
      const boxes = await outlined.evaluateAll((all) =>
        all.map((element) => element.getBoundingClientRect().toJSON()),
      );
      return {
        boxes: boxes.length,
        lines: words.lines,
        encloses:
          boxes.length > 0 &&
          Math.min(...boxes.map((each) => each.left)) <= words.left &&
          Math.min(...boxes.map((each) => each.top)) <= words.top &&
          Math.max(...boxes.map((each) => each.right)) >= words.right &&
          Math.max(...boxes.map((each) => each.bottom)) >= words.bottom,
      };
    };
    await expect(marks).toHaveCount(8);
    // A claim not checked yet takes no room in the margin's stack: on the same line as a checked
    // claim, its unseen anchor sits on that line, and the checked mark keeps its own place (#1941).
    const beside = window.locator('[data-testid="claim-mark"][data-claim="check-7"]');
    const unseen = window.locator('[data-testid="claim-mark"][data-claim="check-8"]');
    const rectOf = (locator: Locator) =>
      locator.evaluate((element) => element.getBoundingClientRect().toJSON());
    await expect(unseen).toBeHidden();
    const [besideBox, unseenBox] = await Promise.all([rectOf(beside), rectOf(unseen)]);
    expect(unseenBox.y).toBe(besideBox.y);

    const metaInk = await tokenColor(window, "--color-ink-meta");
    const clock = await clockOf(window);
    const accent = await tokenColor(window, "--color-accent");
    const sentences = [
      words.supported,
      words.unsupported,
      words.contradicted,
      words.notChecked,
      words.recheck,
    ];

    for (const [at, kind] of KINDS.entries()) {
      const sentence = sentences[at] ?? "";
      const mark = marks.nth(at);
      await expect(mark).toHaveAttribute("data-check", kind);
      await expect(outlined).toHaveCount(0);

      if (kind === "not-checked") {
        // A claim not checked has no mark on the page (#1941): it draws no icon and stays unseen,
        // and its card opens from the badge's row for it, the one a check couldn't settle (#2313).
        await expect(mark).toBeHidden();
        await expect(mark.locator("svg")).toHaveCount(0);
        await pointAndClick(window, (await checkCard(window)).getByTestId("health-cantCheck"));
      } else {
        await pointAndClick(window, mark);
      }
      await expect(card).toHaveAttribute("data-check", kind);
      const line = card.getByTestId("claim-sentence");
      await expect(line).toHaveText(`“${sentence}”`);
      expect(await card.getAttribute("aria-label")).toContain(sentence);
      expect(
        await card
          .getByTestId("claim-badge")
          .evaluate((title) => title.nextElementSibling?.getAttribute("data-testid")),
      ).toBe("claim-sentence");
      await expect(line).toHaveCSS("font-size", "13px");
      await expect(line).toHaveCSS("color", metaInk);
      const checkedBy = card.getByTestId("claim-checked-by");
      // A card that needs a re-check keeps its last check's line as it was.
      if (kind === "not-checked") await expect(checkedBy).toHaveCount(0);
      else {
        await expect(checkedBy).toHaveText(
          CHECKED_BY[language](formatDateTime(CHECKED_AT, language, clock)),
        );
        await expect(checkedBy).toHaveCSS("font-size", "12px");
        await expect(checkedBy).toHaveCSS("color", metaInk);
      }
      const shape = await line.evaluate((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return {
          lines: Math.round(element.getBoundingClientRect().height / lineHeight),
          clipped: element.scrollHeight > element.clientHeight,
        };
      });
      expect(shape.lines, "at most two lines").toBeLessThanOrEqual(2);
      expect(shape.clipped, "only a long sentence is cut").toBe(at === 0);

      await expect(outlined.first()).toBeVisible();
      const around = await outlinesWords(paragraphOf(sentence));
      expect(around.encloses, "it encloses the sentence").toBe(true);
      expect(around.boxes, "a box on each line").toBe(around.lines);
      if (at === 0) expect(around.lines).toBeGreaterThanOrEqual(3);
      await expect(outlined.first()).toHaveCSS("border-top-style", "solid");
      await expect(outlined.first()).toHaveCSS("border-top-width", "2px");
      await expect(outlined.first()).toHaveCSS("border-top-color", accent);
      await expect(mark).toHaveAttribute("data-open", "true");
      const cardBox = await box(card);
      expect(cardBox.x).toBeGreaterThanOrEqual(0);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(900);
      expect(await window.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        900,
      );
      await screenshot(window, `card-${kind}-${language}-900`);

      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(outlined).toHaveCount(0);
      await expect(mark).not.toHaveAttribute("data-open", "true");
    }

    await pointAndClick(window, marks.nth(5));
    await expect(card).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-already-cited")).toBeVisible();
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${words.cited}”`);
    expect(
      await card
        .getByTestId("claim-badge")
        .evaluate((title) => title.nextElementSibling?.getAttribute("data-testid")),
    ).toBe("claim-sentence");
    expect((await outlinesWords(paragraphOf(words.cited))).encloses).toBe(true);
    await screenshot(window, `card-already-cited-${language}-900`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    const edited = `${words.recheck.slice(0, 2)}EDITED${words.recheck.slice(2)}`;
    await editor.evaluate((dom, sentence) => {
      const { editor: current } = dom as unknown as { editor: Editor };
      current.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === sentence) {
          current.commands.insertContentAt(pos + 2, "EDITED");
        }
      });
    }, words.recheck);
    await pointAndClick(window, marks.nth(4));
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${edited}”`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    const first = paragraphOf(words.supported);
    const lineHeight = await first.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).lineHeight),
    );
    const page = await box(first);
    expect(page.height).toBeGreaterThanOrEqual(lineHeight * 3 - 1);
    // In the margin a mark is level with its sentence's first line; in a folded Mind, on its last.
    const folded = (await box(window.locator(".mind-column"))).width < 760;
    const middle = await box(marks.first()).then((rect) => rect.y + rect.height / 2);
    expect(middle).toBeGreaterThanOrEqual(page.y);
    expect(middle).toBeLessThanOrEqual(page.y + (folded ? page.height : lineHeight));

    await marks.nth(1).focus();
    await expect(card).toHaveAttribute("data-check", "unsupported");
    expect((await outlinesWords(paragraphOf(words.unsupported))).encloses).toBe(true);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(outlined).toHaveCount(0);
    // A card shown by the mark's focus was not opened from the keyboard: Esc leaves the mark focused.
    await expect(marks.nth(1)).toBeFocused();
    await window.mouse.move(2, 2);
    await marks.nth(2).hover();
    await expect(card).toHaveAttribute("data-check", "contradicted");
    expect((await outlinesWords(paragraphOf(words.contradicted))).encloses).toBe(true);
    await window.mouse.move(2, 2);
    await expect(card).toHaveCount(0);
    await expect(outlined).toHaveCount(0);

    await editor.evaluate(
      (dom, filler) => {
        const { editor: current } = dom as unknown as { editor: Editor };
        const after = current.state.doc.firstChild?.nodeSize ?? 0;
        current.commands.insertContentAt(after, filler);
      },
      Array.from({ length: 30 }, (_, at) => paragraph({ type: "text", text: `Note ${at + 1}` })),
    );
    const scroller = window.locator(".mind-scroller:visible");
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const unsupported = paragraphOf(words.unsupported);
    // Clear of the page's top and of the fade and the badge at its foot.
    const inView = async () => {
      const [view, target] = await Promise.all([box(scroller), box(unsupported)]);
      return target.y >= view.y + 64 && target.y + target.height <= view.y + view.height - 64;
    };
    expect(await inView()).toBe(false);
    const health = window.getByTestId("check-card");
    await pointAndClick(window, (await checkCard(window)).getByTestId("health-look"));
    await expect(card).toHaveAttribute("data-check", "unsupported");
    await expect(health).toHaveCount(0);
    await expect.poll(inView).toBe(true);
    expect((await outlinesWords(unsupported)).encloses).toBe(true);
    await expect(marks.nth(1)).toHaveAttribute("data-open", "true");
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${words.unsupported}”`);
    await screenshot(window, `next-unsupported-${language}-900`);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(outlined).toHaveCount(0);

    await window.getByTestId("check-badge-open").focus();
    await window.keyboard.press("Enter");
    await expect(health).toBeVisible();
    await health.getByTestId("health-look").focus();
    await window.keyboard.press("Enter");
    await expect(card).toHaveAttribute("data-check", "contradicted");
    await expect(health).toHaveCount(0);
    expect((await outlinesWords(paragraphOf(words.contradicted))).encloses).toBe(true);
    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(outlined).toHaveCount(0);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`Next shows a sentence in a paragraph taller than the page (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 800);
    const bird = (at: number) => (language === "en" ? `Bird ${at} sings.` : `第${at}只鸟在唱歌。`);
    const run = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, at) => bird(from + at)).join(
        language === "en" ? " " : "",
      );
    const sentence = bird(225);

    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${run(1, 224)}${language === "en" ? " " : ""}` },
            checked("tall-1", "unsupported", sentence),
            { type: "text", text: `${language === "en" ? " " : ""}${run(226, 230)}` },
          ],
        },
      ],
    );
    await expect(window.getByTestId("claim-mark")).toHaveCount(1);
    const scroller = window.locator(".mind-scroller:visible");
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    const [view, page, before] = await Promise.all([
      box(scroller),
      box(editor.locator(":scope > p").first()),
      box(window.locator('[data-claim-check="tall-1"]')),
    ]);
    expect(page.height, "the paragraph is taller than the page").toBeGreaterThan(view.height);
    expect(before.y, "the sentence starts below the page").toBeGreaterThan(view.y + view.height);

    await pointAndClick(window, (await checkCard(window)).getByTestId("health-look"));
    const card = window.getByTestId("claim-card");
    await expect(card).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-sentence")).toHaveText(`“${sentence}”`);
    const outlines = window.getByTestId("claim-outline");
    await expect(outlines.first()).toBeVisible();
    await expect
      .poll(async () => {
        const [area, boxes] = await Promise.all([
          box(scroller),
          outlines.evaluateAll((all) =>
            all.map((element) => element.getBoundingClientRect().toJSON()),
          ),
        ]);
        return (
          boxes.length > 0 &&
          boxes.every((each) => each.top >= area.y && each.bottom <= area.y + area.height)
        );
      })
      .toBe(true);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  // protects=the card's last line wraps only between model names or before the time, never inside a name or the time; a name wider than the line wraps at its own spaces, and one with no space to wrap at is cut in the middle with its whole name in its tooltip and for a screen reader; nothing runs past the card, at 900 and 1,440 px and in a 700 px Note, in English and Chinese (#1667); fails_when=a name or the date breaks, a long name runs past the card, or a name with no spaces isn't cut; no_claim=that the latest of several times is the one shown, which the line's unit test checks.
  test(`the line wraps only between names or before the time, and a long name stays in the card (${language})`, async () => {
    test.setTimeout(240_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 900);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const evidence = {
      passageId: "passage-1",
      documentId: tides?.id,
      documentName: "Tides",
      contentHash: tides?.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Harbours publish the times of high water every 12 months.",
      check: "found",
      checkReason: null,
    };
    const [first, second] = SENTENCES[language].twoModels;
    const joined = language === "en" ? `${first} and ${second}.` : `${first}，并${second}。`;
    const judged = (text: string, words: string, modelId: string, checkedAt: string) => {
      const start = text.indexOf(words);
      return {
        span: { start, end: start + words.length },
        kind: "fact",
        verdict: "supported",
        evidence: [evidence],
        decidingEvidence: 0,
        says: null,
        unsupported: null,
        calculation: null,
        reason: null,
        detail: null,
        versions: [],
        excluded: [],
        citedCaseUnchecked: false,
        citedCaseFound: false,
        providerId: null,
        modelId,
        checkedAt,
      };
    };
    /** A sentence one model checked, alone in a paragraph. */
    const checkedBy = (id: string, modelId: string) =>
      paragraph(
        checked(id, "supported", first, {
          evidence,
          providerId: null,
          modelId,
          parts: [judged(first, first, modelId, CHECKED_AT)],
        }),
      );
    const insert = (content: object[]) =>
      window.getByTestId("mind-editor").evaluate((dom, blocks) => {
        const { editor } = dom as unknown as { editor: Editor };
        editor.commands.insertContentAt(editor.state.doc.content.size, blocks);
      }, content);
    await newMind(window);
    await insert([
      paragraph(
        checked("check-two", "supported", joined, {
          evidence,
          providerId: null,
          modelId: "claude-sonnet-5-5",
          parts: [
            judged(joined, first, "claude-haiku-5-5", EARLIER),
            judged(joined, second, "claude-sonnet-5-5", CHECKED_AT),
          ],
        }),
      ),
      checkedBy("check-long", LONG_NAME),
      checkedBy("check-token", LONG_TOKEN),
    ]);
    const card = window.getByTestId("claim-card");
    const line = card.getByTestId("claim-checked-by");
    const markOf = (id: string) => window.locator(`[data-testid="claim-mark"][data-claim="${id}"]`);
    const open = async (id: string) => {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await pointAndClick(window, markOf(id));
      await expect(card).toHaveAttribute("data-check", "supported");
      await motionSettled(window);
    };
    /** How many lines an element of the card's last line takes: its words' line boxes. */
    const linesOf = (locator: Locator) =>
      locator.evaluate((element) => {
        const height = Number.parseFloat(
          getComputedStyle(element.closest("[data-testid='claim-checked-by']") ?? element)
            .lineHeight,
        );
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        const tops = Array.from(range.getClientRects(), (rect) => rect.top).sort((a, b) => a - b);
        return tops.filter((top, at) => at === 0 || top - (tops[at - 1] ?? top) > height / 2)
          .length;
      });
    /** How far past the line's text edge, and past the card, an element reaches. */
    const overrun = (locator: Locator) =>
      locator.evaluate((element) => {
        const paragraph = element.closest("[data-testid='claim-checked-by']");
        const card = element.closest("[data-testid='claim-card']");
        if (!paragraph || !card) return null;
        const style = getComputedStyle(paragraph);
        const edge =
          paragraph.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
        const right = Math.max(
          ...Array.from(element.getClientRects(), (rect) => rect.right),
          element.getBoundingClientRect().right,
        );
        return {
          line: right - edge,
          card: right - card.getBoundingClientRect().right,
          scrolls: card.scrollWidth > card.clientWidth,
        };
      });
    const clock = await clockOf(window);

    const sizes = [
      { name: "900", size: () => setWindowSize(app, window, 900, 900) },
      { name: "1440", size: () => setWindowSize(app, window, 1440, 900) },
      { name: "note-700", size: () => sizeMind(app, window, 700) },
    ];
    for (const { name: width, size } of sizes) {
      await size();

      await open("check-two");
      await expect(line).toHaveText(
        CHECKED_BY_TWO[language](formatDateTime(CHECKED_AT, language, clock)),
      );
      expect(await linesOf(line), `the line wraps (${width})`).toBe(2);
      const names = line.locator(".claim-card-checked-by-name");
      await expect(names).toHaveCount(2);
      for (const name of await names.all()) expect(await linesOf(name)).toBe(1);
      const when = line.locator(".claim-card-checked-by-when");
      expect(await linesOf(when)).toBe(1);
      expect((await overrun(line))?.card ?? 1).toBeLessThanOrEqual(0);
      await screenshot(window, `card-two-models-${language}-${width}`);

      await open("check-long");
      const long = line.locator(".claim-card-checked-by-name");
      await expect(long).toHaveText(language === "en" ? `${LONG_NAME},` : LONG_NAME);
      expect(
        await linesOf(long),
        `a spaced name wider than the line wraps (${width})`,
      ).toBeGreaterThanOrEqual(2);
      const split = await long.evaluate((element) => {
        const text = element.firstChild;
        if (!(text instanceof Text)) return null;
        const range = document.createRange();
        // Each word stays on one line: the name wraps at its spaces, never inside a word.
        return [...text.data.matchAll(/\S+/gu)].filter((word) => {
          range.setStart(text, word.index);
          range.setEnd(text, word.index + word[0].length);
          return (
            new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size > 1
          );
        }).length;
      });
      expect(split).toBe(0);
      expect(await overrun(long)).toMatchObject({ scrolls: false });
      expect((await overrun(long))?.line ?? 1).toBeLessThanOrEqual(0.5);
      await screenshot(window, `card-long-model-name-${language}-${width}`);

      await open("check-token");
      const token = line.locator(".claim-card-checked-by-name");
      await expect(token).toHaveAttribute("title", LONG_TOKEN);
      const shown = token.locator('[aria-hidden="true"]');
      const shownText = (await shown.textContent()) ?? "";
      expect(shownText).toContain("…");
      expect(LONG_TOKEN.startsWith(shownText.slice(0, shownText.indexOf("…")))).toBe(true);
      expect(LONG_TOKEN.endsWith(shownText.slice(shownText.indexOf("…") + 1))).toBe(true);
      await expect(token.locator(".sr-only")).toHaveText(LONG_TOKEN);
      expect(await linesOf(shown), `a name with no space is cut, not wrapped (${width})`).toBe(1);
      expect(await overrun(token)).toMatchObject({ scrolls: false });
      expect((await overrun(token))?.line ?? 1).toBeLessThanOrEqual(0.5);
      await screenshot(window, `card-long-model-token-${language}-${width}`);
    }

    // Names a hair past the line's room: they must wrap, at rest and all through the card's opening.
    await setWindowSize(app, window, 900, 900);
    await open("check-two");
    const room = await line.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width:
          element.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
        font: style.font,
      };
    });
    const near = await window.evaluate(
      ({ width, font, comma }) => {
        const context = document.createElement("canvas").getContext("2d");
        if (!context) return null;
        context.font = font;
        const widthOf = (text: string) => context.measureText(text).width;
        const words = "salt pier tide moor quay buoy".split(" ");
        const grown = (fits: (text: string) => boolean) => {
          let text = "";
          for (let at = 0; widthOf(`${text} ${words[at % words.length]}`) < width - 24; at++)
            text = `${text} ${words[at % words.length]}`.trim();
          for (const filler of [
            "",
            "i",
            "ii",
            "iii",
            "iiii",
            "iiiii",
            "iiiiii",
            "iiiiiii",
            "l",
            "il",
            "ill",
            "illl",
          ]) {
            for (let more = 0; more < 12; more++) {
              const candidate = `${text} ${"i".repeat(more)}${filler}`.trim();
              if (fits(candidate)) return candidate;
            }
          }
          return null;
        };
        return {
          // 0.5 to 3 px wider than the room: it must wrap.
          over: grown((text) => widthOf(text) > width + 0.5 && widthOf(text) <= width + 3),
          // Fits by itself, not with the comma that follows it.
          comma: comma
            ? grown((text) => widthOf(text) <= width - 0.5 && widthOf(`${text},`) > width + 0.5)
            : null,
          // 0.5 to 3 px narrower than the room, with what follows it: it must stay on one line.
          under: grown((text) => {
            const whole = widthOf(comma ? `${text},` : text);
            return whole <= width - 0.5 && whole > width - 3;
          }),
        };
      },
      { ...room, comma: language === "en" },
    );
    expect(near?.over, "a name just past the room").toBeTruthy();
    expect(near?.under, "a name just inside the room").toBeTruthy();
    const edge = [
      { id: "check-over", name: near?.over ?? "", lines: 2 },
      { id: "check-under", name: near?.under ?? "", lines: 1 },
      ...(near?.comma ? [{ id: "check-comma", name: near.comma, lines: 2 }] : []),
    ];
    if (language === "en") expect(near?.comma, "a name that fits but for its comma").toBeTruthy();
    await insert(edge.map(({ id, name }) => checkedBy(id, name)));
    for (const { id, lines } of edge) {
      await open(id);
      const name = line.locator(".claim-card-checked-by-name");
      expect(await linesOf(name), `${id} takes ${lines} lines`).toBe(lines);
      expect((await overrun(name))?.line ?? 1).toBeLessThanOrEqual(0.5);
    }

    // While the card opens it is drawn smaller; a name must keep its line count all the way.
    const linesWhileOpening = async (id: string) => {
      await window.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      const sampled = window.evaluate(
        () =>
          new Promise<number[]>((settle) => {
            const counts: number[] = [];
            const began = performance.now();
            let seen: number | null = null;
            // From the card's first frame, through its opening and a while after.
            const sample = () => {
              const name = document.querySelector(
                "[data-testid='claim-card'] [data-testid='claim-checked-by'] .claim-card-checked-by-name",
              );
              if (name) {
                seen ??= performance.now();
                const range = document.createRange();
                range.selectNodeContents(name);
                const tops = Array.from(range.getClientRects(), (rect) => Math.round(rect.top));
                counts.push(new Set(tops).size);
              }
              const now = performance.now();
              if ((seen === null && now - began < 15_000) || (seen !== null && now - seen < 800))
                requestAnimationFrame(sample);
              else settle(counts);
            };
            requestAnimationFrame(sample);
          }),
      );
      await pointAndClick(window, markOf(id));
      return sampled;
    };
    for (const { id, lines } of edge.slice(0, 2)) {
      const counts = await linesWhileOpening(id);
      expect(counts.length, `${id} was drawn while it opened`).toBeGreaterThan(0);
      expect(new Set(counts), `${id} keeps ${lines} lines all through the opening`).toEqual(
        new Set([lines]),
      );
    }

    // The line can narrow while its card is open, as when a scrollbar comes: its names are
    // measured again, and one that no longer fits wraps.
    const under = line.locator(".claim-card-checked-by-name");
    expect(await linesOf(under)).toBe(1);
    await card.locator(".citation-card").evaluate((element) => {
      (element as HTMLElement).style.width = `${element.getBoundingClientRect().width - 40}px`;
    });
    await expect.poll(() => linesOf(under), "a name that no longer fits wraps").toBe(2);
    expect((await overrun(under))?.line ?? 1).toBeLessThanOrEqual(0.5);
    await app.close();
  });
}
