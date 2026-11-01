import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  slideSelect,
} from "./app";

/*
 * AI › Explain on a selection asks the assistant (#2348): the answer is in the assistant, the
 * selected text is its chip, and the Note is left exactly as it was, as the prototype does.
 * Explaining isn't editing. With the assistant folded it opens, docked as the User left it.
 * In English and Chinese.
 *
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const WORDS = {
  en: {
    title: "Tide notes",
    line: "Spring tides come at new and full moon, when the Sun and the Moon pull together.",
    selected: "new and full moon",
    explain: "Explain",
    question: "Explain “new and full moon”",
    asked: "Explain",
  },
  "zh-CN": {
    title: "潮汐笔记",
    line: "大潮出现在新月和满月，因为太阳和月亮的引力叠加在一起。",
    selected: "新月和满月",
    explain: "解释",
    question: "解释“新月和满月”",
    asked: "解释",
  },
} as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function start(language: "en" | "zh-CN", width: number) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, width, 800);
  await dismissChatSetup(window);
  await window.evaluate(async (chosen) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: chosen } });
    await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
  }, language);
  return { app, window };
}

async function writeNote(window: Page, title: string, line: string): Promise<Locator> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, title);
  await window.keyboard.type(line);
  const note = window.getByTestId("mind-editor").locator(":scope > p").first();
  await expect(note).toHaveText(line);
  return note;
}

/** The action's words for its menu row, in the language on screen. */
const explainRow = (window: Page) =>
  window.getByTestId("selection-menu").getByTestId("selection-action-explain");

for (const [language, width] of [
  ["en", 900],
  ["zh-CN", 1600],
] as const) {
  test(`in ${language} at ${width}px, Explain answers in the assistant, with the selection as a chip, and the Note stays as it was`, async () => {
    const words = WORDS[language];
    const { app, window } = await start(language, width);
    const note = await writeNote(window, words.title, words.line);
    const editor = window.getByTestId("mind-editor");

    await slideSelect(window, note, words.selected);
    await expect(explainRow(window)).toContainText(words.explain);
    await pointAndClick(window, explainRow(window));

    // The answer is in the assistant, and its Question carries the selection as a chip.
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 20_000 });
    const text = answer.getByTestId("assistant-answer-text");
    await expect(text).not.toHaveText("");
    const question = window.getByTestId("assistant-question").last();
    await expect(question).toContainText(words.question);
    const chip = question.getByTestId("assistant-question-quote");
    await expect(chip).toHaveText(new RegExp(`“${words.selected}”`));
    await screenshot(window, `explain-${language}`);

    // Explaining isn't editing: the Note is byte-for-byte what it was, with nothing to review.
    await expect(note).toHaveText(words.line);
    await expect(editor.getByTestId("applied-line")).toHaveCount(0);
    await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
    expect(await editor.evaluate((dom) => dom.textContent)).toBe(words.line);
    await app.close();
  });
}

test("with the assistant folded, Explain opens it where the User left it", async () => {
  const words = WORDS.en;
  const { app, window } = await start("en", 1_280);
  const note = await writeNote(window, words.title, words.line);
  const assistant = window.getByTestId("assistant");

  // Folded away as the User left it: the rail shows, with its place kept.
  const dock = await assistant.getAttribute("data-dock");
  await window.getByTestId("assistant-fold").click();
  await expect(assistant).toHaveAttribute("data-folded", "true");
  await expect(window.getByTestId("assistant-rail")).toBeVisible();

  await slideSelect(window, note, words.selected);
  await pointAndClick(window, explainRow(window));

  // It unfolds, docked as it was, and the answer is there.
  await expect(assistant).not.toHaveAttribute("data-folded", "true");
  await expect(assistant).toHaveAttribute("data-dock", dock ?? "right");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(
    window.getByTestId("assistant-question").last().getByTestId("assistant-question-quote"),
  ).toHaveText(new RegExp(`“${words.selected}”`));
  await screenshot(window, "explain-unfolds");
  await app.close();
});

test("Explain while an Answer is being written waits in view: one Answer at a time, one Stop", async () => {
  const words = WORDS.en;
  const { app, window } = await start("en", 1_280);
  const note = await writeNote(window, words.title, words.line);
  const answers = assistantAnswers(window);
  const questions = window.getByTestId("assistant-question");

  // A slow Answer, still being written when Explain is asked.
  await pointAndClick(window, window.getByTestId("composer-input"));
  await window.keyboard.type("Summarise my notes slowly");
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(1);
  await expect(answers.first()).toHaveAttribute("data-status", "streaming");

  await slideSelect(window, note, words.selected);
  await pointAndClick(window, explainRow(window));

  // It waits in view: one Question, one Answer, while the first is still being written.
  const queued = window.getByTestId("explain-queued");
  await expect(queued).toContainText("Explain will be asked when this Answer is done");
  await expect(answers.first()).toHaveAttribute("data-status", "streaming");
  await expect(questions).toHaveCount(1);
  await expect(answers).toHaveCount(1);

  // A second Explain replaces the first: one waits at most.
  await slideSelect(window, note, words.selected);
  await pointAndClick(window, explainRow(window));
  await expect(queued).toHaveCount(1);

  // When its Question comes, the Answer before it is already done.
  await expect(questions).toHaveCount(2, { timeout: 40_000 });
  await expect(answers.first()).toHaveAttribute("data-status", "done");
  await expect(questions.last()).toContainText(words.question);
  await expect(answers.last()).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  await expect(questions.last().getByTestId("assistant-question-quote")).toHaveText(
    new RegExp(`“${words.selected}”`),
  );
  await app.close();
});

test("a queued Explain can be cancelled, and stopping the Answer cancels it too", async () => {
  const words = WORDS.en;
  const { app, window } = await start("en", 1_280);
  const note = await writeNote(window, words.title, words.line);
  const answers = assistantAnswers(window);
  const questions = window.getByTestId("assistant-question");
  const queued = window.getByTestId("explain-queued");
  const slowQuestion = async () => {
    await pointAndClick(window, window.getByTestId("composer-input"));
    await window.keyboard.type("Summarise my notes slowly");
    await window.keyboard.press("Enter");
    await expect(answers.last()).toHaveAttribute("data-status", "streaming");
  };
  const explain = async () => {
    await slideSelect(window, note, words.selected);
    await pointAndClick(window, explainRow(window));
    await expect(queued).toBeVisible();
  };

  // Cancelled, it is not asked when the Answer ends.
  await slowQuestion();
  await explain();
  await pointAndClick(window, window.getByTestId("explain-queued-cancel"));
  await expect(queued).toHaveCount(0);
  await expect(answers.first()).toHaveAttribute("data-status", "done", { timeout: 40_000 });
  await expect(questions).toHaveCount(1);

  // Stopping the Answer cancels it too: stopping isn't asking.
  await slowQuestion();
  await explain();
  await pointAndClick(window, window.getByTestId("composer-stop"));
  await expect(queued).toHaveCount(0);
  await expect(questions).toHaveCount(2);
  await screenshot(window, "explain-cancelled");
  await app.close();
});
