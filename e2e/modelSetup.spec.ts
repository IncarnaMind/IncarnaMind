import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { createFakeAnthropic } from "../tests/helpers/fakeAnthropic";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  closeSettings,
  continueSetup,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  newMind,
  ollamaListing,
  openSettings,
  placeAssistant,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  showSettingsPage,
  tokenColor,
  urlsOpened,
  useLocalChatModel,
} from "./app";

/*
 * The first own Question with no model set (#103): it waits in the conversation while the
 * composer becomes the setup card, which leads with the ChatGPT plan and a key, the same size
 * (#890); the Question is then asked without being typed again.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("by mouse alone: the first own Question, Use my ChatGPT plan, and its Answer, with no consent dialog", async () => {
  const openai = await createFakeOpenAI();
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    chatGpt: openai.endpoints.issuer,
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is in my Documents?");
    await window.keyboard.press("Enter");

    const card = window.getByTestId("model-setup");
    await expect(card).toBeVisible();
    await expect(window.getByTestId("assistant-log")).toContainText("What is in my Documents?");
    await card.getByTestId("setup-chatgpt").click();
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [authorize] = await urlsOpened(app);
    expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
    await window.getByTestId("chatgpt-welcome-ok").click();

    await continueSetup(window);
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
  } finally {
    await app.close();
  }
});

/** Asks the first own Question in a new Mind; the setup card takes the composer's place. */
async function askFirstQuestion(window: Page) {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is in my Documents?");
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await expect(card).toBeVisible();
  return card;
}

const WORDS = {
  en: {
    title: "Choose your AI",
    chatgpt: "Plus or Pro · no key needed",
    sends: "Sends your questions and document text to OpenAI. · Details",
    key: "OpenAI, Anthropic, Google, DeepSeek, Kimi and more",
  },
  "zh-CN": {
    title: "选择你的 AI",
    chatgpt: "Plus 或 Pro（中国大陆不可用）· 无需密钥",
    sends: "会把你的问题和文档内容发送给 OpenAI。 · 详情",
    key: "DeepSeek、通义千问、Kimi、智谱 GLM 等",
  },
} as const;

/** At most `lines` lines of text, with room for rounding. */
async function expectLines(line: Locator, lines = 1): Promise<void> {
  const [box, lineHeight] = await Promise.all([
    line.boundingBox(),
    line.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight)),
  ]);
  if (!box) throw new Error("The line isn't laid out.");
  expect(box.height).toBeLessThan(lineHeight * (lines + 0.5));
}

