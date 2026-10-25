import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

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
  await expect(answer.getByTestId("answer-asked")).toHaveText(
    "You chose: Board minutes, Lease Mill Lane, Lease Harbour Street",
  );
  const editor = window.locator('[data-testid="mind-editor"]:visible');
  await expect(editor).toContainText("The main points of “Lease Harbour Street”.");
  await app.close();
});

// The question as Claude Haiku 5.5 asked it: one choice, the recommended row ticked, Other… allowed.
for (const [how, act, said] of [
  [
    "a row clicked after words typed in Other… sends the row alone",
    async (card: Locator) => {
      await card.getByTestId("question-other").fill("the boiler one");
      await card.getByTestId("question-option").nth(1).click();
    },
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
    await expect(answer.getByTestId("answer-asked")).toHaveText(said);
    await expect(window.getByRole("alert")).toHaveCount(0);
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
  await expect(answer.getByTestId("answer-asked")).toHaveText("Skipped; went with Board minutes");
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
  await expect(answer.getByTestId("answer-asked")).toHaveText(
    "你选择了：Board minutes、Lease Mill Lane、“还有那份锅炉的”",
  );
  await app.close();
});
