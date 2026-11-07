import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  type AnswerWaitForm,
  acceptPlainTextKeys,
  addDocuments,
  addTideConnector,
  answersTookAboutAMinute,
  assistantAnswers,
  useLocalChatModel as connectLocalChatModel,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  mindWrittenBefore,
  openSteps,
  pointAndClick,
  pointAt,
  removeDataFolder,
  setSilentWaitMs,
  setWindowSize,
  sidebarFolder,
  sizeAssistant,
  slideToHandle,
  watchAnswerWaits,
} from "./app";

/**
 * An Answer's steps in the assistant (#391): while it is written, one line
 * says the step it is on, each held a second; written, the line folds to what
 * it searched and how many sources it cites, and opens, by click, Enter or
 * Space, to a timeline of the reasoning, the Mind read (#544), the searches
 * with their sources, the calls and the check, with Regenerate at its end. An
 * empty conversation says once what the next Question reads and searches;
 * nothing sits under the header, and only Copy · Add to note under an Answer.
 * The scripted model reasons as a model that summarizes its reasoning does
 * (an Anthropic key, so it is kept). Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", SPRING] },
]);
const LEASE = buildPdf([
  {
    lines: [
      "Lease agreement",
      "Term: 36 months from 1 March 2026.",
      "Monthly rent: $4,800.",
      "Deposit: $9,600.",
    ],
  },
]);
const LEASE_ZH = [
  "租赁合同-2026",
  "租期：2026 年 3 月 1 日至 2029 年 2 月 28 日，共三年。",
  "月租金：人民币 4,800 元整。",
  "押金：人民币 9,600 元。",
].join("\n");
const MODEL = "claude-haiku-5-5";
const MODEL_NAME = "Claude Haiku 5.5";
const LONG_FOLDER = "Thesis: urban heat islands and the night-time cooling of city parks";

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

const core = (window: Page) => ({
  /** An Anthropic key, whose models summarize their reasoning: choosing it allows Questions and tagging. */
  anthropic: (modelId = MODEL) =>
    window.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.saveChatProvider({ kind: "anthropic", apiKey: "sk-ant-test", modelId: id });
    }, modelId),
  /** A Mind, in a Folder if given (its id and name), opened from the sidebar. */
  mind: async (title: string, folder: { id: string; name: string } | null = null) => {
    await window.evaluate(
      async ({ name, folderId }) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.createMind({
          title: name,
          folderId,
        }),
      { name: title, folderId: folder?.id ?? null },
    );
    if (folder) {
      const row = sidebarFolder(window, folder.name);
      if ((await row.getAttribute("data-expanded")) !== "true") {
        await pointAndClick(window, row.getByTestId("folder-row"));
      }
    }
    await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
    await expect(frontMindName(window)).toHaveText(title);
  },
  /** A Folder holding every Document so far. */
  folderOfAll: (name: string) =>
    window.evaluate(async (folderName) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const folder = await bridge.createLibraryGroup({ name: folderName, description: "" });
      for (const document of await bridge.listDocuments()) {
        await bridge.assignDocumentGroup(document.id, folder.id);
      }
      return folder.id;
    }, name),
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
});

/** The app with Tides added; the chat model on an Anthropic key, or, `local`, on this computer. */
async function start(
  options: { documents?: boolean; examples?: boolean; local?: boolean; model?: string } = {},
) {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ...(options.examples && { examples: true }),
  });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  if (options.local) {
    await connectLocalChatModel(window);
  } else {
    await acceptPlainTextKeys(window);
    await core(window).anthropic(options.model);
  }
  if (options.documents !== false) {
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
  }
  return { app, window };
}

/** Asks in the assistant, as a person does, and resolves with the Answer once written and its sentences judged. */
async function ask(window: Page, question: string): Promise<Locator> {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1, { timeout: 15_000 });
  const answer = answers.last();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(answer.locator('[data-testid="citation"][data-check="checking"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  return answer;
}

/** The steps the live line showed, in order, from now on. */
async function watchLiveLine(window: Page): Promise<() => Promise<string[]>> {
  await window.evaluate(() => {
    const shown: string[] = [];
    (globalThis as unknown as { shownSteps: typeof shown }).shownSteps = shown;
    const record = () => {
      const live = document.querySelector(
        '[data-testid="assistant"] [data-testid="answer-steps-live"]',
      );
      const step = live?.getAttribute("data-step") ?? "none";
      if (shown.at(-1) !== step) shown.push(step);
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-step"],
    });
  });
  return () =>
    window.evaluate(() => (globalThis as unknown as { shownSteps: string[] }).shownSteps);
}

const stepsOf = (timeline: Locator) =>
  timeline
    .getByTestId("answer-step")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-step")));

test("a Document read shows its pages in English and Chinese", async () => {
  const { app, window } = await start({ local: true });
  await core(window).mind("Lit review: tides");

  const answer = await ask(window, "Read page 2 of “Tides” and answer when spring tides happen.");
  const timeline = await openSteps(window, answer);
  await expect(timeline).toContainText("Read pages 2 of “Tides”");
  await expect(timeline.getByText("Read pages 2 of “Tides”", { exact: true })).toHaveCount(1);
  await expect(timeline).toContainText("1 passage found, 1 used");
  await screenshot(window, "read-document-en-1440");

  await core(window).language("zh-CN");
  await expect(timeline).toContainText("读取了“Tides”第 2 页");
  await setWindowSize(app, window, 900, 760);
  await screenshot(window, "read-document-zh-900");
  await app.close();
});

test("while an Answer is written, its line moves from Reading through Thinking or Searching to Writing and Checking; written, it folds to what it searched and its sources", async () => {
  const { app, window } = await start();
  await core(window).mind("Lit review: tides");
  const shown = await watchLiveLine(window);

  // "Slowly": the scripted model takes a while over each step.
  const answer = await ask(window, "When do spring tides happen? Answer slowly.");

  // The Answer's own line takes over from the one on its way, on the same step. Between Reading and
  // Writing the model thinks and searches, and a step that is over before the one before has had its
  // time (see tests/renderer/heldStep.test.ts) is never shown.
  const names = (await shown())
    .filter((step) => step !== "none")
    .filter((step, index, all) => step !== all[index - 1]);
  expect(names[0]).toBe("reading");
  // An assistant turn is offered the Tools that write Notes, so once its Citations are in it checks
  // the changes its reply says it made (#2037), then is Checking again until it ends. Each of those
  // steps is short, so whether the line shows it depends on how long Checking has been up: only
  // their order holds.
  expect(names.slice(0, names.indexOf("checking"))).not.toContain("checking-claims");
  const own = names
    .filter((step) => step !== "checking-claims")
    .filter((step, index, all) => step !== all[index - 1]);
  expect(own.slice(-2)).toEqual(["writing", "checking"]);
  const between = own.slice(1, -2);
  expect(between.length).toBeGreaterThan(0);
  for (const step of between) expect(["thinking", "searching"]).toContain(step);
  const line = answer.getByTestId("answer-steps");
  await expect(line).toHaveText("Searched All Documents · 1 source");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await expect(answer.getByTestId("answer-timeline")).toHaveCount(0);
  await screenshot(window, "steps-folded-en");
  await app.close();
});

