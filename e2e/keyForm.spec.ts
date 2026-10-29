import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { CATALOG_PROVIDERS } from "../src/core/providers/catalog";
import { createFakeOpenAI } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  addProviderForm,
  assistantAnswers,
  closeSettings,
  continueSetup,
  createDataFolder,
  expectDotsBetweenParts,
  interceptOpenExternal,
  launchApp,
  newMind,
  openServiceList,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * The key form (#719): one row of providers, the key, the model as a line with Change (#1575) and
 * one "Use this key" that tests the key as it saves, in view at 900px high or in a card that scrolls inside itself;
 * "Where do I find it?", closed, with what the catalog knows of getting a key (#920); and the
 * ChatGPT sign-in's way back.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const language = (window: Page, value: "en" | "zh-CN") =>
  window.evaluate(
    (chosen) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: chosen },
      }),
    value,
  );

/** The region a form with a choice of two holds: "cn" or "intl". */
const regionOf = (form: Locator) => form.getByTestId("provider-region").locator("input:checked");

/** The first Question with no model: the setup card waits, with the key form opened. */
async function openKeyForm(window: Page) {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What is in my Documents?");
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await card.waitFor();
  return card;
}

test("at 900px high the key form is in view, or scrolls inside its card, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    // Linux in CI has no keyring: its notice is accepted first, as a User does once.
    await acceptPlainTextKeys(window);
    for (const value of ["en", "zh-CN"] as const) {
      await language(window, value);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      await expect(form.getByRole("radio", { checked: true })).toHaveCount(1);
      await expect(form.getByTestId("provider-model-line")).toBeVisible();
      await form.getByTestId("provider-model-change").click();
      await expect(form.getByTestId("provider-model").locator("option").first()).toContainText(
        value === "en" ? "Recommended" : "推荐",
      );
      await expect(form.getByTestId("provider-key-help-toggle")).toBeVisible();
      await expect(form.getByTestId("provider-key-link")).toBeHidden();
      // The card stays in the window; what doesn't fit scrolls inside it.
      const box = await card.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900);
      await form.getByTestId("provider-use-key").scrollIntoViewIfNeeded();
      await expect(form.getByTestId("provider-use-key")).toBeInViewport({ ratio: 1 });
      await form.getByTestId("provider-model").scrollIntoViewIfNeeded();
      await expect(form.getByTestId("provider-model")).toBeInViewport({ ratio: 1 });
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await window.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-form-900-${value}.png`,
        });
      }
      await card.getByTestId("setup-back").click();
    }
  } finally {
    await app.close();
  }
});

/** The model a provider's key form saves when the User leaves it as it is. */
const defaultModel = (catalogId: string) =>
  CATALOG_PROVIDERS.find((each) => each.id === catalogId)?.roles.answers ?? "";

const MODEL_LINE = {
  // In English the form opens on Anthropic, in Chinese on DeepSeek.
  en: {
    catalogId: "anthropic",
    line: "Model: Claude Haiku 5.5 · Change",
    change: "Change the model",
    recommended: "Claude Haiku 5.5 · Recommended",
  },
  "zh-CN": {
    catalogId: "deepseek",
    line: /^模型：DeepSeek \S.* · 更改$/,
    change: "更改模型",
    recommended: / · 推荐$/,
  },
} as const;

for (const { width, height } of [
  { width: 900, height: 560 },
  { width: 1440, height: 900 },
]) {
  test(`at first run the key form asks only for the key: the model is one line with Change under it, Change opens the list in place by mouse or keyboard, and Esc puts the line back; in English and Chinese, ${width}px wide (#1575)`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, width, height);
      await acceptPlainTextKeys(window);
      for (const value of ["en", "zh-CN"] as const) {
        const words = MODEL_LINE[value];
        await language(window, value);
        const card = await openKeyForm(window);
        await openServiceList(window, card);
        const form = card.getByTestId("provider-form");
        const key = form.locator('input[type="password"]');
        const line = form.getByTestId("provider-model-line");
        const change = form.getByTestId("provider-model-change");
        const picker = form.getByTestId("provider-model");

        await expect(line).toHaveText(words.line);
        await expect(picker).toHaveCount(0);
        await expect(change).toHaveAccessibleName(words.change);
        // One line, under the key and inside the form, at any width.
        expect(await expectDotsBetweenParts(line)).toBe(false);
        const [keyBox, lineBox, formBox] = await Promise.all([
          key.boundingBox(),
          line.boundingBox(),
          form.boundingBox(),
        ]);
        if (!keyBox || !lineBox || !formBox) throw new Error("The key form isn't laid out.");
        expect(lineBox.y).toBeGreaterThanOrEqual(keyBox.y + keyBox.height);
        expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(formBox.x + formBox.width + 0.5);
        if (process.env.INCARNAMIND_SCREENSHOTS) {
          await window.screenshot({
            path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-form-model-line-${width}-${value}.png`,
          });
        }

        // The keyboard reaches Change after the key's help, and Enter opens the list where the line was.
        await form.getByTestId("provider-key-help-toggle").focus();
        await window.keyboard.press("Tab");
        await expect(change).toBeFocused();
        await window.keyboard.press("Enter");
        await expect(picker).toBeFocused();
        await expect(picker).toHaveValue(defaultModel(words.catalogId));
        await expect(line).toHaveCount(0);
        // Esc closes the list, not the card: the line is back, with the focus on Change.
        await window.keyboard.press("Escape");
        await expect(line).toHaveText(words.line);
        await expect(change).toBeFocused();
        await expect(card.getByTestId("provider-form-title")).toBeVisible();

        await pointAndClick(window, change);
        await expect(picker).toBeFocused();
        await expect(picker.locator("option").first()).toHaveText(words.recommended);
        if (process.env.INCARNAMIND_SCREENSHOTS) {
          await window.screenshot({
            path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-form-model-open-${width}-${value}.png`,
          });
        }
        await pointAndClick(window, card.getByTestId("setup-back"));
      }
    } finally {
      await app.close();
    }
  });
}

