import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  forceQuit,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * What the assistant writes into a Note is checked before it lands (#1358): while that check runs,
 * the Answer's card counts only what really waits, and its Review opens that at once. The changes
 * the User asked for are drawn as applied meanwhile and are not waiting, so a Note the assistant
 * has just made shows no count and no Review until its Review changes comes with the write. The
 * scripted model holds each sentence's check until the test releases it.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

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

const TIDES = [
  "# Tide notes",
  "",
  "A tide summary for the harbour: spring tides come at new and full moon.",
  "",
  "Neap tides come at the quarter moons.",
].join("\n");

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
    made: "Created “Tide summary” and wrote 2 paragraphs",
    checkingMade: /^Checking 1 sentence in “Tide summary”…/,
    reviewChanges: "Review changes",
    table: "Add a revenue table for checking",
    checkingTable: /^Checking 2 sentences in “Harbour notes”…/,
    added: "Added a table to “Harbour notes”",
    inNote: "· 2 changes waiting in this note",
    review: "Review",
    first: "Change 1 of 2",
  },
  "zh-CN": {
    made: "已新建“Tide summary”，并写入 2 个段落",
    checkingMade: /^正在核对“Tide summary”中的 1 句话…/,
    reviewChanges: "查看改动",
    table: "添加核对用的收入表格",
    checkingTable: /^正在核对“Harbour notes”中的 2 句话…/,
    added: "在“Harbour notes”中添加了 1 个表格",
    inNote: "· 本笔记有 2 处修订待处理",
    review: "审阅",
    first: "第 1 处修订，共 2 处",
  },
} as const;

type SlowCheck = { incarnamindSlowCheck: { hold: boolean; release(): void } };

/** Every sentence check waits from now on, until `releaseChecks`. */
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

/** Asks as a person does, and gives back the Answer at once: its write's check is still held. */
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