/** What the latest Answer being written shows, as it changes: its step line alone, with the wait, then its text. */
async function watchWait(window: Page): Promise<() => Promise<string[]>> {
  await window.evaluate(() => {
    const shown: string[] = [];
    (globalThis as unknown as { shownWaits: string[] }).shownWaits = shown;
    const record = () => {
      const assistant = document.querySelector('[data-testid="assistant"]');
      const answer = [
        ...(assistant?.querySelectorAll('[data-testid="assistant-answer"]') ?? []),
      ].at(-1);
      const text = answer?.querySelector('[data-testid="assistant-answer-text"]')?.textContent;
      const state = text?.trim()
        ? "text"
        : answer?.querySelector('[data-testid="answer-steps-wait"]')
          ? "wait"
          : answer?.querySelector('[data-testid="answer-steps-live"]')
            ? "line"
            : "none";
      if (shown.at(-1) !== state) shown.push(state);
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  return () =>
    window.evaluate(() => (globalThis as unknown as { shownWaits: string[] }).shownWaits);
}

/** Asks slowly in the assistant, as a person does, without waiting for the Answer. */
async function askSlowly(window: Page, question: string): Promise<void> {
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
}

/** After the wait gave up the line, a step change brought it back onto the first row, joined. */
async function expectComeback(waits: () => Promise<AnswerWaitForm[]>, from: number): Promise<void> {
  const seen = (await waits()).slice(from);
  const row = seen.findIndex((each) => each.form === "row");
  expect(row).toBeGreaterThanOrEqual(0);
  const back = seen
    .slice(row + 1)
    .find((each) => each.form === "joined" && each.step !== seen[row]?.step);
  expect(back).toBeDefined();
  expect(back?.text.startsWith("· ")).toBe(true);
}

test("a slow Answer's step line takes the wait after 15 seconds, in English, and the composer's ■ is its one Stop", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startWithMinuteHistory();
  await setWindowSize(app, window, 900, 760);
  await setSilentWaitMs(window, 300);
  const shown = await watchWait(window);

  await askSlowly(window, "Where do neap tides come from? Answer slowly without searching.");
  const answer = assistantAnswers(window).last();
  const wait = answer.getByTestId("answer-steps-wait");
  // The wait joins the line itself: no second Stop, and no "Still working".
  await expect(wait).toHaveText(`· usually about a minute with ${MODEL_NAME}`);
  expect(await wait.evaluate((element) => element.textContent)).toBe(
    `· usually about a minute with ${MODEL_NAME}`,
  );
  await expect(answer.getByTestId("answer-steps-wait-row")).toHaveCount(0);
  await expect(answer.getByTestId("answer-steps-live")).toBeVisible();
  await expect(answer.getByTestId("answer-stop")).toHaveCount(0);
  await expect(answer).not.toContainText("Still working");
  await expect(window.getByTestId("composer-stop")).toBeVisible();
  await screenshot(window, "wait-joined-en");
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  const states = (await shown()).filter((state) => state !== "none");
  const lineAt = states.lastIndexOf("line");
  expect(lineAt).toBeGreaterThanOrEqual(0);
  expect(states.slice(lineAt)).toContain("wait");
  expect(states.at(-1)).toBe("text");
  await expect(wait).toHaveCount(0);
  await app.close();
});

test("before its 15 seconds the step line has no wait, and the composer's ■ stops the Answer", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startWithMinuteHistory();
  await setWindowSize(app, window, 900, 760);
  await setSilentWaitMs(window, 600_000);

  await askSlowly(window, "Where do neap tides come from? Answer slowly without searching.");
  const answer = assistantAnswers(window).last();
  await expect(answer.getByTestId("answer-steps-live")).toBeVisible();
  await expect(answer.getByTestId("answer-steps-wait")).toHaveCount(0);
  await expect(answer.getByTestId("answer-stop")).toHaveCount(0);
  await screenshot(window, "wait-before-en");
  await pointAndClick(window, window.getByTestId("composer-stop"));
  await expect(answer).toHaveAttribute("data-status", "stopped");
  await expect(answer.getByTestId("answer-stopped")).toHaveText("Stopped");
  await app.close();
});

test("in Chinese, the wait joins the step line in Chinese", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startWithMinuteHistory();
  await setWindowSize(app, window, 900, 760);
  await setSilentWaitMs(window, 300);
  await core(window).language("zh-CN");

  await askSlowly(window, "春潮什么时候出现？Answer slowly，不用搜索。");
  const answer = assistantAnswers(window).last();
  await expect(answer.getByTestId("answer-steps-wait")).toHaveText(
    `· 用 ${MODEL_NAME} 通常要 1 分钟左右`,
  );
  expect(
    await answer.getByTestId("answer-steps-wait").evaluate((element) => element.textContent),
  ).toBe(`· 用 ${MODEL_NAME} 通常要 1 分钟左右`);
  await expect(answer.getByTestId("answer-steps-wait-row")).toHaveCount(0);
  await screenshot(window, "wait-joined-zh");
  await pointAndClick(window, window.getByTestId("composer-stop"));
  await expect(answer).toHaveAttribute("data-status", "stopped");
  await app.close();
});

/** Three Answers by `model` that each took 62 seconds to their words, then the app again over the same data. */
async function startWithMinuteHistory(model?: string) {
  const first = await start(model ? { model } : {});
  await core(first.window).mind("Lit review: tides");
  for (const question of [
    "When do spring tides happen?",
    "When do neap tides happen?",
    "Why are there two tides a day?",
  ]) {
    await ask(first.window, question);
  }
  await first.app.close();
  await answersTookAboutAMinute(dataDir);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1440, 900);
  await setSilentWaitMs(window, 600);
  await pointAndClick(window, window.getByTestId("mind-list-item"));
  return { app, window };
}

