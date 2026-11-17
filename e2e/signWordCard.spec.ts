import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { signWordDetail } from "../src/shared/signWord";
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
  useLocalChatModel,
} from "./app";

/*
 * A right sentence about a rent that stands after a clause about a loss that is about something
 * else is Not checked, and its card names the word that may give the amount a minus (#3228). The
 * check is written into the page, so no model is involved. Set INCARNAMIND_SCREENSHOTS to a folder
 * to save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const CASES = {
  en: {
    lease:
      "The Landlord is not liable for any loss of business. The annual rent is ninety-five thousand dollars ($95,000.00).",
    sentence: "The annual rent is $95,000.",
    quote: "The annual rent is ninety-five thousand dollars ($95,000.00).",
    shown: "$95,000.00",
    word: "loss",
    reason: "“$95,000.00” may be negative because of “loss” nearby, so it wasn’t checked.",
  },
  "zh-CN": {
    lease: "出租方对营业损失不承担责任。月租金为人民币九万五千元（¥95,000）。",
    sentence: "月租金为¥95,000。",
    quote: "月租金为人民币九万五千元（¥95,000）。",
    shown: "¥95,000",
    word: "损失",
    reason: "附近的“损失”可能表示“¥95,000”是负数，所以未核对。",
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

for (const language of ["en", "zh-CN"] as const) {
  test(`a right rent sentence after a loss clause about something else is Not checked, naming the word (${language})`, async () => {
    test.setTimeout(120_000);
    const words = CASES[language];
    await writeFile(join(sources, "Lease.md"), `# Lease\n\n${words.lease}\n`);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1100, 760);
    await addDocuments(window, [join(sources, "Lease.md")]);
    const [lease] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const versions = [{ documentId: lease?.id, contentHash: lease?.contentHash }];
    const detail = signWordDetail({ shown: words.shown, word: words.word });
    const check = {
      id: "check-1",
      request: "check-1",
      action: "check-against-documents",
      state: "not-checked",
      reason: "sign-word",
      detail,
      providerId: null,
      modelId: "fake-model",
      text: words.sentence,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions,
      excluded: [],
      checkedAt: "2026-11-17T09:00:00.000Z",
      parts: [],
    };
    const marks = [{ type: "claimCheck", attrs: check }];
    await newMind(window);
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, content) => {
        (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
      },
      [
        { type: "paragraph", content: [{ type: "text", text: "Rent" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: words.sentence.slice(0, -1), marks },
            {
              type: "citation",
              attrs: {
                documentId: lease?.id,
                documentName: "Lease",
                contentHash: lease?.contentHash,
                quote: words.quote,
                check: "found",
                checkReason: null,
              },
            },
            { type: "text", text: words.sentence.slice(-1), marks },
          ],
        },
      ],
    );
    const mark = window.locator('[data-testid="claim-mark"][data-claim="check-1"]');
    await expect(mark).toHaveAttribute("data-check", "not-checked");
    await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
    const card = window.getByTestId("claim-card");
    await expect(card).toBeVisible();
    await expect(card.getByTestId("claim-reason")).toHaveText(words.reason);
    await screenshot(window, `sign-word-card-${language}`);
    await app.close();
  });
}
