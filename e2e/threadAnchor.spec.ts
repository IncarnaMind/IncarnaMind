import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  moveAssistant,
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

const isFullyVisible = (answer: Locator) =>
  answer.evaluate((element) => {
    const thread = element.closest('[data-testid="assistant-thread"]');
    if (!(thread instanceof HTMLElement)) throw new Error("The assistant isn't showing.");
    const box = element.getBoundingClientRect();
    const view = thread.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
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

async function expectAnchoredQuestion(window: Page) {
  await expect(window.getByTestId("assistant-thread")).toHaveAttribute("data-anchored", "");
  await expect.poll(async () => (await whereIs(window)).question).toBeLessThan(24);
}

/**
 * The two states the thread may be in while an Answer grows: the Question at the panel's top
 * while there is room under it, or, once the Answer has reached the foot, the thread at its foot.
 * A wider system font makes a taller Answer, so the foot comes sooner; the Question never rests
 * anywhere else.
 */
async function expectAnchoredOrAtFoot(window: Page) {
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const thread = document.querySelector<HTMLElement>('[data-testid="assistant-thread"]');
          if (!thread) throw new Error("The assistant isn't showing.");
          const questions = document.querySelectorAll('[data-testid="assistant-question"]');
          const top = questions.item(questions.length - 1)?.getBoundingClientRect().top ?? 0;
          const question = top - thread.getBoundingClientRect().top;
          const fromFoot = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
          if (thread.hasAttribute("data-anchored")) {
            return question < 24
              ? "ok"
              : `the anchored Question ${question} px under the panel's top`;
          }
          return fromFoot <= 2 ? "ok" : `the thread ${fromFoot} px from its foot`;
        }),
      { message: "the Question at the panel's top with room under it, or the thread at its foot" },
    )
    .toBe("ok");
}

async function askSlowAnchored(window: Page, question: string) {
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const answers = assistantAnswers(window);
  await expect(answers).toHaveCount(5);
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expectAnchoredQuestion(window);
  return answer;
}

test("a short-lived Answer shrink clamps the scroll without releasing the anchored Question, which later follows the foot", async () => {
  const { app, window } = await startLongThread();
  const answer = await askSlowAnchored(
    window,
    "What do tides do with forty citations. Answer slowly",
  );
  const anchored = await whereIs(window);
  const log = window.getByTestId("assistant-log");
  const thread = window.getByTestId("assistant-thread");

  const grown = await answer.evaluate((element) => {
    const log = element.parentElement;
    if (!(log instanceof HTMLElement)) throw new Error("The assistant isn't showing.");
    const room = Number.parseFloat(log.style.paddingBottom) || 0;
    const added = Math.floor(room / 2);
    element.style.paddingBottom = `${added}px`;
    return { room, added };
  });
  expect(grown.added).toBeGreaterThan(40);
  await expect
    .poll(() => log.evaluate((element) => Number.parseFloat(element.style.paddingBottom) || 0))
    .toBeLessThan(grown.room);

  const clamped = await answer.evaluate((element) => {
    const thread = element.closest('[data-testid="assistant-thread"]');
    if (!(thread instanceof HTMLElement)) throw new Error("The assistant isn't showing.");
    element.style.paddingBottom = "0px";
    const top = thread.scrollTop;
    // The clamp's scroll can arrive before the resize observer refills the room.
    thread.dispatchEvent(new Event("scroll"));
    return top;
  });
  expect(clamped).toBeLessThan(anchored.scrollTop - 2);
  await expectAnchoredQuestion(window);
  expect(Math.abs((await whereIs(window)).question - anchored.question)).toBeLessThanOrEqual(2);
  expect((await whereIs(window)).scrollTop).toBeCloseTo(anchored.scrollTop, 0);

  await answer.evaluate((element) => {
    const thread = element.closest('[data-testid="assistant-thread"]');
    if (!(thread instanceof HTMLElement)) throw new Error("The assistant isn't showing.");
    element.style.paddingBottom = `${thread.clientHeight}px`;
  });
  await expect(thread).not.toHaveAttribute("data-anchored");
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeLessThanOrEqual(2);
  const atFoot = await whereIs(window);
  await answer.evaluate((element) => {
    const thread = element.closest('[data-testid="assistant-thread"]');
    if (!(thread instanceof HTMLElement)) throw new Error("The assistant isn't showing.");
    element.style.paddingBottom = `${thread.clientHeight + 80}px`;
  });
  await expect
    .poll(async () => (await whereIs(window)).scrollTop)
    .toBeGreaterThan(atFoot.scrollTop + 40);
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeLessThanOrEqual(2);
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await app.close();
});

