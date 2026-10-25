import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setLanguage,
  setWindowSize,
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

interface Where {
  /** The newest Question's top under the thread's top. */
  question: number;
  scrollTop: number;
  /** How far the thread's end is below what shows. */
  fromFoot: number;
  /** The last Answer's bottom, above or below the foot of what shows (negative: above). */
  answerBelowFoot: number;
}

const whereIs = (window: Page): Promise<Where> =>
  window.evaluate(() => {
    const thread = document.querySelector<HTMLElement>('[data-testid="assistant-thread"]');
    const questions = document.querySelectorAll('[data-testid="assistant-question"]');
    const answers = document.querySelectorAll('[data-testid="assistant-answer"]');
    if (!thread) throw new Error("The assistant isn't showing.");
    const box = thread.getBoundingClientRect();
    return {
      question: (questions.item(questions.length - 1)?.getBoundingClientRect().top ?? 0) - box.top,
      scrollTop: thread.scrollTop,
      fromFoot: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
      answerBelowFoot:
        (answers.item(answers.length - 1)?.getBoundingClientRect().bottom ?? 0) - box.bottom,
    };
  });

/** One frame's place for the sampled Question, in px: its place among the messages, and what shows. */
interface Place {
  /** Under the conversation's top, which no scroll or resize of the panel changes. */
  inConversation: number;
  /** Under the panel's top: where the User sees it. */
  seen: number;
  /** How far the conversation reaches past the panel. */
  past: number;
}

/** Every frame from now on, where the Question at `index` is, once it shows. */
const followQuestion = (window: Page, index: number) =>
  window.evaluate((at) => {
    const holder = globalThis as unknown as { places: Place[]; following: boolean };
    holder.places = [];
    holder.following = true;
    const sample = () => {
      const thread = document.querySelector<HTMLElement>('[data-testid="assistant-thread"]');
      const log = document.querySelector<HTMLElement>('[data-testid="assistant-log"]');
      const question = document.querySelectorAll('[data-testid="assistant-question"]').item(at);
      if (thread && log && question) {
        const panel = thread.getBoundingClientRect();
        const conversation = log.getBoundingClientRect();
        const top = question.getBoundingClientRect().top;
        holder.places.push({
          inConversation: top - conversation.top,
          seen: top - panel.top,
          past: thread.scrollHeight - thread.clientHeight,
        });
      }
      if (holder.following) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, index);

const stopFollowing = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { places: Place[]; following: boolean };
    holder.following = false;
    return holder.places;
  });

/** Each place the Question was in, and the panel it was seen in, for a failure that says what moved (#1824). */
const whereItMoved = (places: Place[]): string => {
  const states = new Map<string, number[]>();
  for (const { inConversation, seen, past } of places) {
    const at = Math.round(inConversation * 100) / 100;
    const state = `${seen} px under the panel's top, ${past} px past it`;
    const counts = states.get(state) ?? [];
    counts.push(at);
    states.set(state, counts);
  }
  return `the Question moved: ${[...states]
    .map(([state, at]) => `${Math.min(...at)}–${Math.max(...at)} px in the conversation (${state})`)
    .join("; ")}`;
};

/** From now on, the layout shifts the User didn't cause that move a Question. */
const watchQuestionShifts = (window: Page) =>
  window.evaluate(() => {
    const holder = globalThis as unknown as { questionShifts: number[] };
    holder.questionShifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: { node: Node | null }[];
        };
        const moved = (shift.sources ?? []).some(({ node }) => {
          const element = node instanceof Element ? node : node?.parentElement;
          return element?.closest('[data-testid="assistant-question"]');
        });
        if (moved && !shift.hadRecentInput && shift.value > 0) {
          holder.questionShifts.push(shift.value);
        }
      }
    }).observe({ type: "layout-shift" });
  });

const questionShifts = (window: Page) =>
  window.evaluate(() => (globalThis as unknown as { questionShifts: number[] }).questionShifts);

