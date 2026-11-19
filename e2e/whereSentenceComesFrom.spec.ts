/**
 * A check says where each sentence comes from (#3322): stated by a Document, worked out from what
 * the Documents state, contradicted by them, or its writer's own view. The Note, the margin, the
 * card and the check card's rows each say which, in English and in Chinese.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor, JSONContent } from "@tiptap/core";
import type {
  CitationAttributes,
  ClaimCheckAttributes,
  ClaimCheckPart,
  CoreBridge,
} from "../src/core/api";
import { checkWithParts } from "../src/shared/claimParts";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  markShownFor,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  showEveryCheckResult,
} from "./app";

const WORDS = {
  en: {
    lines: [
      "The centre handled 9,200 tickets in 2026.",
      "Ticket volume is forecast to grow 15% in 2027.",
      "Two agents retire in 2027.",
      "The lead says the team cannot keep its reply times if volume grows.",
    ],
    worked: "So next year the centre will handle more than ten thousand tickets.",
    working: "9,200 × 1.15 = 10,580 > 10,000",
    wrong: "Next year the centre will handle fewer than ten thousand tickets.",
    wrongSays: "Worked out from the review, next year comes to 10,580 tickets.",
    view: "The centre should add two agents by May.",
    viewHolds: "The review forecasts more tickets and two retirements, and says nothing of hiring.",
    typed: "We believe the outlook is bright.",
  },
  "zh-CN": {
    lines: [
      "客服中心 2026 年共处理工单 9,200 张。",
      "预计 2027 年工单量增长 15%。",
      "有两名客服将在 2027 年退休。",
      "客服负责人表示，如果工单量继续增长，团队无法保持现在的回复时间。",
    ],
    worked: "所以明年客服中心处理的工单会超过一万张。",
    working: "9,200 × (1 + 15%) = 10,580 > 10,000",
    wrong: "明年客服中心处理的工单不会超过一万张。",
    wrongSays: "按文档推算，明年的工单量约为 10,580 张。",
    view: "客服中心应该在 5 月前增加 2 名客服。",
    viewHolds: "文档预计工单量增长，且有两名客服退休，但没有提到招人。",
    typed: "我们认为前景光明。",
  },
} as const;

const wholePart = (sentence: string, more: Partial<ClaimCheckPart>): ClaimCheckPart => ({
  span: { start: 0, end: sentence.length },
  kind: "fact",
  verdict: "supported",
  evidence: [],
  says: null,
  unsupported: null,
  calculation: null,
  reason: null,
  detail: null,
  versions: [],
  excluded: [],
  citedCaseUnchecked: false,
  citedCaseFound: false,
  ...more,
});

const checked = (id: string, sentence: string, part: ClaimCheckPart): ClaimCheckAttributes =>
  checkWithParts(
    {
      id,
      request: "where-from",
      action: "check-against-documents",
      state: "checking",
      text: sentence,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-11-18T09:00:00.000Z",
    },
    [part],
  );

const paragraph = (id: string, text: string, check?: ClaimCheckAttributes): JSONContent => ({
  type: "paragraph",
  attrs: { id },
  content: [
    { type: "text", text, ...(check && { marks: [{ type: "claimCheck", attrs: check }] }) },
  ],
});

async function setContent(window: Page, content: JSONContent[]) {
  await window.getByTestId("mind-editor").evaluate((dom, blocks) => {
    const editor = (dom as unknown as { editor: Editor }).editor;
    editor.commands.setContent(blocks);
    editor.commands.setTextSelection(1);
  }, content);
}

async function screenshot(window: Page, name: string) {
  const folder = process.env.INCARNAMIND_SCREENSHOTS;
  if (!folder) return;
  await motionSettled(window);
  await window.screenshot({ path: join(folder, `${name}.png`) });
}

/** The words of the open Note that carry a wash; a sentence's wash can be drawn in several pieces. */
const washed = (window: Page, wash = "") =>
  window
    .getByTestId("mind-editor")
    .last()
    .locator(wash ? `.claim-wash--${wash}` : ".claim-wash")
    .allTextContents()
    .then((pieces) => pieces.join(""));

const markOf = (window: Page, id: string) =>
  window.locator(`[data-testid="claim-mark"][data-claim="${id}"]`);