for (const { value, next, catalogId } of [
  { value: "en", next: "OpenAI", catalogId: "openai" },
  { value: "zh-CN", next: "通义千问", catalogId: "qwen" },
] as const) {
  test(`choosing another provider after Change puts the model back as a line, for that provider's default (${value}, #1575)`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 900);
      await acceptPlainTextKeys(window);
      await language(window, value);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      const line = form.getByTestId("provider-model-line");
      const picker = form.getByTestId("provider-model");
      const before = await line.innerText();

      await pointAndClick(window, form.getByTestId("provider-model-change"));
      await expect(picker).toBeFocused();
      await expect(line).toHaveCount(0);

      const chip = form.getByRole("radio", { name: next, exact: true });
      await pointAndClick(window, chip.locator("xpath=ancestor::label"));
      await expect(chip).toBeChecked();
      await expect(line).toBeVisible();
      await expect(line).not.toHaveText(before);
      await expect(picker).toHaveCount(0);
      // Change opens the list again, on the new provider's default.
      await pointAndClick(window, form.getByTestId("provider-model-change"));
      await expect(picker).toHaveValue(defaultModel(catalogId));

      // A model typed under "Another model…" belongs to the provider it was typed for.
      await picker.selectOption({ index: (await picker.locator("option").count()) - 1 });
      const typed = form.getByTestId("provider-model-text");
      await typed.fill("a-model-of-the-first-provider");
      const third = form.getByRole("radio", {
        name: value === "en" ? "Google" : "Kimi",
        exact: true,
      });
      await pointAndClick(window, third.locator("xpath=ancestor::label"));
      await expect(third).toBeChecked();
      await expect(line).toBeVisible();
      await expect(typed).toHaveCount(0);
      await expect(picker).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

for (const value of ["en", "zh-CN"] as const) {
  test(`saving a key without touching the model saves the provider's default, by mouse in English and by the keyboard in Chinese (${value}, #1575)`, async () => {
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    try {
      await setWindowSize(app, window, 1100, 900);
      await acceptPlainTextKeys(window);
      await language(window, value);
      const { catalogId } = MODEL_LINE[value];
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      await expect(form.getByRole("radio", { checked: true })).toHaveValue(catalogId);
      await expect(form.getByLabel(/^API /)).toBeFocused();
      await window.keyboard.insertText(value === "en" ? KEYS.anthropic : KEYS.bare);
      if (value === "en") await pointAndClick(window, form.getByTestId("provider-use-key"));
      else await window.keyboard.press("Enter");
      await expect(card.getByTestId("setup-ready-title")).toBeVisible();
      const chatModel = await window.evaluate(
        async () =>
          (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings())
            .user.chatModel,
      );
      expect(chatModel?.modelId).toBe(defaultModel(catalogId));
    } finally {
      await app.close();
    }
  });
}

test("Where do I find it? opens with the keyboard, and holds the notes, the steps, the key line and the key page, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    // The first provider is Anthropic in English, which has all four; DeepSeek in Chinese, with no note and no key line.
    for (const [value, count, keyPage] of [
      ["en", 1, "Open Anthropic’s key page ↗"],
      ["zh-CN", 0, "打开 DeepSeek 的密钥页面 ↗"],
    ] as const) {
      await language(window, value);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      const help = form.getByTestId("provider-key-help");
      await expect(help).not.toHaveAttribute("open", "");
      await form.locator('input[type="password"]').focus();
      await window.keyboard.press("Tab");
      await expect(form.getByTestId("provider-key-help-toggle")).toBeFocused();
      await window.keyboard.press("Enter");
      await expect(help).toHaveAttribute("open", "");
      await expect(help.getByTestId("provider-note")).toHaveCount(count);
      await expect(help.locator("ol > li")).toHaveCount(3);
      await expect(help.getByTestId("provider-key-line")).toHaveCount(count);
      await expect(help.getByTestId("provider-key-link")).toHaveText(keyPage);
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await window.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-help-open-${value}.png`,
        });
      }
      // The notes come first, then the steps, then the key line, then the key page.
      const order = await help.evaluate((element) =>
        [
          ...element.querySelectorAll(
            "[data-testid=provider-note], ol, [data-testid=provider-key-line], [data-testid=provider-key-link]",
          ),
        ].map((each) => each.getAttribute("data-testid") ?? each.tagName),
      );
      expect(order).toEqual(
        count
          ? ["provider-note", "OL", "provider-key-line", "provider-key-link"]
          : ["OL", "provider-key-link"],
      );
      // At first run the notes and the key line are in the disclosure only, and the model has no docs link.
      await expect(form.getByTestId("provider-note")).toHaveCount(count);
      await expect(form.getByTestId("provider-key-line")).toHaveCount(count);
      await expect(form.getByTestId("provider-docs-link")).toHaveCount(0);
      await window.keyboard.press("Enter");
      await expect(help).not.toHaveAttribute("open", "");
      await card.getByTestId("setup-back").click();
    }
  } finally {
    await app.close();
  }
});

test("in Settings the notes and the key line are under the key field, the steps and the key page behind Where do I find it?, and the model has a link to its models and prices; in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await language(window, "en");
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "anthropic");
    const help = form.getByTestId("provider-key-help");
    // The form opens on Anthropic, which has all of it, whichever language is chosen after.
    for (const [value, link] of [
      ["en", "Models and prices ↗"],
      ["zh-CN", "模型和价格 ↗"],
    ] as const) {
      await language(window, value);
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await settings.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-settings-${value}.png`,
        });
      }
      const note = form.getByTestId("provider-note");
      const line = form.getByTestId("provider-key-line");
      await expect(note).toBeVisible();
      await expect(line).toBeVisible();
      // One column with the hint lines' own spacing, no more.
      const [noteBox, lineBox] = await Promise.all([note.boundingBox(), line.boundingBox()]);
      expect((lineBox?.y ?? 0) - ((noteBox?.y ?? 0) + (noteBox?.height ?? 0))).toBeLessThanOrEqual(
        4,
      );
      await expect(help.locator("ol")).toBeHidden();
      await expect(form.getByTestId("provider-docs-link")).toHaveText(link);
      await expect(form.getByTestId("provider-docs-link")).toHaveAttribute("href", /^https:\/\//);
    }
    // The link ends the model's line, after Change; once Change opens the list, it heads the list:
    // Tab goes from one to the other.
    const docs = form.getByTestId("provider-docs-link");
    const change = form.getByTestId("provider-model-change");
    const [docsOnLine, changeBox] = await Promise.all([docs.boundingBox(), change.boundingBox()]);
    expect(docsOnLine?.x ?? 0).toBeGreaterThan((changeBox?.x ?? 0) + (changeBox?.width ?? 0));
    await change.focus();
    await window.keyboard.press("Tab");
    await expect(docs).toBeFocused();
    await window.keyboard.press("Shift+Tab");
    await window.keyboard.press("Enter");
    const picker = form.getByTestId("provider-model");
    await expect(picker).toBeFocused();
    const [docsBox, pickerBox] = await Promise.all([docs.boundingBox(), picker.boundingBox()]);
    expect(docsBox?.y ?? 0).toBeLessThan(pickerBox?.y ?? 0);
    await docs.focus();
    await window.keyboard.press("Tab");
    await expect(picker).toBeFocused();
    await help.getByTestId("provider-key-help-toggle").click();
    await expect(help.locator("ol > li")).toHaveCount(3);
    await expect(help.getByTestId("provider-note")).toHaveCount(0);
    await expect(help.getByTestId("provider-key-line")).toHaveCount(0);
    await expect(help.getByTestId("provider-key-link")).toHaveText("打开 Anthropic 的密钥页面 ↗");
  } finally {
    await app.close();
  }
});