for (const [width, height] of [
  [1100, 760],
  [1440, 900],
] as const) {
  test(`at ${width} px the card offers the ChatGPT plan and Paste an API key at the same size, each with a short line under it; in Chinese the key comes first`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      const card = await askFirstQuestion(window);
      for (const language of ["en", "zh-CN"] as const) {
        await setLanguage(window, language);
        const plan = card.getByTestId("setup-chatgpt");
        const key = card.getByTestId("setup-key");
        const words = WORDS[language];
        await expect(card.getByRole("heading", { level: 2 })).toHaveText(words.title);
        await expect(card.getByTestId("setup-chatgpt-line")).toHaveText(words.chatgpt);
        await expect(card.getByTestId("setup-chatgpt-sends").locator("p")).toHaveText(words.sends);
        await expect(card.getByTestId("setup-key-for")).toHaveText(words.key);
        if (width === 1440) {
          await expectLines(card.getByTestId("setup-chatgpt-line"));
          await expectLines(card.getByTestId("setup-key-for"), 2);
        }
        await expect(plan).toBeInViewport({ ratio: 1 });
        await expect(key).toBeInViewport({ ratio: 1 });
        const planBox = await plan.boundingBox();
        const keyBox = await key.boundingBox();
        const cardBox = await card.boundingBox();
        if (!planBox || !keyBox || !cardBox) throw new Error("The two ways aren't laid out.");
        expect(Math.abs(planBox.width - keyBox.width)).toBeLessThan(1);
        expect(Math.abs(planBox.height - keyBox.height)).toBeLessThan(1);
        for (const box of [planBox, keyBox]) {
          expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
        }
        const [first, second] = language === "en" ? [planBox, keyBox] : [keyBox, planBox];
        const sameRow = Math.abs(first.y - second.y) < 1;
        expect(sameRow ? second.x > first.x : second.y > first.y).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
}

for (const language of ["en", "zh-CN"] as const) {
  test(`after narrowing the window, Claude's notice, Details and key form remain reachable (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1440, 760);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      await pointAndClick(window, card.getByTestId("setup-other"));
      const row = card.getByTestId("way-claude");
      await pointAndClick(window, row.getByTestId("way-claude-open"));

      for (const width of [900, 1440]) {
        await setWindowSize(app, window, width, 760);
        const sends = row.getByTestId("claude-plan-sends");
        const details = sends.getByTestId("claude-plan-sends-details");
        await details.scrollIntoViewIfNeeded();
        await expect(details).toBeInViewport({ ratio: 1 });
        await pointAndClick(window, details);
        const items = sends.getByRole("listitem");
        await expect(items).toHaveCount(4);
        for (const item of [items.first(), items.last()]) {
          await item.scrollIntoViewIfNeeded();
          // Text can end a fraction of a pixel past the scroller's edge on Linux, still readable.
          await expect(item).toBeInViewport({ ratio: 0.99 });
        }
        const signIn = row.getByTestId("claude-plan-sign-in");
        await signIn.scrollIntoViewIfNeeded();
        await expect(signIn).toBeInViewport({ ratio: 1 });
        await details.press("Space");
        await expect(details).toHaveAttribute("aria-expanded", "false");
      }

      await setWindowSize(app, window, 900, 760);
      await row.getByTestId("claude-plan-cancel").press("Enter");
      await pointAndClick(window, card.getByTestId("setup-key"));
      const form = card.getByTestId("provider-form");
      for (const target of [form.getByLabel(/^API /), form.getByTestId("provider-use-key")]) {
        await target.scrollIntoViewIfNeeded();
        await expect(target).toBeInViewport({ ratio: 1 });
      }
      await card.getByTestId("setup-back").press("Enter");
      await expect(card.getByTestId("setup-key")).toBeFocused();
      await expect(card.getByTestId("setup-key")).toBeInViewport({ ratio: 1 });
    } finally {
      await app.close();
    }
  });
}

/** The smallest window the app allows (`src/main/index.ts`). */
const SMALLEST_WINDOW = { width: 900, height: 560 };

async function expectInsideCardAndWindow(window: Page, card: Locator, target: Locator) {
  const [box, cardBox, page] = await Promise.all([
    target.boundingBox(),
    card.boundingBox(),
    window.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight })),
  ]);
  if (!box || !cardBox) throw new Error("The card and its control aren't laid out.");
  expect(cardBox.y).toBeGreaterThanOrEqual(0);
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(page.height);
  // A scroll lands on whole pixels, so a control can sit half a pixel past the edge.
  expect(box.y).toBeGreaterThanOrEqual(cardBox.y - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
  expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
}

const PINNED = "[data-setup-title], [data-setup-foot]";

async function expectStaysOverContent(window: Page, card: Locator, part: Locator) {
  await expectInsideCardAndWindow(window, card, part);
  const { onTop, under } = await part.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const onTop = [box.x + 8, box.x + box.width / 2, box.right - 8].every((x) => {
      const hit = document.elementFromPoint(x, box.y + box.height / 2);
      return hit !== null && element.contains(hit);
    });
    const root = element.closest("[data-testid=model-setup]");
    const covered = [
      ...(root?.querySelectorAll("button, a, input, select, summary, p, label") ?? []),
    ]
      .filter((each) => !element.contains(each))
      .filter((each) => {
        const other = each.getBoundingClientRect();
        const rows = Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top);
        const columns = Math.min(other.right, box.right) - Math.max(other.left, box.left);
        return rows > 4 && columns > 8;
      });
    return { onTop, under: covered.length };
  });
  expect(onTop).toBe(true);
  expect(under).toBeGreaterThan(0);
}

/** The rule is the part's ::before, shown only while content passes under the part. */
const edgeShown = (part: Locator) =>
  part.evaluate((element) => getComputedStyle(element, "::before").display !== "none");

async function expectClearOfPinned(card: Locator, target: Locator) {
  const [box, parts] = await Promise.all([
    target.boundingBox(),
    card.locator(PINNED).evaluateAll((elements) =>
      elements.map((element) => {
        const part = element.getBoundingClientRect();
        const focused = document.activeElement;
        const holdsFocus = focused !== null && element.contains(focused);
        let ringInside = true;
        if (holdsFocus) {
          const control = focused.getBoundingClientRect();
          const { outlineStyle, outlineWidth, outlineOffset } = getComputedStyle(focused);
          const reach =
            outlineStyle === "none"
              ? 0
              : Number.parseFloat(outlineWidth) + Math.max(0, Number.parseFloat(outlineOffset));
          ringInside =
            control.left - reach >= part.left - 0.5 &&
            control.right + reach <= part.right + 0.5 &&
            control.top - reach >= part.top - 0.5 &&
            control.bottom + reach <= part.bottom + 0.5;
        }
        return { top: part.top, bottom: part.bottom, holdsFocus, ringInside };
      }),
    ),
  ]);
  if (!box) throw new Error("The focused control isn't laid out.");
  for (const part of parts) {
    if (part.holdsFocus) expect(part.ringInside).toBe(true);
    else expect(box.y >= part.bottom - 0.5 || box.y + box.height <= part.top + 0.5).toBe(true);
  }
}

const TABBABLE =
  "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), summary";

async function tabThroughEveryControl(
  window: Page,
  card: Locator,
  direction: "forward" | "backward" = "forward",
) {
  const place = (focus?: number) =>
    card.evaluate(
      (root, given) => {
        const controls = [...root.querySelectorAll<HTMLElement>(given.selector)].filter(
          (each) =>
            each.checkVisibility() &&
            !(each instanceof HTMLInputElement && each.type === "radio" && !each.checked),
        );
        if (given.focus === 0) root.scrollTop = 0;
        if (given.focus !== undefined) controls[given.focus]?.focus();
        return {
          index: controls.findIndex((each) => each === document.activeElement),
          count: controls.length,
        };
      },
      { selector: TABBABLE, focus },
    );
  const { count } = await place(direction === "forward" ? 0 : undefined);
  expect(count).toBeGreaterThan(3);
  const order = [...Array(count).keys()];
  if (direction === "backward") {
    order.reverse();
    await place(count - 1);
  }
  for (const [step, index] of order.entries()) {
    if (step > 0) await window.keyboard.press(direction === "forward" ? "Tab" : "Shift+Tab");
    expect((await place()).index).toBe(index);
    const focused = window.locator(":focus");
    await expectInsideCardAndWindow(window, card, focused);
    await expectClearOfPinned(card, focused);
  }
}

async function wheelToEnd(window: Page, card: Locator) {
  const box = await card.boundingBox();
  if (!box) throw new Error("The card isn't laid out.");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await expect
    .poll(async () => {
      await window.mouse.wheel(0, 120);
      return card.evaluate((root) => root.scrollTop + root.clientHeight >= root.scrollHeight - 1);
    })
    .toBe(true);
}

for (const dock of ["bottom", "float"] as const) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`at 900 px with the assistant ${dock === "bottom" ? "docked at the bottom" : "floating"}, the card scrolls inside itself with its title in view, and the last control under Other ways is reached by wheel and by Tab (${language})`, async () => {
      const { app, window } = await launchApp(dataDir);
      try {
        await setWindowSize(app, window, SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
        await acceptPlainTextKeys(window);
        await setLanguage(window, language);
        const card = await askFirstQuestion(window);
        await placeAssistant(window, { dock });
        await pointAndClick(window, card.getByTestId("setup-other"));
        const last = card.locator("details").locator("button, a").last();
        const title = card.getByRole("heading", { level: 2 });

        for (const first of [
          title,
          card.getByTestId("setup-chatgpt"),
          card.getByTestId("setup-key"),
        ]) {
          await expectInsideCardAndWindow(window, card, first);
        }
        expect(await edgeShown(title)).toBe(false);

        const cardBox = await card.boundingBox();
        if (!cardBox) throw new Error("The card isn't laid out.");
        await window.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, {
          steps: 8,
        });
        await expect
          .poll(async () => {
            await window.mouse.wheel(0, 120);
            const box = await last.boundingBox();
            return box !== null && box.y + box.height <= cardBox.y + cardBox.height + 0.5;
          })
          .toBe(true);
        await expectInsideCardAndWindow(window, card, last);
        await expect(card.getByTestId("setup-later")).toBeInViewport({ ratio: 1 });
        await expectStaysOverContent(window, card, title);
        expect(Math.abs(((await title.boundingBox())?.y ?? NaN) - cardBox.y)).toBeLessThan(1);
        await expect.poll(() => edgeShown(title)).toBe(true);

        await tabThroughEveryControl(window, card);
        await window.keyboard.press("Shift+Tab");
        await expect(last).toBeFocused();
        await expectInsideCardAndWindow(window, card, last);
        await expectClearOfPinned(card, last);
        await tabThroughEveryControl(window, card, "backward");
      } finally {
        await app.close();
      }
    });
  }
}

for (const dock of ["bottom", "float"] as const) {
  for (const language of ["en", "zh-CN"] as const) {
    test(`at 900 px with the assistant ${dock === "bottom" ? "docked at the bottom" : "floating"}, the key form's action row and a plan sign-in's Finish signing in stay at the card's foot as it scrolls (${language})`, async () => {
      const fake = await createFakeAnthropic();
      const { app, window } = await launchApp(dataDir, { claude: fake.origin });
      try {
        await setWindowSize(app, window, SMALLEST_WINDOW.width, SMALLEST_WINDOW.height);
        await interceptOpenExternal(app);
        await acceptPlainTextKeys(window);
        await setLanguage(window, language);
        const card = await askFirstQuestion(window);
        await placeAssistant(window, { dock });
        const scrollsInside = () => card.evaluate((root) => root.scrollHeight > root.clientHeight);
        const scrollTo = (top: number) =>
          card.evaluate((root, to) => {
            root.scrollTop = to;
          }, top);

        await pointAndClick(window, card.getByTestId("setup-key"));
        const form = card.getByTestId("provider-form");
        await form.getByLabel(/^API /).fill("sk-ant-not-a-key");
        const action = form.getByTestId("provider-use-key");
        const foot = form.locator("[data-setup-foot]");
        await expect(foot).toHaveCount(1);
        expect(await scrollsInside()).toBe(true);
        await scrollTo(0);
        await expectStaysOverContent(window, card, foot);
        await expectInsideCardAndWindow(window, card, action);
        const [cardBox, footBox] = await Promise.all([card.boundingBox(), foot.boundingBox()]);
        if (!cardBox || !footBox) throw new Error("The card and its action row aren't laid out.");
        expect(Math.abs(footBox.y + footBox.height - (cardBox.y + cardBox.height))).toBeLessThan(1);
        await expect.poll(() => edgeShown(foot)).toBe(true);

        await wheelToEnd(window, card);
        await expectInsideCardAndWindow(window, card, action);
        await expect(card.getByTestId("setup-later")).toBeInViewport({ ratio: 1 });
        const [later, endFoot] = await Promise.all([
          card.getByTestId("setup-later").boundingBox(),
          foot.boundingBox(),
        ]);
        expect(later?.y ?? NaN).toBeGreaterThanOrEqual(
          (endFoot?.y ?? NaN) + (endFoot?.height ?? NaN) - 0.5,
        );
        await expect.poll(() => edgeShown(foot)).toBe(false);
        await tabThroughEveryControl(window, card);
        await tabThroughEveryControl(window, card, "backward");

        await pointAndClick(window, card.getByTestId("setup-back"));
        await pointAndClick(window, card.getByTestId("setup-other"));
        await pointAndClick(window, card.getByTestId("way-claude-open"));
        await pointAndClick(window, card.getByTestId("claude-plan-sign-in"));
        const waiting = card.getByTestId("claude-plan-waiting");
        await expect(waiting).toBeVisible();
        const code = waiting.getByTestId("claude-paste-address");
        await code.fill("not-a-code");
        const finish = waiting.getByTestId("claude-paste-continue");
        const paste = waiting.getByTestId("claude-paste");
        await expect(finish).toBeEnabled();

        // Its top just in view: its row is pulled up from below the fold, and can't leave the block.
        await card.evaluate((root) => {
          const block = root.querySelector("[data-testid=claude-plan-waiting]");
          if (block) {
            root.scrollTop +=
              block.getBoundingClientRect().top - (root.getBoundingClientRect().bottom - 100);
          }
        });
        const blockBox = await waiting.boundingBox();
        expect((blockBox?.y ?? NaN) + (blockBox?.height ?? NaN)).toBeGreaterThan(
          cardBox.y + cardBox.height,
        );
        await expectStaysOverContent(window, card, paste);
        await expectInsideCardAndWindow(window, card, finish);
        await expect.poll(() => edgeShown(paste)).toBe(true);
        await tabThroughEveryControl(window, card);
        await tabThroughEveryControl(window, card, "backward");

        // The row is in its own place now, up under the title, which stays over it.
        await wheelToEnd(window, card);
        await expectStaysOverContent(window, card, card.getByRole("heading", { level: 2 }));
      } finally {
        await app.close();
        await fake.close();
      }
    });
  }
}

