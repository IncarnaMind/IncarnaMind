import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  assistantAnswers,
  busyOllama,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  forceQuit,
  launchApp,
  nameMind,
  ollamaListing,
  openSteps,
  pointAndClick,
  pointAt,
  removeDataFolder,
  saveProviderUnasked,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * The composer at the foot of the assistant (DESIGN.md, Composer; #253, #201):
 * asking shows the Question in the assistant's conversation and streams its
 * Answer under it, with checked Citations, and leaves the Mind as it was;
 * Stop keeps what streamed; sending shows at once, and the send button is
 * Stop while an Answer is written, so nothing is asked twice; ⌘J, Enter,
 * Shift+Enter and Esc; the model chip, remembered per Mind; Minds written before. Driven as a person would, with
 * the mouse slid onto what it clicks and the keys typed. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Three short pages: the line about spring tides is on page 2. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
  { lines: ["Tide tables", "Harbours publish the times of high water every year."] },
]);

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

/**
 * The Mind as wide as the approved mockups drew it (a 1440px window's card),
 * beside the assistant docked on the right (#253), which takes 328px of it.
 */
async function atMockupSize(app: ElectronApplication, window: Page) {
  await setWindowSize(app, window, 1600, 900);
  await window.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Each top-level Block of the Mind: "question", "answer", or a Note's text. */
const order = (editor: Locator) =>
  editor
    .locator(":scope > *")
    .evaluateAll((all) =>
      all.map((block) =>
        block.matches(".node-question")
          ? "question"
          : block.matches(".node-answer")
            ? "answer"
            : (block.textContent ?? "").trim(),
      ),
    );

const opacityOf = (locator: Locator) =>
  locator.evaluate((element) => Number(getComputedStyle(element).opacity));

const bridge = (window: Page) => ({
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  /** The chat model: one in Ollama at `baseUrl`. */
  ollama: (baseUrl: string) =>
    window.evaluate(async (url) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "ollama",
        baseUrl: url,
        modelId: "fake-model",
      });
    }, baseUrl),
  /** "Keep everything on this computer", as its switch in Settings sets it. */
  localOnly: (on: boolean) =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setLocalOnly(value),
      on,
    ),
  /** The last Answer the core keeps in the only conversation: its status and its Markdown. */
  storedAnswer: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [conversation] = await core.listConversations();
      if (!conversation) throw new Error("The core keeps no conversation.");
      const { messages } = await core.getConversation(conversation.id);
      const answer = messages.filter((message) => message.kind === "answer").at(-1);
      return answer?.kind === "answer" ? { status: answer.status, text: answer.text } : null;
    }),
  storedConversation: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const [conversation] = await core.listConversations();
      return conversation ? core.getConversation(conversation.id) : null;
    }),
});

/** The scripted Answer repeats the Question: a long one keeps it streaming for a few seconds. */
const LONG_QUESTION =
  "What is IncarnaMind, how does it read my Documents, where does it keep them, which models can it use, how does it cite a page, and what happens to my files when I close it?";

