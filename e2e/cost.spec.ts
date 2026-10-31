import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { openDatabase } from "../src/core/storage";
import { createFakeOpenAI, signInAt } from "../tests/helpers/fakeOpenAI";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  openSettings,
  removeDataFolder,
  setWindowSize,
  showSettingsPage,
  urlsOpened,
} from "./app";

/*
 * Cloud cost (#83): Settings → General shows what the User's keys spent this
 * month and holds one optional cap, off by default; Settings → Models shows
 * each key's month and the ChatGPT plan's own line; an Answer the cap stops
 * says so in place, and "Change cap" opens the cap. Set INCARNAMIND_SCREENSHOTS
 * to a folder to also save screenshots, narrow and wide, in English and Chinese.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const NARROW = { width: 900, height: 720 };
const WIDE = { width: 1440, height: 860 };

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const bridge = (window: Page) => ({
  language: (language: "en" | "zh-CN") =>
    window.evaluate(
      (value) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
          user: { language: value },
        }),
      language,
    ),
  /** Claude Haiku 5.5 on an Anthropic key, billed per token: choosing it allows Questions to Anthropic. */
  keyProvider: () =>
    window.evaluate(async () => {
      const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
      return provider.id;
    }),
  cap: () =>
    window.evaluate(
      async () =>
        (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings())
          .user.monthlyCap,
    ),
});

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`an invalid monthly cap keeps its draft, explains the active cap, and can be corrected or cancelled (${language})`, async () => {
    const { app, window } = await launchApp(dataDir);
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 660);
      const settings = await openSettings(window, "general");
      await bridge(window).language(language);
      const cap = settings.getByTestId("spending-cap-settings");
      const toggle = cap.getByTestId("spending-cap-switch");
      await toggle.hover();
      await toggle.click();
      const amount = cap.getByTestId("spending-cap-amount");
      const currency = cap.getByTestId("spending-cap-currency");
      const problem = cap.getByTestId("spending-cap-problem");
      const initial = {
        amount: language === "en" ? 20 : 150,
        currency: language === "en" ? "USD" : "CNY",
      };
      const message =
        language === "en"
          ? "Enter an amount from 0 to 1,000,000. The active cap is still $20.00."
          : "输入 0 到 1,000,000 之间的金额。当前上限仍为 ¥150.00。";
      await expect(amount).toHaveValue(String(initial.amount));

      await amount.fill("-1");
      await amount.press("Enter");
      await expect(problem).toHaveText(message);
      await expect(amount).toHaveValue("-1");
      await expect(amount).toHaveAttribute("aria-invalid", "true");
      await expect(amount).toHaveAttribute(
        "aria-describedby",
        (await problem.getAttribute("id")) ?? "",
      );
      expect(await bridge(window).cap()).toEqual(initial);
      await shot(window, `cap-invalid-wide-${language}`);
      await setWindowSize(app, window, 900, 560);
      await expect(problem).toBeInViewport();
      const within = await problem.evaluate((element) => {
        const row = element.parentElement?.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return row && bounds.left >= row.left && bounds.right <= row.right;
      });
      expect(within).toBe(true);
      await shot(window, `cap-invalid-narrow-${language}`);
      await amount.press("Escape");
      await expect(amount).toHaveValue(String(initial.amount));
      await expect(problem).toHaveCount(0);
      await expect(settings).toBeVisible();

      await amount.fill("-2");
      await amount.press("Tab");
      await expect(toggle).toBeFocused();
      await expect(amount).toHaveValue("-2");
      await expect(problem).toHaveText(message);
      expect(await bridge(window).cap()).toEqual(initial);
      await currency.selectOption(initial.currency === "USD" ? "CNY" : "USD");
      await expect(currency).toHaveValue(initial.currency);
      await expect(amount).toHaveValue("-2");
      await expect(problem).toHaveText(message);
      expect(await bridge(window).cap()).toEqual(initial);

      await amount.fill("1000001");
      await amount.press("Enter");
      await expect(amount).toHaveValue("1000001");
      await expect(problem).toHaveText(message);
      expect(await bridge(window).cap()).toEqual(initial);
      await amount.fill("");
      await amount.press("Tab");
      await expect(amount).toHaveValue(String(initial.amount));
      await expect(problem).toHaveCount(0);
      expect(await bridge(window).cap()).toEqual(initial);

      for (const value of [0, 12.5, 1000000]) {
        await amount.fill(String(value));
        await amount.press(value === 12.5 ? "Tab" : "Enter");
        await expect
          .poll(() => bridge(window).cap())
          .toEqual({ amount: value, currency: initial.currency });
        await expect(amount).not.toHaveAttribute("aria-invalid", "true");
        await expect(problem).toHaveCount(0);
      }
      await amount.fill("-3");
      await amount.press("Enter");
      await expect(problem).toBeVisible();
      await amount.fill("25");
      await amount.press("Enter");
      await amount.press("Enter");
      await expect
        .poll(() => bridge(window).cap())
        .toEqual({ amount: 25, currency: initial.currency });
      await expect(problem).toHaveCount(0);
      await amount.press("Escape");
      await expect(settings).toBeHidden();
      await window
        .getByRole("button", { name: language === "en" ? "Settings" : "设置", exact: true })
        .click();
      await expect(settings).toBeVisible();
      await expect(amount).toHaveValue("25");

      await amount.fill("-4");
      await amount.press("Tab");
      await expect(problem).toBeVisible();
      await toggle.press("Space");
      await expect.poll(() => bridge(window).cap()).toBeNull();
      await expect(problem).toHaveCount(0);
      await toggle.press("Space");
      await expect.poll(() => bridge(window).cap()).toEqual(initial);
      await expect(amount).toHaveValue(String(initial.amount));
    } finally {
      await app.close();
    }
  });
}