for (const language of ["en", "zh-CN"] as const) {
  test(`a check says where each sentence comes from: stated, worked out, contradicted, or the writer's own view (${language})`, async () => {
    test.setTimeout(120_000);
    const data = await createDataFolder();
    const sources = await createDataFolder();
    const words = WORDS[language];
    const [stated, forecast, retire, lead] = words.lines;
    await writeFile(join(sources, "Service centre review.txt"), words.lines.join("\n"));
    const { app, window } = await launchApp(data, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await setLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1280, 860);
      await addDocuments(window, [join(sources, "Service centre review.txt")]);
      const [review] = await window.evaluate(() =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
      );
      if (!review) throw new Error("The review was not added.");
      const quote = (id: string, line: string): CitationAttributes => ({
        id,
        passageId: `passage-${id}`,
        documentId: review.id,
        documentName: review.name,
        contentHash: review.contentHash,
        quote: line,
        pageFrom: null,
        pageTo: null,
        location: null,
        check: "found",
        checkReason: null,
      });
      await newMind(window);
      await setContent(window, [
        paragraph(
          "stated",
          stated,
          checked("stated", stated, wholePart(stated, { evidence: [quote("s1", stated)] })),
        ),
        paragraph(
          "worked",
          words.worked,
          checked(
            "worked",
            words.worked,
            wholePart(words.worked, {
              evidence: [quote("w1", stated), quote("w2", forecast)],
              workedOut: words.working,
            }),
          ),
        ),
        paragraph(
          "wrong",
          words.wrong,
          checked(
            "wrong",
            words.wrong,
            wholePart(words.wrong, {
              verdict: "contradicted",
              evidence: [quote("c1", forecast)],
              says: words.wrongSays,
              workedOut: words.working,
            }),
          ),
        ),
        paragraph(
          "view",
          words.view,
          checked(
            "view",
            words.view,
            wholePart(words.view, {
              verdict: "unsupported",
              evidence: [quote("v2", retire), quote("v3", lead)],
              unsupported: {
                word: "own-view",
                reason: words.viewHolds,
                covered: null,
                uncovered: null,
                found: true,
                quoted: quote("v1", forecast),
              },
            }),
          ),
        ),
      ]);

      // The margin: a tick for both Supported sentences, the contradiction's mark, and the quiet
      // dash for the view.
      await expect(window.getByTestId("claim-mark")).toHaveCount(4);
      await expect(markOf(window, "stated")).toHaveAttribute("data-check", "supported");
      await expect(markOf(window, "worked")).toHaveAttribute("data-check", "supported");
      await expect(markOf(window, "wrong")).toHaveAttribute("data-check", "contradicted");
      await expect(markOf(window, "view")).toHaveAttribute("data-check", "own-view");
      // By default only what needs a look is marked: the contradiction's mark and wash (#3358).
      await expect(window.locator('[data-testid="claim-mark"]:not([data-quiet])')).toHaveCount(1);
      await expect.poll(() => washed(window)).toBe(words.wrong);
      // With every result: a dotted line under the sentence worked out, a wash on the
      // contradiction, and nothing on the view, which only the margin marks.
      await showEveryCheckResult(window);
      await expect.poll(() => washed(window, "worked-out")).toBe(words.worked);
      expect(await washed(window, "contradicted")).toBe(words.wrong);
      expect(await washed(window)).toBe(words.worked + words.wrong);
      await screenshot(window, `where-from-note-${language}`);

      const card = window.getByTestId("claim-card");
      // The view's card: named as one, what the Document holds on it, every quote, and no fix.
      await markShownFor(window, markOf(window, "view"));
      await pointAndClick(window, markOf(window, "view"));
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.own-view"),
      );
      await expect(card.getByTestId("claim-part-reason")).toHaveText(words.viewHolds);
      await expect(card.getByTestId("claim-part-citation")).toHaveText([forecast, retire, lead]);
      await expect(card.getByTestId("claim-part-more")).toHaveCount(0);
      await expect(card.locator(".citation-card-actions button")).toHaveText([
        translate(language, "claim.checkAgain"),
      ]);
      await screenshot(window, `where-from-view-${language}`);
      await window.keyboard.press("Escape");

      // Worked out: headed so, the working before the two quotes it used.
      await markShownFor(window, markOf(window, "worked"));
      await pointAndClick(window, markOf(window, "worked"));
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.workedOut"),
      );
      await expect(card.getByTestId("claim-worked-out")).toHaveText(words.working);
      await expect(card.getByTestId("claim-part-citation")).toHaveText([stated, forecast]);
      await screenshot(window, `where-from-worked-${language}`);
      await window.keyboard.press("Escape");

      // A contradiction reached by working keeps its heading and shows the working too.
      await pointAndClick(window, markOf(window, "wrong"));
      await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "contradicted");
      await expect(card.getByTestId("claim-worked-out")).toHaveText(words.working);
      await screenshot(window, `where-from-wrong-${language}`);
      await window.keyboard.press("Escape");

      // The check card counts the view on a row of its own: one sentence needs a look, not two.
      const health = await checkCard(window);
      await expect(health.getByTestId("health-ownViews")).toContainText(
        translate(language, "checks.row.ownViews.one"),
      );
      await expect(health.getByTestId("health-look")).toHaveAttribute("data-count", "1");
      // Both Supported sentences cite nothing yet, so the row of what can be cited holds them (#3358).
      await expect(health.getByTestId("health-notYetCited")).toHaveAttribute("data-count", "2");
      await expect(health.getByTestId("health-supported")).toHaveCount(0);
      await screenshot(window, `where-from-rows-${language}`);
      await window.keyboard.press("Escape");

      // A real check of a sentence its model takes for the writer's own view ends on that mark.
      await newMind(window);
      await setContent(window, [paragraph("typed", words.typed)]);
      await runCommand(window, "mind.check", translate(language, "mindCheck.command"));
      const typed = window.locator('[data-testid="claim-mark"][data-check="own-view"]');
      await expect(typed).toHaveCount(1, { timeout: 30_000 });
      expect(await washed(window)).toBe("");
      await markShownFor(window, typed);
      await pointAndClick(window, typed);
      await expect(card.getByTestId("claim-badge")).toHaveText(
        translate(language, "claim.state.own-view"),
      );
      await expect(card.getByTestId("claim-part-reason")).toHaveText(
        translate(language, "claim.ownView.nothing"),
      );
    } finally {
      await app.close();
      await removeDataFolder(data);
      await removeDataFolder(sources);
    }
  });
}