test("typing in the composer and pressing Enter shows the Question in the assistant as a bubble, and its Answer streams in under it with checked Citations, the Mind as it was", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await atMockupSize(app, window);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await nameMind(window, "Reading notes: tides");
  await enterContent(window);
  await window.keyboard.type("Spring tides come twice a month.");
  const editor = window.getByTestId("mind-editor");

  // The composer, at the foot of the Mind: its placeholder, the model and the Search scope.
  const composer = window.getByTestId("composer");
  const input = composer.getByTestId("composer-input");
  await expect(input).toHaveAttribute("placeholder", "Ask, or say ‘write a note on…’");
  await expect(composer.getByTestId("composer-model")).toHaveText("fake-model");
  await expect(composer.getByTestId("composer-scope-all")).toHaveText("All Documents");
  const ask = composer.getByTestId("composer-ask");
  await expect(ask).toBeDisabled();
  await expect(ask).toHaveAccessibleName("Ask (Enter)");
  // At the foot of the assistant, beside the card (#253), and as wide as the assistant lets it be.
  const inputBox = await composer.boundingBox();
  const assistantBox = await window.getByTestId("assistant").boundingBox();
  const cardBox = await window.getByTestId("card").boundingBox();
  expect(inputBox?.x ?? 0).toBeGreaterThan((cardBox?.x ?? 0) + (cardBox?.width ?? 0));
  expect(inputBox?.x ?? 0).toBeGreaterThan(assistantBox?.x ?? 0);
  expect((inputBox?.x ?? 0) + (inputBox?.width ?? 0)).toBeLessThan(
    (assistantBox?.x ?? 0) + (assistantBox?.width ?? 0),
  );
  // Its 16px edges are all that is left of the assistant's width.
  expect(inputBox?.width ?? 0).toBeGreaterThanOrEqual((assistantBox?.width ?? 0) - 33);
  await screenshot(window, "composer-empty-en");

  // Clicked into, then typed in: the Ask button turns primary; Enter asks.
  await pointAndClick(window, input);
  await window.keyboard.type("When do spring tides happen?");
  await expect(ask).toBeEnabled();
  await expect(composer).toHaveCSS("border-color", "rgb(42, 91, 215)");
  await screenshot(window, "composer-typed-en");
  await window.keyboard.press("Enter");

  // A bubble at the right of the assistant, in the assistant's reading size; its Answer under it.
  const question = window.getByTestId("assistant-question");
  await expect(question).toHaveCount(1);
  await expect(question).toContainText("When do spring tides happen?");
  const bubble = question.locator(".assistant-question-bubble");
  await expect(bubble).toHaveCSS("font-size", "14px");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "streaming");
  // While it is written: the pulsing dot shows and the composer's button is Stop, with none under
  // the line; it is read out in a polite live region.
  await expect(answer.getByTestId("answer-writing")).toBeVisible();
  await expect(composer.getByTestId("composer-stop")).toBeVisible();
  await expect(answer.getByTestId("answer-stop")).toHaveCount(0);
  const live = composer.getByTestId("composer-live");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(live).toHaveText(/Writing the Answer…|Your Documents answer this/);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(live).toHaveText("Your Documents answer this. That is all. The Answer is done.");
  // The Mind is as it was written.
  await expect.poll(() => order(editor)).toEqual(["Spring tides come twice a month."]);

  // The Citation is checked: found on page 2, its check in its badge.
  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await expect(citation.getByTestId("citation-chip")).toHaveAttribute(
    "aria-label",
    "Citation 1: Tides, p. 2. Quote found on p. 2",
  );
  await expect(citation.locator(".citation-marker-icon")).toBeVisible();
  // The composer is empty and keeps the focus, for a follow-up.
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(ask).toBeDisabled();

  // The newest Answer shows its actions at rest: Write as a note, Add to note and Copy; its
  // steps, folded above it, say what it searched, and Regenerate is at their end.
  await window.mouse.move(10, 10);
  const actions = answer.getByTestId("answer-actions");
  await expect.poll(() => opacityOf(actions)).toBe(1);
  await expect(actions).toHaveText("Write as a noteAdd to noteCopy");
  await expect(answer.getByTestId("answer-steps")).toHaveText("Searched All Documents · 1 source");
  await expect(answer.getByTestId("answer-regenerate")).toHaveCount(0);
  await screenshot(window, "composer-answered-en");

  // An earlier one shows them on hover only.
  await window.keyboard.type("And neap tides?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).nth(1)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await window.mouse.move(10, 10);
  await expect.poll(() => opacityOf(answer.getByTestId("answer-actions"))).toBe(0);
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await expect.poll(() => opacityOf(answer.getByTestId("answer-actions"))).toBe(1);
  await screenshot(window, "answer-hover-en");
  await expect.poll(() => order(editor)).toEqual(["Spring tides come twice a month."]);
  await app.close();
});

test("Stop keeps what streamed, and Regenerate writes the Answer again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  const composer = window.getByTestId("composer");
  await pointAndClick(window, composer.getByTestId("composer-input"));
  // A long Question keeps its Answer streaming while the pointer slides to Stop, even on a
  // slow runner.
  await window.keyboard.type(LONG_QUESTION);
  await window.keyboard.press("Enter");

  const answer = assistantAnswers(window).first();
  await expect(answer).toContainText("scripted");
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await pointAndClick(window, composer.getByTestId("composer-stop"));
  await expect(answer).toHaveAttribute("data-status", "stopped");
  const kept = await answer.locator(".assistant-answer-text").textContent();
  expect(kept).toContain("scripted");
  expect(kept).not.toContain("That is all.");
  // Stopped: it says so under its last line, at rest too.
  await window.mouse.move(10, 10);
  await expect(answer.getByTestId("answer-stopped")).toHaveText("Stopped");
  await expect.poll(() => opacityOf(answer.getByTestId("answer-actions"))).toBe(1);
  await expect(composer.getByTestId("composer-live")).toContainText("The Answer was stopped.");
  // What streamed stays, on the screen and in what the core keeps.
  await expect(answer.locator(".assistant-answer-text")).toHaveText(kept ?? "");
  const stored = await bridge(window).storedAnswer();
  expect(stored?.status).toBe("stopped");
  expect(stored?.text).toContain("scripted");
  expect(stored?.text).not.toContain("That is all.");
  await screenshot(window, "answer-stopped-en");

  // Regenerate, at the end of its steps, writes it again in full, in its place.
  await openSteps(window, answer);
  await pointAndClick(window, answer.getByTestId("answer-regenerate"));
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer).toContainText("That is all.");
  await expect(assistantAnswers(window)).toHaveCount(1);
  await expect(window.getByTestId("mind-editor").getByTestId("answer")).toHaveCount(0);
  await app.close();
});