test("at the default 320px assistant the wait joins in its first fitting form, in English and Chinese, and the whole sentence stays in the tooltip", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startWithMinuteHistory();
  await addTideConnector(window);
  const languages = [
    [
      "en",
      "When do spring tides happen? Please lookup_tide slowly",
      "Searching",
      "Usually about a minute",
      `· usually about a minute with ${MODEL_NAME}`,
    ],
    [
      "zh-CN",
      "春潮什么时候出现？Please lookup_tide slowly",
      "正在搜索",
      "通常要 1 分钟左右",
      `· 用 ${MODEL_NAME} 通常要 1 分钟左右`,
    ],
  ] as const;
  const waits = await watchAnswerWaits(window);

  for (const [index, [language, question, searching, short, whole]] of languages.entries()) {
    const from = (await waits()).length;
    await core(window).language(language);
    await askSlowly(window, question);
    if (index === 0) {
      const consent = window.getByTestId("consent-dialog");
      await expect(consent).toBeVisible({ timeout: 15_000 });
      await pointAndClick(window, consent.getByTestId("consent-allow"));
    }
    const answer = assistantAnswers(window).last();
    const live = answer.getByTestId("answer-steps-live");
    const words = live.getByTestId("answer-writing");
    const wait = answer.getByTestId("answer-steps-wait");
    // The search step's words leave no room for the model's name: the short wait takes the second row.
    await expect(live).toHaveAttribute("data-step", "searching", { timeout: 30_000 });
    await expect(words).toContainText(searching, { timeout: 30_000 });
    await expect(wait).toHaveText(short, { timeout: 30_000 });
    await expect(answer.getByTestId("answer-steps-wait-row")).toHaveCount(1);
    await expect(answer.getByTestId("answer-steps-wait-spoken")).toHaveText(whole);
    await expect.poll(async () => (await live.getAttribute("title")) ?? "").toContain(whole);
    await expect(answer.getByTestId("answer-stop")).toHaveCount(0);
    expect(await words.evaluate((step) => step.scrollWidth <= step.clientWidth + 1)).toBe(true);
    expect(await live.evaluate((line) => line.scrollWidth <= line.clientWidth + 1)).toBe(true);
    await screenshot(window, `wait-320-${language}`);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    await expectComeback(waits, from);
  }
  await app.close();
});

test("the wait keeps the form that fits as the steps change, and the summary keeps the first row, in English and Chinese", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startWithMinuteHistory();
  await addTideConnector(window);
  const languages = [
    [
      "en",
      430,
      "When do spring tides happen? Please lookup_tide slowly",
      "· usually about a minute",
      `· usually about a minute with ${MODEL_NAME}`,
    ],
    [
      "zh-CN",
      380,
      "春潮什么时候出现？Please lookup_tide slowly",
      "· 通常要 1 分钟左右",
      `· 用 ${MODEL_NAME} 通常要 1 分钟左右`,
    ],
  ] as const;
  const waits = await watchAnswerWaits(window);

  for (const [index, [language, width, question, short, whole]] of languages.entries()) {
    const from = (await waits()).length;
    await core(window).language(language);
    await sizeAssistant(window, width);
    await setSilentWaitMs(window, 300);
    await askSlowly(window, question);
    if (index === 0) {
      const consent = window.getByTestId("consent-dialog");
      await expect(consent).toBeVisible({ timeout: 15_000 });
      await pointAndClick(window, consent.getByTestId("consent-allow"));
    }
    const answer = assistantAnswers(window).last();
    const live = answer.getByTestId("answer-steps-live");
    const wait = answer.getByTestId("answer-steps-wait");
    // Thinking: the summary keeps the first row, and the wait takes the second in its own form.
    await expect(live).toHaveAttribute("data-step", "thinking", { timeout: 30_000 });
    const summary = live.getByTestId("answer-steps-summary");
    await expect(summary).toBeVisible({ timeout: 30_000 });
    // It keeps more than five of the dot's own widths: never cut to its dot.
    const dotWidth = await live
      .locator(".answer-steps-dot")
      .evaluate((element) => element.getBoundingClientRect().width);
    await expect
      .poll(() => summary.evaluate((element) => element.getBoundingClientRect().width), {
        timeout: 30_000,
      })
      .toBeGreaterThan(dotWidth * 5);
    const alone = short.replace(/^· /, "").replace(/^./, (letter) => letter.toUpperCase());
    await expect(wait).toHaveText(alone, { timeout: 30_000 });
    expect(await wait.evaluate((element) => element.textContent)).toBe(alone);
    await expect(answer.getByTestId("answer-steps-wait-row")).toHaveCount(1);
    await expect(wait).not.toContainText(MODEL_NAME);
    await expect(answer.getByTestId("answer-steps-wait-spoken")).toHaveText(whole);
    expect(
      await live
        .getByTestId("answer-writing")
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    // A shorter step frees the line: the wait comes back onto the first row, and the record shows it.
    await expectComeback(waits, from);
  }
  await app.close();
});

test("just above the whole wait's threshold the step's words stay whole, in English and Chinese", async () => {
  test.setTimeout(180_000);
  const { app, window } = await startWithMinuteHistory();
  const languages = [
    ["en", 430, "Thinking"],
    ["zh-CN", 380, "正在思考"],
  ] as const;

  for (const [language, width, thinking] of languages) {
    await core(window).language(language);
    await sizeAssistant(window, width);
    await setSilentWaitMs(window, 300);
    await askSlowly(
      window,
      language === "en"
        ? "Where do neap tides come from? Answer slowly without searching."
        : "春潮什么时候出现？Answer slowly，不用搜索。",
    );
    const answer = assistantAnswers(window).last();
    const live = answer.getByTestId("answer-steps-live");
    const words = live.getByTestId("answer-writing");
    await expect(words).toContainText(thinking);
    await expect(answer.getByTestId("answer-steps-wait")).toBeVisible();
    expect(await words.evaluate((step) => step.scrollWidth <= step.clientWidth + 1)).toBe(true);
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  }
  await app.close();
});

test("a long model name keeps the step's words whole on one line, and the whole sentence in the tooltip", async () => {
  test.setTimeout(180_000);
  const long = "claude-haiku-5-5-with-a-very-long-experimental-identifier-20261016";
  const { app, window } = await startWithMinuteHistory(long);
  await setWindowSize(app, window, 900, 760);
  await setSilentWaitMs(window, 300);
  await askSlowly(window, "Where do neap tides come from? Answer slowly without searching.");
  const answer = assistantAnswers(window).last();
  const live = answer.getByTestId("answer-steps-live");
  const words = live.getByTestId("answer-writing");
  const wait = answer.getByTestId("answer-steps-wait");
  const whole = `· usually about a minute with ${long}`;
  await expect(wait).toBeVisible();
  await expect(wait).not.toContainText(long);
  await expect(answer.getByTestId("answer-steps-wait-spoken")).toHaveText(whole);
  await expect.poll(async () => (await live.getAttribute("title")) ?? "").toContain(whole);
  expect(await words.evaluate((step) => step.getClientRects().length)).toBe(1);
  expect(await words.evaluate((step) => step.scrollWidth <= step.clientWidth + 1)).toBe(true);
  expect(await live.evaluate((line) => line.scrollWidth <= line.clientWidth + 1)).toBe(true);
  await screenshot(window, "wait-long-name");
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await app.close();
});

