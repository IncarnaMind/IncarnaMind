import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { ClaudeAccountStatus, CoreBridge } from "../src/core/api";
import {
  ANSWER,
  createFakeAnthropic,
  type FakeAnthropic,
  type MessagesReply,
} from "../tests/helpers/fakeAnthropic";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  closeSettings,
  continueSetup,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  newMind,
  openSettings,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * "Use my Claude plan" (#872): one of the ways in beside the key in first run and a row in Settings ›
 * Models. A local stand-in for Anthropic signs in and answers; the browser is stood in for, and
 * the User pastes the code Anthropic's page shows, as they do.
 */

const USAGE = "Answers count toward your Claude plan’s usage limits.";

let dataDir: string;
let fake: FakeAnthropic;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  fake = await createFakeAnthropic();
});
test.afterEach(async () => {
  await fake.close();
  await removeDataFolder(dataDir);
});

const account = (window: Page): Promise<ClaudeAccountStatus> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getClaudeAccount(),
  );

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

/** The code Anthropic's page shows once the User approves the sign-in the app opened. */
async function codeAfterApproving(app: ElectronApplication, count: number): Promise<string> {
  await expect.poll(() => urlsOpened(app)).toHaveLength(count);
  const authorize = (await urlsOpened(app))[count - 1] ?? "";
  const { code, state } = fake.approve(authorize);
  return `${code}#${state}`;
}

/** Each box sits inside the card, so nothing is cut off at its edge. */
async function expectInside(card: Locator, parts: Locator[]) {
  const outer = await card.boundingBox();
  if (!outer) throw new Error("The card isn't laid out.");
  for (const part of parts) {
    const box = await part.boundingBox();
    if (!box) throw new Error("A part of the row isn't laid out.");
    expect(box.x).toBeGreaterThanOrEqual(outer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  }
}

test("first run: the row follows the plan, says the usage limits first before anything is sent, and the pasted code signs in and answers", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await setWindowSize(app, window, 1100, 660);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);

    await card.getByTestId("setup-other").click();
    const ways = card.locator('[data-testid="way-claude"], [data-testid="way-local"]');
    await expect(ways.first()).toHaveAttribute("data-testid", "way-claude");
    const row = card.getByTestId("way-claude");
    await expect(row.getByText("Use my Claude plan", { exact: true })).toBeVisible();
    await expect(row.getByText("Pro, Max or Team", { exact: true })).toBeVisible();
    await expect(row.getByTestId("claude-plan-notice")).toHaveCount(0);

    await row.getByTestId("way-claude-open").click();
    const notice = row.getByTestId("claude-plan-notice");
    // Two lines, the usage limits first and in weight 600, then what goes to Anthropic.
    const usage = notice.getByTestId("claude-plan-usage");
    const sends = notice.getByTestId("claude-plan-sends");
    await expect(usage).toHaveText(USAGE);
    await expect(usage).toHaveCSS("font-weight", "600");
    await expect(sends.locator("p")).toHaveText(
      "Sends your questions and document text to Anthropic. · Details",
    );
    await expect(sends).toHaveCSS("font-weight", "400");
    const [usageBox, sendsBox] = await Promise.all([usage.boundingBox(), sends.boundingBox()]);
    expect(usageBox?.y ?? 0).toBeLessThan(sendsBox?.y ?? 0);
    await expect(notice).not.toContainText("Claude Code");
    await expect(notice).not.toContainText("stays off");
    // The safe choice has the focus, and nothing has been sent.
    await expect(notice.getByTestId("claude-plan-cancel")).toBeFocused();
    expect(await urlsOpened(app)).toHaveLength(0);
    await expectInside(card, [usage, sends]);

    const details = sends.getByTestId("claude-plan-sends-details");
    await details.focus();
    await window.keyboard.press("Space");
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(sends.getByRole("listitem")).toHaveCount(4);
    await expect(sends).toContainText("each sentence you check");
    expect(await urlsOpened(app)).toHaveLength(0);
    expect(fake.tokenRequests).toHaveLength(0);
    await window.keyboard.press("Enter");
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(sends.getByRole("listitem")).toHaveCount(0);
    await expect(details).toBeFocused();

    await notice.getByTestId("claude-plan-cancel").click();
    await expect(notice).toBeHidden();
    await expect(row.getByTestId("way-claude-open")).toHaveAttribute("aria-expanded", "false");

    await row.getByTestId("way-claude-open").click();
    await row.getByTestId("claude-plan-sign-in").click();
    const code = await codeAfterApproving(app, 1);
    const waiting = row.getByTestId("claude-plan-waiting");
    await expect(waiting).toContainText("Sign in to Claude, then paste the code it shows.");
    await expect(waiting.getByTestId("claude-plan-usage")).toHaveText(USAGE);
    // The code is the way on, so its field is open, focused and named for what goes in it.
    const field = waiting.getByLabel("Code from Claude’s page");
    await expect(field).toBeFocused();
    await expect(waiting.getByTestId("claude-paste-continue")).toHaveText("Finish signing in");

    await field.fill("not a code");
    await field.press("Enter");
    await expect(waiting.getByTestId("claude-paste-problem")).toHaveText(
      "That isn’t the code from Claude’s page.",
    );
    await field.fill(code);
    await waiting.getByTestId("claude-paste-continue").click();

    await continueSetup(window);
    const answer = assistantAnswers(window).first();
    await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(answer).toContainText(ANSWER);
    expect(fake.messages.at(-1)?.headers.authorization).toMatch(/^Bearer /);
    expect((await account(window)).account).toMatchObject({ state: "signed-in" });
  } finally {
    await app.close();
  }
});