test("a key line says what to do in IncarnaMind and links to the company's own page for the rest, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    for (const [name, en, zh] of [
      [
        "anthropic",
        "Paste an API key from the Anthropic Console. · Details ↗",
        "粘贴 Anthropic Console 中的 API 密钥。 · 详情 ↗",
      ],
      [
        "openai",
        "With a ChatGPT plan, you can use Continue with ChatGPT instead of a key. · Details ↗",
        "有 ChatGPT 订阅时，可以改用“使用 ChatGPT 继续”，无需密钥。 · 详情 ↗",
      ],
      [
        "google",
        "Paste a Gemini API key from Google AI Studio · Pricing ↗",
        "粘贴 Google AI Studio 的 Gemini API 密钥 · 价格 ↗",
      ],
      [
        "openrouter",
        "Pay per use with OpenRouter credits · Pricing ↗",
        "用 OpenRouter 额度按用量付费 · 价格 ↗",
      ],
      [
        "kimi",
        "If Kimi refuses requests, check your Kimi account · Pricing ↗",
        "如果 Kimi 拒绝请求，请检查你的 Kimi 账户 · 价格 ↗",
      ],
    ] as const) {
      await language(window, "en");
      const form = await addProviderForm(settings, name);
      const line = form.getByTestId("provider-key-line");
      await expect(line).toHaveText(en);
      await expect(line.getByRole("link")).toHaveAttribute("href", /^https:\/\//);
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await settings.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-line-${name}-en.png`,
        });
      }
      await language(window, "zh-CN");
      await expect(line).toHaveText(zh);
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await settings.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-line-${name}-zh-CN.png`,
        });
      }
      await settings.getByTestId("models-back").click();
    }
  } finally {
    await app.close();
  }
});

test("the provider's own line on what it does with the data sits under the sentence of where it goes, with a link to the page on it, in English and Chinese, at first run and in Settings", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    for (const [value, link, lead] of [
      ["en", "Data use ↗", ""],
      ["zh-CN", "条款 ↗", "数据使用："],
    ] as const) {
      await language(window, value);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const line = card.getByTestId("provider-form").getByTestId("provider-data-use");
      await expect(line).toContainText(lead);
      await expect(line.getByRole("link")).toHaveText(link);
      await expect(line.getByRole("link")).toHaveAttribute("href", /^https:\/\//);
      await card.getByTestId("setup-back").click();
    }

    await language(window, "en");
    const settings = await openSettings(window, "models");
    const line = (await addProviderForm(settings, "anthropic")).getByTestId("provider-data-use");
    await expect(line.getByRole("link")).toHaveText("Data use ↗");
    await language(window, "zh-CN");
    await expect(line).toContainText("数据使用：");
    await expect(line.getByRole("link")).toHaveText("条款 ↗");
  } finally {
    await app.close();
  }
});

test("every provider's line on what it does with the data is one line beside its link at 900px wide, in English and Chinese, at first run and in Settings", async () => {
  const { app, window } = await launchApp(dataDir);
  const hosted = CATALOG_PROVIDERS.filter(
    (each) => each.group !== "local" && each.id !== "openai-compatible",
  );
  const oneLine = (line: Locator) =>
    line.evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height < lineHeight * 1.5;
    });
  try {
    await setWindowSize(app, window, 900, 900);
    await acceptPlainTextKeys(window);
    let checked = 0;
    for (const [value, words] of [
      ["en", "en"],
      ["zh-CN", "zh"],
    ] as const) {
      await language(window, value);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      await form.getByTestId("provider-more-toggle").click();
      for (const provider of hosted.filter((each) => each.support === "first-class")) {
        await form
          .locator("label", { has: window.locator(`input[value="${provider.id}"]`) })
          .click();
        const line = form.getByTestId("provider-data-use");
        await expect(line).toContainText(provider.dataUse.summary[words]);
        expect(await oneLine(line), `${provider.id} at first run, ${value}`).toBe(true);
        checked += 1;
      }
      await card.getByTestId("setup-back").click();

      await language(window, "en");
      const settings = await openSettings(window, "models");
      await language(window, value);
      for (const provider of hosted) {
        const line = (await addProviderForm(settings, provider.id)).getByTestId(
          "provider-data-use",
        );
        await expect(line).toContainText(provider.dataUse.summary[words]);
        expect(await oneLine(line), `${provider.id} in Settings, ${value}`).toBe(true);
        await expect(line.getByRole("link")).toHaveAttribute(
          "href",
          (words === "zh" && provider.dataUse.zhUrl) || (provider.dataUse.url ?? ""),
        );
        checked += 1;
        await settings.getByTestId("models-back").click();
      }
      await language(window, "en");
      await closeSettings(window);
    }
    expect(checked).toBeGreaterThan(40);
  } finally {
    await app.close();
  }
});

test("a way that can't be used yet says why, with the next step: Ollama not running, and Use this key before a key is pasted, in English and Chinese", async () => {
  // Nothing answers where Ollama would be.
  const { app, window } = await launchApp(dataDir, { ollama: "http://127.0.0.1:9" });
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await openKeyForm(window);
    await card.getByTestId("setup-other").click();
    const local = card.getByTestId("way-local");
    await expect(local).toContainText("Needs the free Ollama app");
    await expect(local.getByTestId("ollama-get")).toHaveText("Get Ollama ↗");
    await language(window, "zh-CN");
    await expect(local).toContainText("需要免费的 Ollama 应用");
    await language(window, "en");
    await openServiceList(window, card);
    const form = card.getByTestId("provider-form");
    await expect(form.getByTestId("provider-use-key")).toBeDisabled();
    await expect(form.getByTestId("provider-use-key-why")).toHaveText("Paste the key first.");
    await form.getByLabel(/^API key/).fill("sk-ant-something");
    await expect(form.getByTestId("provider-use-key-why")).toHaveCount(0);
    await expect(form.getByTestId("provider-use-key")).toBeEnabled();
    await form.getByLabel(/^API key/).fill("");

    await language(window, "zh-CN");
    await expect(form.getByTestId("provider-use-key-why")).toHaveText("请先粘贴密钥。");
    if (process.env.INCARNAMIND_SCREENSHOTS) {
      await window.screenshot({
        path: `${process.env.INCARNAMIND_SCREENSHOTS}/why-unavailable-zh-CN.png`,
      });
    }
  } finally {
    await app.close();
  }
});

/** Made-up keys: the prefixes some services' keys all start with, and a bare sk- that names nobody. */
const KEYS = {
  anthropic: `sk-ant-api03-${"aZ3".repeat(14)}`,
  openai: `sk-proj-${"aZ3".repeat(20)}`,
  openrouter: `sk-or-v1-${"0f9a".repeat(16)}`,
  xai: `xai-${"aZ3".repeat(26)}`,
  bare: `sk-${"aZ3".repeat(16)}`,
};

