import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { createFakeAnthropic } from "../tests/helpers/fakeAnthropic";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  ollamaListing,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  startRecording,
  urlsOpened,
} from "./app";

/*
 * First run in three short steps (#1922): your AI, a pasted key named by its form and working at
 * once; meeting transcription, this computer first; and what sorts Documents and names meeting
 * hints, the best the keys reach. Each choice is the consent for its flow (ADR-0022).
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const bridge = (window: Page) => ({
  settings: () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
    ),
  library: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await core.getLibrary()).settings;
    }),
});

async function askFirstQuestion(window: Page): Promise<Locator> {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is in my Documents?");
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await expect(card).toBeVisible();
  return card;
}

/** A key as a real one is shaped, for a stand-in provider: never a real key. */
const ANTHROPIC_KEY = "sk-ant-api03-a-test-key-for-first-run";

test("a pasted key is named by its form and works at once: the waiting Question runs, and steps 2 and 3 take one click each", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);

    // No provider list and no Continue: the field is the way in, and it takes the focus.
    await expect(card.getByTestId("provider-form")).toHaveCount(0);
    await expect(card.getByTestId("setup-continue")).toHaveCount(0);
    const field = card.getByTestId("setup-key");
    await expect(field).toBeFocused();
    await expect(card.getByTestId("setup-key-line")).toHaveText(
      "OpenAI, Anthropic, Google, OpenRouter and xAI keys are recognized here.",
    );

    await field.fill(ANTHROPIC_KEY);
    await field.press("Enter");
    await expect(card.getByTestId("setup-ready-title")).toHaveText("Anthropic works", {
      timeout: 15_000,
    });
    // The Question that waited is asked at once, while the two steps stay below its Answer.
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
    await expect(card.getByTestId("setup-step-transcription")).toBeVisible();

    // Step 2: this computer, free, nothing leaves, and one click uses it.
    const transcription = card.getByTestId("setup-transcription");
    await expect(transcription).toBeFocused();
    await expect(transcription).toHaveValue("local");
    await expect(card.getByTestId("setup-transcription-line")).toHaveText(
      "Free · nothing leaves this computer",
    );
    await pointAndClick(window, card.getByTestId("setup-transcription-use"));
    await expect(card.getByTestId("setup-step-transcription")).toHaveAttribute("data-done", "true");

    // Step 3: the best the key reaches is the AI model just set up, and hints say what they need.
    const sorting = card.getByTestId("models-sorting");
    await expect(sorting).toBeFocused();
    await expect(sorting.locator("option:checked")).toHaveText("Use your AI model");
    await expect(card.getByTestId("models-sorting-line")).toContainText(
      "Tags and Folders use Claude Haiku 5.5",
    );
    await expect(card.getByTestId("models-sorting-line")).toContainText(
      "Meeting hints stay off until a decision model is chosen",
    );
    await pointAndClick(window, card.getByTestId("setup-sorting-use"));

    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("composer-input")).toBeVisible();
    expect((await bridge(window).settings()).device.transcriptionRoute).toBe("local");
    const library = await bridge(window).library();
    expect(library.classifier.kind).toBe("chat");
  } finally {
    await app.close();
  }
});

test("with no key, the ChatGPT plan comes first, the Claude account second, and a model on this computer third", async () => {
  const openai = await createFakeOpenAI();
  const claude = await createFakeAnthropic();
  const ollama = await ollamaListing(["qwen3.5:4b"]);
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    chatGpt: openai.endpoints.issuer,
    claude: claude.origin,
    ollama: ollama.url,
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("way-claude")).toBeVisible();
    const order = await card.evaluate((element) =>
      [
        ...element.querySelectorAll(
          '[data-testid="setup-chatgpt"], [data-testid="way-claude"], [data-testid="way-local"]',
        ),
      ].map((each) => each.getAttribute("data-testid")),
    );
    expect(order).toEqual(["setup-chatgpt", "way-claude", "way-local"]);

    // The plan's sign-in is the first choice, and it finishes first run as a key does.
    await pointAndClick(window, card.getByTestId("setup-chatgpt"));
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [authorize] = await urlsOpened(app);
    expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
    await window.getByTestId("chatgpt-welcome-ok").click();
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
  } finally {
    await app.close();
    await openai.close();
    await claude.close();
    await new Promise<void>((done) => ollama.server.close(() => done()));
  }
});