test("a Question waiting for model readiness survives a force-quit, is stopped on restart, and can be retried", async () => {
  const ollama = await busyOllama();
  try {
    const first = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(first.window);
    await bridge(first.window).ollama(ollama.url);
    await pointAndClick(first.window, first.window.getByTestId("plus-menu"));
    await pointAndClick(first.window, first.window.getByTestId("plus-new-mind"));
    const input = first.window.getByTestId("composer-input");
    await pointAndClick(first.window, input);
    const question = "Keep this Question through a crash";
    const before = ollama.tags;
    ollama.hold();
    await first.window.keyboard.type(question);
    await first.window.keyboard.press("Enter");
    await expect(first.window.getByTestId("assistant-question")).toContainText(question);
    await expect(first.window.getByTestId("assistant-answer-on-its-way")).toBeVisible();
    // The held response proves the ask is waiting inside readyModel.
    await expect.poll(() => ollama.tags).toBeGreaterThan(before);
    await expect.poll(() => bridge(first.window).storedConversation()).not.toBeNull();
    await forceQuit(first.app);
    ollama.release();

    const restarted = await launchApp(dataDir, { fakeChat: true });
    const content = await bridge(restarted.window).storedConversation();
    if (!content) throw new Error("The Question and its Conversation were not kept.");
    expect(content.messages.map((message) => message.kind)).toEqual(["question", "answer"]);
    const [storedQuestion, storedAnswer] = content.messages;
    expect(storedQuestion).toMatchObject({ kind: "question", text: question });
    expect(storedAnswer).toMatchObject({ kind: "answer", status: "stopped", text: "" });
    if (storedAnswer?.kind !== "answer") throw new Error("The recovered Answer is missing.");

    await pointAndClick(restarted.window, restarted.window.getByTestId("assistant-title"));
    await expect(
      restarted.window.getByTestId("assistant-history-row").filter({ hasText: question }),
    ).toHaveCount(1);
    await restarted.window.keyboard.press("Escape");

    // Opened as a person does, by its words in ⌘K.
    await restarted.window.keyboard.press("ControlOrMeta+k");
    const palette = restarted.window.getByTestId("palette");
    await expect(palette).toBeVisible();
    await restarted.window.keyboard.type(question);
    const found = palette
      .locator('[data-testid="palette-group"][data-group="conversations"]')
      .getByTestId("palette-item")
      .first();
    await expect(found).toBeVisible();
    await pointAndClick(restarted.window, found);
    await expect(palette).toBeHidden();

    // Recovered, it says it was stopped where the User looks, and its own retry writes it again.
    const answer = assistantAnswers(restarted.window).first();
    await expect(answer).toHaveAttribute("data-status", "stopped");
    await restarted.window.mouse.move(10, 10);
    await expect(answer.getByTestId("answer-stopped")).toHaveText("Stopped");
    await expect.poll(() => opacityOf(answer.getByTestId("answer-actions"))).toBe(1);
    await openSteps(restarted.window, answer);
    await pointAndClick(restarted.window, answer.getByTestId("answer-regenerate"));
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answer).toContainText("scripted");
    await expect
      .poll(async () => (await bridge(restarted.window).storedAnswer())?.status)
      .toBe("done");
    await restarted.app.close();
  } finally {
    ollama.close();
  }
});