test("first run: a code Anthropic refuses says so in the row, with a key as the way back", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await card.getByTestId("setup-other").click();
    const row = card.getByTestId("way-claude");
    await row.getByTestId("way-claude-open").click();
    await row.getByTestId("claude-plan-sign-in").click();

    const code = await codeAfterApproving(app, 1);
    const [, state] = code.split("#");
    await row.getByTestId("claude-paste-address").fill(`not-the-code#${state}`);
    await row.getByTestId("claude-paste-continue").click();

    const error = row.getByTestId("claude-plan-error");
    await expect(error).toContainText("The Claude sign-in didn’t work · Use an API key instead");
    await expect(row.getByTestId("claude-plan-sign-in")).toBeVisible();
    await row.getByTestId("claude-plan-use-key").click();
    await expect(card.getByTestId("setup-key")).toBeFocused();
    expect((await account(window)).account).toEqual({ state: "signed-out" });
  } finally {
    await app.close();
  }
});

test("Settings: Cancel keeps nothing; signed in, the row names the account and Sign out forgets it; expired, Sign in again", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await setWindowSize(app, window, 1100, 660);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const row = settings.getByTestId("plans-claude-account");
    await expect(row.getByTestId("claude-plan-account")).toHaveText(USAGE);

    await row.getByTestId("plans-claude-sign-in").click();
    await expect(row.getByTestId("claude-plan-usage")).toHaveCSS("font-weight", "600");
    await row.getByTestId("claude-plan-sign-in").click();
    await expect.poll(() => urlsOpened(app)).toHaveLength(1);
    await row.getByTestId("claude-plan-cancel").click();
    await expect(row.getByTestId("claude-plan-waiting")).toBeHidden();
    await expect(row.getByTestId("plans-claude-sign-in")).toBeVisible();
    await expect(row.getByTestId("claude-plan-error")).toHaveCount(0);
    expect((await account(window)).account).toEqual({ state: "signed-out" });
    expect(fake.tokenRequests).toHaveLength(0);

    // Its tokens are due for a refresh at once, which is refused: the sign-in has expired.
    fake.expiresIn = 60;
    await row.getByTestId("plans-claude-sign-in").click();
    await row.getByTestId("claude-plan-sign-in").click();
    const code = await codeAfterApproving(app, 2);
    await row.getByTestId("claude-paste-address").fill(code);
    await row.getByTestId("claude-paste-continue").click();
    await expect(row.getByTestId("claude-plan-account")).toHaveText(
      "Signed in as reader@example.test",
    );
    await expect(row.getByTestId("claude-plan-usage")).toHaveText(USAGE);
    await expect(row.getByTestId("claude-plan-sign-out")).toBeVisible();

    fake.refuseRefresh = "invalid_grant";
    await closeSettings(window);
    await newMind(window);
    await window.getByTestId("mind-editor").click();
    await window.keyboard.press("ControlOrMeta+j");
    await window.keyboard.type("What is in my Documents?");
    await window.keyboard.press("Enter");
    await expect.poll(async () => (await account(window)).account.state).toBe("expired");

    const again = await openSettings(window, "models");
    const expired = again.getByTestId("plans-claude-account");
    await expect(expired.getByTestId("claude-plan-account")).toHaveText(
      "Your Claude sign-in has expired",
    );
    fake.refuseRefresh = null;
    fake.expiresIn = 3600;
    await expired.getByTestId("plans-claude-sign-in").click();
    // Signing in again skips the words already read, straight to the browser.
    await expect(expired.getByTestId("claude-plan-notice")).toHaveCount(0);
    const [, state] = (await codeAfterApproving(app, 3)).split("#");
    await expired.getByTestId("claude-paste-address").fill(`not-the-code#${state}`);
    await expired.getByTestId("claude-paste-continue").click();
    // A sign-in again that fails says so in the row, which stays open for another try.
    await expect(expired.getByTestId("claude-plan-error")).toContainText(
      "The Claude sign-in didn’t work",
    );
    await expired.getByTestId("claude-plan-sign-in").click();
    const third = await codeAfterApproving(app, 4);
    await expired.getByTestId("claude-paste-address").fill(third);
    await expired.getByTestId("claude-paste-continue").click();
    await expect(expired.getByTestId("claude-plan-sign-out")).toBeVisible();
    await expect(expired.getByTestId("claude-plan-error")).toHaveCount(0);

    await expired.getByTestId("claude-plan-sign-out").click();
    await expect(expired.getByTestId("plans-claude-sign-in")).toBeVisible();
    expect((await account(window)).account).toEqual({ state: "signed-out" });
  } finally {
    await app.close();
  }
});