const checked = (form: Locator) => form.locator('input[name$="-kind"]:checked');

for (const { value, first, other, anyway, notAnthropic, notGoogle } of [
  {
    value: "en",
    first: "Anthropic",
    other: "OpenAI",
    anyway: "Use it for Anthropic anyway",
    notGoogle:
      "This isn’t Google’s key: its keys start with AQ. or AIza. Choose the service it belongs to.",
    notAnthropic:
      "This isn’t Anthropic’s key: its keys start with sk-ant-. Choose the service it belongs to.",
  },
  {
    value: "zh-CN",
    first: "DeepSeek",
    other: "OpenAI",
    anyway: "仍用于 DeepSeek",
    notGoogle: "这不是 Google 的密钥：Google 的密钥以 AQ. 或 AIza 开头。请选择它所属的服务。",
    notAnthropic: "这不是 Anthropic 的密钥：Anthropic 的密钥以 sk-ant- 开头。请选择它所属的服务。",
  },
] as const) {
  test(`a key goes only to its own service: its prefix picks the service, a key the chosen one can't have is never sent, and nothing goes before the User agrees (${value})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 900);
      await acceptPlainTextKeys(window);
      await language(window, value);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      const key = form.locator('input[type="password"]');
      const line = form.getByTestId("provider-key-wrong");
      const useKey = form.getByTestId("provider-use-key");
      await expect(checked(form)).toHaveAccessibleName(first);

      await key.fill(KEYS.openai);
      await expect(checked(form)).toHaveAccessibleName(other);
      await expect(line).toContainText(
        value === "en" ? "This is OpenAI’s key" : "这是 OpenAI 的密钥",
      );
      await expect(line.getByTestId("provider-key-anyway")).toHaveText(anyway);
      await expect(key).toHaveValue(KEYS.openai);
      await expect(useKey).toBeEnabled();
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await window.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/key-wrong-service-${value}.png`,
        });
      }
      await line.getByTestId("provider-key-anyway").click();
      await expect(checked(form)).toHaveAccessibleName(first);
      await expect(key).toHaveValue(KEYS.openai);
      await expect(line).toHaveCount(0);
      await expect(useKey).toBeEnabled();

      await key.fill(` ${KEYS.openai} `);
      await expect(checked(form)).toHaveAccessibleName(first);
      await expect(line).toHaveCount(0);
      await expect(useKey).toBeEnabled();

      await key.fill(KEYS.openrouter);
      await expect(checked(form)).toHaveAccessibleName("OpenRouter");

      // xAI is under More… with every other provider, so its key picks it too.
      await key.fill(KEYS.xai);
      await expect(line).toContainText(value === "en" ? "This is xAI’s key" : "这是 xAI 的密钥");
      await expect(checked(form)).toHaveAccessibleName("xAI");
      await expect(useKey).toBeEnabled();
      await line.getByTestId("provider-key-anyway").click();
      await expect(checked(form)).toHaveAccessibleName("OpenRouter");
      await expect(line).toHaveCount(0);
      await key.fill(`${KEYS.xai}x`);
      await expect(checked(form)).toHaveAccessibleName("xAI");
      await expect(line).toHaveCount(1);

      await form.getByRole("radio", { name: "Anthropic" }).check({ force: true });
      await key.fill(KEYS.bare);
      await expect(line).toHaveText(notAnthropic);
      await expect(line.getByTestId("provider-key-anyway")).toHaveCount(0);
      await expect(useKey).toBeDisabled();
      await key.press("Enter");
      await expect(form.getByTestId("connection-test")).toHaveCount(0);
      await expect(useKey).toHaveText(value === "en" ? "Use this key" : "使用这个密钥");

      await form.getByRole("radio", { name: "Google" }).check({ force: true });
      await expect(key).toHaveValue(KEYS.bare);
      await expect(line).toHaveText(notGoogle);
      await expect(useKey).toBeDisabled();

      await form.getByRole("radio", { name: "DeepSeek" }).check({ force: true });
      await expect(key).toHaveValue(KEYS.bare);
      await expect(line).toHaveCount(0);
      await expect(useKey).toBeEnabled();

      await key.fill("not-a-key-at-all");
      await expect(line).toHaveCount(0);
      await expect(useKey).toBeEnabled();
    } finally {
      await app.close();
    }
  });
}

test("Kimi's form opens on the region of the interface's language: International in English, China in Chinese", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    for (const [value, region] of [
      ["en", "intl"],
      ["zh-CN", "cn"],
    ] as const) {
      await language(window, value);
      const form = await addProviderForm(settings, "kimi");
      await expect(regionOf(form)).toHaveValue(region);
      await settings.getByTestId("models-back").click();
    }
  } finally {
    await app.close();
  }
});

test("a key refused on the chosen region says which host refused it, in English and Chinese, and only that host is asked (#1650)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    await acceptPlainTextKeys(window);
    await app.evaluate(() => {
      const asked: string[] = [];
      (globalThis as unknown as { askedMoonshot: string[] }).askedMoonshot = asked;
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (!/^(api\.moonshot\.|dashscope)/.test(url.host)) return original(input, init);
        if (url.host.startsWith("api.moonshot.")) asked.push(url.host);
        return Promise.resolve(
          Response.json({ error: { message: "Invalid Authentication" } }, { status: 401 }),
        );
      };
    });
    const askedMoonshot = () =>
      app.evaluate(() => (globalThis as unknown as { askedMoonshot: string[] }).askedMoonshot);

    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "kimi");
    const refused = form.getByTestId("connection-test");
    await form.getByLabel(/^API key/).fill(KEYS.bare);
    await form.getByTestId("provider-use-key").click();
    await expect(refused).toContainText(
      "International: api.moonshot.ai refused this key. Check it on platform.kimi.ai.",
    );
    await language(window, "zh-CN");
    await expect(refused).toContainText(
      "国际：api.moonshot.ai 拒绝了这个密钥。请到 platform.kimi.ai 检查。",
    );
    await language(window, "en");
    expect(new Set(await askedMoonshot())).toEqual(new Set(["api.moonshot.ai"]));

    // The button sends the same key to the other region; refused there too, the line offers the first again.
    const sent = (await askedMoonshot()).length;
    await form.getByTestId("provider-send-other-region").click();
    await expect(refused).toContainText("China: api.moonshot.cn refused this key.");
    await expect(form.getByTestId("provider-send-other-region")).toHaveText(
      "Send it to International",
    );
    expect(new Set((await askedMoonshot()).slice(sent))).toEqual(new Set(["api.moonshot.cn"]));

    await app.evaluate(() => {
      (globalThis as unknown as { askedMoonshot: string[] }).askedMoonshot.length = 0;
    });
    await form.getByRole("radio", { name: "China" }).check({ force: true });
    await form.getByLabel(/^API key/).fill(KEYS.bare);
    await form.getByTestId("provider-use-key").click();
    await expect(refused).toContainText(
      "China: api.moonshot.cn refused this key. Check it on platform.kimi.com.",
    );
    expect(new Set(await askedMoonshot())).toEqual(new Set(["api.moonshot.cn"]));

    // A region's own label may carry brackets: the line does not wrap it in more.
    await settings.getByTestId("models-back").click();
    const qwen = await addProviderForm(settings, "qwen");
    await qwen.getByLabel(/^API key/).fill(KEYS.bare);
    await qwen.getByTestId("provider-use-key").click();
    await expect(qwen.getByTestId("connection-test")).toContainText(
      "China (Beijing): dashscope.aliyuncs.com refused this key. Check it on bailian.console.aliyun.com.",
    );
  } finally {
    await app.close();
  }
});

