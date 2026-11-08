import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/*
 * Enter while a reply runs queues the Question (#2866): it waits above the box as one line, is
 * asked when the reply ends, Cancel puts its words back in the box, Stop and Esc stop the reply
 * and the Question is asked next, and only one waits. In English and Chinese.
 *
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** The scripted model writes a Question that says "slowly" word by word: seconds, not a blink. */
const WORDS = {
  en: {
    slow: "How do spring tides form? Answer slowly without searching.",
    next: "And what about neap tides?",
    other: "Why do tides differ from coast to coast?",
    queued: "Asks next, when this reply ends",
    cancel: "Cancel",
    stop: "Stop the Answer",
  },
  "zh-CN": {
    slow: "春潮是怎么形成的？Answer slowly，不用搜索。",
    next: "那小潮呢？",
    other: "为什么不同海岸的潮汐不一样？",
    queued: "这条回复结束后接着问",
    cancel: "取消",
    stop: "停止生成回答",
  },
} as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function start(language: "en" | "zh-CN") {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1_280, 800);
  await dismissChatSetup(window);
  await window.evaluate(async (chosen) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: chosen } });
    await bridge.saveChatProvider({ kind: "ollama", modelId: "fake-model" });
  }, language);
  const composer = window.getByTestId("composer");
  const input = composer.getByTestId("composer-input");
  return {
    app,
    window,
    input,
    stop: composer.getByTestId("composer-stop"),
    queued: window.getByTestId("ask-queued"),
    cancel: window.getByTestId("ask-queued-cancel"),
    questions: window.getByTestId("assistant").getByTestId("assistant-question"),
    answers: assistantAnswers(window),
  };
}

/** Asks the slow Question and waits until its Answer is being written. */
async function askSlowly(
  window: Page,
  words: { slow: string },
  { input, answers }: Pick<Awaited<ReturnType<typeof start>>, "input" | "answers">,
): Promise<void> {
  await pointAndClick(window, input);
  await window.keyboard.type(words.slow);
  await window.keyboard.press("Enter");
  await expect(answers.first()).toHaveAttribute("data-status", "streaming");
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`in ${language}, Enter while a reply runs queues the Question above the box, and it is asked when the reply ends`, async () => {
    test.setTimeout(120_000);
    const page = await start(language);
    const { app, window, input, stop, queued, cancel, questions, answers } = page;
    await askSlowly(window, words, page);

    await window.keyboard.type(words.next);
    await window.keyboard.press("Enter");

    // The line shows what Enter did, the box is empty, and Stop is where it was.
    await expect(queued).toContainText(words.queued);
    await expect(cancel).toHaveText(words.cancel);
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(stop).toBeVisible();
    await expect(stop).toHaveAccessibleName(words.stop);
    await expect(answers.first()).toHaveAttribute("data-status", "streaming");
    await expect(questions).toHaveCount(1);
    const line = await queued.boundingBox();
    const box = await input.boundingBox();
    expect((line?.y ?? 0) + (line?.height ?? 0)).toBeLessThanOrEqual(box?.y ?? 0);
    await screenshot(window, `ask-queued-${language}`);

    // With no further press, it is asked when the reply is done.
    await expect(answers.first()).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(questions).toHaveCount(2);
    await expect(questions.last()).toContainText(words.next);
    await expect(queued).toHaveCount(0);
    await expect(answers).toHaveCount(2);
    await expect(answers.last()).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(input).toHaveValue("");
    await app.close();
  });

  test(`in ${language}, Cancel puts the words back in the box; Enter again changes the waiting Question; Stop asks it next`, async () => {
    test.setTimeout(120_000);
    const page = await start(language);
    const { app, window, input, stop, queued, cancel, questions, answers } = page;
    await askSlowly(window, words, page);

    // Cancel: the words are in the box again, unsent, and the reply goes on.
    await window.keyboard.type(words.next);
    await window.keyboard.press("Enter");
    await expect(queued).toBeVisible();
    await pointAndClick(window, cancel);
    await expect(queued).toHaveCount(0);
    await expect(input).toHaveValue(words.next);
    await expect(input).toBeFocused();
    await expect(answers.first()).toHaveAttribute("data-status", "streaming");
    await expect(questions).toHaveCount(1);

    // Queued again, then changed by a second Enter: one waits, with the new words.
    await window.keyboard.press("Enter");
    await expect(queued).toContainText(words.queued);
    await expect(input).toHaveValue("");
    await window.keyboard.type(words.other);
    await window.keyboard.press("Enter");
    await expect(queued).toHaveCount(1);
    await expect(input).toHaveValue("");
    await expect(questions).toHaveCount(1);

    // Stop ends the reply, keeping what it wrote, and the waiting Question is asked next.
    await pointAndClick(window, stop);
    await expect(answers.first()).toHaveAttribute("data-status", "stopped");
    await expect(questions).toHaveCount(2);
    await expect(questions.last()).toContainText(words.other);
    await expect(questions.filter({ hasText: words.next })).toHaveCount(0);
    await expect(queued).toHaveCount(0);
    await expect(answers.last()).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(answers).toHaveCount(2);
    await app.close();
  });
}

test("Esc stops the reply, and the waiting Question is asked next", async () => {
  test.setTimeout(120_000);
  const words = WORDS.en;
  const page = await start("en");
  const { app, window, input, queued, questions, answers } = page;
  await askSlowly(window, words, page);

  await window.keyboard.type(words.next);
  await window.keyboard.press("Enter");
  await expect(queued).toBeVisible();

  await window.keyboard.press("Escape");
  await expect(answers.first()).toHaveAttribute("data-status", "stopped");
  await expect(questions).toHaveCount(2);
  await expect(questions.last()).toContainText(words.next);
  await expect(queued).toHaveCount(0);
  await expect(answers.last()).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  // Esc stopped the reply and nothing more: the cursor is still in the box.
  await expect(input).toBeFocused();
  await app.close();
});