test("an Answer stopped by the monthly cap says so in place, and Change cap opens the cap; set by mouse and keyboard, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await acceptPlainTextKeys(window);
    await bridge(window).keyProvider();

    // Off by default; turned on, it starts at a first cap that can be changed in place.
    const settings = await openSettings(window, "general");
    const cap = settings.getByTestId("spending-cap-settings");
    await expect(cap).toBeVisible();
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText(
      "Nothing spent on your keys this month.",
    );
    const toggle = cap.getByTestId("spending-cap-switch");
    await expect(toggle).not.toBeChecked();
    expect(await bridge(window).cap()).toBeNull();
    await toggle.hover();
    await toggle.click();
    const amount = cap.getByTestId("spending-cap-amount");
    await expect(amount).toHaveValue("20");
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText(
      "Spent this month: $0 of $20.00 on your keys.",
    );
    await shot(window, "cap-control-wide-en");

    // Esc puts a changed amount back without closing Settings; Enter saves.
    await amount.fill("5");
    await window.keyboard.press("Escape");
    await expect(amount).toHaveValue("20");
    await expect(settings).toBeVisible();
    await amount.fill("0");
    await window.keyboard.press("Enter");
    await expect.poll(() => bridge(window).cap()).toEqual({ amount: 0, currency: "USD" });
    await closeSettings(window);

    // Asked in the assistant, the Answer is stopped before anything is sent, with one line and
    // one action.
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is in my Documents?");
    await window.keyboard.press("Enter");
    const answer = assistantAnswers(window).first();
    await expect(answer).toHaveAttribute("data-status", "failed");
    const error = answer.getByTestId("answer-error");
    await expect(error).toHaveAttribute("data-error-kind", "cost-cap");
    const line = error.getByRole("alert");
    await expect(line).toContainText("Could pass your monthly cap");
    await expect(line.getByRole("button")).toHaveText("Change cap");
    await shot(window, "cap-problem-wide-en");
    await setWindowSize(app, window, NARROW.width, NARROW.height);
    // The line keeps to one line, under the Answer, at a narrow window too.
    expect((await line.boundingBox())?.height).toBeLessThan(24);
    await shot(window, "cap-problem-narrow-en");

    // Change cap opens the cap, where it can be raised.
    await error.getByTestId("answer-error-action").click();
    await expect(settings).toHaveAttribute("data-page", "general");
    await expect(cap).toBeInViewport();
    await shot(window, "cap-control-narrow-en");
    await closeSettings(window);

    // The same in Chinese.
    await bridge(window).language("zh-CN");
    await expect(line).toContainText("可能超出你设置的每月上限");
    await expect(line.getByRole("button")).toHaveText("更改上限");
    await shot(window, "cap-problem-narrow-zh");
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await shot(window, "cap-problem-wide-zh");
    await error.getByTestId("answer-error-action").click();
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText(
      "本月 API 密钥已花费：$0，上限 $0。",
    );
    await shot(window, "cap-control-wide-zh");
    await setWindowSize(app, window, NARROW.width, NARROW.height);
    await shot(window, "cap-control-narrow-zh");
  } finally {
    await app.close();
  }
});

