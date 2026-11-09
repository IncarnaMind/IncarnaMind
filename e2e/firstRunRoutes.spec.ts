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
  exampleRow,
  interceptOpenExternal,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  useLocalChatModel as setLocalChatModel,
  setupWay,
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
  test(`a pasted key is recognised from its form, and the waiting Question runs with no other click (${language}, ${width} px)`, async () => {
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
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
      await expect(card).toHaveCount(0);
      await expect(window.getByTestId("composer-input")).toBeVisible();
    } finally {
      await app.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`a refused key says what to do in one line, and the next key answers the waiting Question (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");

      await field.fill("sk-ant-a-key-that-is-refused");
      await field.press("Enter");
      const refused = card.getByTestId("setup-key-refused");
      await expect(refused).toHaveText(
        `${translate(language, "setup.key.refused")} · ${translate(language, "setup.key.check")}`,
      );
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);
      await pointAndClick(window, card.getByTestId("setup-key-check"));
      await expect(field).toBeFocused();

      // The same field takes the working key, and the Question that waited is answered.
      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
    } finally {
      await app.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`a key with no credit says what to do in one line, and the next key answers the waiting Question (${language}, ${width} px)`, async () => {
    const { app, window } = await launchApp(dataDir, {
      fakeChat: true,
      ollama: "http://127.0.0.1:9",
    });
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      await setLanguage(window, language);
      const card = await askFirstQuestion(window);
      const field = card.getByTestId("setup-key");

      await field.fill("sk-ant-a-key-with-no-credit");
      await field.press("Enter");
      const refused = card.getByTestId("setup-key-refused");
      await expect(refused).toHaveText(
        [
          translate(language, "setup.key.credit"),
          translate(language, "setup.key.addCredit"),
          translate(language, "setup.key.another"),
        ].join(" · "),
      );
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);
      await pointAndClick(window, card.getByTestId("setup-key-another"));
      await expect(field).toBeFocused();

      await field.fill(ANTHROPIC_KEY);
      await field.press("Enter");
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
    } finally {
      await app.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`with no key and a ChatGPT plan, the plan's sign-in is the first choice offered where it can be bought, and under Other ways in Chinese (${language}, ${width} px)`, async () => {
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

      const ways = () =>
        card.evaluate((element) =>
          [
            ...element.querySelectorAll(
              '[data-testid="setup-chatgpt"], [data-testid="way-claude"], [data-testid="way-local"], [data-testid="setup-other"]',
            ),
          ].map((each) => each.getAttribute("data-testid")),
        );
      if (language === "en") {
        await expect(card.getByTestId("way-claude")).toBeVisible();
        expect(await ways()).toEqual(["setup-chatgpt", "way-claude", "way-local", "setup-other"]);
      } else {
        // Neither plan can be bought in mainland China: they wait under Other ways, and no line
        // says they aren't available (#2865).
        await expect(card.getByTestId("way-local")).toBeVisible();
        await expect(card.getByTestId("setup-chatgpt")).toBeHidden();
        await expect(card.getByTestId("way-claude")).toBeHidden();
        expect(await ways()).toEqual(["way-local", "setup-other", "setup-chatgpt", "way-claude"]);
        await setupWay(window, card, "setup-chatgpt");
        await expect(card.getByTestId("way-claude")).toBeVisible();
        await expect(card.getByTestId("setup-chatgpt-line")).toHaveText(
          translate(language, "setup.chatgpt.line"),
        );
        await expect(card.getByTestId("way-claude")).toContainText(
          translate(language, "claudePlan.way.line"),
        );
        await expect(card).not.toContainText("中国大陆不可用");
      }
      await expect(card.getByTestId("setup-chatgpt")).toHaveText(
        translate(language, "setup.chatgpt.use"),
      );
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      await pointAndClick(window, card.getByTestId("setup-chatgpt"));
      await expect.poll(() => urlsOpened(app)).toHaveLength(1);
      const [authorize] = await urlsOpened(app);
      expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
      await window.getByTestId("chatgpt-welcome-ok").click();
      await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
        timeout: 20_000,
      });
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
      const example = exampleRow(window);
      await expect(example).toHaveAttribute("aria-current", "page");

      const card = await askFirstQuestion(window);

      await expect(card.getByTestId("setup-key")).toBeVisible();
      const local = card.getByTestId("way-local");
      await expect(local).toContainText(translate(language, "setup.way.local.install"));
      await expect(local).toContainText(translate(language, "setup.way.local.notRunning"));
      await expect(local.getByTestId("ollama-get")).toBeVisible();
      expect(await cardFits(window), "the card is whole in the window, nothing cut").toEqual(fits);

      await expect(exampleRow(window)).toBeVisible();
      await pointAndClick(window, card.getByTestId("setup-later"));
      await expect(card).toHaveCount(0);
      await expect(window.getByTestId("composer-input")).toHaveValue("What is in my Documents?");
    } finally {
      await app.close();
    }
  });
}

for (const { language, width, height } of COMBINATIONS) {
  test(`in Local mode only choices on this computer are offered (${language}, ${width} px)`, async () => {
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
      await expect(card).toHaveCount(0);
    } finally {
      await app.close();
      await claude.close();
    }
  });
}