test("nothing at all: installing a model on this computer is offered, the example still opens, and Set up later gives the words back", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    examples: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("way-local")).toContainText("Install a model on this computer…");
    await expect(card.getByTestId("way-local")).toContainText("Needs the free Ollama app");
    await card.getByTestId("ollama-get").click();
    await expect.poll(() => urlsOpened(app)).toContain("https://ollama.com/download");

    // The example the app opens on is still there.
    await expect(window.getByTestId("mind-list-item").getByTestId("example-chip")).toBeVisible();

    await pointAndClick(window, card.getByTestId("setup-later"));
    await expect(card).toHaveCount(0);
    await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  } finally {
    await app.close();
  }
});

test("a refused key, a key with no credit and a key from a service we don’t list each say what to do in one line", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    const field = card.getByTestId("setup-key");

    await field.fill("sk-ant-a-key-that-is-refused");
    await field.press("Enter");
    await expect(card.getByTestId("setup-key-refused")).toHaveText(
      "The key was refused · Check the key",
    );

    await field.fill("sk-ant-a-key-with-no-credit");
    await field.press("Enter");
    const credit = card.getByTestId("setup-key-refused");
    await expect(credit).toHaveText("No credit on this key · Add credit · Use another key");
    await credit.getByTestId("setup-key-credit").click();
    expect((await urlsOpened(app))[0]).toBe("https://platform.claude.com/settings/billing");
    await credit.getByTestId("setup-key-another").click();
    await expect(field).toBeFocused();

    // A form no prefix names: one line, and the way on is to say which service it is.
    await field.fill("pk-live-a-key-from-a-service-we-dont-list");
    await field.press("Enter");
    await expect(card.getByTestId("setup-key-unrecognised")).toHaveText(
      "We don’t recognize this key’s service · Choose the service",
    );
    await pointAndClick(window, card.getByTestId("setup-key-choose-service"));
    await expect(card.getByTestId("provider-form")).toBeVisible();
    // The form opens on the service the key belongs to, its key kept.
    await expect(card.getByTestId("provider-form").locator('input[type="password"]')).toHaveValue(
      "pk-live-a-key-from-a-service-we-dont-list",
    );
  } finally {
    await app.close();
  }
});

test("each step is skippable: Set up when I record and Skip leave both settings as they were, in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "zh-CN");
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });

    await expect(card.getByTestId("setup-step-transcription")).toContainText("会议转写");
    await expect(card.getByTestId("setup-step-sorting")).toContainText("整理和会议提示");
    await expect(card.getByTestId("setup-transcription-line")).toHaveText(
      "免费 · 不会离开这台电脑",
    );
    await pointAndClick(window, card.getByTestId("setup-transcription-later"));
    await expect(card.getByTestId("models-sorting")).toBeFocused();
    await pointAndClick(window, card.getByTestId("setup-sorting-skip"));
    await expect(card).toHaveCount(0);

    expect((await bridge(window).settings()).device.transcriptionRoute).toBeNull();
    expect((await bridge(window).library()).classifier).toEqual({ kind: "automatic" });
  } finally {
    await app.close();
  }
});

test("with no key and no AI model, the Example still opens and Set up later returns the words", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, examples: true });
  try {
    await setWindowSize(app, window, 900, 760);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await expect(card.getByTestId("setup-chatgpt")).toBeVisible();
    await expect(window.getByTestId("mind-list-item").getByTestId("example-chip")).toBeVisible();
    await pointAndClick(window, card.getByTestId("setup-later"));
    await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  } finally {
    await app.close();
  }
});

test("Settings › Models shows the same three rows, editable in place, with Quick tasks and Reading images automatic", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await setLocalChatModel(window);
    await dismissChatSetup(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
      await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    });
    const settings = await openSettings(window, "models");

    await expect(settings.getByTestId("model-default-chatModel")).toBeVisible();
    await expect(settings.getByTestId("model-default-quickTasksModel")).toHaveCount(0);
    await expect(settings.getByTestId("model-default-imageModel")).toHaveCount(0);
    await expect(settings.getByTestId("models-follow-answers")).toHaveText(
      "Quick tasks and reading images are automatic.",
    );

    // Meeting transcription, changed where it is shown.
    const meetings = settings.getByTestId("meetings-route");
    await expect(meetings).toHaveValue("soniox");
    await meetings.selectOption("local");
    await expect
      .poll(async () => (await bridge(window).settings()).device.transcriptionRoute)
      .toBe("local");

    // What sorts, saved where it is shown: the select is the setting.
    const sorting = settings.getByTestId("models-sorting");
    await expect(sorting.locator("option:checked")).toHaveText("Use your AI model");
    await sorting.selectOption({ label: "Use your AI model" });
    await expect.poll(async () => (await bridge(window).library()).classifier.kind).toBe("chat");
  } finally {
    await app.close();
  }
});