test("a Question already inserted while Thinking survives a force-quit (control)", async () => {
  const ollama = await busyOllama();
  try {
    const first = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(first.window);
    await bridge(first.window).ollama(ollama.url);
    await pointAndClick(first.window, first.window.getByTestId("plus-menu"));
    await pointAndClick(first.window, first.window.getByTestId("plus-new-mind"));
    const input = first.window.getByTestId("composer-input");
    await pointAndClick(first.window, input);
    const before = ollama.tags;
    ollama.hold();
    await first.window.keyboard.type("Answer slowly: what is a Mind?");
    await first.window.keyboard.press("Enter");
    await expect.poll(() => ollama.tags).toBeGreaterThan(before);
    ollama.release();
    const answer = assistantAnswers(first.window).first();
    await expect(answer).toHaveAttribute("data-status", "streaming");
    // Thinking is shown only after the turn is inserted and its Answer starts.
    await expect(answer.getByTestId("answer-writing")).toHaveText("Thinking…", {
      timeout: 15_000,
    });
    await forceQuit(first.app);

    const restarted = await launchApp(dataDir, { fakeChat: true });
    const content = await bridge(restarted.window).storedConversation();
    if (!content) throw new Error("The inserted Question and its Conversation were not kept.");
    expect(content.messages.map((message) => message.kind)).toEqual(["question", "answer"]);
    expect(content.messages[0]).toMatchObject({
      kind: "question",
      text: "Answer slowly: what is a Mind?",
    });
    expect(content.messages[1]).toMatchObject({ kind: "answer", status: "stopped" });
    await pointAndClick(restarted.window, restarted.window.getByTestId("assistant-title"));
    await expect(
      restarted.window
        .getByTestId("assistant-history-row")
        .filter({ hasText: "Answer slowly: what is a Mind" }),
    ).toHaveCount(1);
    await restarted.app.close();
  } finally {
    ollama.close();
  }
});

test("sending empties the composer and shows the Question with its Answer on its way at once; until it is written the send button is Stop, so a second Enter, a double click, or Enter then a click never asks twice, and the same Question can be asked again once it is done", async () => {
  const ollama = await busyOllama();
  try {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await bridge(window).ollama(ollama.url);
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    const composer = window.getByTestId("composer");
    const input = composer.getByTestId("composer-input");
    const ask = composer.getByTestId("composer-ask");
    const stop = composer.getByTestId("composer-stop");
    const assistant = window.getByTestId("assistant");
    const questions = assistant.getByTestId("assistant-question");
    const onItsWay = assistant.getByTestId("assistant-answer-on-its-way");
    const answers = assistantAnswers(window);
    await pointAndClick(window, input);

    // Ollama is slow to say where the model runs, so the Question waits on it. Meanwhile, at
    // once: the composer is empty, the Question is in the assistant with its first step, reading
    // the Mind in focus, and the send button is Stop, with none under the line. A second Enter, in the empty composer, does nothing.
    ollama.hold();
    await window.keyboard.type(LONG_QUESTION);
    await window.keyboard.press("Enter");
    await window.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(questions).toHaveCount(1);
    await expect(questions).toContainText(LONG_QUESTION);
    await expect(onItsWay.getByTestId("answer-writing")).toHaveText("Reading “Untitled”…");
    await expect(onItsWay.getByTestId("answer-stop")).toHaveCount(0);
    await expect(stop).toHaveAccessibleName("Stop the Answer");
    await expect(ask).toHaveCount(0);
    await expect(answers).toHaveCount(0);
    await screenshot(window, "composer-stop-on-its-way-en");

    // Once Ollama answers, the Answer streams in where its first step was, Stop still in the
    // composer; then it is written. One Question, one Answer.
    ollama.release();
    const first = answers.first();
    await expect(first).toHaveAttribute("data-status", "streaming");
    await expect(onItsWay).toHaveCount(0);
    await expect(stop).toBeVisible();
    await screenshot(window, "composer-stop-en");
    await expect(first).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(first).toContainText("That is all.");
    await expect(questions).toHaveCount(1);
    await expect(answers).toHaveCount(1);
    // The send button is back, quiet in the empty composer.
    await expect(stop).toHaveCount(0);
    await expect(ask).toBeDisabled();

    // The same Question again, asked with a double click on the button: it is asked once, and
    // the double click's second click, which lands on Stop, leaves its Answer be.
    await window.keyboard.type(LONG_QUESTION);
    await expect(ask).toBeEnabled();
    await pointAt(window, ask);
    const button = await ask.boundingBox();
    if (!button) throw new Error("The send button isn't visible.");
    await window.mouse.dblclick(button.x + button.width / 2, button.y + button.height / 2);
    await expect(questions).toHaveCount(2);
    await expect(input).toHaveValue("");
    const second = answers.nth(1);
    await expect(second).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(second).toContainText("That is all.");
    await expect(questions).toHaveCount(2);
    await expect(answers).toHaveCount(2);

    // Enter, then a click on the button: the click is on Stop, which stops the Answer, keeping
    // what it wrote. Nothing is asked again.
    await window.keyboard.type(LONG_QUESTION);
    await window.keyboard.press("Enter");
    const third = answers.nth(2);
    await expect(third).toContainText("scripted");
    await pointAndClick(window, stop);
    await expect(third).toHaveAttribute("data-status", "stopped");
    await expect(third.getByTestId("answer-stopped")).toHaveText("Stopped");
    await expect(questions).toHaveCount(3);
    await expect(answers).toHaveCount(3);
    await expect(ask).toBeDisabled();
    await expect(input).toBeFocused();
    await app.close();
  } finally {
    ollama.close();
  }
});