const QUESTIONS = {
  en: ["When do spring tides happen? Answer slowly.", "And neap tides? Answer slowly."],
  "zh-CN": ["春潮什么时候出现？ Answer slowly.", "那小潮呢？ Answer slowly."],
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`in a thread shorter than its panel, a Question holds its place while its Answer grows below it (${language})`, async () => {
    test.setTimeout(120_000);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await connectLocalChatModel(window);
    await setLanguage(window, language);

    let asked = 0;
    for (const question of QUESTIONS[language]) {
      await followQuestion(window, asked);
      const answer = await askInAssistant(window, question);
      const places = await stopFollowing(window);
      // The same place in the conversation from the first frame it shows to the Answer's last word.
      expect(places.length).toBeGreaterThan(30);
      const tops = places.map((each) => each.inConversation);
      const spread = Math.max(...tops) - Math.min(...tops);
      expect(spread, whereItMoved(places)).toBeLessThan(1);
      const here = await whereIs(window);
      expect(here.scrollTop).toBe(0);
      expect(here.answerBelowFoot).toBeLessThan(0);
      await expect(answer).toHaveAttribute("data-status", "done");
      asked += 1;
    }
    // The second Question came under the first Answer, and the first one stayed where it was.
    await expect(assistantAnswers(window)).toHaveCount(2);
    const first = await window.getByTestId("assistant-question").first().boundingBox();
    const thread = await window.getByTestId("assistant-thread").boundingBox();
    expect((first?.y ?? 0) - (thread?.y ?? 0)).toBeLessThan(40);
    await app.close();
  });
}

/** Four Questions in a 640px-high window: the thread is longer than its panel and scrolled to its foot. */
async function startLongThread() {
  await writeFile(
    join(sources, "Tides.pdf"),
    buildPdf([
      {
        lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."],
      },
    ]),
  );
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 640);
  await dismissChatSetup(window);
  await connectLocalChatModel(window);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday"]) {
    await askInAssistant(window, `What do tides do on ${day}`);
  }
  return { app, window };
}

test("in a thread longer than its panel, the Question just sent goes to the top once, the Answer grows below it, and the thread follows the foot only once it is reached, until the User scrolls up", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startLongThread();
  const before = await whereIs(window);
  expect(before.fromFoot).toBeLessThanOrEqual(2);
  expect(before.scrollTop).toBeGreaterThan(100);

  await watchQuestionShifts(window);
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What do tides do with forty citations");
  await window.keyboard.press("Enter");
  const answers = assistantAnswers(window);
  await expect(window.getByTestId("assistant-question")).toHaveCount(5);
  await expect(answers).toHaveCount(5);

  // Sent: the Question is at the top, and the Answer starts below it with room to grow.
  await expect.poll(async () => (await whereIs(window)).question).toBeLessThan(24);
  const anchored = await whereIs(window);
  expect(anchored.answerBelowFoot).toBeLessThan(0);

  // It grows to the foot, the Question where it was; then the thread follows it.
  await expect
    .poll(async () => (await whereIs(window)).scrollTop, { timeout: 90_000 })
    .toBeGreaterThan(anchored.scrollTop + 60);
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeLessThanOrEqual(2);
  expect(await questionShifts(window)).toEqual([]);

  // A scroll up by the User stops it: the Answer goes on growing under what they read.
  const thread = await window.getByTestId("assistant-thread").boundingBox();
  if (!thread) throw new Error("The assistant isn't showing.");
  await window.mouse.move(thread.x + thread.width / 2, thread.y + thread.height / 2, { steps: 8 });
  await window.mouse.wheel(0, -200);
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeGreaterThan(100);
  const read = await whereIs(window);
  const grown = await window.evaluate(
    () => document.querySelector('[data-testid="assistant-thread"]')?.scrollHeight ?? 0,
  );
  await expect
    .poll(
      () =>
        window.evaluate(
          () => document.querySelector('[data-testid="assistant-thread"]')?.scrollHeight ?? 0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(grown + 60);
  expect(Math.abs((await whereIs(window)).scrollTop - read.scrollTop)).toBeLessThanOrEqual(2);
  await app.close();
});

test("a scroll up before the Answer reaches the foot leaves no blank under it once it has ended", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startLongThread();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What do tides do with forty citations");
  await window.keyboard.press("Enter");
  const answers = assistantAnswers(window);
  await expect(answers).toHaveCount(5);
  await expect.poll(async () => (await whereIs(window)).question).toBeLessThan(24);

  const thread = await window.getByTestId("assistant-thread").boundingBox();
  if (!thread) throw new Error("The assistant isn't showing.");
  await window.mouse.move(thread.x + thread.width / 2, thread.y + thread.height / 2, { steps: 8 });
  await window.mouse.wheel(0, -200);
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeGreaterThan(100);

  await expect(answers.last()).toHaveAttribute("data-status", "done", { timeout: 90_000 });
  const blank = await window.evaluate(() => {
    const scroller = document.querySelector('[data-testid="assistant-thread"]');
    const answer = [...document.querySelectorAll('[data-testid="assistant-answer"]')].at(-1);
    if (!scroller || !answer) throw new Error("The assistant isn't showing.");
    const end = answer.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    return scroller.scrollHeight - (end + scroller.scrollTop);
  });
  expect(blank).toBeLessThan(80);
  await app.close();
});