test("the folded line opens by click, Enter and Space, at once, to the reasoning, the Mind read, the search and its source, and the check; the source opens beside the Mind", async () => {
  const { app, window } = await start();
  await core(window).mind("Moon notes");
  await core(window).mind("Lit review: tides");
  const answer = await ask(window, "When do spring tides happen?");
  const line = answer.getByTestId("answer-steps");

  // A click opens it, with nothing moving: the chevron turns down.
  await pointAndClick(window, line);
  await expect(line).toHaveAttribute("aria-expanded", "true");
  const timeline = answer.getByTestId("answer-timeline");
  await expect(timeline).toBeVisible();
  expect(await answer.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await stepsOf(timeline)).toEqual([
    "reasoning",
    "read",
    "read-documents",
    "search",
    "check",
  ]);
  const reasoning = timeline.locator('[data-step="reasoning"]');
  await expect(reasoning).toContainText(new RegExp(`^${MODEL_NAME} thought for \\d+s`));
  await expect(reasoning.getByTestId("answer-reasoning")).toContainText(
    "When do spring tides happen?",
  );
  await expect(reasoning.getByTestId("answer-reasoning-more")).toHaveCount(0);
  await expect(timeline.locator('[data-step="read"]')).toHaveText("Read “Lit review: tides”");
  // The Documents sent whole with the Question are read too, a search or not.
  await expect(timeline.locator('[data-step="read-documents"]')).toContainText("Read “Tides”");
  const search = timeline.locator('[data-step="search"]');
  await expect(search).toContainText("Searched All Documents for “When do spring tides happen?”");
  await expect(search.getByTestId("answer-step-found")).toContainText(/passages? found, 1 used/);
  const source = search.getByTestId("answer-step-source");
  await expect(source).toHaveCount(1);
  await expect(source).toHaveText("Tidesp. 2");
  await expect(timeline.locator('[data-step="check"]')).toHaveText(
    "Citation check: 1 Citation against its source · found",
  );
  await expect(answer.getByTestId("answer-regenerate")).toBeVisible();
  await screenshot(window, "steps-open-en");

  // Enter and Space fold and open it again.
  await line.focus();
  await window.keyboard.press("Enter");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  await expect(timeline).toHaveCount(0);
  await window.keyboard.press("Space");
  await expect(line).toHaveAttribute("aria-expanded", "true");
  await expect(timeline).toBeVisible();

  // The source opens its Document beside the Mind, at its page, the quote washed.
  await pointAndClick(window, source);
  await expect(window.getByTestId("viewer-title")).toHaveText("Tides");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("2");
  await expect(
    window.getByTestId("viewer").locator('[data-page-number="2"] [data-quote-highlight]'),
  ).toHaveText([SPRING]);
  const groups = window.getByTestId("tab-group");
  await expect(
    groups.first().getByTestId("mind-tab").filter({ hasText: "Lit review: tides" }),
  ).toHaveAttribute("aria-selected", "true");

  // Read goes to that Mind's tab.
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Moon notes" }),
  );
  await expect(frontMindName(window)).toHaveText("Moon notes");
  await pointAndClick(window, timeline.getByTestId("answer-step-read"));
  await expect(frontMindName(window)).toHaveText("Lit review: tides");
  await app.close();
});

test("a sentence its quote doesn't support loses its green check, and the check step says it needs a look, in English and Chinese (#2311)", async () => {
  const { app, window } = await start();
  await core(window).mind("Lit review: tides");
  const kept = await ask(window, "When do spring tides happen?");
  await expect(kept.getByTestId("citation")).toHaveAttribute("data-check", "found");

  const beyond = await ask(window, "When do spring tides happen, beyond its quote?");
  await expect(beyond.getByTestId("citation")).toHaveAttribute("data-check", "unsupported");
  await pointAndClick(window, beyond.getByTestId("answer-steps"));
  await expect(beyond.getByTestId("answer-timeline").locator('[data-step="check"]')).toHaveText(
    "Citation check: 1 Citation against its source · 1 needs a look",
  );
  await screenshot(window, "beyond-its-quote-en");

  await core(window).language("zh-CN");
  const chinese = await ask(window, "spring tides 什么时候出现？超出引文");
  await expect(chinese.getByTestId("citation")).toHaveAttribute("data-check", "unsupported");
  await pointAndClick(window, chinese.getByTestId("answer-steps"));
  await expect(chinese.getByTestId("answer-timeline").locator('[data-step="check"]')).toHaveText(
    "引用核对：1 处引用和原文对照 · 1 处需要留意",
  );
  await screenshot(window, "beyond-its-quote-zh");
  await app.close();
});

test("in Chinese, the line and the timeline; after a restart the steps are still there, folded", async () => {
  const first = await start();
  let { window } = first;
  await core(window).mind("Lit review: tides");
  let answer = await ask(window, "When do spring tides happen?");
  // Kept in the Mind, so its link leads back to the conversation after the restart.
  await pointAt(window, answer.getByTestId("assistant-answer-text"));
  await pointAndClick(window, answer.getByTestId("answer-add"));
  await expect(answer.getByTestId("answer-added")).toBeVisible();
  await core(window).language("zh-CN");
  await expect(answer.getByTestId("answer-steps")).toHaveText("已搜索全部文档 · 1 个来源");
  let timeline = await openSteps(window, answer);
  await expect(timeline.locator('[data-step="reasoning"]')).toContainText(
    new RegExp(`^${MODEL_NAME} 思考了 \\d+ 秒`),
  );
  await expect(timeline.locator('[data-step="read"]')).toHaveText("读了“Lit review: tides”");
  await expect(timeline.locator('[data-step="search"]')).toContainText(
    "在全部文档中搜索“When do spring tides happen?”",
  );
  await expect(timeline.getByTestId("answer-step-found")).toContainText("用了 1 段");
  await expect(timeline.locator('[data-step="check"]')).toHaveText(
    "引用核对：1 处引用和原文对照 · 找到了",
  );
  await expect(answer.getByTestId("answer-regenerate")).toHaveText("重新生成");
  await screenshot(window, "steps-open-zh");
  const summary = await timeline.getByTestId("answer-reasoning").textContent();
  await first.app.close();

  const second = await launchApp(dataDir, { fakeChat: true });
  window = second.window;
  await setWindowSize(second.app, window, 1440, 900);
  await pointAndClick(window, window.getByTestId("mind-list-item"));
  await (
    await slideToHandle(window, window.getByTestId("mind-editor").locator(":scope > *").first())
  ).click();
  await pointAndClick(window, window.getByTestId("block-menu-open-conversation"));
  answer = assistantAnswers(window).first();
  const line = answer.getByTestId("answer-steps");
  await expect(line).toHaveText("已搜索全部文档 · 1 个来源");
  await expect(line).toHaveAttribute("aria-expanded", "false");
  timeline = await openSteps(window, answer);
  expect(await stepsOf(timeline)).toEqual([
    "reasoning",
    "read",
    "read-documents",
    "search",
    "check",
  ]);
  await expect(timeline.getByTestId("answer-reasoning")).toHaveText(summary ?? "");
  await second.app.close();
});