/** Each region's host, as the catalog has it: the tests never spell a host the app doesn't. */
const hostOfRegion = (catalogId: string, region: string) => {
  const endpoint = CATALOG_PROVIDERS.find((each) => each.id === catalogId)?.endpoints.find(
    (each) => each.id === region,
  );
  if (!endpoint) throw new Error(`${catalogId} has no ${region} endpoint.`);
  return new URL(endpoint.baseUrl).host;
};

/** Picks a provider's chip on the setup card's key form, opening More… when it is under it. */
async function chooseProvider(form: Locator, catalogId: string) {
  const radio = form.locator(`input[name$="-kind"][value="${catalogId}"]`);
  if ((await radio.count()) === 0) await form.getByTestId("provider-more-toggle").click();
  await form
    .locator("label", { has: form.page().locator(`input[name$="-kind"][value="${catalogId}"]`) })
    .click();
}

/**
 * Stands in for the providers' hosts: each host in `accepts` takes only its own key and refuses
 * every other; the hosts it was asked, in order, are read back with `hostsAsked`.
 */
async function standInForHosts(app: ElectronApplication, accepts: Record<string, string>) {
  await app.evaluate((_electron, accepted) => {
    const asked: string[] = [];
    (globalThis as unknown as { askedHosts: string[] }).askedHosts = asked;
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const wanted = accepted[url.host];
      if (wanted === undefined) return original(input, init);
      asked.push(url.host);
      const sent = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
      if (sent.get("authorization") !== `Bearer ${wanted}`) {
        return Promise.resolve(
          Response.json({ error: { message: "Invalid Authentication" } }, { status: 401 }),
        );
      }
      if (url.pathname.endsWith("/models")) {
        return Promise.resolve(Response.json({ data: [{ id: "a-model" }] }));
      }
      return Promise.resolve(
        Response.json({
          id: "chat_1",
          object: "chat.completion",
          created: 1_790_000_000,
          model: "a-model",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    };
  }, accepts);
}

const hostsAsked = (app: ElectronApplication) =>
  app.evaluate(() => [...(globalThis as unknown as { askedHosts: string[] }).askedHosts]);

const savedRegions = (window: Page, catalogId: string) =>
  window.evaluate(async (id) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.listChatProviders())
      .filter((each) => (each.catalogId ?? each.kind) === id)
      .map((each) => each.endpoint);
  }, catalogId);

const TWO_REGIONS = ["kimi", "qwen", "glm", "siliconflow"] as const;

const REGION_WORDS = {
  en: { cn: "China", intl: "International" },
  "zh-CN": { cn: "中国", intl: "国际" },
} as const;

test("a provider with a region in each shows one inline choice, Region: International | China, that opens on the interface language's region; a provider with one shows none", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    await acceptPlainTextKeys(window);
    const card = await openKeyForm(window);
    await openServiceList(window, card);
    const form = card.getByTestId("provider-form");
    const group = form.getByTestId("provider-region");
    for (const [value, opens, words] of [
      ["en", "intl", { label: "Region", intl: "International", cn: "China" }],
      ["zh-CN", "cn", { label: "区域", intl: "国际", cn: "中国" }],
    ] as const) {
      await language(window, value);
      for (const id of TWO_REGIONS) {
        await chooseProvider(form, id);
        await expect(group, `${id}, ${value}`).toBeVisible();
        await expect(group).toHaveText(
          `${words.label}${words.intl}${words.cn}`.replace(/\s+/g, ""),
        );
        await expect(regionOf(form), `${id}, ${value}`).toHaveValue(opens);
        await expect(group).toHaveAccessibleName(words.label);
        const boxes = await group
          .locator("label")
          .evaluateAll((labels) => labels.map((each) => each.getBoundingClientRect()));
        expect(boxes.length).toBe(2);
        expect(
          Math.abs((boxes[0]?.top ?? 0) - (boxes[1]?.top ?? 1)),
          `${id} on one line`,
        ).toBeLessThan(2);
      }
      await chooseProvider(form, "anthropic");
      await expect(group).toHaveCount(0);
      await chooseProvider(form, "openrouter");
      await expect(group).toHaveCount(0);
    }
  } finally {
    await app.close();
  }
});

