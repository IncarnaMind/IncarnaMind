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
 * While a write's check waits on a rate limit of 5 s or more, its row says when it resumes, in
 * Tags' words; a second's wait leaves the row's checking words (#2944). The scripted model refuses
 * the check's requests as a service does, saying how long to wait.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots, and INCARNAMIND_KEEP_ARTIFACTS=1
 * for the recording.
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

const WORDS = {
  en: {
    ask: "Add a revenue table for checking, citing after",
    waiting: /^Rate limit reached · resumes at \d/,
    checking: /^Checking 2 sentences in “Harbour notes”…/,
  },
  "zh-CN": {
    ask: "添加核对用的收入表格，写完再引用",
    waiting: /^已达到速率上限 · .+ 继续$/,
    checking: /^正在核对“Harbour notes”中的 2 句话…/,
  },
} as const;

type CheckLimit = { incarnamindCheckLimit: { once: number | null; everyMs: number | null } };

const limitChecks = (app: ElectronApplication, limit: { once?: number; everyMs?: number }) =>
  app.evaluate((_, set) => {
    const { incarnamindCheckLimit } = globalThis as unknown as CheckLimit;
    incarnamindCheckLimit.once = set.once ?? null;
    incarnamindCheckLimit.everyMs = set.everyMs ?? null;
  }, limit);

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

/** The app, at a narrow window, with the annual report and a Note to write in. */
async function opened(language: "en" | "zh-CN") {
  await writeFile(join(sources, "Annual report.md"), REVENUE);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 900, 900);
  await dismissChatSetup(window);
  // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
  await useLocalChatModel(window);
  await setLanguage(window, language);
  await addDocuments(window, [join(sources, "Annual report.md")]);
  await newMind(window);
  await nameMind(window, "Harbour notes");
  await enterContent(window);
  await window.keyboard.type("Tides rise twice a day along this coast.");
  return { app, window };
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`a check waiting 6 s on a rate limit says when it resumes, then checks on, in ${language}`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await opened(language);

    await limitChecks(app, { once: 6 });
    const answer = await ask(window, words.ask);
    const row = answer.getByTestId("answer-writing");
    await expect(row).toHaveText(words.waiting, { timeout: 60_000 });
    if (SCREENSHOTS) {
      await window.screenshot({ path: join(SCREENSHOTS, `check-wait-row-${language}.png`) });
    }
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await app.close();
  });
}

test("waits of a second one after another leave the row's checking words", async () => {
  test.setTimeout(180_000);
  const { app, window } = await opened("en");

  await limitChecks(app, { everyMs: 1000 });
  const answer = await ask(window, WORDS.en.ask);
  const row = answer.getByTestId("answer-writing");
  await expect(row).toHaveText(WORDS.en.checking, { timeout: 60_000 });
  const seen = new Set<string>();
  while ((await answer.getAttribute("data-status")) !== "done") {
    const text = await row.textContent().catch(() => null);
    if (text) seen.add(text);
    await window.waitForTimeout(100);
  }
  expect([...seen].some((text) => WORDS.en.checking.test(text))).toBe(true);
  expect([...seen].filter((text) => text.startsWith("Rate limit reached"))).toEqual([]);
  await app.close();
});