async function start(language: "en" | "zh-CN", file: string, text: string) {
  await writeFile(join(sources, file), text);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  // biome-ignore lint/correctness/useHookAtTopLevel: an e2e helper whose name begins with "use", not a React hook.
  await useLocalChatModel(window);
  await setLanguage(window, language);
  await addDocuments(window, [join(sources, file)]);
  return { app, window };
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`a Note the assistant made says nothing waits while its write is checked, and its Review changes opens the write once it lands, in ${language}`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language, "Tides.md", TIDES);
    await holdChecks(app);
    const answer = await ask(
      window,
      "Summarise my Documents into a new note called “Tide summary”",
    );
    await expect(answer.getByTestId("answer-writing")).toHaveText(words.checkingMade, {
      timeout: 60_000,
    });

    // The write is in the Note, drawn as applied, and the card says what it did: nothing of it waits.
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    await expect(editor).toContainText("Your Documents answer this");
    const card = answer.getByTestId("mind-changes");
    await expect(card.getByTestId("mind-changes-title")).toHaveText(words.made);
    await screenshot(window, `made-while-checked-${language}`);
    await expect(card.getByTestId("mind-changes-left")).toHaveCount(0);
    await expect(card.getByTestId("mind-changes-review")).toHaveCount(0);
    await expect(window.getByTestId("proposals-count")).toHaveCount(0);
    await expect(answer).toHaveAttribute("data-status", "streaming");

    // Checked, it lands, and Review changes shows it.
    await releaseChecks(app);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    const review = card.getByTestId("mind-changes-review");
    await expect(review).toHaveText(words.reviewChanges);
    await pointAndClick(window, review);
    await expect(
      editor.locator(".applied-new").filter({ hasText: "Your Documents answer this" }).first(),
    ).toBeVisible();
    await app.close();
  });

  test(`Review pressed while a write is checked opens the changes waiting in the Note at once, as many as the card says, in ${language}`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language, "Annual report.md", REVENUE);
    await newMind(window);
    await nameMind(window, "Harbour notes");
    await enterContent(window);
    await window.keyboard.type(NOTES[0] ?? "");
    await window.keyboard.press("Enter");
    await window.keyboard.type(NOTES[1] ?? "");
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    await expect(editor.locator(":scope > p")).toHaveText(NOTES);
    // A rewrite of most of the User's own text waits for them: two changes.
    const held = await askInAssistant(window, "Rewrite the intro to be clearer");
    await expect(held.getByTestId("mind-changes-left")).toHaveText(/\b2\b/);

    await holdChecks(app);
    const answer = await ask(window, words.table);
    await expect(answer.getByTestId("answer-writing")).toHaveText(words.checkingTable, {
      timeout: 60_000,
    });
    const card = answer.getByTestId("mind-changes");
    await expect(card.getByTestId("mind-changes-title")).toHaveText(words.added);
    const review = card.getByTestId("mind-changes-review");
    await expect(review).toHaveText(words.review);
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await screenshot(window, `waiting-while-checked-${language}`);

    await pointAndClick(window, review);
    // The Note's first waiting change, under the cursor, with its card: one of the two the card counts.
    const bar = window.getByTestId("change-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAccessibleName(words.first);
    await expect(editor).toBeFocused();
    await expect(answer).toHaveAttribute("data-status", "streaming");
    await expect(card.getByTestId("mind-changes-in-note")).toHaveText(words.inNote);
    // The table it writes applies at once: none of it is said to wait.
    await expect(card.getByTestId("mind-changes-left")).toHaveCount(0);
    await screenshot(window, `review-while-checked-${language}`);
    // Pressed again, it lands on the same change.
    await pointAndClick(window, review);
    await expect(bar).toHaveAccessibleName(words.first);
    await expect(editor).toBeFocused();

    // Checked, the table lands with Undo, which takes back the table alone: the rewrite still waits.
    await releaseChecks(app);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(editor.locator("table")).toHaveCount(1);
    await pointAndClick(window, card.getByTestId("mind-changes-undo"));
    await expect(editor.locator("table")).toHaveCount(0);
    await expect(editor.locator("ins.proposal-insert").first()).toBeVisible();
    await app.close();
  });
}

test("quit while a write is checked, the Note keeps it, and what its card then says waits is what Review opens", async () => {
  test.setTimeout(120_000);
  const { app, window } = await start("en", "Tides.md", TIDES);
  await holdChecks(app);
  const question = "Summarise my Documents into a new note called “Tide summary”";
  const answer = await ask(window, question);
  await expect(answer.getByTestId("answer-writing")).toHaveText(WORDS.en.checkingMade, {
    timeout: 60_000,
  });
  await forceQuit(app);

  const restarted = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(restarted.app, restarted.window, 1440, 900);
  await pointAndClick(
    restarted.window,
    restarted.window.getByTestId("sidebar").getByText("Tide summary", { exact: true }),
  );
  const editor = restarted.window.locator('[data-testid="mind-editor"]:visible');
  await expect(editor).toContainText("Your Documents answer this");
  await restarted.window.keyboard.press("ControlOrMeta+k");
  await expect(restarted.window.getByTestId("palette")).toBeVisible();
  await restarted.window.keyboard.type(question);
  await pointAndClick(
    restarted.window,
    restarted.window
      .locator('[data-testid="palette-group"][data-group="conversations"]')
      .getByTestId("palette-item")
      .first(),
  );
  const card = assistantAnswers(restarted.window).last().getByTestId("mind-changes");
  const left = card.getByTestId("mind-changes-left");
  await expect(left).toHaveText(/^· \d+ changes? waiting$/);
  const count = Number(/\d+/.exec(await left.innerText())?.[0]);
  await pointAndClick(restarted.window, card.getByTestId("mind-changes-review"));
  await expect(restarted.window.getByTestId("change-bar")).toHaveAccessibleName(
    `Change 1 of ${count}`,
  );
  await expect(editor).toBeFocused();
  await restarted.app.close();
});
