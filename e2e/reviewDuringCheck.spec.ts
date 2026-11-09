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
  frontMindName,
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
 * What the assistant writes into a Note is checked after its reply (#2830), and while that check
 * runs the Answer's card counts only what really waits, and its Review opens that at once (#1358).
 * The changes the User asked for are applied, so a Note the assistant has just made shows no
 * count, and its Review changes shows the write while its sentences are still checked. The
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
    made: "Wrote “Tide summary”",
    checking: /^Checking: /,
    reviewChanges: "Review changes",
    open: "Open",
    table: "Add a revenue table for checking",
    added: "Added a table to “Harbour notes”",
    inNote: "· 2 changes waiting in this note",
    review: "Review",
    first: "Change 1 of 2",
  },
  "zh-CN": {
    made: "已写入“Tide summary”",
    checking: /^正在核对：/,
    reviewChanges: "查看改动",
    open: "打开",
    table: "添加核对用的收入表格",
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

/** A new Note, named, and its paragraphs typed as a person types them. */
async function writeNote(window: Page, title: string, lines: readonly string[]): Promise<void> {
  await newMind(window);
  await nameMind(window, title);
  await enterContent(window);
  for (const [index, line] of lines.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  await expect(
    window.locator('[data-testid="mind-editor"]:visible').locator(":scope > p"),
  ).toHaveText([...lines]);
}

interface RowFrame {
  streaming: boolean;
  rows: number;
  /** Rows that draw how many of their changes wait. */
  counted: number;
  opens: number;
}

/** Every frame from now on: the newest Answer's rows, what they count, and their Open. */
const sampleRows = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { rowFrames: RowFrame[]; sampling: boolean };
    holder.rowFrames = [];
    holder.sampling = true;
    const sample = () => {
      const answer = [...document.querySelectorAll('[data-testid="assistant-answer"]')].at(-1);
      const rows = [...(answer?.querySelectorAll('[data-testid="mind-changes-row"]') ?? [])];
      const having = (testId: string) =>
        rows.filter((row) => row.querySelector(`[data-testid="${testId}"]`)).length;
      holder.rowFrames.push({
        streaming: answer?.getAttribute("data-status") === "streaming",
        rows: rows.length,
        counted: having("mind-changes-left"),
        opens: having("mind-changes-open"),
      });
      if (holder.sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

const stopSamplingRows = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { rowFrames: RowFrame[]; sampling: boolean };
    holder.sampling = false;
    return holder.rowFrames;
  });

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`a Note the assistant made says nothing waits while its write is checked, its Open shows the Note, and Review changes opens it, in ${language}`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language, "Tides.md", TIDES);
    await holdChecks(app);
    const answer = await ask(
      window,
      "Summarise my Documents into a new note called “Tide summary”",
    );
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(answer.getByTestId("self-check-checking")).toHaveText(words.checking);

    // The write is in the Note, drawn as applied, and the card says what it did: nothing of it waits.
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    await expect(editor).toContainText("Your Documents answer this");
    const card = answer.getByTestId("mind-changes");
    await expect(card.getByTestId("mind-changes-title")).toHaveText(words.made);
    await screenshot(window, `made-while-checked-${language}`);
    await expect(card.getByTestId("mind-changes-left")).toHaveCount(0);
    await expect(window.getByTestId("proposals-count")).toHaveCount(0);

    // Open, while the check still runs, shows the Note it made.
    const open = card.getByTestId("mind-changes-open");
    await expect(open).toHaveText(words.open);
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await pointAndClick(window, open);
    await expect(frontMindName(window)).toHaveText("Tide summary");

    // Review changes shows it while its sentences are still checked, and once they are.
    await expect(answer.getByTestId("self-check-checking")).toHaveText(words.checking);
    const review = card.getByTestId("mind-changes-review");
    await expect(review).toHaveText(words.reviewChanges);
    await pointAndClick(window, review);
    await expect(
      editor.locator(".applied-new").filter({ hasText: "Your Documents answer this" }).first(),
    ).toBeVisible();
    await releaseChecks(app);
    await expect(answer.getByTestId("self-check-checking")).toHaveCount(0, { timeout: 30_000 });
    await app.close();
  });

  test(`Review pressed while a write is checked opens the changes waiting in the Note at once, as many as the card says, in ${language}`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language, "Annual report.md", REVENUE);
    await writeNote(window, "Harbour notes", NOTES);
    const editor = window.locator('[data-testid="mind-editor"]:visible');
    // A rewrite of most of the User's own text waits for them: two changes.
    const held = await askInAssistant(window, "Rewrite the intro to be clearer");
    await expect(held.getByTestId("mind-changes-left")).toHaveText(/\b2\b/);

    await holdChecks(app);
    const answer = await ask(window, words.table);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(answer.getByTestId("self-check-checking")).toHaveText(words.checking);
    const card = answer.getByTestId("mind-changes");
    await expect(card.getByTestId("mind-changes-title")).toHaveText(words.added);
    const review = card.getByTestId("mind-changes-note-review");
    await expect(review).toHaveText(words.review);
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await screenshot(window, `waiting-while-checked-${language}`);

    await pointAndClick(window, review);
    // The Note's first waiting change, under the cursor, with its card: one of the two the card counts.
    const bar = window.getByTestId("change-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAccessibleName(words.first);
    await expect(editor).toBeFocused();
    await expect(answer.getByTestId("self-check-checking")).toHaveText(words.checking);
    await expect(card.getByTestId("mind-changes-in-note")).toHaveText(words.inNote);
    // The table it writes applies at once: none of it is said to wait.
    await expect(card.getByTestId("mind-changes-left")).toHaveCount(0);
    await screenshot(window, `review-while-checked-${language}`);
    // Pressed again, it lands on the same change.
    await pointAndClick(window, review);
    await expect(bar).toHaveAccessibleName(words.first);
    await expect(editor).toBeFocused();

    // Checked, the table keeps its Undo, which takes back the table alone: the rewrite still waits.
    await releaseChecks(app);
    await expect(answer.getByTestId("self-check-checking")).toHaveCount(0, { timeout: 30_000 });
    await expect(editor.locator("table")).toHaveCount(1);
    await pointAndClick(window, card.getByTestId("mind-changes-undo"));
    await expect(editor.locator("table")).toHaveCount(0);
    await expect(editor.locator("ins.proposal-insert").first()).toBeVisible();
    await app.close();
  });

  test(`Review on an earlier request's waiting changes opens them while another write is checked, in ${language}`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await start(language, "Tides.md", TIDES);
    await writeNote(window, "Harbour notes", NOTES);
    await askInAssistant(window, "Rewrite the intro to be clearer");
    const held = assistantAnswers(window).first();
    await expect(held.getByTestId("mind-changes-left")).toHaveText(/\b2\b/);
    await writeNote(window, "Ferry notes", ["The ferry runs twice a day."]);
    await expect(frontMindName(window)).toHaveText("Ferry notes");

    await holdChecks(app);
    const answer = await ask(
      window,
      "Summarise my Documents into a new note called “Tide summary”",
    );
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(answer.getByTestId("self-check-checking")).toHaveText(words.checking);
    await pointAndClick(window, held.getByTestId("mind-changes-review"));
    // The Note opens while the write is checked, its two changes still waiting, the first under the cursor.
    await expect(frontMindName(window)).toHaveText("Harbour notes");
    await expect(window.getByTestId("change-bar")).toHaveAccessibleName(words.first);
    await expect(window.locator('[data-testid="mind-editor"]:visible')).toBeFocused();

    // Checked, the Note it made stays behind the one the User went to (#2572).
    await releaseChecks(app);
    await expect(answer.getByTestId("self-check-checking")).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByTestId("mind-tab").filter({ hasText: "Tide summary" })).toHaveCount(1);
    await expect(frontMindName(window)).toHaveText("Harbour notes");
    await app.close();
  });
}