test("a newcomer pastes a key from the card in two clicks, picks Claude Sonnet 5.5 from the list behind Change without typing an id, and gets an Answer", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);

    await card.getByTestId("setup-key").click();
    const form = card.getByTestId("provider-form");
    await expect(card.getByTestId("provider-form-title")).toHaveText("Paste your Anthropic key");
    await expect(form.getByLabel(/^API key/)).toBeFocused();
    await window.keyboard.insertText("sk-ant-a-key-from-the-company");

    await expect(form.getByTestId("provider-model-line")).toHaveText(
      "Model: Claude Haiku 5.5 · Change",
    );
    await pointAndClick(window, form.getByTestId("provider-model-change"));
    const model = form.getByTestId("provider-model");
    await expect(model.locator("option").first()).toHaveText("Claude Haiku 5.5 · Recommended");
    const options = await model.locator("option").allTextContents();
    expect(options).toEqual(
      expect.arrayContaining([
        "Claude Fable 5.1 · Most capable",
        "Claude Sonnet 5.5 · Good with images and scans",
        "Claude Opus 5.5",
      ]),
    );
    expect(options.at(-1)).toBe("Another model…");
    await model.selectOption({ label: "Claude Sonnet 5.5 · Good with images and scans" });
    await form.getByTestId("provider-use-key").click();

    await continueSetup(window);
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    const chatModel = await window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings())
          .user.chatModel,
    );
    expect(chatModel?.modelId).toBe("claude-sonnet-5-5");
  } finally {
    await app.close();
  }
});

