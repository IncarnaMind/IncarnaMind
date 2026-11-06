import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  addTideConnector,
  answersTookAboutAMinute,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setSilentWaitMs,
  setWindowSize,
  useLocalChatModel,
  watchAnswerWaits,
} from "./app";

const connectLocalChatModel = useLocalChatModel;

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

const NAMES = ["Lease Harbour Street", "Lease Mill Lane", "Board minutes"];
const FOUR = ["Lease Harbour Street", "Lease Mill Lane", "Boiler service report", "Board minutes"];

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** The Answer's ink, the AI grey (DESIGN.md, `ink-answer`). */
const INK_ANSWER = "rgb(59, 64, 72)";

/** Documents added in this order, three by default, so the newest is Board minutes. */
async function setUp(
  app: ElectronApplication,
  window: Page,
  language: "en" | "zh-CN" = "en",
  names: readonly string[] = NAMES,
) {
  await setLanguage(window, language);
  await setWindowSize(app, window, 1440, 900);
  const paths = await Promise.all(
    names.map(async (name) => {
      const path = join(sources, `${name}.md`);
      await writeFile(path, `# ${name}\n\nSigned in 2026.\n`);
      return path;
    }),
  );
  await addDocuments(window, paths);
  await newMind(window);
}

async function ask(window: Page, question: string) {
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const card = window.getByTestId("task-tray").getByTestId("question-card");
  await expect(card).toBeVisible();
  return card;
}

/** The question and its line in full, not cut, as the short tray of a narrow window draws them. */
async function expectWhole(card: Locator, question: string, detail: string) {
  const title = card.getByText(question, { exact: true });
  await expect(title).toBeVisible();
  expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(card.getByText(detail, { exact: true })).toBeVisible();
}

test("asked which Documents to summarise, the User ticks one more and goes on", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const card = await ask(window, "Summarise the main documents");
  await expect(card).toContainText("Which Documents should I summarise?");
  await expect(card).toContainText("Your Library has 3. The two newest are picked.");
  const rows = card.getByTestId("question-option");
  await expect(rows).toHaveText([
    /^1Board minutesRecommended/,
    /^2Lease Mill Lane/,
    /^3Lease Harbour Street/,
  ]);
  await expect(rows.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(rows.nth(2)).toHaveAttribute("aria-checked", "false");
  await expect(rows.nth(0)).toBeFocused();

  await window.keyboard.press("3");
  await expect(rows.nth(2)).toHaveAttribute("aria-checked", "true");
  await window.keyboard.press("ControlOrMeta+Enter");

  await expect(card).toHaveCount(0);
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("answer-asked-question")).toHaveText(
    "Which Documents should I summarise?",
  );
  await expect(answer.getByTestId("answer-asked-words")).toHaveText(
    "Board minutes, Lease Mill Lane, Lease Harbour Street",
  );
  await expect(answer.getByTestId("answer-asked-chose")).toHaveText(
    "You chose: Board minutes, Lease Mill Lane, Lease Harbour Street",
  );
  const order = await answer.evaluate((node) =>
    [
      ...node.querySelectorAll(
        '[data-testid="answer-asked-question"], [data-testid="answer-asked-answer"], [data-testid="answer-steps"], [data-testid="assistant-answer-text"]',
      ),
    ].map((each) => each.getAttribute("data-testid")),
  );
  expect(order).toEqual([
    "answer-asked-question",
    "answer-asked-answer",
    "answer-steps",
    "assistant-answer-text",
  ]);
  const editor = window.locator('[data-testid="mind-editor"]:visible');
  await expect(editor).toContainText("The main points of “Lease Harbour Street”.");
  await app.close();
});