test("an Answer whose Citations are all from a Document given with the Question names that Document beside the Mind it read, in the line and the timeline, in English and Chinese", async () => {
  const { app, window } = await start({ documents: false });
  await writeFile(join(sources, "Lease 2026.pdf"), LEASE);
  await addDocuments(window, [join(sources, "Lease 2026.pdf")]);
  await core(window).mind("Credit report draft");
  const answer = await ask(
    window,
    "What are the term, monthly rent and deposit in the lease? Answer without searching.",
  );

  const line = answer.getByTestId("answer-steps-line");
  await expect(line).toHaveText("Read “Credit report draft” and “Lease 2026”");
  await expect(answer.getByTestId("answer-steps")).toHaveAttribute("data-kind", "read-documents");
  const timeline = await openSteps(window, answer);
  expect(await stepsOf(timeline)).toEqual(["answered", "read", "read-documents", "check"]);
  await expect(timeline.locator('[data-step="read"]')).toHaveText("Read “Credit report draft”");
  const read = timeline.locator('[data-step="read-documents"]');
  await expect(read).toContainText("Read “Lease 2026”");
  const source = read.getByTestId("answer-step-source");
  await expect(source).toHaveText("Lease 2026p. 1");
  await screenshot(window, "steps-read-documents-en");

  await core(window).language("zh-CN");
  await expect(line).toHaveText("读了“Credit report draft”，还读了“Lease 2026”");
  await expect(read).toContainText("读了“Lease 2026”");
  await screenshot(window, "steps-read-documents-zh");

  // The Mind's name stays the button that opens it.
  await core(window).mind("Moon notes");
  await pointAndClick(window, answer.getByTestId("answer-steps-mind"));
  await expect(frontMindName(window)).toHaveText("Credit report draft");

  // Like a search's source, it opens its Document beside the Mind, at its page.
  await pointAndClick(window, source);
  await expect(window.getByTestId("viewer-title")).toHaveText("Lease 2026");
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("1");
  await app.close();
});

test("Documents sent whole are read whether or not the Answer cites them: the line counts them beside the Mind", async () => {
  const { app, window } = await start({ documents: false });
  await writeFile(join(sources, "Lease 2026.pdf"), LEASE);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Lease 2026.pdf"), join(sources, "Tides.pdf")]);
  await core(window).mind("Credit report draft");
  const answer = await ask(
    window,
    "What is the monthly rent in the lease? Answer without searching and without citing.",
  );
  await expect(answer.getByTestId("citation-chip")).toHaveCount(0);

  const line = answer.getByTestId("answer-steps-line");
  await expect(line).toHaveText("Read “Credit report draft” and 2 Documents");
  // In the narrowest assistant the Note's name gives way and the count stays whole.
  await sizeAssistant(window, 280);
  const tail = line.locator(".answer-steps-tail");
  await expect(tail).toHaveText("” and 2 Documents");
  expect(
    await tail.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "the count is drawn whole",
  ).toBe(true);
  const timeline = await openSteps(window, answer);
  expect(await stepsOf(timeline)).toEqual(["answered", "read", "read-documents"]);
  const read = timeline.locator('[data-step="read-documents"]');
  await expect(read).toContainText("Read 2 Documents");
  await expect(read.getByTestId("answer-step-source")).toHaveCount(0);

  await core(window).language("zh-CN");
  await expect(line).toHaveText("读了“Credit report draft”，还读了 2 个文档");
  await expect(read).toContainText("读了 2 个文档");
  await app.close();
});

const EXAMPLE_LINES = {
  en: {
    note: "Draft: credit committee paper",
    question: "What is the monthly rent in the lease? Answer without searching and without citing.",
    line: "Read “Draft: credit committee paper”, 2 of your Documents and 2 example Documents",
    row: "Read 2 of your Documents and 2 example Documents",
  },
  "zh-CN": {
    note: "授信委员会报告（草稿）",
    question: "租赁合同里的月租金是多少？不用搜索，也不用引用。",
    line: "读了“授信委员会报告（草稿）”、你的 2 个文档和 2 个示例文档",
    row: "读了你的 2 个文档和 2 个示例文档",
  },
} as const;

for (const language of ["en", "zh-CN"] as const) {
  test(`asked from the example's Note, the line counts the User's two Documents as the sidebar does, and the example's apart (${language})`, async () => {
    test.setTimeout(180_000);
    const words = EXAMPLE_LINES[language];
    const { app, window } = await start({ documents: false, examples: true });
    await core(window).language(language);
    await expect(window.getByTestId("mind-editor")).toContainText(words.note);
    await expect
      .poll(
        () =>
          window.evaluate(async () => {
            const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const { linkedFolderId } = await bridge.getExamples();
            const read = (await bridge.listDocuments()).filter(
              (each) => each.linkedFolderId === linkedFolderId && each.status === "ready",
            );
            return read.length;
          }),
        { timeout: 60_000 },
      )
      .toBe(2);
    await writeFile(join(sources, "Lease 2026.pdf"), LEASE);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    await addDocuments(window, [join(sources, "Lease 2026.pdf"), join(sources, "Tides.pdf")]);
    await expect(
      window.getByTestId("not-in-a-folder-section").getByTestId("sidebar-section-count"),
    ).toHaveText("2");

    const answer = await ask(window, words.question);

    // The scripted model searches in English though all four Documents went with the Question, so
    // only the Chinese line folds to what was read; the timeline's row names it in both.
    if (language === "zh-CN") {
      await expect(answer.getByTestId("answer-steps-line")).toHaveText(words.line);
    }
    const timeline = await openSteps(window, answer);
    await expect(timeline.locator('[data-step="read-documents"]')).toContainText(words.row);
    await app.close();
  });
}

test("at a 320px assistant a long Mind title and a long Document name are cut, the line stays on one line inside the Answer, and the whole line is its tooltip", async () => {
  const { app, window } = await start({ documents: false });
  const name = "Lease agreement for the north wing of the harbour offices 2026";
  await writeFile(join(sources, `${name}.pdf`), LEASE);
  await addDocuments(window, [join(sources, `${name}.pdf`)]);
  await core(window).mind(LONG_FOLDER);
  expect(Math.round((await window.getByTestId("assistant").boundingBox())?.width ?? 0)).toBe(320);
  const answer = await ask(
    window,
    "What is the monthly rent in the lease? Answer without searching.",
  );

  const line = answer.getByTestId("answer-steps-line");
  const whole = `Read “${LONG_FOLDER}” and “${name}”`;
  await expect(line).toHaveAttribute("title", whole);
  const box = await line.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(30);
  const edge = await answer.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    (edge?.x ?? 0) + (edge?.width ?? 0),
  );
  expect(await line.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  // The chevron is still on the line.
  const chevron = await line.locator(".answer-steps-chevron").boundingBox();
  expect((chevron?.x ?? 0) + (chevron?.width ?? 0)).toBeLessThanOrEqual(
    (box?.x ?? 0) + (box?.width ?? 0) + 1,
  );
  await screenshot(window, "steps-read-documents-narrow-en");

  await core(window).language("zh-CN");
  await expect(line).toHaveAttribute("title", `读了“${LONG_FOLDER}”，还读了“${name}”`);
  expect((await line.boundingBox())?.height ?? 0).toBeLessThan(30);
  await app.close();
});