test("the key step follows the company picked and Back returns keyboard focus to Paste an API key, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    const title = card.getByTestId("provider-form-title");
    const form = card.getByTestId("provider-form");
    const chip = (name: string) =>
      form.locator("label").filter({ hasText: new RegExp(`^${name}$`) });

    await card.getByTestId("setup-key").click();
    await expect(title).toHaveText("Paste your Anthropic key");
    await chip("OpenAI").click();
    await expect(title).toHaveText("Paste your OpenAI key");
    const model = form.getByTestId("provider-model");
    const change = form.getByTestId("provider-model-change");
    await change.click();
    await model.selectOption({ label: "Another model…" });
    await expect(form.getByTestId("provider-model-text")).toHaveAttribute(
      "placeholder",
      "e.g. gpt-6-luna",
    );
    // The list stays, so a model in it can still be picked instead.
    await model.selectOption({ index: 0 });
    await expect(form.getByTestId("provider-model-text")).toHaveCount(0);

    await card.getByTestId("setup-back").focus();
    await window.keyboard.press("Enter");
    await expect(card.getByTestId("setup-key")).toBeFocused();
    await setLanguage(window, "zh-CN");
    await card.getByTestId("setup-key").click();
    // In Chinese the key step opens on DeepSeek, and says so until another company is picked.
    await expect(title).toHaveText("粘贴 DeepSeek 密钥");
    await chip("Anthropic").click();
    await expect(title).toHaveText("粘贴 Anthropic 密钥");
    await change.click();
    await model.selectOption({ label: "其他模型…" });
    await expect(form.getByTestId("provider-model-text")).toHaveAttribute(
      "placeholder",
      "例如 claude-haiku-5-5",
    );
    await card.getByTestId("setup-back").focus();
    await window.keyboard.press("Enter");
    await expect(card.getByTestId("setup-key")).toBeFocused();
    await card.getByTestId("setup-other").press("Enter");
    await card.getByTestId("way-local").press("Enter");
    await card.getByTestId("setup-back").press("Enter");
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await expect(card.getByTestId("way-local")).toBeFocused();
    await expect(card.getByTestId("way-local")).toBeInViewport({ ratio: 1 });
  } finally {
    await app.close();
  }
});

