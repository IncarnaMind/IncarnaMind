import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CitationAttributes, CoreBridge } from "../src/core/api";
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
  useLocalChatModel,
} from "./app";

/*
 * The walk's sentence (#2313): its figure's part is contradicted and the part that says when it
 * happened is Supported on the Document, as the judge now reads it. One press on Change writes
 * the Document's words and asks the sentence's check; the model's verdict is the one shown
 * (#2563), and the card never offers Cut on the words the Document states.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

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

const TEXT = {
  en: {
    sentence: "Customer churn fell to 3.9 per cent after the onboarding redesign.",
    first: "Customer churn fell to 3.9 per cent",
    timing: "after the onboarding redesign",
    from: "3.9 per cent",
    to: "4.2 per cent",
    deck: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
    document: "Quarterly Research Update",
    fix: "Change to 4.2 per cent",
    supported: "Supported",
    cut: "Cut the unsupported part",
  },
  "zh-CN": {
    sentence: "客户流失率在 2025 年第 2 季度降至 3.9%，时点在引导流程重新设计之后。",
    first: "客户流失率在 2025 年第 2 季度降至 3.9%",
    timing: "时点在引导流程重新设计之后",
    from: "3.9%",
    to: "4.2%",
    deck: "客户流失率在 2025 年第 2 季度降至 4.2%，时点在引导流程重新设计之后。",
    document: "季度研究更新",
    fix: "改为 4.2%",
    supported: "有依据",
    cut: "删去无依据的部分",
  },
} as const;

for (const [language, width] of [
  ["en", 1440],
  ["en", 900],
  ["zh-CN", 1440],
  ["zh-CN", 900],
] as const) {
  test(`the walk's sentence is changed and the model checks it, never Cut (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const words = TEXT[language];
    await writeFile(
      join(sources, `${words.document}.md`),
      `# ${words.document}\n\n${words.deck}\n`,
    );
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    await addDocuments(window, [join(sources, `${words.document}.md`)]);
    const [document] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    if (!document) throw new Error("The deck isn't among the Documents.");
    await newMind(window);

    const deck: CitationAttributes = {
      passageId: "passage-deck",
      documentId: document.id,
      documentName: words.document,
      contentHash: document.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: words.deck,
      check: "found",
      checkReason: null,
    };
    const result = (found: CitationAttributes[]) => ({
      reason: null,
      detail: null,
      evidence: found[0] ?? null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      versions: [],
      excluded: [],
    });
    const timingAt = words.sentence.indexOf(words.timing);
    const check = {
      type: "claimCheck",
      attrs: {
        id: "churn",
        request: "request-churn",
        action: "check-against-documents",
        state: "contradicted",
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        text: words.sentence,
        ...result([deck]),
        scope: { folderId: null, widened: false },
        checkedAt: new Date(Date.now() + 60_000).toISOString(),
        parts: [
          {
            ...result([deck]),
            span: { start: 0, end: words.first.length },
            kind: "fact",
            verdict: "contradicted",
            evidence: [deck],
            decidingEvidence: 0,
            correction: { from: words.from, choices: [{ wording: words.to, evidence: deck }] },
          },
          {
            ...result([deck]),
            span: { start: timingAt, end: timingAt + words.timing.length },
            kind: "fact",
            verdict: "supported",
            evidence: [deck],
            decidingEvidence: 0,
          },
        ],
      },
    };
    await window.getByTestId("mind-editor").evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [{ type: "paragraph", content: [{ type: "text", text: words.sentence, marks: [check] }] }],
    );

    const editor = window.getByTestId("mind-editor");
    const line = editor.locator(":scope > p").first();
    const mark = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");

    // Before: the Document's own words for "after the onboarding redesign" are Supported, and the
    // figure's row offers the change.
    await pointAndClick(window, mark);
    // The supported part folds into the foot's line; the figure's change, the card's one fix, is
    // its first button (#2869).
    await expect(card.getByTestId("claim-part")).toHaveCount(1);
    await expect(card.getByTestId("claim-parts-folded")).toContainText(
      language === "en" ? "1 other part is supported" : "另外 1 处有依据",
    );
    const change = card.locator(".citation-card-actions button").first();
    await expect(change).toHaveAttribute("data-testid", "claim-part-correct");
    await expect(change).toHaveText(words.fix);
    await expect(card.getByTestId("claim-cut")).toHaveCount(0);
    await expect(card).not.toContainText(words.cut);
    await screenshot(window, `fix-judge-before-${language}-${width}`);

    const earlierId = await mark.getAttribute("data-claim");
    await pointAndClick(window, change);
    await expect(line).toContainText(words.to);
    await expect(line).not.toContainText(words.from);
    await expect(line.getByTestId("citation")).toHaveCount(1);
    // The words are written at once; the verdict then comes from the check the press asked for.
    await expect(mark).not.toHaveAttribute("data-claim", earlierId ?? "", { timeout: 30_000 });
    await expect(mark).toHaveAttribute("data-check", "supported", { timeout: 30_000 });
    await pointAndClick(window, mark);
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-badge")).toContainText(words.supported);
    await expect(card.getByTestId("claim-cut")).toHaveCount(0);
    await expect(card).not.toContainText(words.cut);
    await screenshot(window, `fix-judge-after-${language}-${width}`);
    await app.close();
  });
}