test("with a Chinese lease and the Chinese interface, the line names 租赁合同-2026 beside the open Mind, and a Mind with no lease says only that it read the Mind", async () => {
  const { app, window } = await start({ documents: false });
  await core(window).language("zh-CN");
  await core(window).mind("授信委员会报告（草稿）");
  const before = await ask(window, "春潮什么时候出现？");
  await expect(before.getByTestId("answer-steps-line")).toHaveText("读了“授信委员会报告（草稿）”");

  await writeFile(join(sources, "租赁合同-2026.txt"), LEASE_ZH);
  await addDocuments(window, [join(sources, "租赁合同-2026.txt")]);
  const answer = await ask(window, "租赁合同-2026 里的租期、月租金和押金分别是多少？不用搜索");
  await expect(answer.getByTestId("answer-steps-line")).toHaveText(
    "读了“授信委员会报告（草稿）”，还读了“租赁合同-2026”",
  );
  const timeline = await openSteps(window, answer);
  expect(await stepsOf(timeline)).toEqual(["answered", "read", "read-documents", "check"]);
  await expect(timeline.locator('[data-step="read-documents"]')).toContainText(
    "读了“租赁合同-2026”",
  );
  await expect(timeline.getByTestId("answer-step-source")).toContainText("租赁合同-2026");
  await app.close();
});

test("a search that finds nothing says nothing was found, and names no Document or Mind as read, in English and Chinese", async () => {
  const { app, window } = await start();
  await core(window).mind("Lit review: tides");
  const answer = await ask(window, "Quokka zebra?");

  const line = answer.getByTestId("answer-steps");
  await expect(line).toHaveText("Searched All Documents · nothing found");
  const timeline = await openSteps(window, answer);
  expect(await stepsOf(timeline)).toEqual(["reasoning", "read", "read-documents", "search"]);
  await expect(timeline.getByTestId("answer-step-found")).toHaveText("0 passages found, 0 used");
  await expect(timeline.getByTestId("answer-step-source")).toHaveCount(0);

  await core(window).language("zh-CN");
  await expect(line).toHaveText("已搜索全部文档 · 没有找到相关内容");
  await app.close();
});

test("an empty conversation says once what it reads and searches, following focus; nothing under the header, and only Copy · Add to note under an Answer", async () => {
  const { app, window } = await start();
  const thread = window.getByTestId("assistant-thread");
  await core(window).mind("Alpha");
  const reads = window.getByTestId("assistant-reads");
  await expect(reads).toHaveText("Reads “Alpha” and All Documents");
  // In the conversation, above its words: the header has nothing under it.
  await expect(thread.getByTestId("assistant-reads")).toBeVisible();
  const header = await window.getByTestId("assistant-header").boundingBox();
  const threadBox = await thread.boundingBox();
  expect((threadBox?.y ?? 0) - ((header?.y ?? 0) + (header?.height ?? 0))).toBeLessThan(2);
  await expect(reads).toHaveCSS("font-size", "14px");
  await expect(window.getByTestId("assistant-empty")).toHaveCSS("font-size", "14px");
  await core(window).mind("Beta");
  await expect(reads).toHaveText("Reads “Beta” and All Documents");
  await pointAndClick(window, window.getByTestId("open-library"));
  await expect(reads).toHaveText("Searches All Documents");
  await screenshot(window, "steps-empty-en");

  // Asked: the line goes; under the Answer, Write as a note, Add to note (naming the empty Mind) and Copy.
  await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: "Beta" }));
  const answer = await ask(window, "When do spring tides happen?");
  await expect(reads).toHaveCount(0);
  await window.mouse.move(10, 10);
  const actions = answer.getByTestId("answer-actions");
  await expect(actions).toHaveText("Write as a noteAdd to “Beta”Copy");
  await expect(actions).not.toContainText(MODEL_NAME);
  await expect(answer.getByTestId("answer-copy")).toHaveCSS("font-size", "13px");
  await expect(answer.getByTestId("answer-copy")).toHaveCSS("font-weight", "400");
  await app.close();
});

test("at a 320px assistant the folded line is cut, never wrapped, in English and Chinese; the reasoning shows Show more only when it is longer than three lines; one reading size", async () => {
  const { app, window } = await start();
  const folder = await core(window).folderOfAll(LONG_FOLDER);
  await core(window).mind("Night cooling", { id: folder, name: LONG_FOLDER });
  expect(Math.round((await window.getByTestId("assistant").boundingBox())?.width ?? 0)).toBe(320);
  const answer = await ask(window, "When do spring tides happen?");
  const line = answer.getByTestId("answer-steps");
  const full = `Searched “${LONG_FOLDER}” · 1 source`;
  await expect(line).toHaveAttribute("title", full);
  const cut = async () => {
    const box = await line.boundingBox();
    expect(box?.height ?? 0).toBeLessThan(30);
    expect(
      await line
        .locator(".answer-steps-text")
        .evaluate((text) => text.scrollWidth > text.clientWidth),
    ).toBe(true);
  };
  await cut();
  // One reading size: the Question, the Answer, the steps are 14px; the note stays larger.
  await expect(
    window.getByTestId("assistant-question").locator(".assistant-question-bubble"),
  ).toHaveCSS("font-size", "14px");
  await expect(answer.locator(".assistant-answer-text p").first()).toHaveCSS("font-size", "14px");
  await expect(answer.locator(".assistant-answer-text p").first()).toHaveCSS("line-height", "22px");
  await expect(line).toHaveCSS("font-size", "14px");
  const timeline = await openSteps(window, answer);
  await expect(timeline).toHaveCSS("font-size", "14px");
  // A short reasoning shows whole.
  await expect(timeline.getByTestId("answer-reasoning-more")).toHaveCount(0);
  await screenshot(window, "steps-narrow-en");

  await core(window).language("zh-CN");
  await expect(line).toHaveAttribute("title", `已搜索“${LONG_FOLDER}” · 1 个来源`);
  await cut();
  await screenshot(window, "steps-narrow-zh");
  await core(window).language("en");

  // A long one is cut at three lines, with Show more, which shows it whole.
  const long = await ask(
    window,
    "When do spring tides happen, how much higher do they rise than neap tides along the coast, and does the Sun's pull add to the Moon's at new and full moon in every harbour?",
  );
  const steps = await openSteps(window, long);
  const reasoning = steps.getByTestId("answer-reasoning");
  const more = steps.getByTestId("answer-reasoning-more");
  await expect(more).toHaveText("Show more");
  const lineHeight = 20;
  expect((await reasoning.boundingBox())?.height ?? 0).toBeLessThanOrEqual(3 * lineHeight + 1);
  await pointAndClick(window, more);
  await expect(more).toHaveText("Show less");
  expect((await reasoning.boundingBox())?.height ?? 0).toBeGreaterThan(3 * lineHeight + 1);
  await screenshot(window, "steps-show-more-en");
  await app.close();
});