// The question as Claude Haiku 5.5 asked it: one choice, the recommended row ticked, Other… allowed.
for (const [how, act, said, chose] of [
  [
    "a row clicked after words typed in Other… sends the row alone",
    async (card: Locator) => {
      await card.getByTestId("question-other").fill("the boiler one");
      await card.getByTestId("question-option").nth(1).click();
    },
    "All 3 Documents",
    "You chose: All 3 Documents",
  ],
  [
    "words typed in Other… untick the ticked row and are sent alone",
    async (card: Locator) => {
      const ticked = card.getByTestId("question-option").first();
      await expect(ticked).toHaveAttribute("aria-checked", "true");
      await card.getByTestId("question-other").fill("the boiler one");
      await expect(ticked).toHaveAttribute("aria-checked", "false");
      await card.getByTestId("question-other").press("Enter");
    },
    "the boiler one",
    "You chose: “the boiler one”",
  ],
] as const) {
  test(`in a single choice, ${how}`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setUp(app, window);

    const card = await ask(window, "Summarise the main ones");
    await expect(card).toContainText("Which documents should I summarise as the “main” ones?");
    await act(card);

    await expect(card).toHaveCount(0);
    const answer = assistantAnswers(window).last();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    const bubble = answer.getByTestId("answer-asked-answer").locator(".assistant-question-bubble");
    await expect(answer.getByTestId("answer-asked-words")).toHaveText(said);
    await expect(answer.getByTestId("answer-asked-chose")).toHaveText(chose);
    await expect(bubble).toMatchAriaSnapshot(`- paragraph: ${JSON.stringify(chose)}`);
    await expect(window.getByRole("alert")).toHaveCount(0);
    await app.close();
  });
}

const ANSWER_CARD = {
  en: {
    asked: "Summarise the main documents slowly",
    question: "Which Documents should I summarise?",
    answer: "Board minutes, Lease Mill Lane",
    chose: "You chose: ",
    reply: "Summarised the Documents you chose.",
    waiting: "Waiting for your answer below",
  },
  "zh-CN": {
    asked: "总结主要的文档 slowly",
    question: "要总结哪几份文档？",
    answer: "Board minutes、Lease Mill Lane",
    chose: "你选择了：",
    reply: "已写好你选的文档的摘要。",
    waiting: "等你在下方回答",
  },
} as const;

for (const [language, width, height] of [
  ["en", 900, 760],
  ["en", 1440, 900],
  ["zh-CN", 900, 760],
  ["zh-CN", 1440, 900],
] as const) {
  test(`after the User answers a question card, their own bubble, one step line and the reply, in ${language} at ${width} × ${height}`, async () => {
    test.setTimeout(180_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setUp(app, window, language);
    await setWindowSize(app, window, width, height);
    const said = ANSWER_CARD[language];

    const card = await ask(window, said.asked);
    await expect(card).toContainText(said.question);
    await pointAndClick(window, card.getByTestId("question-continue"));
    await expect(card).toHaveCount(0);
    const answer = assistantAnswers(window).last();

    // The answered card folds to the assistant's question, in the Answer's ink, its options gone.
    const question = answer.getByTestId("answer-asked-question");
    await expect(question).toHaveText(said.question);
    await expect(question).toHaveCSS("color", INK_ANSWER);
    await expect(answer.getByTestId("question-option")).toHaveCount(0);
    await expect(answer.getByTestId("answer-asked")).toHaveCount(0);

    // The User's answer is their own bubble, right-aligned as the Question above it.
    const bubble = answer.getByTestId("answer-asked-answer").locator(".assistant-question-bubble");
    const words = bubble.getByTestId("answer-asked-words");
    await expect(words).toHaveText(said.answer);
    // The attribution is spoken only: a hidden box, never part of the visible words.
    const chose = bubble.getByTestId("answer-asked-chose");
    await expect(chose).toHaveText(`${said.chose}${said.answer}`);
    const choseBox = await chose.boundingBox();
    expect(choseBox?.width ?? 0).toBeLessThanOrEqual(1);
    expect(choseBox?.height ?? 0).toBeLessThanOrEqual(1);
    await expect(words).not.toContainText(said.chose);
    // A screen reader hears the attribution once, and the bubble is right-aligned.
    await expect(bubble).toMatchAriaSnapshot(
      `- paragraph: ${JSON.stringify(`${said.chose}${said.answer}`)}`,
    );
    await expect(answer.getByTestId("answer-asked-answer")).toHaveCSS(
      "justify-content",
      "flex-end",
    );
    const asked = window
      .getByTestId("assistant-question")
      .last()
      .locator(".assistant-question-bubble");
    const askedBox = await asked.boundingBox();
    const bubbleBox = await bubble.boundingBox();
    expect(askedBox).not.toBeNull();
    expect(bubbleBox).not.toBeNull();
    if (askedBox && bubbleBox) {
      expect(
        Math.abs(bubbleBox.x + bubbleBox.width - (askedBox.x + askedBox.width)),
      ).toBeLessThanOrEqual(1);
    }

    // One step line, and no second Stop: the composer's ■ is the one Stop.
    await expect(answer.getByTestId("answer-steps-live")).toHaveCount(1);
    await expect(answer.getByTestId("answer-stop")).toHaveCount(0);
    await expect(answer).not.toContainText("Still working");
    await expect(window.getByTestId("composer-stop")).toBeVisible();
    // The line goes on with the run, never saying it waits over the User's answer.
    await expect(answer.getByTestId("answer-writing")).not.toHaveText(said.waiting, {
      timeout: 10_000,
    });
    await screenshot(window, `answered-waiting-${language}-${width}`);

    // The reply streams under that one line.
    await expect(answer.getByTestId("assistant-answer-text")).toContainText(/\p{L}/u, {
      timeout: 30_000,
    });
    await screenshot(window, `answered-${language}-${width}`);

    // The reply comes under that one line; the question, the bubble, the line and the reply hold that order.
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expect(answer.getByTestId("assistant-answer-text")).toContainText(said.reply);
    const line = await answer.getByTestId("answer-steps").boundingBox();
    const text = await answer.getByTestId("assistant-answer-text").boundingBox();
    const questionBox = await question.boundingBox();
    const kept = await bubble.boundingBox();
    expect((line?.height ?? 0) < 30).toBe(true);
    expect((questionBox?.y ?? 0) < (kept?.y ?? 0)).toBe(true);
    expect((kept?.y ?? 0) < (line?.y ?? 0)).toBe(true);
    expect((line?.y ?? 0) < (text?.y ?? 0)).toBe(true);
    await screenshot(window, `answered-done-${language}-${width}`);
    await app.close();
  });
}

test("at a narrow window the question keeps its line, and its rows and buttons stay in view", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);
  await setWindowSize(app, window, 900, 700);

  const card = await ask(window, "Summarise the main documents");
  await expectWhole(
    card,
    "Which Documents should I summarise?",
    "Your Library has 3. The two newest are picked.",
  );
  await expect(card.getByTestId("question-option").first()).toBeInViewport();
  await expect(card.getByTestId("question-continue")).toBeInViewport();
  await app.close();
});

