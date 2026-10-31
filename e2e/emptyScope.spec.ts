import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/**
 * A Search scope that holds no Documents never blocks a request (#748): the
 * Question goes to the model, which answers from the Mind it reads, and the
 * Answer's line says the scope has no Documents and offers to search all of
 * them, which writes the Answer again from every Document. English and Chinese.
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
    folder: "Contracts",
    line: "“Contracts” has no Documents",
    all: "Search all Documents",
  },
  "zh-CN": {
    folder: "合同",
    line: "“合同”中没有文档",
    all: "搜索全部文档",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`with an empty Search scope the Questions are still answered, and the line offers Search all Documents (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: dataDir });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await setLanguage(window, language);
    await window.evaluate(async (name) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.createLibraryGroup({ name, description: "" });
    }, words.folder);
    await newMind(window);
    await nameMind(window, "Deal memo");
    await window.getByTestId("mind-editor").click();
    await window.keyboard.type("The summary section is long and wordy.");

    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type(`@${words.folder}`);
    await expect(window.getByTestId("scope-choice")).toHaveCount(1);
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("composer").getByTestId("scope-chip")).toBeVisible();

    // An edit request edits the Mind (it needs no Documents); a Question about the Mind is answered
    // from it. Neither is refused for the empty scope.
    for (const [question, answered] of [
      ["Make the summary section shorter", /Deal memo/],
      ["What does this Mind say about it?", /Answer to: What does this Mind say about it\?/],
    ] as const) {
      await window.keyboard.press("ControlOrMeta+j");
      await window.keyboard.type(question);
      await window.keyboard.press("Enter");
      const answer = assistantAnswers(window).last();
      await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
      await expect(answer.getByTestId("assistant-answer-text")).toHaveText(answered);
      await expect(answer.getByTestId("answer-empty-scope")).toContainText(words.line);
    }

    // Search all Documents writes the Answer again, in place, from every Document.
    const last = assistantAnswers(window).last();
    await last.getByTestId("answer-search-all").click();
    await expect(last).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(last.getByTestId("answer-empty-scope")).toHaveCount(0);
    await expect(assistantAnswers(window)).toHaveCount(2);
    await app.close();
  });
}
