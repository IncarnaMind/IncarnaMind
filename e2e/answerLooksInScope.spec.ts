import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  frontMindName,
  launchApp,
  motionSettled,
  openCardMenu,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * An Answer's sentence that lists more than its one Citation states (#3020, #2809), on a made-up
 * résumé whose six projects sit in Passages of their own. With every listed project in the
 * résumé, the check finds the missing Passages itself: the sentence passes, and each found
 * Passage is a Citation whose card says a check found it. With one project the résumé doesn't
 * name, the sentence stays Unsupported, and the Note made from the Answer has a card that names
 * that project in the sentence's own words, says what the check read, and cuts only those words,
 * with Undo. The scripted model (src/main/fakeChat) writes the list sentences, judges them
 * Unsupported against their one Citation, and checks each listed project against the line that
 * names it. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const FIXTURES = join(__dirname, "../tests/fixtures/answers/resume");

const LANGUAGES = {
  en: {
    file: "Sample resume.md",
    all: "What were the main projects?",
    withAbsent: "What were the main projects, and the wallet?",
    listed:
      "The main projects include the Sampletown First Hospital fever clinic mini program, the Example District epidemic data dashboard and the Example Exchange cross-chain data platform",
    absent: "the Example Bank mobile wallet",
    cut: "The main projects include the Sampletown First Hospital fever clinic mini program, the Example District epidemic data dashboard and the Example Exchange cross-chain data platform",
    foundByCheck: "Found by a check of this sentence",
    dontMention: "Your Documents don’t mention: the Example Bank mobile wallet",
    checkedIn: /^Checked against “[^”]+”$/,
    cutAction: "Cut the unsupported part",
    keep: "Keep as my view",
    name: "Sample resume",
    carried: "Alex ran the hospital's design team for nine years.",
    quote: "Runs a team of four designers and reports to the head of product.",
    why: "The quote gives the team's size, not how long Alex ran it.",
    citedIn: "Checked against its Citations in “Sample resume”",
    checkAgain: "Check again",
  },
  "zh-CN": {
    file: "示例简历.md",
    all: "主要项目有哪些？",
    withAbsent: "主要项目有哪些？还有钱包吗？",
    listed: "主要项目包括示例市第一医院发热门诊小程序、示例区疫情数据大屏和示例交易所跨链数据平台",
    absent: "示例银行手机钱包",
    cut: "主要项目包括示例市第一医院发热门诊小程序、示例区疫情数据大屏和示例交易所跨链数据平台",
    foundByCheck: "核对这句话时找到",
    dontMention: "文档中没有提到：示例银行手机钱包",
    checkedIn: /^已对照“[^”]+”核对$/,
    cutAction: "删去无依据的部分",
    keep: "保留为我的观点",
    name: "示例简历",
    carried: "林示例带领医院的设计团队九年。",
    quote: "带领四名设计师，向产品负责人汇报。",
    why: "引文写的是团队人数，没有写带了多久。",
    citedIn: "已对照“示例简历”中的引用核对",
    checkAgain: "重新核对",
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

const bridge = (window: Page) => ({
  anthropic: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
    }),
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  mind: async (title: string) => {
    await window.evaluate(
      (name) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createMind({
          title: name,
          folderId: null,
        }),
      title,
    );
    await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
    await expect(frontMindName(window)).toHaveText(title);
  },
});