test("Stop works before the Answer has started; a Question that can't be asked puts its words back in the composer; in Chinese too", async () => {
  const ollama = await busyOllama();
  try {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await bridge(window).ollama(ollama.url);
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    const composer = window.getByTestId("composer");
    const input = composer.getByTestId("composer-input");
    const ask = composer.getByTestId("composer-ask");
    const stop = composer.getByTestId("composer-stop");
    const assistant = window.getByTestId("assistant");
    const questions = assistant.getByTestId("assistant-question");
    const onItsWay = assistant.getByTestId("assistant-answer-on-its-way");
    const answers = assistantAnswers(window);
    await pointAndClick(window, input);

    // Stop while the Question is on its way: it says "Stopped" at once, and the Answer stops as
    // soon as it starts.
    ollama.hold();
    await window.keyboard.type(LONG_QUESTION);
    await window.keyboard.press("Enter");
    await expect(onItsWay.getByTestId("answer-writing")).toBeVisible();
    await pointAndClick(window, stop);
    await expect(onItsWay.getByTestId("answer-stopped")).toHaveText("Stopped");
    await expect(onItsWay.getByTestId("answer-stop")).toHaveCount(0);
    ollama.release();
    const first = answers.first();
    await expect(first).toHaveAttribute("data-status", "stopped");
    await expect(first).not.toContainText("That is all.");
    await expect(onItsWay).toHaveCount(0);
    await expect(questions).toHaveCount(1);
    await expect(ask).toBeDisabled();

    // The model turns out to run on ollama.com, and "Keep everything on this computer" is on:
    // the Question shows at once, then isn't asked. Its words come back in the composer, with
    // why, and the assistant is as it was.
    await bridge(window).localOnly(true);
    ollama.inTheCloud(true);
    ollama.hold();
    await window.keyboard.type("Is anyone there?");
    await window.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(questions).toHaveCount(2);
    await expect(onItsWay).toBeVisible();
    ollama.release();
    const refusal = composer.getByTestId("composer-not-ready");
    await expect(refusal).toContainText("Keep everything on this computer");
    await expect(input).toHaveValue("Is anyone there?");
    await expect(questions).toHaveCount(1);
    await expect(onItsWay).toHaveCount(0);
    await expect(answers).toHaveCount(1);
    await expect(ask).toBeEnabled();

    // In Chinese, on this computer again: the first step and the composer's Stop say so in Chinese.
    await bridge(window).localOnly(false);
    ollama.inTheCloud(false);
    await bridge(window).language("zh-CN");
    ollama.hold();
    await pointAndClick(window, input);
    await window.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(refusal).toHaveCount(0);
    await expect(onItsWay.getByTestId("answer-writing")).toHaveText("正在读“未命名”…");
    await expect(onItsWay.getByTestId("answer-stop")).toHaveCount(0);
    await expect(stop).toHaveAccessibleName("停止生成回答");
    await screenshot(window, "composer-stop-on-its-way-zh");
    ollama.release();
    await expect(answers.nth(1)).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(questions).toHaveCount(2);
    await expect(composer.getByTestId("composer-ask")).toHaveAccessibleName("提问（Enter）");
    await app.close();
  } finally {
    ollama.close();
  }
});

test("⌘J focuses the composer from the note; Shift+Enter breaks the Question's line; Esc goes back to the note, where the cursor was, and leaves the assistant open", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await enterContent(window);
  // Notes, not a title: the first line made body text.
  await window.keyboard.press("Backspace");
  await window.keyboard.type("First thought");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Second thought");
  const editor = window.getByTestId("mind-editor");
  const input = window.getByTestId("composer-input");

  // The cursor at the end of the first line: ⌘J, two lines, Enter.
  const first = editor.locator(":scope > p").first();
  await pointAndClick(window, first);
  // The editor takes the click's place from the browser's selectionchange: wait, as a person would.
  await expect(first).toHaveClass(/has-focus/);
  await window.keyboard.press("End");
  await window.keyboard.press("ControlOrMeta+j");
  await expect(input).toBeFocused();
  await window.keyboard.type("Which thought");
  await window.keyboard.press("Shift+Enter");
  await window.keyboard.type("comes first?");
  await expect(input).toHaveValue("Which thought\ncomes first?");
  await window.keyboard.press("Enter");

  // Its two lines, in one bubble.
  const bubble = window.getByTestId("assistant-question").locator(".assistant-question-bubble");
  await expect.poll(() => bubble.textContent()).toContain("Which thought\ncomes first?");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect.poll(() => order(editor)).toEqual(["First thought", "Second thought"]);

  // Esc goes back to the note, where the cursor was, to write there; the assistant stays open.
  await expect(input).toBeFocused();
  await window.keyboard.press("Escape");
  const assistant = window.getByTestId("assistant");
  await expect(editor).toBeFocused();
  await expect(assistant).not.toHaveAttribute("data-folded");
  await window.keyboard.type(" noted");
  await expect.poll(() => order(editor)).toEqual(["First thought noted", "Second thought"]);

  // From the Mind's tab, ⌘J too: the assistant unfolds into its composer.
  await pointAndClick(window, window.getByTestId("mind-tab"));
  await window.keyboard.press("ControlOrMeta+j");
  await expect(assistant).not.toHaveAttribute("data-folded");
  await expect(input).toBeFocused();
  await window.keyboard.type("And the last?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).nth(1)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect.poll(() => order(editor)).toEqual(["First thought noted", "Second thought"]);
  await app.close();
});