for (const { language, width, question } of [
  {
    language: "en",
    width: 1440,
    question: "What do tides do with forty citations. Answer slowly",
  },
  {
    language: "zh-CN",
    width: 900,
    question: "潮水每天怎样变化？ forty citations. Answer slowly",
  },
] as const) {
  test(`resizing, docking, floating and folding keep an anchored Question from the foot (${language}, ${width}px)`, async () => {
    const { app, window } = await startLongThread();
    await setWindowSize(app, window, width, 640);
    await setLanguage(window, language);
    const answer = await askSlowAnchored(window, question);
    const assistant = window.getByTestId("assistant");

    const before = await assistant.boundingBox();
    if (!before) throw new Error("The assistant isn't showing.");
    const dock = await assistant.getAttribute("data-dock");
    await window.getByTestId("assistant-resize").focus();
    await window.keyboard.press(dock === "bottom" ? "ArrowUp" : "ArrowLeft");
    await expect
      .poll(() =>
        assistant.evaluate((element, place) => {
          const box = element.getBoundingClientRect();
          return place === "bottom" ? box.height : box.width;
        }, dock),
      )
      .toBe(dock === "bottom" ? before.height + 10 : before.width + 10);
    await expectAnchoredOrAtFoot(window);

    await moveAssistant(window, "float");
    await expect(assistant).toHaveAttribute("data-dock", "float");
    await expectAnchoredOrAtFoot(window);
    await window.getByTestId("assistant-fold").click();
    await expect(assistant).toHaveAttribute("data-folded", "true");
    await window.getByTestId("assistant-fold").click();
    await expect(assistant).not.toHaveAttribute("data-folded");
    await expectAnchoredOrAtFoot(window);

    await moveAssistant(window, "right");
    await expect(assistant).toHaveAttribute("data-chosen-dock", "right");
    await expect(assistant).toHaveAttribute("data-dock", width < 1000 ? "bottom" : "right");
    await expectAnchoredOrAtFoot(window);
    await expect(answer).toHaveAttribute("data-status", "streaming");
    await app.close();
  });
}

test("Add to Mind on an earlier Answer leaves the anchored Question and its room unchanged", async () => {
  const { app, window } = await startLongThread();
  const answer = await askSlowAnchored(
    window,
    "What do tides do with forty citations. Answer slowly",
  );
  const before = await whereIs(window);
  const room = () =>
    window.evaluate(() => {
      const thread = document.querySelector<HTMLElement>('[data-testid="assistant-thread"]');
      const log = document.querySelector<HTMLElement>('[data-testid="assistant-log"]');
      const question = [...(log?.querySelectorAll(".assistant-question") ?? [])].at(-1);
      const last = [...(log?.children ?? [])]
        .filter((child) => !child.matches('[data-testid="add-to-picker"]'))
        .at(-1);
      if (!thread || !log || !question || !last) throw new Error("The anchored turn is missing.");
      const style = getComputedStyle(thread);
      const filled = last.getBoundingClientRect().bottom - question.getBoundingClientRect().top;
      const inner =
        thread.clientHeight -
        (Number.parseFloat(style.paddingTop) || 0) -
        (Number.parseFloat(style.paddingBottom) || 0);
      return {
        actual: Number.parseFloat(log.style.paddingBottom) || 0,
        expected: Math.max(0, Math.round(inner - filled)),
      };
    });
  const check = async () => {
    const held = await room();
    expect(held.actual).toBe(held.expected);
    const after = await whereIs(window);
    expect(Math.abs(after.question - before.question)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
    await expect(window.getByTestId("assistant-thread")).toHaveAttribute("data-anchored", "");
  };
  const duringNextChunk = async (act: () => Promise<void>) => {
    const text = await answer.textContent();
    await act();
    await expect.poll(() => answer.textContent()).not.toBe(text);
    await expect
      .poll(async () => {
        const held = await room();
        return held.actual - held.expected;
      })
      .toBe(0);
    await check();
  };

  await duringNextChunk(async () => {
    await assistantAnswers(window)
      .first()
      .getByTestId("answer-add-to")
      .evaluate((button: HTMLElement) => button.click());
    await expect(window.getByTestId("add-to-picker")).toBeVisible();
  });
  await duringNextChunk(async () => {
    await window.getByTestId("add-to-search").fill("no such Mind");
    await expect(window.locator(".add-to-empty")).toBeVisible();
  });
  await duringNextChunk(async () => {
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("add-to-picker")).toHaveCount(0);
  });
  await app.close();
});

