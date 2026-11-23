import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  markSteps,
  openExample,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

// The scripted model says what real models said in #1172: a line setting the User's file apart
// from the example.

const WALKS = [
  {
    name: "English",
    language: "en",
    example: "Draft: credit committee paper",
    file: "Employment agreement.md",
    text: "# Employment agreement\n\nThe employee may work from home three days a week.\n\nHoliday is 27 working days a year.\n",
    question: "What are the home working rules?",
  },
  {
    name: "Chinese",
    language: "zh-CN",
    example: "授信委员会报告（草稿）",
    file: "劳动合同.md",
    text: "# 劳动合同\n\n乙方每周可居家办公两天。\n\n年假为 15 个工作日。\n",
    question: "居家办公的规定是什么？",
  },
] as const;

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

for (const walk of WALKS) {
  test(`asked from the example's page, an Answer about their own file says nothing of the example (${walk.name})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
    await openExample(window);
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, walk.language);
    await expect(frontMind(window).locator(".mind-editor h1")).toHaveText(walk.example, {
      timeout: 30_000,
    });
    // The ready Question waits for the example's Documents to be read, as its Citations show.
    const checks = frontMind(window).getByTestId("mind-editor").getByTestId("citation-chip");
    await expect(checks).toHaveCount(2);
    await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 60_000 });
    await markSteps(window, { indexed: true });
    await pointAndClick(
      window,
      window
        .locator('[data-testid="first-open-step"][data-step="question"]')
        .getByTestId("first-open-ready"),
    );
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done");
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    const path = join(sources, walk.file);
    await writeFile(path, walk.text);
    await window.getByTestId("add-documents-input").setInputFiles([path]);
    await expect(
      window.getByTestId("document-list-item").filter({ hasText: walk.file.replace(".md", "") }),
    ).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
    await expect(frontMind(window).locator(".mind-editor h1")).toHaveText(walk.example);

    const own = await askInAssistant(window, walk.question);
    const ownText = own.getByTestId("assistant-answer-text");
    await expect(ownText).toContainText("Your Documents answer this");
    await expect(ownText).not.toContainText(walk.example);
    await expect(ownText).not.toContainText("Northwind");
    await app.close();
  });
}
