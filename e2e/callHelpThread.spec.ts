import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { ASKED_ANEW } from "../src/main/fakeChat/meetingHelp";
import {
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  expectQuoteLines,
  firstTranscriptLine,
  launchApp,
  panelOf,
  pointAndClick,
  pressHeldKeys,
  pressHelp,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setMeetingKeys,
  setWindowSize,
  startRecording,
} from "./app";

/**
 * The call-help panel's thread and its typed question (#2925): Note | Ask at the field's left, a
 * question asked in Ask answered in the call's short form, its Citation's quote drawn under it as a
 * prompt's is, with ✓ where the app found it, the Meeting's
 * conversation shown oldest first with its earlier items one line each, the same conversation in
 * the assistant and in History, and a panel that stays under 60% of the screen and scrolls inside.
 */
const LINUX = process.platform === "linux";
const NO_FIELD = "On Linux the panel has no field (#2925), so no typed question.";
const PRICE = "Enterprise plan: $45 per seat a month, single sign-on included.";

const CALLS = {
  en: {
    buyer: [
      "Can you do thirty-five dollars a seat for Enterprise?",
      "How much is the Enterprise plan per seat, and does it include single sign-on?",
    ],
    answer: "Answer their question",
    sumUp: "Sum up so far",
    question: "How much is the Enterprise plan per seat?",
    ask: "Ask",
    placeholder: "Ask about this call…",
  },
  zh: {
    buyer: ["企业版能便宜一点吗？", "Enterprise 每个席位多少钱，包含单点登录吗？"],
    answer: "回答对方的问题",
    sumUp: "到目前为止的总结",
    question: "Enterprise plan 每个席位多少钱？",
    ask: "追问",
    placeholder: "问问这场通话…",
  },
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

const core = (window: Page) =>
  window.evaluateHandle(() => (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind);

/**
 * A call recording, the price sheet in the Library first: Documents wait while a meeting records.
 * `lines`: what the User says in it, the transcriber's own lines when none.
 */
async function recording(language: keyof typeof CALLS = "en", lines?: readonly string[]) {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { theirLines: CALLS[language].buyer, ...(lines && { lines }) },
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await setMeetingKeys(window);
  await connectLocalChatModel(window);
  if (language === "zh") await setLanguage(window, "zh-CN");
  const sheet = join(sources, "Price sheet.txt");
  await writeFile(sheet, `Price sheet 2026\n\nTeam plan: $25 per seat a month.\n${PRICE}\n`);
  await (await core(window)).evaluate((bridge, path) => bridge.addDocuments([path]), sheet);
  await expect
    .poll(async () =>
      (await core(window)).evaluate(async (bridge) =>
        (await bridge.listDocuments()).map((document) => document.status),
      ),
    )
    .toEqual(["ready"]);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await firstTranscriptLine(window);
  return { app, window, bar, panel: await panelOf(app) };
}

const newest = (panel: Page) => panel.getByTestId("help-suggestion").last();
const earlierLines = (panel: Page) => panel.getByTestId("help-earlier");
const windowHeight = (panel: Page) => panel.evaluate(() => window.innerHeight);
const panelFocused = async (app: ElectronApplication, panel: Page) =>
  (await app.browserWindow(panel)).evaluate((win) => win.isFocused());

/** Chooses a mode of the field by its label, as a person clicks it. */
const chooseMode = (panel: Page, label: string) =>
  pointAndClick(panel, panel.getByTestId("field-mode").locator("label").filter({ hasText: label }));

/** Asks a question in Ask: a click in the field, the question, Enter; resolves once it is answered. */
async function askInPanel(panel: Page, question: string): Promise<Locator> {
  await pointAndClick(panel, panel.getByTestId("quick-note-field"));
  await panel.keyboard.type(question);
  await panel.keyboard.press("Enter");
  const answer = newest(panel);
  await expect(answer.getByTestId("help-heading")).toHaveText(question);
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  return answer;
}

for (const language of ["en", "zh"] as const) {
  const said = CALLS[language];
  test(`typed question (${language}): a prompt, then a question in Ask, cited to the price sheet, its quote found; the prompt is one line that opens on click; Ask is kept through a collapse and a closed panel, and "/" asks a prompt in it`, async () => {
    test.skip(LINUX, NO_FIELD);
    test.setTimeout(120_000);
    const { app, window, panel } = await recording(language);
    const field = panel.getByTestId("quick-note-field");

    await pressHelp(panel, said.answer);
    await expect(panel.getByTestId("field-mode-note")).toBeChecked();
    await chooseMode(panel, said.ask);
    await expect(panel.getByTestId("field-mode-ask")).toBeChecked();
    await expect(field).toHaveAttribute("placeholder", said.placeholder);
    // Choosing a mode is a click on a button: the meeting app keeps the keyboard.
    expect(await panelFocused(app, panel)).toBe(false);

    const answer = await askInPanel(panel, said.question);
    await expect(answer.getByTestId("help-option-say").first()).toContainText("$45 per seat");
    expect((await expectQuoteLines(window, answer))[0]).toMatchObject({ found: true });
    await expect(answer.getByTestId("help-source")).toHaveText([/^1 · Price sheet · /]);
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();

    // The prompt before it is one line: its time, its name and the start of its reply.
    await expect(earlierLines(panel)).toHaveCount(1);
    await expect(earlierLines(panel)).toHaveText(new RegExp(`^\\d+:\\d{2}·${said.answer}·“.+”$`));
    await expect(panel.getByTestId("help-suggestion")).toHaveCount(1);
    // A click opens it and closes the question, which becomes a line named by the question.
    await pointAndClick(panel, earlierLines(panel));
    await expect(panel.getByTestId("help-suggestion")).toHaveCount(1);
    await expect(newest(panel).getByTestId("help-heading")).toContainText(said.answer);
    await expect(earlierLines(panel)).toHaveCount(1);
    await expect(earlierLines(panel)).toContainText(said.question);

    // Ask stays chosen through a collapse, and a panel closed and shown again, with its thread.
    await panel.keyboard.press("Escape");
    await pointAndClick(panel, panel.getByTestId("panel-collapse"));
    await pointAndClick(panel, panel.getByTestId("panel-expand"));
    await expect(panel.getByTestId("field-mode-ask")).toBeChecked();
    await pointAndClick(panel, panel.getByTestId("panel-close"));
    await expect.poll(() => panel.isClosed()).toBe(true);
    await (await core(window)).evaluate(() =>
      (
        globalThis as unknown as { incarnamindFiles: { showMeetingPanel(shown: boolean): void } }
      ).incarnamindFiles.showMeetingPanel(true),
    );
    const again = await panelOf(app);
    await expect(again.getByTestId("field-mode-ask")).toBeChecked();
    await expect(again.getByTestId("help-suggestion")).toHaveCount(1);
    await expect(again.getByTestId("help-earlier")).toHaveCount(1);

    // "/" lists the prompts in Ask too; Enter asks the one chosen, not a question.
    await pointAndClick(again, again.getByTestId("quick-note-field"));
    await again.keyboard.type(language === "en" ? "/su" : "/总结");
    await expect(
      again.getByTestId("help-slash-list").getByTestId("help-prompt").first(),
    ).toHaveText(new RegExp(`^${said.sumUp}`));
    await again.keyboard.press("Enter");
    await expect(newest(again).getByTestId("help-heading")).toContainText(said.sumUp);
    await expect(again.getByTestId("quick-note-field")).toHaveValue("");
    await app.close();
  });
}

test("a Chinese question on a Chinese call answered in English is asked anew once: the English line stays until the Chinese reply's first words replace it", async () => {
  test.skip(LINUX, NO_FIELD);
  test.setTimeout(120_000);
  // A call in Chinese on both sides, as the question is.
  const { app, panel } = await recording("zh", ["我们先看一下报价。", "企业版的价格在报价单上。"]);
  await chooseMode(panel, CALLS.zh.ask);
  // Watches the reply's line from the first words on: it may change, never be empty. The English
  // line may stand for a moment only, so it is caught as it is drawn, not looked for afterwards.
  await panel.evaluate(() => {
    const seen = { written: false, emptied: false, english: false };
    (globalThis as unknown as { anew: typeof seen }).anew = seen;
    new MutationObserver(() => {
      const line = [...document.querySelectorAll('[data-testid="help-suggestion"]')]
        .at(-1)
        ?.querySelector('[data-testid="help-option-say"]');
      const text = line?.textContent?.trim() ?? "";
      if (text.includes("The Enterprise plan is $45 a seat")) seen.english = true;
      if (text !== "") seen.written = true;
      else if (seen.written) seen.emptied = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await pointAndClick(panel, panel.getByTestId("quick-note-field"));
  await panel.keyboard.type(ASKED_ANEW);
  await panel.keyboard.press("Enter");

  const answer = newest(panel);
  const line = answer.getByTestId("help-option-say").first();
  await expect(line).toContainText("企业版每个席位每月 45 美元", { timeout: 20_000 });
  await expect(answer).toHaveAttribute("data-status", "done");
  await expect(answer.getByTestId("help-option-say")).toHaveCount(1);
  expect(
    await panel.evaluate(() => (globalThis as unknown as { anew: { emptied: boolean } }).anew),
  ).toEqual({ written: true, emptied: false, english: true });
  await app.close();
});

test("typed question: the panel's conversation is the one the assistant shows, Open in assistant goes on there, and History keeps it after Stop", async () => {
  test.skip(LINUX, NO_FIELD);
  test.setTimeout(120_000);
  const { app, window, bar, panel } = await recording();
  await pressHelp(panel, "Answer their question");
  await chooseMode(panel, "Ask");
  await askInPanel(panel, CALLS.en.question);

  // Its actions sit under the reply: Open in assistant is the newest's, the question's.
  await expect(panel.getByTestId("help-open-assistant")).toHaveCount(1);
  await pointAndClick(panel, panel.getByTestId("help-open-assistant"));
  await expect(window.getByTestId("assistant-question")).toHaveText([
    /Answer their question/,
    new RegExp(CALLS.en.question.replace("?", "\\?")),
  ]);
  await expect(window.getByTestId("composer-input")).toBeFocused();

  await bar.getByTestId("meeting-stop").click();
  await pointAndClick(window, window.getByTestId("assistant-title"));
  await expect(
    window.getByTestId("assistant-history-row").filter({ hasText: "Answer their question" }),
  ).toHaveCount(1);
  await app.close();
});

test("thread: it scrolls inside a panel under 60% of the screen's height, the newest in view, and nothing shifts or scrolls while the pointer rests on it as an answer is written", async () => {
  test.setTimeout(150_000);
  const { app, panel } = await recording();
  const tallest = await panel.evaluate(() => Math.round(window.screen.availHeight * 0.6));
  const thread = panel.getByTestId("help-thread");
  await pressHelp(panel, "What should I say?");
  // An answer as tall as the screen, so the thread outgrows the panel whatever the screen.
  await panel.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `.panel-suggestion { min-height: ${window.screen.availHeight}px; }`;
    document.head.append(style);
  });
  await expect
    .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 1))
    .toBe(true);
  await expect.poll(() => windowHeight(panel)).toBeLessThanOrEqual(tallest + 1);
  expect(await windowHeight(panel)).toBeGreaterThan(tallest - 40);
  // Its top in the thread's view: a reply is read from its start.
  const inView = async (target: Locator) => {
    const [box, frame] = await Promise.all([target.boundingBox(), thread.boundingBox()]);
    if (!box || !frame) throw new Error("The thread isn't drawn.");
    return box.y >= frame.y - 1 && box.y < frame.y + frame.height;
  };

  // The pointer rests on the thread; a key asks again, from the meeting app.
  const frame = await thread.boundingBox();
  if (!frame) throw new Error("The thread isn't drawn.");
  await panel.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2, { steps: 4 });
  await panel.evaluate(() => {
    const kept = globalThis as unknown as { shifted: number };
    kept.shifted = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput) kept.shifted += entry.value;
      }
    }).observe({ type: "layout-shift" });
  });
  const before = await thread.evaluate((element) => element.scrollTop);
  await pressHeldKeys(app, "sum");
  // The ask comes into view in the thread, from its start, and then nothing scrolls while it is
  // written: the pointer is on the panel. The page around the thread never scrolls.
  const asked = newest(panel);
  await expect(asked.getByTestId("help-heading")).toContainText("Sum up so far");
  expect(await inView(asked)).toBe(true);
  const scrolled = await thread.evaluate((element) => element.scrollTop);
  expect(scrolled).toBeGreaterThan(before);
  await expect(asked).toHaveAttribute("data-status", "done", { timeout: 20_000 });
  expect(await inView(asked)).toBe(true);
  expect(await thread.evaluate((element) => element.scrollTop)).toBe(scrolled);
  expect(await panel.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  expect(
    await panel.evaluate(() => (globalThis as unknown as { shifted: number }).shifted),
  ).toBeLessThan(0.001);
  await app.close();
});
