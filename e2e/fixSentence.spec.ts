import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CitationAttributes, CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  addDocuments,
  useLocalChatModel as chooseScriptedModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * Fix the sentence (#3383): a sentence its check found the Documents say otherwise of offers the
 * rewrite first on its card. The scripted model rewrites it to the quote, the new sentence is
 * checked again and, Supported by that quote, cited with it; one Undo brings the old words and
 * their check back.
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

const WORDS = {
  en: {
    quote: "The Eastgate terminal opened in September 2025, six months later than planned.",
    sentence: "The Eastgate terminal opened on schedule in 2025.",
    says: "The review says it opened six months late.",
  },
  "zh-CN": {
    quote: "东区水厂于2025年10月投入运行，比原计划推迟四个月。",
    sentence: "东区水厂于2025年10月按计划投入运行。",
    says: "年度报告说它比原计划推迟了四个月。",
  },
} as const;

for (const [language, width] of [
  ["en", 1440],
  ["zh-CN", 900],
] as const) {
  test(`Fix the sentence rewrites it to the quote, checks it again and undoes in one step (${language}, ${width}px)`, async () => {
    test.setTimeout(240_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Annual review.txt"), `${words.quote}\n`);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await chooseScriptedModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, width, 900);
    await addDocuments(window, [join(sources, "Annual review.txt")]);
    const [document] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    if (!document) throw new Error("The Document wasn't added.");
    const evidence: CitationAttributes = {
      passageId: "passage-review",
      documentId: document.id,
      documentName: document.name,
      contentHash: document.contentHash,
      pageFrom: null,
      pageTo: null,
      location: null,
      quote: words.quote,
      check: "found",
      checkReason: null,
    };
    await newMind(window);
    const mark = {
      type: "claimCheck",
      attrs: {
        id: "late",
        request: "request-late",
        action: "check-against-documents",
        state: "contradicted",
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        text: words.sentence,
        reason: null,
        detail: null,
        evidence,
        says: words.says,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    await window.getByTestId("mind-editor").evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [{ type: "paragraph", content: [{ type: "text", text: words.sentence, marks: [mark] }] }],
    );
    const line = window.getByTestId("mind-editor").locator(":scope > p").first();
    const marks = window.getByTestId("claim-mark");
    await expect(marks).toHaveCount(1);

    await pointAndClick(window, marks.first());
    const card = window.getByTestId("claim-card");
    const fix = card.getByTestId("claim-fix");
    await expect(fix).toHaveText(translate(language, "claim.fixSentence"));
    await expect(card.locator(".citation-card-actions button").first()).toHaveAttribute(
      "data-testid",
      "claim-fix",
    );
    await screenshot(window, `fix-sentence-card-${language}`);

    await pointAndClick(window, fix);
    await expect(line).toContainText(words.quote, { timeout: 30_000 });
    const chip = line.getByTestId("citation-chip");
    const badge = window.getByTestId("check-badge");
    if (language === "en") {
      // The scripted check finds the English Document's line word for word: the new sentence is
      // Supported by the quote it rests on, which is placed as its Citation in the same step.
      await expect(chip).toHaveAttribute("data-check", "found", { timeout: 30_000 });
      await expect(badge).toContainText(translate(language, "health.state.checked.noTime"));
    } else {
      // No Chinese line is found: the new sentence still needs a look, as the badge counts it.
      await expect(marks.first()).toHaveAttribute("data-check", "unsupported", { timeout: 30_000 });
      await expect(badge).toContainText(translate(language, "health.state.look.one"));
      await expect(window.getByText(translate(language, "claim.fix.needsLook"))).toBeVisible();
      await expect(chip).toHaveCount(0);
    }
    await screenshot(window, `fix-sentence-fixed-${language}`);
    if (language === "zh-CN") {
      // Its card says why, and offers no rewrite: nothing was found to rest one on.
      await pointAndClick(window, marks.first());
      await expect(card).toBeVisible();
      await expect(card.getByTestId("claim-fix")).toHaveCount(0);
      await screenshot(window, `fix-sentence-fixed-card-${language}`);
      await window.keyboard.press("Escape");
    }

    // One Undo brings the old words back with their check, and takes the Citation back with them.
    await pointAndClick(window, window.getByTestId("applied-line").getByTestId("applied-undo"));
    await expect(line).toHaveText(words.sentence);
    await expect(chip).toHaveCount(0);
    await expect(marks.first()).toHaveAttribute("data-check", "contradicted");
    await app.close();
  });
}