/** Whether nothing covers the middle of `target`: what the User sees there is it. */
const uncovered = (target: Locator) =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const seen = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return seen !== null && element.contains(seen);
  });

const questionShows = (question: Locator) =>
  question.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const seen = document.elementFromPoint(box.x + 8, box.y + 6);
    return seen !== null && element.contains(seen);
  });

const clamped = (question: Locator) =>
  question.evaluate((element) => element.scrollHeight > element.clientHeight + 1);

/** Whether `target` is drawn whole: inside every box that clips it, and not covered. */
const whole = (target: Locator) =>
  target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY === "visible") continue;
      const clip = parent.getBoundingClientRect();
      top = Math.max(top, clip.top + parent.clientTop);
      bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
    }
    const seen = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return (
      box.top >= top - 1 && box.bottom <= bottom + 1 && seen !== null && element.contains(seen)
    );
  });

const heightOf = async (target: Locator) => (await target.boundingBox())?.height ?? 0;

/** While some rows are out of view, the tray takes all the room it has: none is left to the thread. */
const roomUsed = (window: Page) =>
  window.getByTestId("task-tray").evaluate((tray) => {
    const options = tray.querySelector(".choice-options");
    const scrolls = options !== null && options.scrollHeight > options.clientHeight + 1;
    const height = tray.getBoundingClientRect().height;
    return !scrolls || height >= Number.parseFloat(getComputedStyle(tray).maxHeight) - 1;
  });

/** Four Documents, so the question has four rows; and a Mind long enough to scroll, scrolled down. */
async function setUpFour(
  app: ElectronApplication,
  window: Page,
  language: "en" | "zh-CN",
  height: number,
) {
  await setUp(app, window, language, FOUR);
  await setWindowSize(app, window, 900, height);
  await window.keyboard.type("Notes on the leases.");
  for (let line = 0; line < 40; line++) await window.keyboard.press("Enter");
  await window.keyboard.type("The last line.");
  const scroller = window.locator(".mind-scroller:visible");
  await scroller.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(200);
  return scroller;
}