/** Asks in the assistant, as a person does, and resolves with the Answer once written and its sentences judged. */
async function ask(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(answer.locator('[data-testid="citation"][data-check="checking"]')).toHaveCount(0, {
    timeout: 60_000,
  });
  return answer;
}

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

  test(`${language}: a list sentence that cites one line passes with the found Passages cited; with a project no Document names it stays Unsupported, and its Note's card names that project and cuts it`, async () => {
    test.setTimeout(240_000);
    await copyFile(join(FIXTURES, words.file), join(sources, words.file));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await bridge(window).anthropic();
    await bridge(window).language(language);
    await addDocuments(window, [join(sources, words.file)]);
    await bridge(window).mind("Projects");

    // Every listed project is in the résumé: the check finds the Passages the Answer didn't cite.
    const passes = await ask(window, words.all);
    await expect(passes.getByTestId("assistant-answer-text")).toContainText(words.listed);
    const citations = passes.getByTestId("citation");
    // The one its writer gave, and each Passage the check found.
    await expect.poll(() => citations.count()).toBeGreaterThan(1);
    for (const citation of await citations.all()) {
      await expect(citation).toHaveAttribute("data-check", "found");
    }
    await motionSettled(window);
    await pointAndClick(window, citations.last());
    const citationCard = window.getByTestId("citation-card");
    await expect(citationCard.getByTestId("citation-found-by-check")).toHaveText(
      words.foundByCheck,
    );
    await screenshot(window, `found-by-check-${language}`);
    await window.keyboard.press("Escape");

    // One listed project is in no Document: the sentence stays Unsupported and nothing is added.
    const marked = await ask(window, words.withAbsent);
    await expect(marked.getByTestId("assistant-answer-text")).toContainText(words.absent);
    await expect(marked.getByTestId("citation")).toHaveCount(1);
    await expect(marked.getByTestId("citation")).toHaveAttribute("data-check", "unsupported");
    await screenshot(window, `stays-unsupported-${language}`);

    // In the Note made from it, the card names the project in the sentence's own words.
    await pointAt(window, marked.getByTestId("assistant-answer-text"));
    await pointAndClick(window, marked.getByTestId("answer-add"));
    await expect(marked.getByTestId("answer-added")).toBeVisible();
    const editor = window.getByTestId("mind-editor");
    const mark = window.getByTestId("claim-mark").first();
    await expect(mark).toHaveAttribute("data-check", "unsupported");
    const card = window.getByTestId("claim-card");
    await motionSettled(window);
    await pointAndClick(window, mark);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("claim-dont-mention")).toHaveText(words.dontMention);
    // No quote is the reason, so none shows, and nothing offers to open one or rewrite the sentence.
    for (const absent of ["claim-differs", "claim-quote", "claim-cited-quote", "claim-fix"]) {
      await expect(card.getByTestId(absent)).toHaveCount(0);
    }
    await expect(card.getByTestId("claim-cut")).toHaveText(words.cutAction);
    await expect(card.getByTestId("claim-keep")).toHaveText(words.keep);
    await screenshot(window, `card-names-the-part-${language}`);
    // The check searched the Answer's scope, and the card's ⋯ says so.
    const menu = await openCardMenu(window, card);
    await expect(menu.getByTestId("claim-checked-in")).toHaveText(words.checkedIn);
    await screenshot(window, `card-menu-${language}`);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Cut the unsupported part takes out only those words, at once; ⌘Z brings back words and mark.
    await pointAndClick(window, card.getByTestId("claim-cut"));
    const line = editor.locator(":scope > p").filter({ hasText: words.listed }).first();
    await expect(line).toContainText(words.cut);
    await expect(line).not.toContainText(words.absent);
    await screenshot(window, `cut-${language}`);
    await focusSettled(window, editor);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).toContainText(words.absent);
    await expect(window.getByTestId("claim-mark").first()).toHaveAttribute(
      "data-check",
      "unsupported",
    );
    await app.close();
  });

  test(`${language}: a check carried from an Answer that read only the sentence's Citations says so, and offers Check again`, async () => {
    test.setTimeout(120_000);
    await copyFile(join(FIXTURES, words.file), join(sources, words.file));
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await acceptPlainTextKeys(window);
    await bridge(window).anthropic();
    await bridge(window).language(language);
    await addDocuments(window, [join(sources, words.file)]);
    await bridge(window).mind("Projects");
    const [document] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    if (!document) throw new Error("The résumé wasn't added.");

    // As Add to note leaves a sentence its Answer's check never looked further for (#2809).
    const mark = {
      type: "claimCheck",
      attrs: {
        id: "carried",
        request: "answer-1",
        action: "check-against-documents",
        state: "unsupported",
        text: words.carried,
        evidence: null,
        says: words.why,
        unsupported: { reason: words.why, covered: null, uncovered: null, found: true },
        calculation: null,
        reason: null,
        detail: null,
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        citedCaseUnchecked: false,
        citedCaseFound: false,
        scope: { folderId: null, widened: false },
        versions: [{ documentId: document.id, contentHash: document.contentHash }],
        excluded: [],
        checkedAt: "2026-11-16T09:30:00.000Z",
        fromAnswer: "answer-1",
        citedOnly: true,
      },
    };
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: words.carried, marks: [mark] },
            {
              type: "citation",
              attrs: {
                passageId: "passage-1",
                documentId: document.id,
                documentName: words.name,
                contentHash: document.contentHash,
                pageFrom: 1,
                pageTo: 1,
                location: null,
                quote: words.quote,
                check: "found",
                checkReason: null,
              },
            },
          ],
        },
      ],
    );

    const claim = window.getByTestId("claim-mark").first();
    await expect(claim).toHaveAttribute("data-check", "unsupported");
    const card = window.getByTestId("claim-card");
    await motionSettled(window);
    await pointAndClick(window, claim);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("claim-why")).toHaveText(words.why);
    await expect(card.getByTestId("claim-differs")).toHaveCount(0);
    // A check in the Note searches for the rest: it is the card's first action.
    await expect(card.getByTestId("claim-check-again")).toHaveText(words.checkAgain);
    await screenshot(window, `cited-only-card-${language}`);
    const menu = await openCardMenu(window, card);
    await expect(menu.getByTestId("claim-checked-in")).toHaveText(words.citedIn);
    await screenshot(window, `cited-only-menu-${language}`);
    await app.close();
  });
}