test("Settings → Models shows what a key spent this month, and the ChatGPT plan keeps its own line", async () => {
  const openai = await createFakeOpenAI();
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    chatGpt: openai.endpoints.issuer,
  });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await acceptPlainTextKeys(window);
    await bridge(window).keyProvider();

    // One Answer on the key: its month shows under the provider.
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is in my Documents?");
    await window.keyboard.press("Enter");
    await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done");
    const settings = await openSettings(window, "models");
    await settings.getByTestId("provider-row").first().click();
    const cost = settings.getByTestId("chat-provider-cost");
    await expect(cost).toHaveText("This month: $0 spent");
    await shot(window, "models-key-wide-en");
    await setWindowSize(app, window, NARROW.width, NARROW.height);
    await shot(window, "models-key-narrow-en");
    await bridge(window).language("zh-CN");
    await expect(cost).toHaveText("本月已花 $0");
    await shot(window, "models-key-narrow-zh");
    await bridge(window).language("en");
    await settings.getByTestId("models-back").click();

    // Signed in with ChatGPT and using the plan: its line names the plan, never a price.
    await interceptOpenExternal(app);
    const plan = settings.getByTestId("chatgpt-settings");
    await plan.getByTestId("chatgpt-continue").click();
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    const [authorize] = await urlsOpened(app);
    expect((await signInAt(openai, authorize ?? "")).status).toBe(200);
    await window.getByTestId("chatgpt-welcome-ok").click();
    await plan.getByTestId("chatgpt-use").click();
    await expect(plan.getByTestId("chatgpt-in-use")).toHaveText(
      "Using ChatGPT plan · Manage usage ↗",
    );
    await settings.getByTestId("provider-row").filter({ hasText: "ChatGPT plan" }).click();
    await expect(settings.getByTestId("provider-page-title")).toHaveText("ChatGPT plan");
    await expect(settings.getByTestId("chat-provider-cost")).toHaveCount(0);
    await settings.getByTestId("models-back").click();
    await plan.scrollIntoViewIfNeeded();
    await shot(window, "models-plan-narrow-en");
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await shot(window, "models-plan-wide-en");
    await bridge(window).language("zh-CN");
    await expect(plan.getByTestId("chatgpt-in-use")).toContainText("ChatGPT");
    await shot(window, "models-plan-wide-zh");
  } finally {
    await app.close();
    await openai.close();
  }
});