for (const [language, asked, more, less] of [
  ["en", "Summarise the main documents for the board", "More", "Less"],
  ["zh-CN", "为董事会总结主要的文档", "展开", "收起"],
] as const) {
  for (const [height, done] of [
    [700, "skip"],
    [560, "continue"],
  ] as const) {
    test(`docked at the bottom, the assistant grows to fit a long question of four described rows, which stays at the top, two lines with ${more}, and goes back after (${language}, 900 × ${height})`, async () => {
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      const scroller = await setUpFour(app, window, language, height);
      const assistant = window.getByTestId("assistant");
      const own = await heightOf(assistant);

      const card = await ask(window, asked);
      const question = card.getByTestId("question-text");
      const rows = card.getByTestId("question-option");
      await expect(rows).toHaveCount(4);
      await expect(rows.first()).toBeFocused();
      // It grows at once, leaving the card its tab strip, and the Mind stays where it was.
      await expect.poll(() => heightOf(assistant)).toBeGreaterThan(own);
      expect(
        await assistant.evaluate((element) => getComputedStyle(element).transitionDuration),
      ).toBe("0s");
      const strip = window.locator('[data-testid="tab-group"][data-focused] .tab-strip');
      expect(await uncovered(strip)).toBe(true);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(200);

      expect(await clamped(question)).toBe(true);
      expect(await questionShows(question)).toBe(true);
      expect(await whole(rows.first())).toBe(true);
      expect(await whole(rows.first().locator(".choice-description"))).toBe(true);
      expect(await roomUsed(window)).toBe(true);
      expect(await uncovered(card.getByTestId("question-continue"))).toBe(true);
      for (const [index, next] of [rows.nth(1), rows.nth(2), rows.nth(3)].entries()) {
        await window.keyboard.press("ArrowDown");
        await expect(next).toBeFocused();
        expect(await whole(next), `row ${index + 2}`).toBe(true);
        expect(await questionShows(question)).toBe(true);
      }
      await window.keyboard.press("ArrowDown");
      await expect(card.getByTestId("question-other")).toBeFocused();
      expect(await uncovered(card.getByTestId("question-other"))).toBe(true);

      const toggle = card.getByTestId("question-more");
      await expect(toggle).toHaveText(more);
      await pointAndClick(window, toggle);
      await expect(toggle).toHaveText(less);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(await clamped(question)).toBe(false);
      const detail = card.locator(".approval-explanation");
      expect(await clamped(detail)).toBe(false);
      expect(await whole(detail)).toBe(true);
      expect(await roomUsed(window)).toBe(true);
      expect(await uncovered(card.getByTestId("question-continue"))).toBe(true);
      await window.keyboard.press("3");
      await expect(rows.nth(2)).toHaveAttribute("aria-checked", "true");
      expect(await whole(rows.nth(2))).toBe(true);
      await pointAndClick(window, toggle);
      await expect(toggle).toHaveText(more);
      expect(await clamped(question)).toBe(true);

      if (done === "skip") await window.keyboard.press("Escape");
      else await pointAndClick(window, card.getByTestId("question-continue"));
      await expect(card).toHaveCount(0);
      await expect.poll(() => heightOf(assistant)).toBe(own);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(200);
      await app.close();
    });
  }
}

