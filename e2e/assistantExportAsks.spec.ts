import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * Asked to export a Mind to Word before the User has chosen whether to mark the text IncarnaMind
 * wrote (#1535), the assistant asks that question in its tray, keeps the answer as the export
 * line keeps it, and exports. Closing the tray exports nothing and keeps nothing; a request that
 * names the choice skips the question. The model is the smoke tests' fake. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const WORDS = {
  en: {
    question: "Mark the text IncarnaMind wrote?",
    mark: "Mark it",
    leave: "Leave it out",
    closed: "Nothing was exported",
    chose: (label: string) => `You chose: ${label}`,
  },
  "zh-CN": {
    question: "标出 IncarnaMind 写的内容？",
    mark: "标出",
    leave: "不标",
    closed: "未导出",
    chose: (label: string) => `你选择了：${label}`,
  },
} as const;

let dataDir: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(out);
});

// Biome reads a call of use… in a helper as a hook.
const chooseLocalModel = useLocalChatModel;
const chooseOutputLocation = useOutputLocation;

const markAiText = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getSettings()).user.exportOptions.docx.markAiText;
  });

async function setUp(
  app: Parameters<typeof setWindowSize>[0],
  window: Page,
  language: "en" | "zh-CN",
  width: number,
): Promise<void> {
  await dismissChatSetup(window);
  await chooseLocalModel(window);
  await setLanguage(window, language);
  await setWindowSize(app, window, width, 900);
  await chooseOutputLocation(window, out);
  await newMind(window);
  await nameMind(window, "Deal notes");
  await window.keyboard.type("Notes on the deal.");
}

async function request(window: Page, text: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(text);
  await window.keyboard.press("Enter");
}

const tray = (window: Page): Locator =>
  window.getByTestId("task-tray").getByTestId("question-card");

for (const [language, width] of [
  ["en", 900],
  ["en", 1440],
  ["zh-CN", 900],
  ["zh-CN", 1440],
] as const) {
  const words = WORDS[language];
  test(`with no answer yet, an export to Word asks in the tray, keeps the answer and saves; the next doesn't ask (${language}, ${width}px)`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true, askToMarkAiText: true });
    await setUp(app, window, language, width);

    await request(window, "Export this Mind as Word");
    const card = tray(window);
    await expect(card).toContainText(words.question);
    await expect(card.getByTestId("question-option")).toHaveText([
      new RegExp(`^1${words.mark}$|${words.mark}`),
      new RegExp(words.leave),
    ]);
    expect(await readdir(out)).toEqual([]);
    expect(await markAiText(window)).toBeNull();
    await screenshot(window, `export-asks-${language === "en" ? "en" : "zh"}-${width}`);

    await card.getByTestId("question-option").nth(1).click();
    await expect(card).toHaveCount(0);
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answer.getByTestId("answer-asked")).toHaveText(words.chose(words.leave));
    await expect.poll(() => readdir(out)).toEqual(["Deal notes.docx"]);
    expect(await markAiText(window)).toBe("leave");

    await request(window, "Export this Mind as Word");
    await expect(assistantAnswers(window)).toHaveCount(2);
    await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await expect(tray(window)).toHaveCount(0);
    await expect.poll(() => readdir(out)).toEqual(["Deal notes 2.docx", "Deal notes.docx"]);
    await app.close();
  });
}

test("closing the question exports nothing and keeps no answer; asked again, it asks again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, askToMarkAiText: true });
  await setUp(app, window, "zh-CN", 900);
  const words = WORDS["zh-CN"];

  await request(window, "Export this Mind as Word");
  const card = tray(window);
  await expect(card).toContainText(words.question);
  await window.keyboard.press("Escape");

  await expect(card).toHaveCount(0);
  const closed = assistantAnswers(window).last();
  await expect(closed).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(closed.getByTestId("assistant-answer-text")).toContainText("Nothing was exported");
  expect(await readdir(out)).toEqual([]);
  expect(await markAiText(window)).toBeNull();

  await request(window, "Export this Mind as Word");
  await expect(tray(window)).toContainText(words.question);
  await tray(window).getByTestId("question-option").first().click();
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  await expect.poll(() => readdir(out)).toEqual(["Deal notes.docx"]);
  expect(await markAiText(window)).toBe("mark");
  await app.close();
});

test("a request that names the choice skips the question and keeps it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, askToMarkAiText: true });
  await setUp(app, window, "en", 1440);

  await request(window, "Export this Mind as Word without the AI marks");

  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(tray(window)).toHaveCount(0);
  await expect.poll(() => readdir(out)).toEqual(["Deal notes.docx"]);
  expect(await markAiText(window)).toBe("leave");
  await app.close();
});