test("a sign-in not finished in time says so in the row, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin, claudeSignInMs: 1500 });
  try {
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const settings = await openSettings(window, "models");
    const row = settings.getByTestId("plans-claude-account");
    await row.getByTestId("plans-claude-sign-in").click();
    await row.getByTestId("claude-plan-sign-in").click();
    await expect(row.getByTestId("claude-plan-waiting")).toBeVisible();

    const error = row.getByTestId("claude-plan-error");
    await expect(error).toContainText(
      "The Claude sign-in wasn’t finished in time: nothing was kept",
    );
    await expect(row.getByTestId("claude-plan-sign-in")).toBeVisible();
    expect((await account(window)).account).toEqual({ state: "signed-out" });

    await setLanguage(window, "zh-CN");
    await expect(error).toContainText("Claude 登录未在时限内完成，未保存任何内容");
  } finally {
    await app.close();
  }
});

test("⌘K: Sign in with Claude opens the words in Settings › Models, before anything is sent", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await interceptOpenExternal(app);
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("> Sign in with Claude");
    const item = window.getByTestId("palette").getByTestId("palette-item").first();
    await expect(item).toHaveText(/Sign in with Claude/);
    await window.keyboard.press("Enter");

    const settings = window.getByTestId("settings");
    await expect(settings).toHaveAttribute("data-page", "models");
    const row = settings.getByTestId("plans-claude-account");
    await expect(row.getByTestId("claude-plan-usage")).toHaveText(USAGE);
    await expect(row.getByTestId("claude-plan-cancel")).toBeFocused();
    expect(await urlsOpened(app)).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test("in Chinese: the row follows the plan and comes before a model on this computer, with the usage limits first", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await setWindowSize(app, window, 1100, 660);
    await interceptOpenExternal(app);
    await setLanguage(window, "zh-CN");
    await acceptPlainTextKeys(window);
    const card = await askFirstQuestion(window);
    await card.getByTestId("setup-other").click();
    const ways = card.locator('[data-testid="way-claude"], [data-testid="way-local"]');
    // Every plan comes before a model on this computer.
    await expect(ways.first()).toHaveAttribute("data-testid", "way-claude");
    await expect(ways.last()).toHaveAttribute("data-testid", "way-local");

    const row = card.getByTestId("way-claude");
    await expect(row).toContainText("使用我的 Claude 订阅");
    await expect(row).toContainText("Pro、Max 或 Team（中国大陆不可用）");
    await row.getByTestId("way-claude-open").click();
    const notice = row.getByTestId("claude-plan-notice");
    const usage = notice.getByTestId("claude-plan-usage");
    const sends = notice.getByTestId("claude-plan-sends");
    await expect(usage).toHaveText("回答会计入你 Claude 订阅的用量限额。");
    await expect(usage).toHaveCSS("font-weight", "600");
    await expect(sends.locator("p")).toHaveText("会把你的问题和文档内容发送给 Anthropic。 · 详情");
    await expect(row.getByTestId("claude-plan-sign-in")).toHaveText("用 Claude 账号登录");
    await expectInside(card, [usage, sends]);
    await row.getByTestId("claude-plan-sign-in").click();
    await expect(row.getByLabel("Claude 页面上的代码")).toBeFocused();
    await expect(row.getByTestId("claude-paste-continue")).toHaveText("完成登录");
  } finally {
    await app.close();
  }
});