test("a request a force-quit cut short counts for nothing, and the cost line says it was interrupted, in English and Chinese (#636)", async () => {
  const first = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(first.window);
  await acceptPlainTextKeys(first.window);
  const providerId = await first.window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    return provider.id;
  });
  await first.app.close();
  // What a quit mid-request leaves: a reservation, never settled.
  const db = openDatabase(join(dataDir, "incarnamind.db"));
  const at = new Date().toISOString();
  db.run(
    `INSERT INTO model_requests (id, provider_id, model_id, flow, billing, status, currency,
       reserved, created_at, updated_at)
     VALUES ('interrupted-1', ?, 'claude-haiku-5-5', 'chat', 'per-token', 'reserved', 'USD', 0.26, ?, ?)`,
    [providerId, at, at],
  );
  db.close();

  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    const settings = await openSettings(window, "general");
    const cap = settings.getByTestId("spending-cap-settings");
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText(
      "Spent this month: $0 on your keys.",
    );
    await expect(cap.getByTestId("spending-cap-interrupted")).toHaveText(
      "1 request was interrupted; its cost isn’t known.",
    );
    await shot(window, "cost-interrupted-wide-en");
    await bridge(window).language("zh-CN");
    await expect(cap.getByTestId("spending-cap-interrupted")).toHaveText(
      "有 1 次请求被中断，费用未知。",
    );
    await shot(window, "cost-interrupted-wide-zh");
  } finally {
    await app.close();
  }
});

test("work still running is set aside apart from what was spent, and the set-aside part goes when the work ends, in English and Chinese (#891)", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await dismissChatSetup(window);
    await setWindowSize(app, window, WIDE.width, WIDE.height);
    await acceptPlainTextKeys(window);
    const providerId = await bridge(window).keyProvider();

    // One request settled at a cent, and one still open with $1.28 reserved for it.
    const db = openDatabase(join(dataDir, "incarnamind.db"));
    const at = new Date().toISOString();
    const insert = `INSERT INTO model_requests (id, provider_id, model_id, flow, billing, status,
        currency, reserved, cost, created_at, updated_at)
      VALUES (?, ?, 'claude-haiku-5-5', 'chat', 'per-token', ?, 'USD', ?, ?, ?, ?)`;
    db.run(insert, ["settled-1", providerId, "settled", 0.3, 0.01, at, at]);
    db.run(insert, ["open-1", providerId, "reserved", 1.28, null, at, at]);

    const settings = await openSettings(window, "models");
    await settings.getByTestId("provider-row").first().click();
    const cost = settings.getByTestId("chat-provider-cost");
    await expect(cost).toHaveText("This month: $0.01 spent · $1.28 set aside for work in progress");
    await expect(settings.getByTestId("chat-provider-set-aside")).toHaveAttribute(
      "title",
      "Kept aside so running work can’t go over your monthly limit",
    );
    await shot(window, "set-aside-models-wide-en");
    await showSettingsPage(window, "general");
    const cap = settings.getByTestId("spending-cap-settings");
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText(
      "Spent this month: $0.01 on your keys.",
    );
    await expect(cap.getByTestId("spending-cap-set-aside")).toHaveText(
      "$1.28 set aside for work in progress",
    );
    await shot(window, "set-aside-cap-wide-en");

    await bridge(window).language("zh-CN");
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText("本月 API 密钥已花费：$0.01。");
    await expect(cap.getByTestId("spending-cap-set-aside")).toHaveText("进行中的任务预留 $1.28");
    await expect(cap.getByTestId("spending-cap-set-aside")).toHaveAttribute(
      "title",
      "预留出来，避免进行中的任务超出你的月度上限",
    );
    await shot(window, "set-aside-cap-wide-zh");
    await showSettingsPage(window, "models");
    await expect(cost).toHaveText("本月已花 $0.01 · 进行中的任务预留 $1.28");
    await setWindowSize(app, window, NARROW.width, NARROW.height);
    await shot(window, "set-aside-models-narrow-zh");
    await bridge(window).language("en");
    await shot(window, "set-aside-models-narrow-en");
    await closeSettings(window);

    db.run("UPDATE model_requests SET status = 'settled', cost = 0.01 WHERE id = 'open-1'");
    db.close();
    await openSettings(window, "models");
    await settings.getByTestId("provider-row").first().click();
    await expect(cost).toHaveText("This month: $0.02 spent");
    await expect(settings.getByTestId("chat-provider-set-aside")).toHaveCount(0);
    await showSettingsPage(window, "general");
    await expect(cap.getByTestId("spending-cap-spent")).toHaveText(
      "Spent this month: $0.02 on your keys.",
    );
    await expect(cap.getByTestId("spending-cap-set-aside")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