test("with a Soniox key a cloud route is offered in step 2 and named as the consent; this computer stays chosen", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await newMind(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setTranscriptionKey({ route: "soniox", apiKey: "soniox-a-test-key" });
    });
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
    const route = card.getByTestId("setup-transcription");
    await expect(route).toHaveValue("local");
    await expect(route.locator("option")).toHaveText(["On this computer", "Soniox"]);
    // Choosing a cloud route is the consent, so its line is on screen first.
    await expect(card.getByTestId("meetings-route-consent")).toHaveText(
      "A cloud service gets the meeting’s audio while you record.",
    );
    await route.selectOption("soniox");
    await expect(card.getByTestId("setup-transcription-line")).toHaveText(
      "Audio goes to Soniox while you record",
    );
    await pointAndClick(window, card.getByTestId("setup-transcription-use"));
    expect((await bridge(window).settings()).device.transcriptionRoute).toBe("soniox");
  } finally {
    await app.close();
  }
});

test("Local mode offers only choices on this computer, in step 1 and in the steps after it", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await core.setLocalOnly(true);
    });
    await expect(card.getByTestId("setup-local-mode")).toContainText(
      "Cloud models are off: “Keep everything on this computer”.",
    );
    await expect(card.getByTestId("setup-key")).toHaveCount(0);
    await expect(card.getByTestId("setup-chatgpt")).toHaveCount(0);
    await expect(card.getByTestId("way-local")).toBeVisible();

    await setLocalChatModel(window);
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("setup-transcription").locator("option")).toHaveText([
      "On this computer",
    ]);
    await expect(card.getByTestId("models-sorting").locator("option")).toHaveText([
      "Use your AI model",
    ]);
  } finally {
    await app.close();
  }
});

test("the card holds at 900 px and 1,600 px, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    for (const [width, height] of [
      [900, 700],
      [1600, 900],
    ] as const) {
      await setWindowSize(app, window, width, height);
      for (const language of ["en", "zh-CN"] as const) {
        await setLanguage(window, language);
        await dismissChatSetup(window);
        const card = await askFirstQuestion(window);
        const box = await card.boundingBox();
        expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(height);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
        expect(
          await window.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        await expect(card.getByTestId("setup-key")).toBeVisible();
        await expect(card.getByTestId("way-local")).toBeVisible();
        await pointAndClick(window, card.getByTestId("setup-later"));
        // Each language's own words, at the card's title.
        expect(await card.count()).toBe(0);
      }
    }
  } finally {
    await app.close();
  }
});

test("a Question waiting for a model is kept if the app quits before step 1 works", async () => {
  const first = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(first.app, first.window, 1100, 900);
  await acceptPlainTextKeys(first.window);
  await askFirstQuestion(first.window);
  await first.app.close();

  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1100, 900);
  await expect(window.getByTestId("home")).toBeVisible();
  await window.getByTestId("mind-tab").click();
  await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
  await app.close();
});

test("when the model that worked goes, the card asks for one again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await setLocalChatModel(window);
    await expect(card.getByTestId("setup-ready-title")).toBeVisible({ timeout: 15_000 });
    await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      for (const provider of await core.listChatProviders())
        await core.deleteChatProvider(provider.id);
    });
    await expect(window.getByTestId("setup-ready-title")).toHaveCount(0);
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("Set up your AI");
    await expect(card.getByTestId("setup-key")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("call help with no model offers the key field where the help was asked, and the buttons come back once a model works", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    ollama: "http://127.0.0.1:9",
  });
  try {
    await setWindowSize(app, window, 1440, 900);
    await acceptPlainTextKeys(window);
    await setLanguage(window, "en");
    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
    await window.getByTestId("mind-editor").click();
    const needs = window.getByTestId("meeting-needs-model");
    await expect(needs).toBeVisible();
    await expect(needs.getByTestId("meeting-needs-model-key")).toBeVisible();
    await setLocalChatModel(window);
    await expect(window.getByTestId("meeting-starters")).toBeVisible();
  } finally {
    await app.close();
  }
});