test("an older Answer sought in another conversation stays in view after its flash ends", async () => {
  const { app, window } = await startLongThread();
  await window.keyboard.press("ControlOrMeta+Shift+o");
  await expect(window.getByTestId("assistant-empty")).toBeVisible();
  for (const day of ["Friday", "Saturday", "Sunday", "Thursday"]) {
    await askInAssistant(window, `What do tides do on ${day}`);
  }
  const previous = await window.getByTestId("assistant-thread").boundingBox();
  if (!previous) throw new Error("The assistant isn't showing.");
  await window.mouse.move(previous.x + previous.width / 2, previous.y + previous.height / 2, {
    steps: 8,
  });
  await window.mouse.wheel(0, -200);
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeGreaterThan(100);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Your Documents answer this");
  const found = window
    .locator('[data-testid="palette-group"][data-group="conversationText"]')
    .getByTestId("palette-item")
    .filter({ hasText: "What do tides do on Monday" });
  await expect(found).toHaveCount(1);
  await found.click();

  const answers = assistantAnswers(window);
  await expect(answers).toHaveCount(4);
  const selected = answers.first();
  await expect(selected).toHaveAttribute("data-sought", "true");
  await expect.poll(() => isFullyVisible(selected)).toBe(true);
  await expect.poll(async () => (await whereIs(window)).fromFoot).toBeGreaterThan(24);
  const before = (await whereIs(window)).scrollTop;

  await expect(selected).not.toHaveAttribute("data-sought");
  await expect.poll(() => isFullyVisible(selected)).toBe(true);
  const after = await whereIs(window);
  expect(after.fromFoot).toBeGreaterThan(24);
  expect(Math.abs(after.scrollTop - before)).toBeLessThanOrEqual(2);
  await app.close();
});

test("an older Answer already visible when it is sought stays put after its flash ends", async () => {
  const { app, window } = await startLongThread();
  const older = assistantAnswers(window).first();
  await older.scrollIntoViewIfNeeded();
  await expect.poll(() => isFullyVisible(older)).toBe(true);
  const position = (await whereIs(window)).scrollTop;

  await window.keyboard.press("ControlOrMeta+Shift+o");
  await expect(window.getByTestId("assistant-empty")).toBeVisible();
  for (const day of ["Friday", "Saturday", "Sunday", "Thursday"]) {
    await askInAssistant(window, `What do tides do on ${day}`);
  }
  await window.getByTestId("assistant-thread").evaluate((thread, top) => {
    thread.scrollTop = top;
    thread.dispatchEvent(new Event("scroll"));
  }, position);

  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Your Documents answer this");
  const found = window
    .locator('[data-testid="palette-group"][data-group="conversationText"]')
    .getByTestId("palette-item")
    .filter({ hasText: "What do tides do on Monday" });
  await expect(found).toHaveCount(1);
  await found.click();

  const selected = assistantAnswers(window).first();
  await expect(selected).toHaveAttribute("data-sought", "true");
  await expect.poll(() => isFullyVisible(selected)).toBe(true);
  const before = await whereIs(window);
  expect(before.scrollTop).toBe(position);
  expect(before.fromFoot).toBeGreaterThan(24);

  await expect(selected).not.toHaveAttribute("data-sought");
  await expect.poll(() => isFullyVisible(selected)).toBe(true);
  const after = await whereIs(window);
  expect(after.scrollTop).toBeCloseTo(position, 0);
  expect(after.fromFoot).toBeGreaterThan(24);
  await app.close();
});