for (const how of ["keys", "drag"] as const) {
  test(`resizing the grown dock while a question waits sets the User's own height, which it keeps after Skip (${how})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setUpFour(app, window, "en", 700);
    const assistant = window.getByTestId("assistant");
    const own = await heightOf(assistant);

    const card = await ask(window, "Summarise the main documents for the board");
    await expect.poll(() => heightOf(assistant)).toBeGreaterThan(own);
    const grown = await heightOf(assistant);
    const rod = window.getByTestId("assistant-resize");
    // The line starts from the dock on screen: bigger never shrinks it, and a step is a step.
    expect(Number(await rod.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(grown);
    if (how === "keys") {
      await rod.focus();
      await window.keyboard.press("ArrowUp");
      await expect.poll(() => heightOf(assistant)).toBeGreaterThanOrEqual(grown);
      const bigger = await heightOf(assistant);
      await window.keyboard.press("ArrowDown");
      await expect.poll(() => heightOf(assistant)).toBeLessThan(bigger);
      expect(await heightOf(assistant)).toBeGreaterThanOrEqual(bigger - 10);
      await window.keyboard.press("ArrowDown");
    } else {
      const box = await rod.boundingBox();
      if (!box) throw new Error("No resize line.");
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await window.mouse.down();
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 6 });
      await window.mouse.up();
    }
    await expect.poll(() => heightOf(assistant)).toBeLessThan(grown);
    const chosen = await heightOf(assistant);
    expect(chosen).toBeGreaterThan(own);

    await pointAndClick(window, card.getByTestId("question-skip"));
    await expect(card).toHaveCount(0);
    // The User's height holds, within what the dock may take when no question waits.
    const usual = Number(await rod.getAttribute("aria-valuemax"));
    await expect.poll(() => heightOf(assistant)).toBe(Math.min(chosen, usual));
    await app.close();
  });
}

test("with the assistant at the side, a long question shows every described row and Other, as the prototype does", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "en", FOUR);
  const assistant = window.getByTestId("assistant");
  const own = await heightOf(assistant);

  const card = await ask(window, "Summarise the main documents for the board");
  for (const row of await card.getByTestId("question-option").all()) {
    expect(await whole(row)).toBe(true);
  }
  expect(await uncovered(card.getByTestId("question-other"))).toBe(true);
  await expect(card).toHaveAccessibleName(/rather than why it was decided\?$/);
  expect(await heightOf(assistant)).toBe(own);
  await app.close();
});

test("Esc skips: the Answer goes on with the two newest and says so", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window);

  const card = await ask(window, "Summarise the main documents");
  await window.keyboard.press("Escape");

  await expect(card).toHaveCount(0);
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("answer-asked-question")).toHaveText(
    "Which Documents should I summarise?",
  );
  await expect(answer.getByTestId("answer-asked")).toHaveText("Skipped; went with Board minutes");
  const order = await answer.evaluate((node) =>
    [
      ...node.querySelectorAll(
        '[data-testid="answer-asked-question"], [data-testid="answer-asked"], [data-testid="answer-steps"], [data-testid="assistant-answer-text"]',
      ),
    ].map((each) => each.getAttribute("data-testid")),
  );
  expect(order).toEqual([
    "answer-asked-question",
    "answer-asked",
    "answer-steps",
    "assistant-answer-text",
  ]);
  await expect(answer).toContainText("Summarised the two newest Documents, as you didn't choose.");
  await app.close();
});

test("in Chinese, the question and its rows, at a narrow window", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setUp(app, window, "zh-CN");
  await setWindowSize(app, window, 900, 700);

  const card = await ask(window, "总结主要的文档");
  await expectWhole(card, "要总结哪几份文档？", "资料库里有 3 份，已选中最新的两份。");
  await expect(card.getByTestId("question-recommended")).toHaveText("推荐");
  await expect(card.getByTestId("question-other")).toHaveAttribute("placeholder", "其他…");
  await expect(card.getByTestId("question-continue")).toContainText("继续");
  await expect(card.getByTestId("question-skip")).toContainText("跳过");
  const box = await card.boundingBox();
  const tray = await window.getByTestId("task-tray").boundingBox();
  expect(box && tray && box.x + box.width <= tray.x + tray.width + 1).toBe(true);
  await expect(card.getByTestId("question-option").first()).toBeInViewport();
  await expect(card.getByTestId("question-continue")).toBeInViewport();

  await card.getByTestId("question-other").fill("还有那份锅炉的");
  await card.getByTestId("question-other").press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(answer.getByTestId("answer-asked-question")).toHaveText("要总结哪几份文档？");
  await expect(answer.getByTestId("answer-asked-words")).toHaveText(
    "Board minutes、Lease Mill Lane、还有那份锅炉的",
  );
  await expect(answer.getByTestId("answer-asked-chose")).toHaveText(
    "你选择了：Board minutes、Lease Mill Lane、“还有那份锅炉的”",
  );
  await expect(
    answer.getByTestId("answer-asked-answer").locator(".assistant-question-bubble"),
  ).toMatchAriaSnapshot(
    `- paragraph: ${JSON.stringify("你选择了：Board minutes、Lease Mill Lane、“还有那份锅炉的”")}`,
  );
  await app.close();
});

/** Three Answers by the local model that each took about a minute to their first word, then the app again. */
async function startWithMinuteHistory() {
  const first = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(first.window);
  await connectLocalChatModel(first.window);
  await setUp(first.app, first.window);
  const answers = assistantAnswers(first.window);
  for (const question of [
    "What do the leases say?",
    "What does the board minute say?",
    "What does the boiler report say?",
  ]) {
    const before = await answers.count();
    await first.window.keyboard.press("ControlOrMeta+j");
    await first.window.keyboard.type(question);
    await first.window.keyboard.press("Enter");
    await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
    await expect(answers.last()).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  }
  await first.app.close();
  await answersTookAboutAMinute(dataDir);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await setSilentWaitMs(window, 300);
  await pointAndClick(window, window.getByTestId("mind-list-item").first());
  return { app, window };
}

test("the silence counts from the User's answer, at the default 320px assistant, in English and Chinese", async () => {
  test.setTimeout(240_000);
  const { app, window } = await startWithMinuteHistory();
  const languages = [
    [
      "en",
      "Summarise the main documents slowly",
      "You chose: Board minutes, Lease Mill Lane",
      "usually about a minute",
      "· usually about a minute with fake-model",
    ],
    [
      "zh-CN",
      "总结主要的文档 slowly",
      "你选择了：Board minutes、Lease Mill Lane",
      "通常要 1 分钟左右",
      "· 用 fake-model 通常要 1 分钟左右",
    ],
  ] as const;

  for (const [language, question, chose, short, whole] of languages) {
    await setLanguage(window, language);
    const card = await ask(window, question);
    await window.keyboard.press("ControlOrMeta+Enter");
    await expect(card).toHaveCount(0);
    const answer = assistantAnswers(window).last();
    const wait = answer.getByTestId("answer-steps-wait");
    // The silence starts at the User's answer, not at the Question: no wait right after it.
    await expect(wait).toHaveCount(0);
    await expect(answer.getByTestId("answer-asked-chose")).toHaveText(chose);
    // After the held step, the wait joins with its whole sentence.
    await expect(answer.getByTestId("answer-steps-wait-spoken")).toHaveText(whole, {
      timeout: 15_000,
    });
    await expect(wait).toContainText(new RegExp(short, "i"));
    const order = await answer.evaluate((node) =>
      [
        ...node.querySelectorAll(
          '[data-testid="answer-asked-question"], [data-testid="answer-asked-answer"], [data-testid="answer-steps"], [data-testid="assistant-answer-text"]',
        ),
      ].map((each) => each.getAttribute("data-testid")),
    );
    expect(order).toEqual([
      "answer-asked-question",
      "answer-asked-answer",
      "answer-steps",
      "assistant-answer-text",
    ]);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  }
  await app.close();
});

test("the silence does not count the card's wait, at the default 320px assistant", async () => {
  test.setTimeout(240_000);
  const { app, window } = await startWithMinuteHistory();
  const connectorId = await addTideConnector(window);
  // The Tool asks before it runs, so its card pauses the Answer with no new model call after it.
  await window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.setApprovalPolicy({
      subject: { kind: "tool", connectorId: id, tool: "lookup_tide" },
      policy: "ask",
    });
  }, connectorId);
  const languages = [
    [
      "en",
      "When do spring tides happen? Please lookup_tide slowly",
      "· usually about a minute with fake-model",
    ],
    ["zh-CN", "春潮什么时候出现？Please lookup_tide slowly", "· 用 fake-model 通常要 1 分钟左右"],
  ] as const;
  const waits = await watchAnswerWaits(window);

  for (const [language, question, whole] of languages) {
    await setLanguage(window, language);
    await setSilentWaitMs(window, 1_500);
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type(question);
    await window.keyboard.press("Enter");
    const approval = window.getByTestId("approval-card");
    await expect(approval).toBeVisible({ timeout: 15_000 });
    // The card sits open past the 1.5 s silence: that is the case under test, not a wait for the app.
    await window.waitForTimeout(2_500);
    const from = (await waits()).length;
    const answeredAt = await window.evaluate(() => Date.now());
    await approval.getByTestId("approval-allow-once").click();
    // The first Tool call also asks where its arguments go: allowed here, so the Tool runs on.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (let tries = 0; tries < 10; tries++) {
        const [request] = await bridge.listConsentRequests();
        if (request) {
          await bridge.respondToConsent(request.requestId, true);
          return;
        }
        await new Promise((done) => setTimeout(done, 50));
      }
    });
    const answer = assistantAnswers(window).last();
    // The Tool still runs: the silence runs from the answer, and its wait joins after its 1.5 s.
    await expect(answer.getByTestId("answer-steps-wait-spoken")).toHaveText(whole, {
      timeout: 15_000,
    });
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    // And it never showed before its 1.5 s: the card's wait is not the Answer's silence.
    const seen = (await waits()).slice(from);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.at).toBeGreaterThanOrEqual(answeredAt + 1_000);
  }
  await app.close();
});