const JOBS = {
  en: {
    ready: "Ollama works",
    title: "What each job uses",
    change: "Change",
    meetings: "On this computer",
    noReader: "No model reads images yet",
    changeQuick: "Change Quick tasks",
  },
  "zh-CN": {
    ready: "“Ollama”可以使用了",
    title: "各项任务使用的模型",
    change: "更改",
    meetings: "在这台电脑上",
    noReader: "还没有能读图的模型",
    changeQuick: "更改快速任务",
  },
} as const;

/** Once a model works (as a key or sign-in accepted does), the card says what each job uses, and the Question waits for Continue. */
async function expectJobsCard(window: Page, card: Locator) {
  await expect(card.getByTestId("setup-ready-title")).toBeVisible();
  await expect(assistantAnswers(window)).toHaveCount(0);
  // The Question waits for Continue; the thread doesn't say it waits for a model that works.
  await expect(window.getByTestId("assistant-waiting-model")).toHaveCount(0);
}

const storedRoute = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getSettings()).device.transcriptionRoute;
  });

for (const language of ["en", "zh-CN"] as const) {
  test(`once a model works, the card lists what each job uses with Change in place, and Continue asks the waiting Question (${language})`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    // The narrowest window the app allows.
    await setWindowSize(app, window, 900, 760);
    await setLanguage(window, language);
    const words = JOBS[language];
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await expect(window.getByTestId("assistant-waiting-model")).toBeVisible();
    await useLocalChatModel(window);
    await expectJobsCard(window, card);
    await expect(card.getByTestId("setup-ready-title")).toHaveText(words.ready);
    await expect(card.getByTestId("setup-jobs").getByRole("heading")).toHaveText(words.title);
    // Neutral, not green: the tick is the ink colour.
    await expect(card.getByTestId("setup-ready-title").locator("svg")).toHaveCSS(
      "color",
      await tokenColor(window, "--color-ink"),
    );
    // A model that can't read images has Reading images beside Answers and Quick tasks.
    await expect(card.getByTestId("setup-job-chatModel-value")).toContainText("fake-model");
    await expect(card.getByTestId("setup-job-quickTasksModel-value")).toContainText("fake-model");
    await expect(card.getByTestId("setup-job-meetings-value")).toHaveText(words.meetings);
    await expect(card.getByTestId("setup-job-imageModel")).toBeVisible();
    await expect(card.getByTestId("setup-continue")).toBeEnabled();
    await expect(card.getByTestId("setup-continue")).toBeFocused();
    const box = await card.boundingBox();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 900).toBe(true);

    // Change edits the row where it is: the words give way to the choice, which has the row's name; Esc puts the words back.
    const quick = card.getByTestId("setup-job-quickTasksModel");
    await expect(quick.getByRole("button", { name: words.changeQuick })).toBeVisible();
    await pointAndClick(window, quick.getByTestId("setup-job-quickTasksModel-change"));
    const choice = quick.getByRole("combobox", { name: /Quick tasks|快速任务/ });
    await expect(choice).toBeFocused();
    await expect(quick.getByTestId("setup-job-quickTasksModel-value")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(quick.getByTestId("setup-job-quickTasksModel-value")).toBeVisible();
    await expect(quick.getByTestId("setup-job-quickTasksModel-change")).toBeFocused();

    // A choice is the setting Settings › Models shows at once.
    await pointAndClick(window, quick.getByTestId("setup-job-quickTasksModel-change"));
    await quick.getByTestId("model-default-quickTasksModel").selectOption({ index: 1 });
    await expect(quick.getByTestId("setup-job-quickTasksModel-value")).toHaveText(
      /^fake-model · Ollama/,
    );
    expect(
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await core.getSettings()).user.quickTasksModel?.modelId ?? null;
      }),
    ).toBe("fake-model");

    // Meetings offers this computer only until cloud routes come, and choosing it is a choice: it is stored.
    const meetings = card.getByTestId("setup-job-meetings");
    const meetingsChange = meetings.getByTestId("setup-job-meetings-change");
    await pointAndClick(window, meetingsChange);
    const route = meetings.getByTestId("meetings-route");
    await expect(route).toBeFocused();
    await expect(route.locator("option:not([hidden])")).toHaveText([words.meetings]);
    // Esc is no choice: the words come back, nothing is stored, and the first Record still asks.
    await window.keyboard.press("Escape");
    await expect(meetings.getByTestId("setup-job-meetings-value")).toHaveText(words.meetings);
    await expect(meetingsChange).toBeFocused();
    expect(await storedRoute(window)).toBeNull();
    // From the keyboard alone, Enter on Change opens the picker, focused, and its one choice is stored.
    await window.keyboard.press("Enter");
    await expect(route).toBeFocused();
    await route.selectOption("local");
    await expect(meetings.getByTestId("setup-job-meetings-value")).toHaveText(words.meetings);
    await expect(meetingsChange).toBeFocused();
    expect(await storedRoute(window)).toBe("local");

    await continueSetup(window);
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 15_000,
    });
    await app.close();
  });
}

