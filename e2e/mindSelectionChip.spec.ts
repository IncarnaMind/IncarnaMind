import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  slideSelect,
  tabTo,
} from "./app";

/**
 * A selection in the Mind stays drawn, in the inactive grey, while the
 * composer has the focus, and the composer shows it as a quote chip (#565):
 * the chip follows the selection, × leaves it out and the Question reads the
 * whole Mind, a click shows the passage again, and the Question keeps its
 * quote and its steps say "Read your selection in…". In English and Chinese,
 * by mouse and by keyboard, at 1,100px and wide. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: {
    title: "Tide notes",
    notes: ["Spring tides come at new and full moon.", "Neap tides come at the quarter moons."],
    first: "new and full moon",
    second: "the quarter moons",
    drop: "Don’t ask about this",
    steps: "Read your selection in “Tide notes”",
    whole: "Read “Tide notes”",
    question: "Explain what I selected",
    summary: "Summarise my notes",
  },
  "zh-CN": {
    title: "潮汐笔记",
    notes: ["大潮出现在新月和满月。", "小潮出现在上弦月和下弦月。"],
    first: "新月和满月",
    second: "上弦月和下弦月",
    drop: "不针对这段内容",
    steps: "读了你在“潮汐笔记”中选中的内容",
    whole: "读了“潮汐笔记”",
    question: "解释选中的内容",
    summary: "总结我的笔记",
  },
} as const;

async function start(language: "en" | "zh-CN", width: number) {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, width, 800);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async (chosen) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: chosen } });
    await bridge.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
  }, language);
  return { app, window };
}

async function writeMind(window: Page, title: string, notes: readonly string[]): Promise<Locator> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, title);
  for (const [index, line] of notes.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  const lines = window.getByTestId("mind-editor").locator("p");
  await expect(lines).toHaveText([...notes]);
  return lines;
}

/** The selection as the page draws it: the chip, the held mark, and what is selected in the page. */
const chipOf = (window: Page) => window.getByTestId("composer-selection");
const heldOf = (window: Page) => window.getByTestId("mind-editor").locator(".held-selection");
const selectedIn = (window: Page) => window.evaluate(() => globalThis.getSelection()?.toString());

/**
 * ProseMirror puts its selection back into the page a moment (20 ms) after the editor takes the
 * focus; keys pressed before that are undone by it. This waits for it.
 */
const afterFocus = (window: Page) =>
  window.evaluate(() => new Promise((resolve) => setTimeout(resolve, 60)));

/** Selects the last words of a line with Shift+ArrowLeft, again if the editor undid it on taking the focus. */
async function selectBack(window: Page, line: Locator, words: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickEndOf(window, line);
    await afterFocus(window);
    await window.keyboard.press("ArrowLeft");
    for (let index = 0; index < [...words].length; index++) {
      await window.keyboard.press("Shift+ArrowLeft");
    }
    if ((await selectedIn(window)) === words) break;
  }
  // The editor reads the page's selection a moment after it changes; a Tab before that loses it.
  await expect.poll(() => selectedInEditor(window)).toBe(words);
}

const selectedInEditor = (window: Page) =>
  window.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as unknown as { editor: Editor }).editor;
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to);
  });

