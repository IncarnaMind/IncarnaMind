import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as Y from "yjs";
import { type CoreBridge, MIND_CONTENT_FIELD } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  frontMindName,
  launchApp,
  nameMind,
  newMind,
  openSteps,
  pointAndClick,
  removeDataFolder,
  saveProviderUnasked,
  setWindowSize,
  slideSelect,
} from "./app";

/**
 * A Question asked beside a Mind reads that Mind (#544): the scripted model's
 * Answer says what it read of it, the steps say "Read “{Mind}”" ("Read part of
 * “{Mind}” for a long one, and how much of it when unfolded), a selection leads, and the consent the first
 * Question asks for says the Mind goes with it; in English and Chinese. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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

/**
 * The app on an Anthropic key whose chat flow isn't allowed yet, as a key
 * chosen before choosing was the consent (ADR-0022) left it, in `language`.
 */
async function start(language: "en" | "zh-CN") {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await window.evaluate(async (chosen) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.updateSettings({ user: { language: chosen } });
  }, language);
  await saveProviderUnasked(window, {
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  return { app, window };
}

/** A new Mind, named, and its Notes typed as a person types them. */
async function writeMind(window: Page, title: string, notes: string[]): Promise<void> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, title);
  for (const [index, line] of notes.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText(notes);
}

/** Asks with ⌘J, as a person does; resolves with the Answer's place in the assistant. */
async function ask(window: Page, question: string) {
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  return assistantAnswers(window).last();
}

/** A Mind of 120 Notes of about 500 tokens each, more than a Question reads whole (#564), made through the bridge. */
async function longMind(window: Page, title: string): Promise<void> {
  const doc = new Y.Doc();
  const notes = Array.from({ length: 120 }, (_, index) => {
    const element = new Y.XmlElement("paragraph");
    element.setAttribute("id", crypto.randomUUID());
    element.insert(0, [new Y.XmlText(`Note ${index + 1}: ${"lorem ipsum ".repeat(170)}`)]);
    return element;
  });
  doc.getXmlFragment(MIND_CONTENT_FIELD).push(notes);
  await window.evaluate(
    async ({ name, update }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const mind = await bridge.createMind({ title: name });
      await bridge.applyMindUpdate(mind.id, new Uint8Array(update));
    },
    { name: title, update: Array.from(Y.encodeStateAsUpdate(doc)) },
  );
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
  await expect(frontMindName(window)).toHaveText(title);
}

test("“Summarise my notes” beside a Mind reads it: the consent says so, the Answer shows its text, the steps say Read; a selection leads; a long one is read in part", async () => {
  const { app, window } = await start("en");
  await writeMind(window, "Tide notes", [
    "Spring tides come at new and full moon.",
    "Neap tides come at the quarter moons.",
  ]);
  await expect(window.getByTestId("assistant-reads")).toHaveText(
    "Reads “Tide notes” · searches All Documents",
  );

  const answer = await ask(window, "Summarise my notes");
  const consent = window.getByTestId("consent-dialog");
  await expect(consent).toContainText(
    "Your text and earlier Answers in this note, minus excluded text",
  );
  await expect(consent).toContainText(
    "Nothing is sent unless you allow it. Change it any time in Settings → Privacy.",
  );
  await screenshot(window, "consent-en");
  await pointAndClick(window, consent.getByTestId("consent-allow"));
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("assistant-answer-text")).toContainText(
    "Read “Tide notes”, which starts: Spring tides come at new and full moon.",
  );
  // With no search, the folded line is the step: the timeline doesn't say it again.
  await expect(answer.getByTestId("answer-steps-line")).toHaveText("Read “Tide notes”");
  const timeline = await openSteps(window, answer);
  await expect(timeline.getByTestId("answer-step")).not.toHaveCount(0);
  await expect(timeline.locator('[data-step="read"]')).toHaveCount(0);
  await screenshot(window, "steps-read-en");

  // What is selected in the Mind leads the next Question.
  const neap = window.getByTestId("mind-editor").locator("p").filter({ hasText: "Neap tides" });
  await slideSelect(window, neap, "the quarter moons");
  await pointAndClick(window, window.getByTestId("composer-input"));
  await window.keyboard.type("Explain what I selected");
  await window.keyboard.press("Enter");
  const second = assistantAnswers(window).nth(1);
  await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(second.getByTestId("assistant-answer-text")).toContainText(
    "About what you selected: the quarter moons",
  );

  // A Mind too long to read whole: the steps say only part of it was read.
  await longMind(window, "Long notes");
  const long = await ask(window, "Summarise my notes");
  await expect(long).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(long.getByTestId("answer-steps-line")).toHaveText("Read part of “Long notes”");
  await screenshot(window, "steps-read-part-en");
  // Unfolded, the steps say how much of it was read (#564).
  const longSteps = await openSteps(window, long);
  await expect(longSteps.getByTestId("answer-step-read-share")).toHaveText(
    /^About \d{1,2}% of it$/,
  );
  await screenshot(window, "steps-read-share-en");

  // The Mind's name in the folded line goes to that Mind.
  await expect(frontMindName(window)).toHaveText("Long notes");
  await pointAndClick(window, second.getByTestId("answer-steps-mind"));
  await expect(frontMindName(window)).toHaveText("Tide notes");
  await app.close();
});

test("in Chinese: the consent, the Answer that read the Mind, and the steps", async () => {
  const { app, window } = await start("zh-CN");
  await writeMind(window, "潮汐笔记", ["大潮出现在新月和满月。", "小潮出现在上弦月和下弦月。"]);
  await expect(window.getByTestId("assistant-reads")).toHaveText("正在读“潮汐笔记” · 搜索全部文档");

  const answer = await ask(window, "总结我的笔记");
  const consent = window.getByTestId("consent-dialog");
  await expect(consent).toContainText("这篇笔记中你写的内容和之前的回答，不含已排除的内容");
  await expect(consent).toContainText(
    "在你允许之前不会发送任何内容。你可以随时在“设置”的“隐私”中更改。",
  );
  await screenshot(window, "consent-zh");
  await pointAndClick(window, consent.getByTestId("consent-allow"));
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("assistant-answer-text")).toContainText(
    "Read “潮汐笔记”, which starts: 大潮出现在新月和满月。",
  );
  await expect(answer.getByTestId("answer-steps-line")).toHaveText("读了“潮汐笔记”");
  const timeline = await openSteps(window, answer);
  await expect(timeline.locator('[data-step="read"]')).toHaveCount(0);
  await screenshot(window, "steps-read-zh");

  await longMind(window, "长笔记");
  const long = await ask(window, "总结我的笔记");
  await expect(long).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(long.getByTestId("answer-steps-line")).toHaveText("读了“长笔记”的一部分");
  await screenshot(window, "steps-read-part-zh");
  const longSteps = await openSteps(window, long);
  await expect(longSteps.getByTestId("answer-step-read-share")).toHaveText(/^约 \d{1,2}%$/);
  await screenshot(window, "steps-read-share-zh");
  await app.close();
});