test("the model chip chooses the model for one Mind, which remembers it after a restart, and a new Mind starts on the last one chosen", async () => {
  // Listed a second late, so the menu opens before its models are there, as on a slow machine
  // or with a provider far away: the current one still takes the focus once it is listed.
  const ollama = await ollamaListing(["fake-model", "other-model"], { delayMs: 1000 });
  try {
    const first = await launchApp(dataDir, { fakeChat: true });
    let { window } = first;
    await dismissChatSetup(window);
    await window.evaluate(async (baseUrl) => {
      await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
        kind: "ollama",
        baseUrl,
        modelId: "fake-model",
      });
    }, ollama.url);
    await atMockupSize(first.app, window);

    // A Mind that chooses another model, with the mouse.
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    await nameMind(window, "Other model");
    const chip = window.getByTestId("composer-model");
    await expect(chip).toHaveText("fake-model");
    await pointAndClick(window, chip);
    const menu = window.getByTestId("composer-model-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("group", { name: "On this computer" })).toBeVisible();
    const options = menu.getByTestId("composer-model-option");
    await expect(options).toHaveText([/fake-model/, /other-model/]);
    await expect(options.first()).toHaveAttribute("aria-checked", "true");
    await expect(options.first()).toBeFocused();
    await expect(menu).not.toContainText("For this note’s Questions.");
    await expect(menu).toContainText("Default for new notes: fake-model · Change in Settings");
    // What stays on this computer says so with its icon, in ink-secondary: green is for checks.
    const stays = menu.getByTestId("on-this-computer").first();
    await expect(stays).toHaveCSS("color", "rgb(74, 79, 87)");
    expect(await stays.evaluate((element) => element.firstElementChild?.tagName)).toBe("svg");
    // Where models run is said once, by the group's heading, not on every row.
    await expect(menu.getByTestId("on-this-computer")).toHaveCount(1);
    await expect(menu.getByText(/^Stays on this/)).toHaveCount(0);
    await screenshot(window, "composer-model-menu-en");
    await pointAndClick(window, options.nth(1));
    await expect(menu).toBeHidden();
    await expect(chip).toHaveText("other-model");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.type("Which model answers?");
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).first();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(await openSteps(window, answer)).toContainText("Answered by other-model");

    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    await nameMind(window, "Default model");
    await expect(chip).toHaveText("other-model");
    await expect(menu).toBeHidden();
    await chip.focus();
    await window.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(options.nth(1)).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await expect(options.first()).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(chip).toHaveText("other-model");
    await window.keyboard.press("Enter");
    await expect(options.nth(1)).toBeFocused();
    await window.keyboard.press("ArrowUp");
    await window.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(chip).toHaveText("fake-model");
    await first.app.close();

    // After a restart: each Mind still asks with its own.
    const second = await launchApp(dataDir, { fakeChat: true });
    window = second.window;
    const minds = window.getByTestId("mind-list-item");
    await pointAndClick(window, minds.filter({ hasText: "Other model" }));
    await expect(window.getByTestId("composer-model")).toHaveText("other-model");
    await pointAndClick(window, minds.filter({ hasText: "Default model" }));
    await expect(window.getByTestId("composer-model")).toHaveText("fake-model");
    await pointAndClick(window, window.getByTestId("composer-input"));
    await window.keyboard.type("And this one?");
    await window.keyboard.press("Enter");
    const other = assistantAnswers(window).first();
    await expect(other).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(await openSteps(window, other)).toContainText("Answered by fake-model");

    // In Chinese.
    await bridge(window).language("zh-CN");
    await expect(window.getByTestId("composer-input")).toHaveAttribute("placeholder", "追问…");
    await pointAndClick(window, window.getByTestId("composer-model"));
    const menuZh = window.getByTestId("composer-model-menu");
    await expect(menuZh.getByRole("group", { name: "在本机运行" })).toBeVisible();
    await expect(menuZh).toContainText("新笔记的默认模型：fake-model · 在设置中更改");
    await screenshot(window, "composer-model-menu-zh");
    await window.keyboard.press("Escape");
    await screenshot(window, "composer-zh");
    await second.app.close();
  } finally {
    ollama.server.close();
  }
});