/** The chip's quote and where it is from, and the mark that keeps the passage drawn in grey. */
async function expectDrawn(window: Page, words: string, title: string): Promise<void> {
  const chip = chipOf(window);
  await expect(chip).toContainText(`“${words}”`);
  await expect(chip).toContainText(title);
  await expect(chip).toHaveAttribute("title", words);
  await expect(heldOf(window)).toHaveText(words);
  await expect
    .poll(() => heldOf(window).evaluate((mark) => getComputedStyle(mark).backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)");
}

for (const [language, width] of [
  ["en", 1100],
  ["zh-CN", 1600],
] as const) {
  test(`by mouse, in ${language} at ${width}px: the selection stays drawn, the chip follows it, × leaves it out, a click shows it, and the Question keeps its quote`, async () => {
    const words = WORDS[language];
    const { app, window } = await start(language, width);
    const lines = await writeMind(window, words.title, words.notes);
    const composer = window.getByTestId("composer-input");

    // Select in the Mind, click the composer: the passage stays drawn, grey, and the chip quotes it.
    await slideSelect(window, lines.nth(1), words.second);
    await expect(chipOf(window)).toBeVisible();
    await pointAndClick(window, composer);
    await expect(composer).toBeFocused();
    await expectDrawn(window, words.second, words.title);
    await screenshot(window, `chip-${language}-${width}`);

    // The chip sits before the text and inside the composer; the words stay in view.
    const chipBox = await chipOf(window).boundingBox();
    const composerBox = await window.getByTestId("composer").boundingBox();
    const inputBox = await composer.boundingBox();
    if (!chipBox || !composerBox || !inputBox) throw new Error("The composer isn't drawn.");
    expect(chipBox.x).toBeGreaterThanOrEqual(composerBox.x);
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height);
    expect(inputBox.width).toBeGreaterThan(40);

    // Selecting something else changes the chip.
    await slideSelect(window, lines.nth(0), words.first);
    await expect(chipOf(window)).toContainText(`“${words.first}”`);
    await pointAndClick(window, composer);
    await expectDrawn(window, words.first, words.title);

    // Clicking in the Mind without selecting takes it away, and the grey with it.
    await clickEndOf(window, lines.nth(0));
    await expect(chipOf(window)).toHaveCount(0);
    await expect(heldOf(window)).toHaveCount(0);

    // × leaves the passage out: the Question reads the whole Mind.
    await slideSelect(window, lines.nth(1), words.second);
    await pointAndClick(window, composer);
    const remove = window.getByTestId("composer-selection-remove");
    await expect(remove).toHaveAccessibleName(words.drop);
    await expect(remove).toHaveAttribute("title", words.drop);
    await pointAndClick(window, remove);
    await expect(chipOf(window)).toHaveCount(0);
    await expect(heldOf(window)).toHaveCount(0);
    await expect(composer).toBeFocused();
    await window.keyboard.type(words.summary);
    await window.keyboard.press("Enter");
    const whole = assistantAnswers(window).first();
    await expect(whole).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(whole.getByTestId("answer-steps-line")).toHaveText(words.whole);
    await expect(whole.getByTestId("assistant-answer-text")).toContainText("which starts");
    await expect(whole.getByTestId("assistant-answer-text")).not.toContainText(
      "About what you selected",
    );
    await expect(window.getByTestId("assistant-question-quote")).toHaveCount(0);

    // Another passage brings the chip back; a click on it scrolls to the passage and selects it again.
    await slideSelect(window, lines.nth(0), words.first);
    await pointAndClick(window, composer);
    await expectDrawn(window, words.first, words.title);
    await pointAndClick(window, window.getByTestId("composer-selection-show"));
    await expect(window.getByTestId("mind-editor")).toBeFocused();
    expect(await selectedIn(window)).toBe(words.first);
    await expect(chipOf(window)).toContainText(`“${words.first}”`);

    // Asked, the Question keeps its quote above its words, the steps say so, and the selection is spent.
    await pointAndClick(window, composer);
    await window.keyboard.type(words.question);
    await window.keyboard.press("Enter");
    const second = assistantAnswers(window).nth(1);
    await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(second.getByTestId("assistant-answer-text")).toContainText(words.first);
    await expect(second.getByTestId("answer-steps-line")).toHaveText(words.steps);
    const quote = window.getByTestId("assistant-question-quote");
    await expect(quote).toHaveCount(1);
    await expect(quote).toHaveText(new RegExp(`“${words.first}”`));
    const bubble = window.getByTestId("assistant-question").last();
    const quoteBox = await quote.boundingBox();
    const wordsBox = await bubble.locator("p").boundingBox();
    if (!quoteBox || !wordsBox) throw new Error("The Question isn't drawn.");
    expect(quoteBox.y).toBeGreaterThanOrEqual(wordsBox.y);
    expect(quoteBox.y + quoteBox.height).toBeLessThan(wordsBox.y + wordsBox.height);
    await expect(chipOf(window)).toHaveCount(0);
    await expect(heldOf(window)).toHaveCount(0);
    await openSteps(window, second);
    await screenshot(window, `question-${language}-${width}`);

    // The quote is kept with the conversation, not with the selection.
    const kept = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [conversation] = await bridge.listConversations();
      if (!conversation) return [];
      const { messages } = await bridge.getConversation(conversation.id);
      return messages.flatMap((message) =>
        message.kind === "question" ? [message.focus?.selection ?? ""] : [],
      );
    });
    expect(kept).toEqual(["", words.first]);
    await app.close();
  });
}

for (const [language, width] of [
  ["en", 1600],
  ["zh-CN", 1100],
] as const) {
  test(`by keyboard, in ${language} at ${width}px: Tab into the composer shows the chip, Backspace takes it away, Tab reaches its buttons`, async () => {
    const words = WORDS[language];
    const { app, window } = await start(language, width);
    const lines = await writeMind(window, words.title, words.notes);
    const composer = window.getByTestId("composer-input");

    // Select with the keyboard, from the end of a line back over its last words.
    await selectBack(window, lines.nth(1), words.second);
    await tabTo(window, composer);
    await expect(chipOf(window)).toBeVisible();
    await expect(heldOf(window)).not.toHaveCount(0);

    // Backspace in the empty text takes the chip away; the Mind keeps nothing drawn.
    await window.keyboard.press("Backspace");
    await expect(chipOf(window)).toHaveCount(0);
    await expect(heldOf(window)).toHaveCount(0);

    // Back in the Mind, the same passage stays out; a new one brings the chip back.
    await selectBack(window, lines.nth(0), words.first);
    await tabTo(window, composer);
    await expect(chipOf(window)).toBeVisible();

    // Shift+Tab walks back over the chip's buttons; Enter on × takes it away, with the focus in the text.
    await window.keyboard.press("Shift+Tab");
    await expect(window.getByTestId("composer-selection-remove")).toBeFocused();
    await window.keyboard.press("Shift+Tab");
    await expect(window.getByTestId("composer-selection-show")).toBeFocused();
    await window.keyboard.press("Tab");
    await window.keyboard.press("Enter");
    await expect(chipOf(window)).toHaveCount(0);
    await expect(composer).toBeFocused();
    await app.close();
  });
}