async function signInThroughTheBridge(app: ElectronApplication, window: Page): Promise<void> {
  await acceptPlainTextKeys(window);
  await window.evaluate(() => {
    void (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.signInToClaude();
  });
  const code = await codeAfterApproving(app, 1);
  await window.evaluate(
    (pasted) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.pasteClaudeSignInAddress(
        pasted,
      ),
    code,
  );
  await expect.poll(async () => (await account(window)).account.state).toBe("signed-in");
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
      kind: "claude-account",
      modelId: "claude-sonnet-5-5",
    });
  });
}

async function askAndFail(window: Page, question: string): Promise<Locator> {
  const index = await assistantAnswers(window).count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).nth(index);
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  return answer.getByTestId("answer-error");
}

const refusal = (status: number, headers?: Record<string, string>): MessagesReply => ({
  kind: "error",
  status,
  ...(headers && { headers }),
  body: JSON.stringify({ type: "error", error: { type: "error", message: "" } }),
});

test("an Answer the Claude plan stopped says why in Claude's words, in English and Chinese, and Sign in again signs in where the code goes", async () => {
  // Every request refreshes first, so a refused refresh can end the sign-in when the test says.
  fake.expiresIn = 60;
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await setWindowSize(app, window, 1100, 800);
    await interceptOpenExternal(app);
    await signInThroughTheBridge(app, window);
    await newMind(window);
    await window.getByTestId("mind-editor").click();

    const limit = refusal(429, {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
    });
    fake.replies = [limit, limit, limit];
    const limited = await askAndFail(window, "What does the lease say about rent?");
    await expect(limited).toHaveText(
      "Your Claude plan’s usage limit is reached · Use another model",
    );

    fake.replies = [refusal(403), refusal(403), refusal(403)];
    const refused = await askAndFail(window, "When does the lease end?");
    await expect(refused).toHaveText("Claude refused this sign-in · Use an API key instead");

    fake.replies = [];
    fake.refuseRefresh = "invalid_grant";
    const expired = await askAndFail(window, "Who signed the lease?");
    await expect(expired).toHaveText("Your Claude sign-in has expired · Sign in again");
    for (const line of [limited, refused, expired]) await expect(line).not.toContainText("ChatGPT");

    await setLanguage(window, "zh-CN");
    await expect(limited).toHaveText("Claude 订阅的用量已达上限 · 换一个模型");
    await expect(refused).toHaveText("Claude 拒绝了这次登录 · 改用 API 密钥");
    await expect(expired).toHaveText("Claude 登录已过期 · 重新登录");

    fake.refuseRefresh = null;
    fake.expiresIn = 3600;
    await pointAndClick(window, expired.getByTestId("answer-error-action"));
    const settings = window.getByTestId("settings");
    await expect(settings).toHaveAttribute("data-page", "models");
    const row = settings.getByTestId("plans-claude-account");
    await expect(row.getByTestId("claude-plan-waiting")).toBeInViewport();
    const field = row.getByLabel("Claude 页面上的代码");
    await expect(field).toBeFocused();
    await field.fill(await codeAfterApproving(app, 2));
    await row.getByTestId("claude-paste-continue").click();
    await expect(row.getByTestId("claude-plan-sign-out")).toBeVisible();

    // Signed in again, that Answer is asked again.
    await pointAndClick(window, settings.getByRole("button", { name: "关闭设置" }));
    await expect(settings).toBeHidden();
    await expect(assistantAnswers(window).last()).toContainText(ANSWER, { timeout: 15_000 });
  } finally {
    await app.close();
  }
});
