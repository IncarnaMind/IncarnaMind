import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  askInAssistant,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  useOutputLocation as setOutputLocation,
  setWindowSize,
  showSettingsPage,
} from "./app";

/*
 * Quiet lines (#2870): a line says something only when there is something to say. A fresh
 * profile with three ready Documents shows none of "Ready" under a Document, "Today: 0 suggested,
 * 0 accepted", "Entries: 0" and "Nothing changed from the default."; a Document that isn't ready
 * still says so. A note written from an Answer is named from its Question, and its Word file
 * takes that name.
 */

const WORDS = {
  en: {
    settings: "Settings",
    ready: /\bReady\b/,
    today: /Today:/,
    entries: /Entries:/,
    nothingChanged: "Nothing changed from the default.",
    failed: "Failed",
    question: "What are the revenue and adjusted EBITDA?",
    named: "What are the revenue and adjusted EBITDA",
    // The line under the Answer cuts a long name in its middle.
    wroteStart: "Wrote “What are the",
  },
  "zh-CN": {
    settings: "设置",
    ready: /就绪/,
    today: /今天：/,
    entries: /共\s*\d+\s*条/,
    nothingChanged: "没有改过默认设置。",
    failed: "失败",
    question: "revenue 和 adjusted EBITDA 是多少？",
    named: "revenue 和 adjusted EBITDA 是多少",
    wroteStart: "已写入“revenue 和",
  },
} as const;
const LANGUAGES = ["en", "zh-CN"] as const;

const RESULTS = [
  "Harbourline results for the six months.",
  "Revenue was 668.3 and adjusted EBITDA was 91.5, in GBP million.",
].join("\n");

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

for (const language of LANGUAGES) {
  const w = WORDS[language];

  test(`a fresh profile with three ready Documents shows none of the lines that report nothing (${language})`, async () => {
    const paths = ["Results", "Costs", "Outlook"].map((name) => join(sources, `${name}.md`));
    for (const path of paths) await writeFile(path, RESULTS);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      await setLanguage(window, language);
      await addDocuments(window, paths);

      // A ready Document says nothing of its state, to the eye or to a screen reader.
      await expect(window.getByTestId("document-list-item")).toHaveCount(3);
      await expect(window.getByTestId("document-status")).toHaveCount(0);
      await expect(window.getByTestId("sidebar")).not.toContainText(w.ready);

      await window.getByRole("button", { name: w.settings }).click();
      const settings = window.getByTestId("settings");

      // General: no tally of suggestions before there is one. Core has answered by the time the
      // call below returns, as it did the page's own question first.
      await showSettingsPage(window, "general");
      const suggestions = settings.getByTestId("suggestion-settings");
      await expect(suggestions.getByTestId("suggestion-switch")).toBeVisible();
      expect(
        await window.evaluate(
          async () =>
            (
              await (
                globalThis as unknown as { incarnamind: CoreBridge }
              ).incarnamind.getSuggestionStatus()
            ).today,
        ),
      ).toEqual({ shown: 0, accepted: 0 });
      await expect(suggestions.getByTestId("suggestion-counts")).toHaveCount(0);
      await expect(suggestions).not.toContainText(w.today);

      // Privacy: no size for a record with nothing in it, no Clear, and no line for an
      // Approvals list with nothing in it.
      await showSettingsPage(window, "privacy");
      const record = settings.getByTestId("ai-use-record");
      await expect(record).toBeVisible();
      expect(
        await window.evaluate(() =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getAiUseStatus(),
        ),
      ).toEqual({ entries: 0 });
      await expect(record.getByTestId("ai-use-entries")).toHaveCount(0);
      await expect(record.getByTestId("ai-use-clear")).toHaveCount(0);
      await expect(record).not.toContainText(w.entries);
      const approvals = settings.getByTestId("approvals-settings");
      await expect(approvals).toBeAttached();
      await expect(approvals.getByTestId("approval-policy")).toHaveCount(0);
      await expect(approvals).not.toContainText(w.nothingChanged);

      // Once the record holds an entry, its size and Clear are there.
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const mind = await bridge.createMind({ title: "Essay" });
        await bridge.recordAiUse([
          { mindId: mind.id, kind: "assistant-change-rejected", characters: 40 },
        ]);
      });
      await expect(record.getByTestId("ai-use-entries")).toContainText(w.entries);
      await expect(record.getByTestId("ai-use-clear")).toBeEnabled();
    } finally {
      await app.close();
    }
  });

  test(`a Document that failed still says so, and the ready one beside it still says nothing (${language})`, async () => {
    const report = join(sources, "Report.pdf");
    const results = join(sources, "Results.md");
    await writeFile(report, "This is not a PDF at all.");
    await writeFile(results, RESULTS);
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setLanguage(window, language);
      await window.getByTestId("add-documents-input").setInputFiles([report, results]);

      const failed = window.getByTestId("document-list-item").filter({ hasText: "Report" });
      const ready = window.getByTestId("document-list-item").filter({ hasText: "Results" });
      await expect(failed).toHaveAttribute("data-status", "failed");
      await expect(failed.getByTestId("document-status")).toContainText(w.failed);
      await expect(ready).toHaveAttribute("data-status", "ready");
      await expect(ready.getByTestId("document-status")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test(`a note written from an Answer is named from its Question, and its Word file takes that name (${language})`, async () => {
    const results = join(sources, "Harbourline results.md");
    await writeFile(results, RESULTS);
    const output = await createDataFolder();
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await dismissChatSetup(window);
      await connectLocalChatModel(window);
      await setLanguage(window, language);
      await setWindowSize(app, window, 1440, 900);
      await addDocuments(window, [results]);
      await setOutputLocation(window, output);

      const answer = await askInAssistant(window, w.question);
      await pointAndClick(window, answer.getByTestId("answer-write-note"));
      await expect(frontMindName(window)).toHaveText(w.named);
      await expect(answer.getByTestId("answer-added")).toContainText(w.wroteStart);

      await pointAndClick(window, window.getByTestId("export-mind"));
      await pointAndClick(window, window.getByTestId("export-menu").getByTestId("export-as-docx"));
      await expect(window.getByTestId("export-result").getByTestId("export-done")).toBeVisible();
      await expect.poll(() => readdir(output)).toContain(`${w.named}.docx`);
    } finally {
      await app.close();
      await removeDataFolder(output);
    }
  });
}