test("past three sources, +N more shows the rest, and each source names its Document and where", async () => {
  const { app, window } = await start({ documents: false });
  const places = ["Brest", "Dover", "Calais", "Leeds", "Hull"];
  for (const place of places) {
    await writeFile(
      join(sources, `${place}.md`),
      `# ${place}\n\nSpring tides at ${place} rise high.`,
    );
  }
  await addDocuments(
    window,
    places.map((place) => join(sources, `${place}.md`)),
  );
  await core(window).mind("Harbours");
  // "Each": the scripted model cites every Document its search found.
  const answer = await ask(window, "How high do spring tides rise at each harbour?");
  // Its search finds more than three of them: each cited is a source.
  const line = await answer.getByTestId("answer-steps").textContent();
  const cited = Number(/· (\d+) sources$/.exec(line ?? "")?.[1]);
  expect(cited).toBeGreaterThan(3);
  const timeline = await openSteps(window, answer);
  const listed = timeline.getByTestId("answer-step-source");
  await expect(listed).toHaveCount(3);
  await expect(listed.first()).toContainText(/^(Brest|Dover|Calais|Leeds|Hull)\S/);
  const more = timeline.getByTestId("answer-step-sources-more");
  await expect(more).toHaveText(`+${cited - 3} more`);
  await pointAndClick(window, more);
  await expect(listed).toHaveCount(cited);
  await expect(more).toHaveCount(0);
  await app.close();
});

test("past twelve Documents, Claude Haiku 5.5 answers a Question asked again in its Note with each Citation checked, and searches again when its Passages fall short; in the assistant it searches first itself", async () => {
  const { app, window } = await start({ documents: false });
  // Thirteen Documents: more than go whole with a Question, so the Answer searches.
  const harbours = ["Brest", "Dover", "Calais"];
  const files = [
    ...harbours.map((place) => ({
      name: `${place}.md`,
      text: `# ${place}\n\nSpring tides at ${place} rise high.`,
    })),
    ...Array.from({ length: 10 }, (_, at) => ({
      name: `Recipe ${at + 1}.md`,
      text: `# Recipe ${at + 1}\n\nCream the butter and the sugar.`,
    })),
  ];
  for (const file of files) await writeFile(join(sources, file.name), file.text);
  await addDocuments(
    window,
    files.map((file) => join(sources, file.name)),
  );

  // A Question in a Note written before the assistant, asked again with Enter: no Tool that
  // writes Notes is offered there.
  const askAgainIn = async (title: string, question: string) => {
    await mindWrittenBefore(window, title, [{ question, answer: "Not yet." }]);
    await pointAndClick(window, window.getByTestId("mind-list-item").filter({ hasText: title }));
    const editor = window.getByTestId("mind-editor");
    await pointAndClick(window, editor.getByTestId("question").locator(".question-text"));
    await window.keyboard.press("End");
    await window.keyboard.press("Enter");
    const answer = editor.getByTestId("answer");
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
    return answer.getByTestId("citation");
  };
  const each = await askAgainIn("Harbours", "How high do spring tides rise at each harbour?");
  await expect(each).toHaveCount(3);
  for (const citation of await each.all()) {
    await expect(citation).toHaveAttribute("data-check", "found");
  }
  const twice = await askAgainIn("Dover", "When do spring tides rise at Dover? Search twice.");
  await expect(twice).toHaveAttribute("data-check", "found");

  const inAssistant = await ask(window, "How high do spring tides rise at each harbour?");
  const timeline = await openSteps(window, inAssistant);
  await expect(timeline.locator('[data-step="search"]')).toContainText(
    "Searched All Documents for “How high do spring tides rise at each harbour?”",
  );
  await app.close();
});

test("a Connector call waiting for approval: the line says so, its card waits outside the steps, and allowing it carries the steps on", async () => {
  const { app, window } = await start({ documents: false, local: true });
  await addTideConnector(window);
  await core(window).mind("Boat trips");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Please book_boat from Dover");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).first();
  const card = answer.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const live = answer.getByTestId("answer-steps-live");
  await expect(live).toHaveAttribute("data-step", "waiting");
  await expect(live).toHaveText("Waiting for your approval");
  await expect(live.locator(".answer-steps-dot--waiting")).toBeVisible();
  // The card is under the line, never inside the steps.
  await expect(answer.getByTestId("answer-timeline")).toHaveCount(0);
  const lineBox = await live.boundingBox();
  const cardBox = await card.boundingBox();
  expect(cardBox?.y ?? 0).toBeGreaterThan((lineBox?.y ?? 0) + (lineBox?.height ?? 0));
  await screenshot(window, "steps-approval-en");

  await pointAndClick(window, card.getByTestId("approval-allow-once"));
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  const timeline = await openSteps(window, answer);
  // No search: the folded line says the Mind read, so the timeline doesn't.
  expect(await stepsOf(timeline)).toEqual(["answered", "call"]);
  await expect(timeline.getByTestId("answer-connector-call")).toHaveAttribute(
    "data-approval",
    "allowed",
  );
  await app.close();
});

interface StepsFrame {
  rows: { step: string | null; running: boolean; title: string | null; reasoning: string | null }[];
  summary: string | null;
  elapsed: string | null;
}

