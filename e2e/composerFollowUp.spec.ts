import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * The composer's placeholder follows the open conversation (#1377): an empty
 * one asks for a Question, one with a message asks for a follow-up. Driven as
 * a person does, with the mouse slid onto what it clicks and the keys typed.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: {
    first: "Ask, or say ‘write a note on…’",
    followUp: "Ask a follow-up…",
    spring: "When do spring tides happen?",
    springFind: "spring tides",
    neap: "Why are neap tides weaker?",
  },
  "zh-CN": {
    first: "提问，或说“写一篇关于……的笔记”",
    followUp: "追问…",
    spring: "大潮什么时候出现？",
    springFind: "大潮",
    neap: "小潮为什么比较弱？",
  },
} as const;

const input = (window: Page) => window.getByTestId("composer-input");
const questions = (window: Page) =>
  window.getByTestId("assistant").getByTestId("assistant-question");

async function newChat(window: Page): Promise<void> {
  await pointAndClick(window, window.getByTestId("assistant-new-chat"));
  await expect(window.getByTestId("assistant-empty")).toBeVisible();
}

/** A conversation found in ⌘K by its name, opened in the assistant. */
async function openFromPalette(window: Page, find: string, question: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(find);
  const found = window
    .getByTestId("palette")
    .locator('[data-testid="palette-group"][data-group="conversations"]')
    .getByTestId("palette-item")
    .first();
  await expect(found).toContainText(question.replace(/[?？]$/, ""));
  await window.keyboard.press("Enter");
  await expect(questions(window).last()).toContainText(question);
}

for (const language of ["en", "zh-CN"] as const) {
  test(`the composer asks for a follow-up once the conversation has a message, and for a Question while it has none (${language})`, async () => {
    const words = WORDS[language];
    let { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 900, 700);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);

    // An empty conversation: today's placeholder, and a draft not yet sent doesn't change it.
    await window.keyboard.press("ControlOrMeta+j");
    await expect(input(window)).toBeFocused();
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await window.keyboard.type("A draft not sent");
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("Backspace");
    await expect(input(window)).toHaveValue("");

    // The first Question, the moment it is sent and after its Answer.
    await window.keyboard.type(words.spring);
    await window.keyboard.press("Enter");
    await expect(questions(window).last()).toContainText(words.spring);
    await expect(input(window)).toHaveAttribute("placeholder", words.followUp);
    await expect(assistantAnswers(window)).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await expect(input(window)).toHaveAttribute("placeholder", words.followUp);

    // New chat brings the first placeholder back, twice over as well; its own first Question changes it.
    await newChat(window);
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await newChat(window);
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await askInAssistant(window, words.neap);
    await expect(input(window)).toHaveAttribute("placeholder", words.followUp);

    // Another conversation shows the placeholder that fits it: from an empty one to one with messages.
    await newChat(window);
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await openFromPalette(window, words.springFind, words.spring);
    await expect(input(window)).toHaveAttribute("placeholder", words.followUp);

    // Cleared, it is empty again; Undo brings it back with its message.
    await pointAndClick(window, window.getByTestId("assistant-more"));
    await pointAndClick(window, window.getByTestId("assistant-menu-clear"));
    await expect(window.getByTestId("assistant-empty")).toBeVisible();
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await pointAndClick(window, window.getByTestId("undo-action"));
    await expect(questions(window)).toContainText(words.spring);
    await expect(input(window)).toHaveAttribute("placeholder", words.followUp);

    // After a restart the assistant starts a new chat, and a conversation opened from the past has its messages.
    await app.close();
    ({ app, window } = await launchApp(dataDir, { fakeChat: true }));
    await setWindowSize(app, window, 900, 700);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(input(window)).toBeFocused();
    await expect(window.getByTestId("assistant-empty")).toBeVisible();
    await expect(input(window)).toHaveAttribute("placeholder", words.first);
    await openFromPalette(window, words.springFind, words.spring);
    await expect(input(window)).toHaveAttribute("placeholder", words.followUp);
    await app.close();
  });
}