for (const { id, tongue, made } of [
  { id: "kimi", tongue: "zh-CN", made: "intl" },
  { id: "kimi", tongue: "en", made: "cn" },
  { id: "qwen", tongue: "en", made: "cn" },
  { id: "qwen", tongue: "zh-CN", made: "intl" },
  { id: "glm", tongue: "en", made: "cn" },
  { id: "glm", tongue: "zh-CN", made: "intl" },
  { id: "siliconflow", tongue: "en", made: "cn" },
  { id: "siliconflow", tongue: "zh-CN", made: "intl" },
] as const) {
  const opens = tongue === "en" ? "intl" : "cn";
  test(`a ${id} key made in ${made === "cn" ? "China" : "International"} works with the interface in ${tongue === "en" ? "English" : "Chinese"}: the form's region refuses it, says where, and the button sends it to the other region on purpose`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 900, 900);
      await acceptPlainTextKeys(window);
      await language(window, tongue);
      const theKey = `${id}-key-made-in-${made}`;
      await standInForHosts(app, {
        [hostOfRegion(id, made)]: theKey,
        [hostOfRegion(id, opens)]: "another-key",
      });
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      await chooseProvider(form, id);
      await expect(regionOf(form)).toHaveValue(opens);

      await form.getByLabel(/^(API key|API 密钥)/).fill(theKey);
      await pointAndClick(window, form.getByTestId("provider-use-key"));
      const refused = form.getByTestId("connection-test");
      await expect(refused).toContainText(hostOfRegion(id, opens));
      await expect(refused).toContainText(tongue === "en" ? "refused this key" : "拒绝了这个密钥");
      const send = form.getByTestId("provider-send-other-region");
      const other = REGION_WORDS[tongue][made];
      await expect(send).toHaveText(tongue === "en" ? `Send it to ${other}` : `发送到${other}区域`);
      await expect(send).toHaveAccessibleName(
        new RegExp(hostOfRegion(id, made).replaceAll(".", "\\.")),
      );
      // Refused, it went to the host the form held and to no other.
      expect(new Set(await hostsAsked(app))).toEqual(new Set([hostOfRegion(id, opens)]));
      expect(await savedRegions(window, id)).toEqual([]);

      // A key edited after a refusal is not refused yet: the line and its button go, and nothing is sent.
      const field = form.getByLabel(/^(API key|API 密钥)/);
      const asked = (await hostsAsked(app)).length;
      await field.fill(`${theKey}x`);
      await expect(send).toHaveCount(0);
      await expect(refused).toHaveCount(0);
      expect((await hostsAsked(app)).length).toBe(asked);
      await field.fill(theKey);
      await pointAndClick(window, form.getByTestId("provider-use-key"));
      await expect(send).toBeVisible();

      const before = (await hostsAsked(app)).length;
      if (tongue === "zh-CN") {
        // By keyboard: the button is the next stop after Use this key, and Enter presses it.
        await form.getByTestId("provider-use-key").focus();
        await window.keyboard.press("Tab");
        await expect(send).toBeFocused();
        await window.keyboard.press("Enter");
      } else {
        await pointAndClick(window, send);
      }
      await expect.poll(() => savedRegions(window, id)).toEqual([made]);
      await expect(regionOf(form)).toHaveCount(0);
      const after = (await hostsAsked(app)).slice(before);
      expect(after.length).toBeGreaterThan(0);
      expect(new Set(after)).toEqual(new Set([hostOfRegion(id, made)]));
    } finally {
      await app.close();
    }
  });
}

test("a region picked by hand before sending keeps the typed key and decides the host of every request; nothing goes to the other host", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    await acceptPlainTextKeys(window);
    const theKey = "kimi-key-made-in-china";
    await standInForHosts(app, {
      [hostOfRegion("kimi", "cn")]: theKey,
      [hostOfRegion("kimi", "intl")]: "another-key",
    });
    const card = await openKeyForm(window);
    await openServiceList(window, card);
    const form = card.getByTestId("provider-form");
    await chooseProvider(form, "kimi");
    await expect(regionOf(form)).toHaveValue("intl");
    const field = form.getByLabel(/^API key/);
    await field.fill(theKey);
    await pointAndClick(window, form.getByRole("radio", { name: "China" }).locator(".."));
    await expect(regionOf(form)).toHaveValue("cn");
    await expect(field).toHaveValue(theKey);
    expect(await hostsAsked(app)).toEqual([]);

    // The arrow keys move the choice, as in any group of radio buttons, and keep the key too.
    await regionOf(form).focus();
    await window.keyboard.press("ArrowLeft");
    await expect(regionOf(form)).toHaveValue("intl");
    await window.keyboard.press("ArrowRight");
    await expect(regionOf(form)).toHaveValue("cn");
    await expect(field).toHaveValue(theKey);

    await pointAndClick(window, form.getByTestId("provider-use-key"));
    await expect.poll(() => savedRegions(window, "kimi")).toEqual(["cn"]);
    expect(new Set(await hostsAsked(app))).toEqual(new Set([hostOfRegion("kimi", "cn")]));
    expect(await form.getByTestId("provider-send-other-region").count()).toBe(0);
  } finally {
    await app.close();
  }
});

test("a key that names another service, then Use it anyway, brings back the service and the region picked by hand", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 900, 900);
    await acceptPlainTextKeys(window);
    const card = await openKeyForm(window);
    await openServiceList(window, card);
    const form = card.getByTestId("provider-form");
    await chooseProvider(form, "kimi");
    await expect(regionOf(form)).toHaveValue("intl");
    await pointAndClick(window, form.getByRole("radio", { name: "China" }).locator(".."));
    await expect(regionOf(form)).toHaveValue("cn");

    await form.getByLabel(/^API key/).fill(KEYS.anthropic);
    await expect(checked(form)).toHaveAccessibleName("Anthropic");
    await expect(form.getByTestId("provider-region")).toHaveCount(0);
    await pointAndClick(window, form.getByTestId("provider-key-anyway"));
    await expect(checked(form)).toHaveAccessibleName(/^Kimi/);
    await expect(regionOf(form)).toHaveValue("cn");
  } finally {
    await app.close();
  }
});

for (const height of [560, 700]) {
  test(`in a window ${height}px high, the line that explains the grey button is in view, not under the card's foot`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 900, height);
      await acceptPlainTextKeys(window);
      const card = await openKeyForm(window);
      await openServiceList(window, card);
      const form = card.getByTestId("provider-form");
      const key = form.locator('input[type="password"]');
      // The card scrolled so the key field sits just above the foot: what comes under it is hidden by it.
      await key.focus();
      await card.evaluate(
        (element, fieldBottom) => {
          const foot = element.querySelector("[data-setup-foot]")?.getBoundingClientRect();
          if (foot) element.scrollTop += fieldBottom - foot.top + 4;
        },
        await key.boundingBox().then((box) => (box ? box.y + box.height : 0)),
      );
      await window.keyboard.insertText(KEYS.bare);
      const line = form.getByTestId("provider-key-wrong");
      await expect(line).toBeVisible();
      await expect(form.getByTestId("provider-use-key")).toBeDisabled();
      await expect(line).toBeInViewport({ ratio: 1 });
      await expect
        .poll(async () => {
          const lineBox = await line.boundingBox();
          const foot = await form.locator("[data-setup-foot]").boundingBox();
          if (!lineBox || !foot) return null;
          return lineBox.y + lineBox.height <= foot.y + 1 || lineBox.y >= foot.y + foot.height - 1;
        })
        .toBe(true);
    } finally {
      await app.close();
    }
  });
}

