import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  motionSettled,
  openCardMenu,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * A check carried into a Note from an Answer whose look read only the sentence's Citations
 * (#2809): its card says what the check read, and offers Check again first. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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
    name: "Sample resume",
    carried: "Alex ran the hospital's design team for nine years.",
    quote: "Runs a team of four designers and reports to the head of product.",
    why: "The quote gives the team's size, not how long Alex ran it.",
    citedIn: "Checked against its Citations in “Sample resume”",
    checkAgain: "Check again",
  },
  "zh-CN": {
    file: "示例简历.md",
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

for (const language of ["en", "zh-CN"] as const) {
  const words = LANGUAGES[language];

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
