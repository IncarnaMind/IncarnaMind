import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * A check a limit kept too short to finish (#2962). On Claude Fable 5, the Answer's $0.25 leaves
 * a batch of four sentences less room than its room for thinking, and the scripted model, asked to
 * think them over, writes past it. Each sentence's card says the limit was reached before the model
 * finished, the line under the Answer names the limit with Check the rest, and Check the rest says
 * what it costs before it checks. Near the monthly cap, the cap is named instead, with Settings.
 * English and Chinese, at the narrowest window. Set INCARNAMIND_SCREENSHOTS to a folder to keep
 * stills.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const TIDES = [
  "# Tides and the Moon",
  "",
  "The tide rises and falls twice a day, as the Moon moves.",
  "",
  "潮水每天涨落两次，月亮的位置决定了涨落的时间。",
  "",
].join("\n");

const WORDS = {
  en: {
    question: "What do tides do? Four citations, thought over.",
    line: "0 of 4 sentences checked · This Answer’s $0.25 checking limit reached",
    card: "Not checked: this Answer’s $0.25 checking limit was reached before Claude Fable 5 finished checking this sentence.",
    capLine: "0 of 4 sentences checked · Your monthly limit reached",
    capCard:
      "Not checked: your monthly limit was reached before Claude Fable 5 finished checking this sentence.",
  },
  "zh-CN": {
    question: "潮水怎么涨落？四条引用，细想。",
    line: "已核对 4 句中的 0 句 · 已达本回答 $0.25 的核对上限",
    card: "未核对：Claude Fable 5 还没核对完这句，就已达本回答 $0.25 的核对上限。",
    capLine: "已核对 4 句中的 0 句 · 已达每月上限",
    capCard: "未核对：Claude Fable 5 还没核对完这句，就已达每月上限。",
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

const bridge = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/** The first Citation's card, opened from its chip. */
async function firstCard(window: Page, answer: Locator): Promise<Locator> {
  await pointAndClick(window, answer.getByTestId("citation-chip").first());
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await motionSettled(window);
  return card;
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a check the $0.25 and then the monthly cap kept too short to finish names that limit (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.md"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 900, 700);
      await dismissChatSetup(window);
      await acceptPlainTextKeys(window);
      await (await bridge(window)).evaluate((core) =>
        core.saveChatProvider({
          kind: "anthropic",
          apiKey: "sk-ant-a-made-up-key",
          modelId: "claude-fable-5",
        }),
      );
      await setLanguage(window, language);
      await addDocuments(window, [join(sources, "Tides.md")]);

      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type(words.question);
      await window.keyboard.press("Enter");
      const answer = assistantAnswers(window).last();
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
      const notChecked = answer.locator('[data-testid="citation"][data-check="not-checked"]');
      await expect(notChecked).toHaveCount(4, { timeout: 30_000 });

      const steps = await openSteps(window, answer);
      await expect(steps.getByTestId("answer-check-stopped")).toContainText(words.line, {
        timeout: 15_000,
      });
      const card = await firstCard(window, answer);
      await expect(card.getByTestId("citation-reason")).toHaveText(words.card);
      await screenshot(window, `check-unfinished-answer-limit-${language}`);
      await window.keyboard.press("Escape");

      // The monthly cap now leaves less beyond the batch's old room than the Answer's $0.25 does.
      await (await bridge(window)).evaluate(async (core) => {
        const spent = (await core.getCostSummary()).spent
          .filter((each) => each.currency === "USD")
          .reduce((sum, each) => sum + each.amount, 0);
        await core.updateSettings({
          user: { monthlyCap: { amount: spent + 0.2, currency: "USD" } },
        });
      });
      await pointAndClick(window, steps.getByTestId("answer-check-the-rest"));
      // The ask shows once the estimate, a request to the core, has come back.
      const ask = steps.getByTestId("answer-check-the-rest-ask");
      await expect(ask).toContainText("$", { timeout: 15_000 });
      await motionSettled(window);
      await screenshot(window, `check-unfinished-check-the-rest-${language}`);
      await pointAndClick(window, ask.getByTestId("answer-check-the-rest-go"));

      await expect(steps.getByTestId("answer-check-stopped")).toContainText(words.capLine, {
        timeout: 30_000,
      });
      await expect(steps.getByTestId("answer-check-settings")).toBeVisible();
      await expect(steps.getByTestId("answer-check-the-rest")).toHaveCount(0);
      const capCard = await firstCard(window, answer);
      await expect(capCard.getByTestId("citation-reason")).toHaveText(words.capCard);
      await screenshot(window, `check-unfinished-monthly-limit-${language}`);
    } finally {
      await app.close();
    }
  });
}