test("Change on Reading images, with no model that reads images, opens a picker that says so, and Esc and a click away close it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await useLocalChatModel(window);
  await expectJobsCard(window, card);

  const images = card.getByTestId("setup-job-imageModel");
  await expect(images.getByTestId("setup-job-imageModel-value")).toHaveText(
    "No model reads images yet",
  );
  await pointAndClick(window, images.getByTestId("setup-job-imageModel-change"));
  const choice = images.getByRole("combobox", { name: "Reading images" });
  await expect(choice).toBeEnabled();
  await expect(choice).toBeFocused();
  await expect(choice.locator("option")).toHaveText(["No model reads images yet"]);
  await window.keyboard.press("Escape");
  await expect(images.getByTestId("setup-job-imageModel-value")).toBeVisible();
  await expect(images.getByTestId("setup-job-imageModel-change")).toBeFocused();

  // Clicking elsewhere in the card closes it too, and the focus stays where the click put it.
  await pointAndClick(window, images.getByTestId("setup-job-imageModel-change"));
  await expect(choice).toBeFocused();
  await pointAndClick(window, card.getByTestId("setup-ready-title"));
  await expect(images.getByTestId("setup-job-imageModel-value")).toBeVisible();
  await expect(card.getByTestId("setup-continue")).toBeEnabled();
  await app.close();
});

