import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  addToNote,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  frontMind,
  launchApp,
  markSteps,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

// The scripted model says what real models said in #1172: a pointer after a short summary, and a
// line setting the User's file apart from the example.

const WALKS = [
  {
    name: "English",
    language: "en",
    example: "Draft: credit committee paper",
    file: "Employment agreement.md",
    text: "# Employment agreement\n\nThe employee may work from home three days a week.\n\nHoliday is 27 working days a year.\n",
    question: "What are the home working rules?",
    summary: "Can you give me a short summary of this agreement?",
    pointer: /earlier answer|as above/i,
  },
  {
    name: "Chinese",
    language: "zh-CN",
    example: "授信委员会报告（草稿）",
    file: "劳动合同.md",
    text: "# 劳动合同\n\n乙方每周可居家办公两天。\n\n年假为 15 个工作日。\n",
    question: "居家办公的规定是什么？",
    summary: "请为这份合同写一个简短的摘要。",
    pointer: /上一条回答|见上文/,
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
  test(`asked from the example's page, an Answer about their own file says nothing of the example, and a summary added to a page leaves its pointer in the panel (${walk.name})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
    await setWindowSize(app, window, 1440, 900);
    await setLanguage(window, walk.language);
    await expect(frontMind(window).locator(".mind-editor h1")).toHaveText(walk.example, {
      timeout: 30_000,
    });
    // The ready Question waits for the example's Documents to be read, as its Citations show.
    const checks = frontMind(window).getByTestId("mind-editor").getByTestId("citation-chip");
    await expect(checks).toHaveCount(2);
    await expect(checks.nth(1)).toHaveAttribute("data-check", "found", { timeout: 60_000 });
    await markSteps(window, { mistakeSeen: true });
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

    await newMind(window);
    const summary = await askInAssistant(window, walk.summary);
    const summaryText = summary.getByTestId("assistant-answer-text");
    await expect(summaryText).toContainText("That is all.");
    await expect(summaryText).toContainText(walk.pointer);
    await addToNote(window, summary);
    const page = frontMind(window).getByTestId("mind-editor");
    await expect(page).toContainText("Your Documents answer this");
    await expect(page).not.toContainText(walk.pointer);
    await app.close();
  });
}
