import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { createFakeAnthropic } from "../tests/helpers/fakeAnthropic";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  ANTHROPIC_KEY,
  acceptPlainTextKeys,
  askFirstQuestion,
  assistantAnswers,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  openSetupSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * Each first-run route in English and Chinese, at 900 and 1,600 px (#1922). modelSetup.spec.ts
 * holds the long-form assertions of the same routes at one size; this file checks only what the
 * language and the width change, so a word that overflows in Chinese or a choice that only breaks
 * narrow is seen. A route that saves a model can't run twice on one data folder, so every
 * combination launches the app on its own.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const COMBINATIONS = [
  { language: "en", width: 900, height: 700 },
  { language: "en", width: 1600, height: 900 },
  { language: "zh-CN", width: 900, height: 700 },
  { language: "zh-CN", width: 1600, height: 900 },
] as const;

function cardFits(window: Page): Promise<{ inside: boolean; sideways: boolean }> {
  return window.evaluate(() => {
    const card = document.querySelector('[data-testid="model-setup"]');
    if (!card) throw new Error("The setup card isn't showing.");
    const box = card.getBoundingClientRect();
    return {
      inside:
        box.left >= -0.5 &&
        box.top >= -0.5 &&
        box.right <= innerWidth + 0.5 &&
        box.bottom <= innerHeight + 0.5,
      sideways:
        card.scrollWidth > card.clientWidth + 1 ||
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

const fits = { inside: true, sideways: false };

for (const { language, width, height } of COMBINATIONS) {
  test(`a pasted key is recognised from its form, the waiting Question runs with no other click, and steps 2 and 3 take one click each (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);

      await expect(card.getByTestId("provider-form")).toHaveCount(0);
      const field = card.getByTestId("setup-key");
      await expect(field).toBeFocused();
      await expect(card.getByTestId("setup-key-line")).toHaveText(
        translate(language, "setup.key.recognised"),
      );

      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-step-transcription")).toContainText(
        translate(language, "setup.step.transcription"),
        { timeout: 15_000 },
      );
      await expect(card.getByTestId("setup-step-sorting")).toContainText(
        translate(language, "setup.step.sorting"),
      );
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      const transcription = card.getByTestId("setup-transcription");
      await expect(transcription).toBeFocused();
      await expect(transcription).toHaveValue("local");
      await expect(card.getByTestId("setup-transcription-line")).toHaveText(
        translate(language, "setup.step.transcription.line"),
      );
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));
      await expect(card.getByTestId("setup-step-transcription")).toHaveAttribute(
        "data-done",
        "true",
      );

      await expect(card.getByTestId("models-sorting").locator("option:checked")).toHaveText(
        translate(language, "models.sorting.chat"),
        { timeout: 15_000 },
      );
      await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));
      await expect(card).toHaveCount(0);
      await expect(window.getByTestId("composer-input")).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`with no key and a ChatGPT plan, the plan's sign-in is the first choice offered (${language}, ${width} px)`, async () => {
    const openai = await createFakeOpenAI();
    const claude = await createFakeAnthropic();
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      chatGpt: openai.endpoints.issuer,
      claude: claude.origin,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, width, height);
      await interceptOpenExternal(app);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
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
      await expect(card.getByTestId("setup-chatgpt")).toHaveText(
        translate(language, "setup.chatgpt.use"),
      );
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      await pointAndClick(window, card.getByTestId("setup-chatgpt"));
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      const [authorize] = await urlsOpened(app);
      expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
      await window.getByTestId("chatgpt-welcome-ok").click();
      await openSetupSteps(window);
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      await expect(card.getByTestId("setup-step-transcription")).toContainText(
        translate(language, "setup.step.transcription"),
      );
      await expect(card.getByTestId("setup-step-sorting")).toContainText(
        translate(language, "setup.step.sorting"),
      );
    } finally {
      await app.close();
      await openai.close();
      await claude.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`with nothing at all, the local-model route is offered and the example still opens (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      examples: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, width, height);
      await interceptOpenExternal(app);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const example = window
        .getByTestId("mind-list-item")
        .filter({ has: window.getByTestId("example-chip") });
      await expect(example).toHaveAttribute("aria-current", "page");

      const card = await askFirstQuestion(window);

      await expect(card.getByTestId("setup-key")).toBeVisible();
      const local = card.getByTestId("way-local");
      await expect(local).toContainText(translate(language, "setup.way.local.install"));
      await expect(local).toContainText(translate(language, "setup.way.local.notRunning"));
      await expect(local.getByTestId("ollama-get")).toBeVisible();
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      await expect(window.getByTestId("mind-list-item").getByTestId("example-chip")).toBeVisible();
      await pointAndClick(window, card.getByTestId("setup-later"));
      await expect(card).toHaveCount(0);
      await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
    } finally {
      await app.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`in Local mode only choices on this computer are offered, in step 1 and in the steps after it (${language}, ${width} px)`, async () => {
    const claude = await createFakeAnthropic();
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      claude: claude.origin,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      await window.evaluate(async () => {
        const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await core.setLocalOnly(true);
      });
      const card = await askFirstQuestion(window);

      await expect(card.getByTestId("setup-local-mode")).toContainText(
        translate(language, "setup.localMode"),
      );
      await expect(card.getByTestId("setup-key")).toHaveCount(0);
      await expect(card.getByTestId("setup-chatgpt")).toHaveCount(0);
      await expect(card.getByTestId("way-claude")).toHaveCount(0);
      await expect(card.getByTestId("setup-other")).toHaveCount(0);
      await expect(card.getByTestId("way-local")).toBeVisible();
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      await setLocalChatModel(window);
      await openSetupSteps(window);
      await expect(card.getByTestId("setup-transcription").locator("option")).toHaveText([
        translate(language, "meetings.route.local"),
      ]);
      await pointAndClick(window, card.getByTestId("setup-transcription-use"));
      await expect(card.getByTestId("models-sorting").locator("option")).toHaveText(
        [translate(language, "models.sorting.chat")],
        { timeout: 15_000 },
      );
      await expect(card.getByTestId("setup-sorting-use")).toBeEnabled({ timeout: 15_000 });
      await pointAndClick(window, card.getByTestId("setup-sorting-use"));
      await expect(card).toHaveCount(0);
    } finally {
      await app.close();
      await claude.close();
    }
  });
}