test("Continue works without touching a row, and Models and Meetings in Settings show the same Meetings choice", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await useLocalChatModel(window);
  await expectJobsCard(window, card);
  await continueSetup(window);
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });

  const models = await openSettings(window, "models");
  await expect(models.getByTestId("model-default-label-meetings")).toHaveText("Meetings");
  const inModels = models.getByTestId("model-defaults").getByTestId("meetings-route");
  await expect(inModels).toHaveValue("");
  const meetings = await showSettingsPage(window, "meetings");
  const inMeetings = meetings.getByTestId("meetings-settings").getByTestId("meetings-route");
  await expect(inMeetings).toHaveValue("");
  // Choosing the one route there stores it, and the other page shows the same.
  await inMeetings.selectOption("local");
  expect(await storedRoute(window)).toBe("local");
  await showSettingsPage(window, "models");
  await expect(window.getByTestId("model-defaults").getByTestId("meetings-route")).toHaveValue(
    "local",
  );
  await app.close();
});

/** A Soniox key kept, so a cloud route is offered beside this computer. */
async function keepSonioxKey(window: Page) {
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
  });
}

const transcriptionConsent = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const flows = await core.listDataFlows();
    return flows.find((each) => each.flow.id === "transcription")?.consent ?? "not-asked";
  });

const CLOUD_CONSENT = "A cloud service gets the meeting’s audio while you record.";

/** The first recording's sheet, opened from a new Meeting's Start. */
async function firstRecordingSheet(window: Page) {
  const start = await recordMeeting(window);
  await start.getByTestId("meeting-start-record").click();
  const sheet = window.getByTestId("meeting-notice");
  await expect(sheet).toBeVisible();
  return sheet;
}

// ADR-0022: choosing the service is the consent, so the line that says what it sends is on screen first.
test("with a Soniox key, the card's Meetings row says a cloud service gets the audio before Soniox can be chosen, then where it goes; the first recording's sheet then shows that choice without asking", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  await keepSonioxKey(window);
  const card = await askFirstQuestion(window);
  await useLocalChatModel(window);
  await expectJobsCard(window, card);

  const line = card.getByTestId("meetings-route-consent");
  await expect(line).toHaveText(CLOUD_CONSENT);
  const meetings = card.getByTestId("setup-job-meetings");
  await pointAndClick(window, meetings.getByTestId("setup-job-meetings-change"));
  const route = meetings.getByTestId("meetings-route");
  await expect(route.locator("option:not([hidden])")).toHaveText(["On this computer", "Soniox"]);
  await expect(line).toBeVisible();
  expect(await transcriptionConsent(window)).toBe("not-asked");
  await route.selectOption("soniox");
  await expect(meetings.getByTestId("setup-job-meetings-value")).toHaveText("Soniox");
  await expect(line).toHaveText("Audio goes to Soniox while you record");
  expect(await transcriptionConsent(window)).toBe("accepted");
  await continueSetup(window);
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });

  const sheet = await firstRecordingSheet(window);
  const chosen = sheet.getByTestId("meeting-route");
  await expect(chosen).toContainText("Transcribe with Soniox");
  await expect(chosen).toContainText("Audio goes to Soniox while you record");
  await expect(sheet.getByTestId("meeting-route-ways")).toHaveCount(0);
  await app.close();
});