/** The open steps and the live line's summary, each time they change, from now on. */
async function watchSteps(window: Page): Promise<() => Promise<StepsFrame[]>> {
  await window.evaluate(() => {
    const frames: StepsFrame[] = [];
    (globalThis as unknown as { stepFrames: StepsFrame[] }).stepFrames = frames;
    const record = () => {
      const assistant = document.querySelector('[data-testid="assistant"]');
      const rows = [
        ...(assistant?.querySelectorAll(
          '[data-testid="answer-timeline"] > [data-testid="answer-step"]',
        ) ?? []),
      ].map((row) => ({
        step: row.getAttribute("data-step"),
        running:
          row.hasAttribute("data-running") || row.querySelector('[data-status="running"]') !== null,
        title: row.querySelector(".answer-step-title")?.textContent ?? null,
        reasoning: row.querySelector('[data-testid="answer-reasoning"]')?.textContent ?? null,
      }));
      const summary =
        assistant?.querySelector('[data-testid="answer-steps-summary"]')?.textContent ?? null;
      const elapsed =
        assistant?.querySelector('[data-testid="answer-steps-elapsed"]')?.textContent ?? null;
      const last = frames.at(-1);
      if (last && JSON.stringify(last) === JSON.stringify({ rows, summary, elapsed })) return;
      frames.push({ rows, summary, elapsed });
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  return () =>
    window.evaluate(() => (globalThis as unknown as { stepFrames: StepsFrame[] }).stepFrames);
}

const QUESTION_WITH_A_SLOW_CALL = "When do spring tides happen? Please lookup_tide slowly";

test("the steps open while the Answer is written: the thinking row grows with its summary, a running call is marked, rows are only added at the end, and they stay open to the end", async () => {
  const { app, window } = await start();
  await addTideConnector(window);
  await core(window).mind("Lit review: tides");
  const frames = await watchSteps(window);

  await askSlowly(window, QUESTION_WITH_A_SLOW_CALL);
  // What a Connector's call finds goes to the model only when the User allows it, once.
  const consent = window.getByTestId("consent-dialog");
  await expect(consent).toBeVisible({ timeout: 15_000 });
  await pointAndClick(window, consent.getByTestId("consent-allow"));
  const answer = assistantAnswers(window).last();
  const toggle = answer.getByTestId("answer-steps");
  await expect(answer).toHaveAttribute("data-status", "streaming");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await pointAndClick(window, toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const timeline = answer.getByTestId("answer-timeline");
  await expect(timeline).toBeVisible();
  // The model's row is first from the start, and the call it makes is marked while it runs.
  await expect(timeline.getByTestId("answer-step").first()).toHaveAttribute(
    "data-step",
    "reasoning",
  );
  await expect(
    timeline.locator('[data-testid="answer-connector-call"][data-status="running"]'),
  ).toBeVisible();
  await screenshot(window, "steps-open-running-en");

  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  // Opened mid-run, they are open still, and the Answer's folded line is the one that opens them.
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(timeline).toBeVisible();
  await expect(toggle).toContainText("Searched");

  const seen = await frames();
  const opened = seen.filter((frame) => frame.rows.length > 0);
  const kinds = opened.map((frame) => frame.rows.map((row) => row.step));
  // Only ever added to at the end: each state starts with the rows of the one before.
  for (const [index, now] of kinds.entries()) {
    const before = kinds[index - 1] ?? [];
    expect(now.slice(0, before.length)).toEqual(before);
  }
  expect(kinds[0]?.[0]).toBe("reasoning");
  expect(kinds.at(-1)).toEqual(
    expect.arrayContaining(["reasoning", "read", "call", "search", "check"]),
  );
  // The model's row pulses while it thinks (the scripted model reasons before its search), and
  // the line counts the seconds of a step that takes over two: the call takes three.
  expect(opened.some((frame) => frame.rows[0]?.running)).toBe(true);
  expect(seen.some((frame) => /^\d+s$/.test(frame.elapsed ?? ""))).toBe(true);
  // The call is a row while it runs, and the same row once it is done.
  const callAt = (frame: StepsFrame) => frame.rows.findIndex((row) => row.step === "call");
  const running = opened.find((frame) =>
    frame.rows.some((row) => row.step === "call" && row.running),
  );
  expect(running).toBeDefined();
  expect(opened.at(-1)?.rows[running ? callAt(running) : 0]?.running).toBe(false);
  // The summary grows: every state is the one before with more.
  const summaries = opened
    .map((frame) => frame.rows.find((row) => row.step === "reasoning")?.reasoning ?? "")
    .filter((text, index, all) => text !== "" && text !== all[index - 1]);
  expect(summaries.length).toBeGreaterThan(1);
  for (const [index, text] of summaries.entries()) {
    expect(text.startsWith(summaries[index - 1] ?? "")).toBe(true);
  }
  await app.close();
});

test("the live line shows the latest of the summary beside the step, out of the screen reader's way; folding the steps mid-run keeps them folded, and the line takes the keyboard", async () => {
  const { app, window } = await start();
  await core(window).mind("Lit review: tides");
  const frames = await watchSteps(window);

  await askSlowly(window, "When do spring tides happen? Answer slowly.");
  const answer = assistantAnswers(window).last();
  const live = answer.getByTestId("answer-steps-live");
  const toggle = answer.getByTestId("answer-steps");
  await expect(answer.getByTestId("answer-steps-summary")).toContainText("Answer slowly");
  await expect(live).toHaveAttribute("data-step", "thinking");
  await expect(live).toContainText("Thinking·");
  await expect(answer.getByTestId("answer-steps-summary")).toHaveAttribute("aria-hidden", "true");
  await expect(live).toHaveAttribute("role", "status");
  await screenshot(window, "steps-live-summary-en");

  // From the keyboard: Enter opens, Space folds, Enter opens again.
  await toggle.focus();
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(answer.getByTestId("answer-timeline")).toBeVisible();
  await window.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(answer.getByTestId("answer-timeline")).toHaveCount(0);
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The focus goes with it when the Answer is written.
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await window.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(answer.getByTestId("answer-timeline")).toHaveCount(0);

  // The summary line changed with the summary, and was never longer than the summary.
  const lines = (await frames())
    .map((frame) => frame.summary)
    .filter((text): text is string => text !== null);
  expect(lines.length).toBeGreaterThan(0);
  await app.close();
});

test("in Chinese, the live line and the thinking row say so, and the summary is the model's own", async () => {
  const { app, window } = await start();
  await core(window).mind("Lit review: tides");
  await core(window).language("zh-CN");
  const frames = await watchSteps(window);

  await askSlowly(window, "春潮什么时候出现？ Answer slowly.");
  const answer = assistantAnswers(window).last();
  await expect(answer.getByTestId("answer-steps-live")).toContainText("正在思考·");
  await pointAndClick(window, answer.getByTestId("answer-steps"));
  await expect(answer.getByTestId("answer-timeline")).toBeVisible();
  await screenshot(window, "steps-open-running-zh");
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });

  const first = (await frames())
    .map((frame) => frame.rows[0])
    .filter((row) => row?.step === "reasoning");
  expect(first.some((row) => row?.running && row.title === "正在思考…")).toBe(true);
  expect(first.some((row) => row?.reasoning?.includes("春潮什么时候出现"))).toBe(true);
  await expect(
    answer.getByTestId("answer-timeline").getByTestId("answer-step").first(),
  ).toContainText("思考了");
  await app.close();
});

test("a long Answer written with its steps opened stays where its reader is: at the foot", async () => {
  const { app, window } = await start();
  await core(window).mind("Lit review: tides");
  await setWindowSize(app, window, 1440, 760);
  await window.evaluate(() => {
    const scroller = document.querySelector('[data-testid="assistant-log"]')?.parentElement;
    const jumps: number[] = [];
    (globalThis as unknown as { jumps: number[] }).jumps = jumps;
    let before = scroller?.scrollTop ?? 0;
    scroller?.addEventListener("scroll", () => {
      jumps.push(before - scroller.scrollTop);
      before = scroller.scrollTop;
    });
  });

  await askSlowly(window, "What do tides do with forty citations");
  const answer = assistantAnswers(window).last();
  // A click gives the button the focus, which goes to the folded line when the Answer is written.
  await pointAndClick(window, answer.getByTestId("answer-steps"));
  await expect(answer.getByTestId("answer-timeline")).toBeVisible();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(answer.getByTestId("answer-steps")).toBeFocused();

  const thread = await window.evaluate(() => {
    const scroller = document.querySelector('[data-testid="assistant-log"]')?.parentElement;
    return {
      fromFoot:
        (scroller?.scrollHeight ?? 0) - (scroller?.scrollTop ?? 0) - (scroller?.clientHeight ?? 0),
      overflow: (scroller?.scrollHeight ?? 0) - (scroller?.clientHeight ?? 0),
      jumps: (globalThis as unknown as { jumps: number[] }).jumps,
    };
  });
  // It overflowed, so there was a foot to be taken from, and the Answer's end is in view.
  expect(thread.overflow).toBeGreaterThan(200);
  expect(thread.fromFoot).toBeLessThanOrEqual(2);
  expect(Math.max(...thread.jumps)).toBeLessThan(100);
  await app.close();
});
