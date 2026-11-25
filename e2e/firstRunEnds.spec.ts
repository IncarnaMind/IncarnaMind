import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  addDocuments,
  askFirstQuestion,
  assistantAnswers,
  createDataFolder,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The first run ends at the first checked Answer (#2867): once a model works and the first Answer
 * is there, the assistant asks nothing more to set up, and nothing offers what to try next.
 * Meeting transcription and sorting are set up where they are first used (the record sheet and
 * Organize). In English and Chinese, on a fresh profile.
 */

/** What the two lines said, in each language: the count of steps left, and what to try next. */
const GONE = {
  en: { setup: /more to set up|Skip these steps/, next: /Try next|Compare documents in a table/ },
  "zh-CN": { setup: /项可设置|跳过这些步骤/, next: /接下来可以试试|用表格对比文档/ },
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
  test(`on a fresh profile, after the first checked Answer no setup or Try next line shows (${language})`, async () => {
    test.setTimeout(180_000);
    const notes = join(sources, "Harbour notes.md");
    await writeFile(
      notes,
      "# Harbour notes\n\nThe harbour master publishes the tide tables every January.\n",
    );
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      examples: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, 1440, 900);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const assistant = window.getByTestId("assistant");

      // The first Question waits for a model; a pasted key is the way in, and the Answer comes.
      const card = await askFirstQuestion(window);
      await card.getByTestId("setup-key").fill(ANTHROPIC_KEY);
      await card.getByTestId("setup-key").press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      // The composer is back, and the assistant says no more about setting up.
      await expect(window.getByTestId("composer-input")).toBeVisible();
      await expect(card).toHaveCount(0);
      await expect(assistant).not.toContainText(GONE[language].setup);

      // A file of their own and the example's first checked Citation: still nothing to set up
      // or to try next, in the example or the assistant.
      await addDocuments(window, [notes]);
      await pointAndClick(
        window,
        window.getByTestId("example-section").getByTestId("mind-list-item"),
      );
      const pane = window.getByTestId("mind-pane");
      const citations = pane.getByTestId("mind-editor").getByTestId("citation-chip");
      await expect(citations.nth(0)).toHaveAttribute("data-check", "found", { timeout: 20_000 });
      await pointAndClick(window, citations.nth(0));
      await window.keyboard.press("Escape");
      for (const line of [GONE[language].setup, GONE[language].next]) {
        await expect(pane).not.toContainText(line);
        await expect(assistant).not.toContainText(line);
      }
    } finally {
      await app.close();
    }
  });
}