/**
 * A Mind written before the composer, in its stored shape: a Note, a Question
 * with a model, a Search scope and a forced Skill, and its finished Answer.
 */
function oldMind(): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment("blocks");
  const paragraph = (text: string) => {
    const element = new Y.XmlElement("paragraph");
    element.setAttribute("id", crypto.randomUUID());
    element.insert(0, [new Y.XmlText(text)]);
    return element;
  };
  const question = new Y.XmlElement("question");
  question.setAttribute("id", "question-1");
  question.setAttribute("providerId", "provider-gone");
  question.setAttribute("modelId", "an-older-model");
  question.setAttribute("scopeTagIds", ["tag-gone"] as unknown as string);
  question.insert(0, [new Y.XmlText("What did the tide tables say?")]);
  const answer = new Y.XmlElement("answer");
  answer.setAttribute("id", "answer-1");
  answer.setAttribute("questionId", "question-1");
  answer.setAttribute("modelId", "an-older-model");
  answer.setAttribute("status", "done");
  answer.insert(0, [paragraph("They said high water comes later each day.")]);
  blocks.insert(0, [paragraph("Written before the composer."), question, answer, paragraph("")]);
  return Y.encodeStateAsUpdate(doc);
}

test("a Mind written before opens with its Questions and Answers in the new style, and its stored Blocks unchanged", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  const mindId = await window.evaluate(async (update) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const mind = await core.createMind({ title: "From before" });
    await core.applyMindUpdate(mind.id, new Uint8Array(update));
    await core.closeMind(mind.id);
    return mind.id;
  }, Array.from(oldMind()));
  const stored = () =>
    window.evaluate(async (id) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return Array.from((await core.openMind(id)).state);
    }, mindId);
  const beforeState = new Uint8Array(await stored());

  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "From before" }),
  );
  const editor = window.getByTestId("mind-editor");
  const question = editor.getByTestId("question");
  await expect(question.locator(".question-text")).toHaveText("What did the tide tables say?");
  await expect(question.locator(".question-text")).toHaveCSS("font-size", "14px");
  await expect(question.getByTestId("question-model")).toHaveText("an-older-model");
  const chip = question.getByTestId("scope-chip");
  await expect(chip).toHaveAttribute("data-deleted", "true");
  const answer = editor.getByTestId("answer");
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer).toContainText("They said high water comes later each day.");
  await expect(answer.getByTestId("answer-model")).toHaveText("an-older-model");
  await window.mouse.move(10, 10);
  await expect.poll(() => opacityOf(answer.getByTestId("answer-meta"))).toBe(0);
  await screenshot(window, "old-mind-en");

  // Its Blocks are as they were stored: opening and showing them wrote nothing.
  const afterState = new Uint8Array(await stored());
  const read = (state: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return { vector: Y.encodeStateVector(doc), blocks: doc.getXmlFragment("blocks").toString() };
  };
  expect(read(afterState)).toEqual(read(beforeState));
  await app.close();
});

test("a follow-up asked straight away goes into the same conversation, without taking the focus from the composer or touching the Mind", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  const input = window.getByTestId("composer-input");
  await pointAndClick(window, input);
  await window.keyboard.type("A first Question?");
  await window.keyboard.press("Enter");
  const editor = window.getByTestId("mind-editor");
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await window.keyboard.type("A follow-up?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).nth(1)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect(window.getByTestId("assistant-question")).toHaveCount(2);
  await expect(window.getByTestId("assistant-title")).toContainText("A first Question");
  const blocks = await editor.evaluate(
    (dom) => (dom as unknown as { editor: Editor }).editor.state.doc.childCount,
  );
  expect(blocks).toBe(1);
  await expect(editor.getByTestId("question")).toHaveCount(0);
  await expect(input).toBeFocused();
  await app.close();
});