for (const { value, line, chips, titles } of [
  {
    value: "en",
    line: "OpenAI, Anthropic, Google, OpenRouter and xAI keys are recognized here.",
    chips: ["Anthropic", "OpenAI", "Google", "DeepSeek", "Kimi", "Qwen"],
    titles: ["Anthropic", "OpenAI", "Google", "DeepSeek", "Kimi"],
  },
  {
    value: "zh-CN",
    line: "在这里可以识别 OpenAI、Anthropic、Google、OpenRouter 和 xAI 的密钥。",
    chips: ["DeepSeek", "通义千问", "Kimi", "智谱 GLM", "Anthropic", "OpenAI", "Google"],
    titles: ["DeepSeek", "通义千问", "Kimi", "智谱 GLM"],
  },
] as const) {
  test(`first run names the key forms it recognises and hands the rest to the service list, whose chips and key forms all open in one step (${value})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 900);
      await acceptPlainTextKeys(window);
      await language(window, value);
      const card = await openKeyForm(window);
      await expect(card.getByTestId("setup-key-line")).toHaveText(line);
      const field = card.getByTestId("setup-key");
      await field.fill("a-key-from-no-known-service");
      await field.press("Enter");
      await expect(card.getByTestId("setup-key-unrecognised")).toBeVisible();
      await card.getByTestId("setup-key-choose-service").click();
      const form = card.getByTestId("provider-form");
      const row = form.getByRole("radio");
      await expect(row).toHaveCount(chips.length);
      for (const [index, name] of chips.entries()) {
        await expect(row.nth(index)).toHaveAccessibleName(name);
      }
      for (const name of titles) {
        await form.getByRole("radio", { name, exact: true }).check({ force: true });
        await expect(card.getByTestId("provider-form-title")).toContainText(name);
        await expect(form.locator('input[type="password"]')).toBeVisible();
        await expect(checked(form)).toHaveAccessibleName(name);
      }
    } finally {
      await app.close();
    }
  });
}

test("in Settings, a key that is not the page's service goes nowhere on Add a provider and on a provider's page, and the page stays the provider's", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "anthropic");
    const key = form.locator('input[type="password"]');
    const line = form.getByTestId("provider-key-wrong");
    const useKey = form.getByTestId("provider-use-key");
    const title = settings.getByTestId("provider-page-title");

    await key.fill(KEYS.openai);
    await expect(line).toContainText("This is OpenAI’s key");
    await expect(title).toHaveText("Anthropic");
    await expect(useKey).toBeDisabled();
    await key.press("Enter");
    await expect(form.getByTestId("connection-test")).toHaveCount(0);
    await key.fill(KEYS.bare);
    await expect(line).toHaveText("This isn’t Anthropic’s key: its keys start with sk-ant-.");
    await expect(useKey).toBeDisabled();
    await key.fill(KEYS.openai);
    await line.getByTestId("provider-key-anyway").click();
    await expect(line).toHaveCount(0);
    await expect(useKey).toBeEnabled();
    await expect(title).toHaveText("Anthropic");
    await key.fill(KEYS.anthropic);
    await expect(line).toHaveCount(0);
    await expect(useKey).toBeEnabled();
    await settings.getByTestId("models-back").click();

    const saved = await window.evaluate(async (apiKey) => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({ kind: "anthropic", apiKey, modelId: "claude-haiku-5-5" });
    }, KEYS.anthropic);
    await settings.getByTestId("provider-row").first().click();
    const page = settings.getByTestId("provider-page");
    await expect(page).toHaveAttribute("data-provider-id", saved.id);
    const pageKey = page.getByTestId("provider-page-key");
    const save = page.getByTestId("provider-page-save-key");
    await pageKey.fill(KEYS.bare);
    await expect(page.getByTestId("provider-key-wrong")).toHaveText(
      "This isn’t Anthropic’s key: its keys start with sk-ant-.",
    );
    await expect(save).toBeDisabled();
    await pageKey.press("Enter");
    await expect(page.getByTestId("provider-page-key-error")).toHaveCount(0);
    await pageKey.fill(KEYS.openai);
    await expect(page.getByTestId("provider-key-wrong")).toContainText("This is OpenAI’s key");
    await expect(save).toBeDisabled();
    await page.getByTestId("provider-key-anyway").click();
    await expect(save).toBeEnabled();
    await pageKey.fill(KEYS.anthropic);
    await expect(page.getByTestId("provider-key-wrong")).toHaveCount(0);
    await expect(save).toBeEnabled();
  } finally {
    await app.close();
  }
});

test("Kimi is listed under International and under China, and each opens its form on that region (#1348)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    const settings = await openSettings(window, "models");
    const region = (form: Locator) => regionOf(form);
    const open = async (group: string) => {
      await settings.getByTestId("models-add-provider").click();
      await settings.getByTestId("provider-directory-search").fill("kimi");
      const tiles = settings.locator(
        `[data-testid="provider-directory-group"][data-group="${group}"]`,
      );
      await tiles.locator('[data-catalog-id="kimi"]').click();
      return region(settings.getByTestId("provider-add").getByTestId("provider-form"));
    };

    await settings.getByTestId("models-add-provider").click();
    await settings.getByTestId("provider-directory-search").fill("kimi");
    await expect(settings.getByTestId("provider-directory-group")).toHaveCount(2);
    await expect(settings.getByTestId("provider-directory-group").first()).toHaveAttribute(
      "data-group",
      "international",
    );
    await settings.getByTestId("models-back").click();

    await expect(await open("international")).toHaveValue("intl");
    await settings.getByTestId("models-back").click();
    await expect(await open("china")).toHaveValue("cn");
    await settings.getByTestId("models-back").click();

    await language(window, "zh-CN");
    await settings.getByTestId("models-add-provider").click();
    await settings.getByTestId("provider-directory-search").fill("kimi");
    await expect(settings.getByTestId("provider-directory-group")).toHaveCount(2);
    await settings.getByTestId("models-back").click();
    await expect(await open("international")).toHaveValue("intl");
    await settings.getByTestId("models-back").click();
    // Popular, in Chinese, is Kimi's own region.
    await expect(await open("popular")).toHaveValue("cn");
  } finally {
    await app.close();
  }
});

test("with Kimi saved on China, only the China tile says Added and opens it, and International opens an empty form (#1348)", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const saved = await window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return core.saveChatProvider({
        kind: "kimi",
        endpoint: "cn",
        apiKey: "sk-not-real",
        modelId: "kimi-k2.6",
      });
    });
    const settings = await openSettings(window, "models");
    const tile = (group: string) =>
      settings.locator(
        `[data-testid="provider-directory-group"][data-group="${group}"] [data-catalog-id="kimi"]`,
      );
    const directory = async () => {
      await settings.getByTestId("models-add-provider").click();
      await settings.getByTestId("provider-directory-search").fill("kimi");
    };

    await directory();
    await expect(tile("china")).toContainText("Added");
    await expect(tile("international")).not.toContainText("Added");
    await tile("international").click();
    const form = settings.getByTestId("provider-add").getByTestId("provider-form");
    await expect(regionOf(form)).toHaveValue("intl");
    await expect(form.getByLabel(/^API key/)).toHaveValue("");
    await settings.getByTestId("models-back").click();

    await directory();
    await tile("china").click();
    await expect(settings.getByTestId("provider-page")).toHaveAttribute(
      "data-provider-id",
      saved.id,
    );
  } finally {
    await app.close();
  }
});

const COMPLETION = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "any",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/**
 * An OpenAI-compatible server that refuses one key and answers with the other, and answers a
 * third with Anthropic's 400 for a model that needs 30-day data retention.
 */
async function server(): Promise<{ server: Server; url: string }> {
  const http = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.headers.authorization === "Bearer locked-key") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "In order to access this model, your organization or workspace must have data retention enabled.",
            },
          }),
        );
        return;
      }
      const good = request.headers.authorization === "Bearer good-key";
      response.writeHead(good ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify(good ? COMPLETION : { error: { message: "bad key" } }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { server: http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1` };
}