test("an Answer that writes in two Notes says no change of either waits while it writes, and offers Open on each", async () => {
  test.setTimeout(120_000);
  const { app, window } = await start("en", "Tides.md", TIDES);
  await writeNote(window, "Project plan", ["Hire a designer."]);
  await writeNote(window, "Q3 review", ["The quarter was good."]);
  await sampleRows(window);
  // Slowly: the scripted model writes word by word, so the card shows both rows while it runs.
  const answer = await askInAssistant(
    window,
    "Add Ship the beta in May to Project plan and make a new note called Fieldwork plan slowly",
  );
  const frames = await stopSamplingRows(window);
  const running = frames.filter((frame) => frame.streaming && frame.rows === 2);
  expect(running.length).toBeGreaterThan(0);
  expect(running.filter((frame) => frame.counted > 0)).toHaveLength(0);
  expect(running.filter((frame) => frame.opens !== 2)).toHaveLength(0);
  await expect(answer.getByTestId("mind-changes-title")).toHaveText([
    "Added 1 paragraph to “Project plan”",
    "Wrote “Fieldwork plan”",
  ]);
  await app.close();
});

test("quit while a write is checked, the Note keeps it, its sentences read not checked, and nothing of it waits", async () => {
  test.setTimeout(120_000);
  const { app, window } = await start("en", "Tides.md", TIDES);
  await holdChecks(app);
  const question = "Summarise my Documents into a new note called “Tide summary”";
  const answer = await ask(window, question);
  await expect(answer.getByTestId("self-check-checking")).toHaveText(WORDS.en.checking, {
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
  // The check that was running when IncarnaMind quit leaves no sentence shown as still checked.
  await expect(
    restarted.window.locator('[data-testid="claim-mark"][data-check="not-checked"]').first(),
  ).toBeAttached();
  await expect(
    restarted.window.locator('[data-testid="claim-mark"][data-check="checking"]'),
  ).toHaveCount(0);
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
  // Its reply had come and its change applied before the quit: none of it waits.
  const card = assistantAnswers(restarted.window).last().getByTestId("mind-changes");
  await expect(card.getByTestId("mind-changes-left")).toHaveText("· none waiting");
  await expect(restarted.window.getByTestId("proposals-count")).toHaveCount(0);
  await restarted.app.close();
});