test("in Chinese: the composer with a Search scope and a Skill chosen from its pickers, the Answer's meta line, and a narrow window", async () => {
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await bridge(window).language("zh-CN");
  await atMockupSize(app, window);

  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await nameMind(window, "潮汐笔记");
  await enterContent(window);
  await window.keyboard.type("大潮每月出现两次。");
  const composer = window.getByTestId("composer");
  const input = composer.getByTestId("composer-input");
  await expect(input).toHaveAttribute("placeholder", "提问，或说“写一篇关于……的笔记”");
  await expect(input).toHaveAccessibleName(/提问，或说“写一篇关于……的笔记”（(⌘J|Ctrl\+J)）/);
  await expect(composer.getByTestId("composer-ask")).toHaveAccessibleName("提问（Enter）");
  await expect(composer.getByTestId("composer-scope-all")).toHaveText("全部文档");

  // "@" chooses what it searches; "/" a Skill: each a chip in the composer.
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("@");
  const picker = window.getByTestId("scope-picker");
  await expect(picker.getByRole("group", { name: "文档" })).toBeVisible();
  await screenshot(window, "composer-scope-picker-zh");
  await window.keyboard.type("Tid");
  await window.keyboard.press("Enter");
  await expect(composer.getByTestId("scope-chip")).toHaveText("Tides");
  await window.keyboard.type("/");
  const skills = window.getByTestId("composer-skill-picker");
  await expect(skills.getByTestId("slash-item-skill-literature-review")).toBeVisible();
  await screenshot(window, "composer-skill-picker-zh");
  await window.keyboard.type("lit");
  await window.keyboard.press("Enter");
  await expect(composer.getByTestId("composer-skill")).toHaveText("文献综述");
  await window.keyboard.type("大潮什么时候出现？");
  await screenshot(window, "composer-chips-zh");

  // Asked: the Question carries both, its Answer says what it searched, in Chinese.
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(composer.getByTestId("composer-live")).toContainText("回答已生成。");
  const question = window.getByTestId("assistant-question");
  await expect(question.getByTestId("assistant-question-skill")).toHaveText("文献综述");
  await expect(answer.getByTestId("answer-steps")).toContainText("已搜索“Tides”");
  await openSteps(window, answer);
  await expect(answer.getByTestId("answer-regenerate")).toHaveText("重新生成");
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await expect(answer.getByTestId("answer-add")).toHaveText("添加到笔记");
  await screenshot(window, "answer-hover-zh");

  // A narrow window: the assistant goes to the bottom (#253), and the composer spans it there,
  // up to the Mind's column.
  await setWindowSize(app, window, 960, 640);
  const assistant = window.getByTestId("assistant");
  await expect(assistant).toHaveAttribute("data-dock", "bottom");
  const card = await window.getByTestId("card").boundingBox();
  const below = await composer.boundingBox();
  expect(below?.y ?? 0).toBeGreaterThan((card?.y ?? 0) + (card?.height ?? 0));
  // Under the card, in its 40px gutters.
  expect(below?.width ?? 0).toBeGreaterThanOrEqual((card?.width ?? 0) - 80 - 1);
  await screenshot(window, "composer-narrow-zh");
  await app.close();
});

test("after the consent dialog closes, the caret is back in the composer, and both Answers are in the assistant, the Mind as it was", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  // A model on a server elsewhere, chosen before choosing was the consent (ADR-0022), so the
  // first Question asks to send first. The scripted model answers.
  await saveProviderUnasked(window, {
    kind: "openai-compatible",
    baseUrl: "https://llm.example.com/v1",
    modelId: "example-model",
  });
  await pointAndClick(window, window.getByTestId("plus-menu"));
  await pointAndClick(window, window.getByTestId("plus-new-mind"));
  await enterContent(window);
  await window.keyboard.type("Alpha");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Omega");
  const editor = window.getByTestId("mind-editor");
  // The cursor in the note: the Mind stays as it is, whatever is asked.
  const first = editor.locator(":scope > p").first();
  await pointAndClick(window, first);
  await expect(first).toHaveClass(/has-focus/);
  await window.keyboard.press("End");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("A first Question?");
  await window.keyboard.press("Enter");

  const consent = window.getByTestId("consent-dialog");
  await expect(consent).toBeVisible();
  await consent.getByTestId("consent-allow").click();
  await expect(consent).toBeHidden();

  // Typed straight away, with no click: it reaches the composer. It is sent once the first
  // Answer is written; until then the send button is Stop.
  const input = window.getByTestId("composer-input");
  await expect(input).toBeFocused();
  await window.keyboard.type("A follow-up?");
  await expect(input).toHaveValue("A follow-up?");
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).nth(1)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect(window.getByTestId("assistant-question")).toHaveCount(2);
  await expect.poll(() => order(editor)).toEqual(["Alpha", "Omega"]);
  await app.close();
});