/** A server on this computer that needs no key: it answers every request once `answer` is called. */
async function keylessServer(): Promise<{ server: Server; url: string; answer(): void }> {
  let answer = () => {};
  const answering = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const http = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      void answering.then(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(COMPLETION));
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`;
  return { server: http, url, answer };
}

/** An address on this computer that refuses the connection: a port just freed. */
async function refusingAddress(): Promise<string> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return `http://127.0.0.1:${port}/v1`;
}

for (const { value, connect, connecting, unreachable } of [
  {
    value: "en",
    connect: "Connect server",
    connecting: "Connecting…",
    unreachable: "Couldn’t reach the server. Check its URL and your connection.",
  },
  {
    value: "zh-CN",
    connect: "连接服务器",
    connecting: "正在连接…",
    unreachable: "无法连接到服务器。请检查地址和网络连接。",
  },
] as const) {
  test(`a server that needs no key says Connect server; a refused address keeps the form for the next try (${value})`, async () => {
    const fake = await keylessServer();
    const refused = await refusingAddress();
    const { app, window } = await launchApp(dataDir);
    try {
      await setWindowSize(app, window, 1100, 900);
      const settings = await openSettings(window, "models");
      await language(window, value);
      const form = await addProviderForm(settings, "openai-compatible");
      const address = form.locator('input[type="url"]');
      const model = form.getByTestId("provider-model-text");
      const key = form.locator('input[type="password"]');
      const button = form.getByTestId("provider-use-key");
      await expect(button).toHaveText(connect);

      await address.fill(refused);
      await model.fill("any");
      await button.click();
      await expect(form.getByTestId("connection-test")).toContainText(unreachable, {
        timeout: 20_000,
      });
      await expect(address).toHaveValue(refused);
      await expect(model).toHaveValue("any");
      await expect(key).toHaveValue("");
      await expect(button).toHaveText(connect);
      if (process.env.INCARNAMIND_SCREENSHOTS) {
        await window.screenshot({
          path: `${process.env.INCARNAMIND_SCREENSHOTS}/keyless-server-refused-${value}.png`,
        });
      }

      await address.fill(fake.url);
      await button.click();
      await expect(button).toHaveText(connecting);
      await expect(button).toBeDisabled();
      fake.answer();
      await expect(form).toBeHidden();
      await expect(settings.getByTestId("provider-page-address")).toHaveText(fake.url);
    } finally {
      await app.close();
      fake.server.close();
    }
  });
}

test("Connect server shows a key the server refuses in place, and with a good one saves and the waiting Question is asked", async () => {
  const fake = await server();
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    const card = await openKeyForm(window);
    // A server the User gives is offered in Settings, not at first run (ADR-0019); saved there,
    // it answers the Question waiting in the setup card all the same.
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "openai-compatible");
    // A compatible server keeps a free-text Model.
    await expect(form.getByTestId("provider-model-text")).toBeVisible();
    await form.getByLabel("Server URL").fill(fake.url);
    await form.getByTestId("provider-model-text").fill("any");
    await form.getByLabel(/^API key/).fill("wrong-key");
    await expect(form.getByTestId("provider-use-key")).toHaveText("Connect server");
    await form.getByTestId("provider-use-key").click();
    await expect(form.getByTestId("connection-test")).toContainText("The key was refused", {
      timeout: 20_000,
    });
    await expect(card).toBeVisible();

    await form.getByLabel(/^API key/).fill("good-key");
    await form.getByTestId("provider-use-key").click();
    await expect(form).toBeHidden();
    await closeSettings(window);
    await continueSetup(window);
    // The waiting Question was asked: the conversation holds its Answer (the server only answers
    // the connection test, so how it ends is not the point).
    await expect(assistantAnswers(window).first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close();
    fake.server.close();
  }
});

test("a model that needs 30-day data retention says so with the model's name, and its action puts the cursor where the model is chosen; in English and Chinese", async () => {
  const fake = await server();
  const { app, window } = await launchApp(dataDir);
  try {
    await setWindowSize(app, window, 1100, 900);
    await acceptPlainTextKeys(window);
    await language(window, "en");
    const settings = await openSettings(window, "models");
    const form = await addProviderForm(settings, "openai-compatible");
    await form.locator('input[type="url"]').fill(fake.url);
    await form.getByTestId("provider-model-text").fill("claude-fable-5-1");
    await form.locator('input[type="password"]').fill("locked-key");
    await form.getByTestId("provider-use-key").click();
    const result = form.getByTestId("connection-test");
    await expect(result).toContainText(
      "The key works, but your organization disallows 30-day retention for claude-fable-5-1. Choose another model. · Choose another model",
      { timeout: 20_000 },
    );
    await expect(result).not.toContainText("Console");
    await language(window, "zh-CN");
    await expect(result).toContainText(
      "密钥可用，但你的组织未开启 claude-fable-5-1 所需的 30 天数据保留。请换一个模型。· 换一个模型",
    );
    await result.getByTestId("connection-test-choose-model").click();
    await expect(form.getByTestId("provider-model-text")).toBeFocused();
  } finally {
    await app.close();
    fake.server.close();
  }
});

test("the ChatGPT wait offers the sign-in page again, and after five minutes says so in place; Cancel goes back", async () => {
  const openai = await createFakeOpenAI();
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    chatGpt: openai.endpoints.issuer,
  });
  try {
    await setWindowSize(app, window, 1100, 900);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    await window.clock.install();
    const card = await openKeyForm(window);
    await card.getByTestId("setup-chatgpt").click();
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    await expect(card).toContainText("Finish signing in in your browser");
    await expect(card).toContainText("OpenAI may ask you to allow IncarnaMind.");
    await card.getByTestId("chatgpt-reopen").click();
    await expect.poll(() => urlsOpened(app)).toHaveLength(2);
    await expect(card.getByTestId("chatgpt-late")).toHaveCount(0);

    await window.clock.fastForward("05:01");
    await expect(card.getByTestId("chatgpt-late")).toHaveText(
      "Didn’t finish? Open the sign-in page again.",
    );
    await expect(window.getByTestId("chatgpt-error")).toHaveCount(0);

    await card.getByTestId("chatgpt-cancel").click();
    await expect(card.getByTestId("setup-chatgpt")).toBeVisible();
  } finally {
    await app.close();
  }
});