test("with a Soniox key, Settings › Models says a cloud service gets the audio beside the Meetings choice before Soniox is chosen, then where it goes; this computer chosen there, the first recording's sheet doesn't offer other ways", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  await useLocalChatModel(window);
  await keepSonioxKey(window);

  const models = (await openSettings(window, "models")).getByTestId("model-defaults");
  const line = models.getByTestId("meetings-route-consent");
  await expect(line).toHaveText(CLOUD_CONSENT);
  const route = models.getByTestId("meetings-route");
  await expect(route).toHaveValue("");
  expect(await transcriptionConsent(window)).toBe("not-asked");
  await route.selectOption("soniox");
  await expect(line).toHaveText("Audio goes to Soniox while you record");
  expect(await transcriptionConsent(window)).toBe("accepted");
  await route.selectOption("local");
  await expect(line).toHaveText(CLOUD_CONSENT);
  await closeSettings(window);

  const sheet = await firstRecordingSheet(window);
  await expect(sheet.getByTestId("meeting-route")).toContainText("Transcribe on this computer");
  await expect(sheet.getByTestId("meeting-route-other")).toHaveCount(0);
  await app.close();
});

test("Reading images is left out when the Answers model reads images", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.saveChatProvider({
      kind: "deepseek",
      apiKey: "sk-not-real",
      modelId: "deepseek-flash",
    });
  });
  await expect(card.getByTestId("setup-ready-title")).toHaveText("DeepSeek works");
  await expect(card.getByTestId("setup-job-chatModel")).toBeVisible();
  await expect(card.getByTestId("setup-job-imageModel")).toHaveCount(0);
  await app.close();
});

test("a slow list of models changes nothing: the heading names the provider, and Continue works at once", async () => {
  const slow = await ollamaListing(["fake-model"], { delayMs: 6000 });
  const { app, window } = await launchApp(dataDir, { fakeChat: true, ollama: slow.url });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await useLocalChatModel(window);
  await expect(card.getByTestId("setup-ready-title")).toHaveText("Ollama works");
  // The Answers row names its provider at once too, as the list of models is not what says it.
  await expect(card.getByTestId("setup-job-chatModel-value")).toHaveText(/^fake-model · Ollama/);
  // No wait for the list: Continue is there, focused, and asks the Question.
  await expect(card.getByTestId("setup-continue")).toBeFocused();
  await continueSetup(window);
  // The Question goes out once the slow list answers.
  await expect(assistantAnswers(window).first()).toBeVisible({ timeout: 20_000 });
  await app.close();
  slow.server.close();
});

test("when the model that worked goes, the card asks for one again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await useLocalChatModel(window);
  await expect(card.getByTestId("setup-ready-title")).toBeVisible();
  await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    for (const provider of await core.listChatProviders())
      await core.deleteChatProvider(provider.id);
  });
  await expect(window.getByTestId("setup-ready-title")).toHaveCount(0);
  await expect(window.getByTestId("model-setup").getByRole("heading", { level: 2 })).toHaveText(
    "Choose your AI",
  );
  await expect(window.getByTestId("assistant-waiting-model")).toBeVisible();
  await app.close();
});

test("a Question waiting for Continue is kept if the app quits, and is in the composer at the next start", async () => {
  const first = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(first.app, first.window, 1100, 900);
  await acceptPlainTextKeys(first.window);
  const card = await askFirstQuestion(first.window);
  await useLocalChatModel(first.window);
  await expectJobsCard(first.window, card);
  await first.app.close();

  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await expect(window.getByTestId("home")).toBeVisible();
  await window.getByTestId("mind-tab").click();
  await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  await app.close();
});
