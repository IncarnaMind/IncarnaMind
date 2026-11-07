import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A write whose Citations came in the step after it is checked once the reply has streamed
 * (#1635). Until it lands, the step line says that check is running, in the write's own words,
 * instead of the reply's Writing or Checking Citations (#1624). The scripted model holds each
 * sentence's check until the test releases it.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

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

const REVENUE = [
  "# Annual report",
  "",
  "Revenue in Q1 was €4 million.",
  "",
  "Revenue in Q2 was €5 million.",
].join("\n");

const NOTES = [
  "Tides rise twice a day along this coast.",
  "The harbour office posts the times each week.",
];

const WORDS = {
  en: {
    ask: "Add a revenue table for checking, citing after",
    checking: /^Checking 2 sentences in “Harbour notes”…/,
  },
  "zh-CN": {
    ask: "添加核对用的收入表格，写完再引用",
    checking: /^正在核对“Harbour notes”中的 2 句话…/,
  },
} as const;

type SlowCheck = { incarnamindSlowCheck: { hold: boolean; release(): void } };

const holdChecks = (app: ElectronApplication) =>
  app.evaluate(() => {
    (globalThis as unknown as SlowCheck).incarnamindSlowCheck.hold = true;
  });

const releaseChecks = (app: ElectronApplication) =>
  app.evaluate(() => {
    const { incarnamindSlowCheck } = globalThis as unknown as SlowCheck;
    incarnamindSlowCheck.hold = false;
    incarnamindSlowCheck.release();
  });

async function ask(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  return answers.nth(before);
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`a write cited after it says it is being checked until it lands, in ${language}`, async () => {
    test.setTimeout(120_000);
    await writeFile(join(sources, "Annual report.md"), REVENUE);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Annual report.md")]);
    await newMind(window);
    await nameMind(window, "Harbour notes");
    await enterContent(window);
    await window.keyboard.type(NOTES[0] ?? "");
    await window.keyboard.press("Enter");
    await window.keyboard.type(NOTES[1] ?? "");

    await holdChecks(app);
    const answer = await ask(window, words.ask);
    // A write cited after it isn't checked as it lands, so only the check after the reply says this.
    await expect(answer.getByTestId("answer-writing")).toHaveText(words.checking, {
      timeout: 60_000,
    });
    await expect(answer).toHaveAttribute("data-status", "streaming");
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `late-write-check-${language}.png`) });
    }

    await releaseChecks(app);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await app.close();
  });
}
