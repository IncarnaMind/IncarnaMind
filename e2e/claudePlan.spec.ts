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
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  newMind,
  openProviderRow,
  pointAndClick,
  removeDataFolder,
  saveProvider,
  setLanguage,
  setWindowSize,
  urlsOpened,
} from "./app";

/*
 * "Use my Claude plan" (#872): a row in Settings › AI. A plan is no longer added in IncarnaMind
 * (#3767): the plan here was saved before, and its own page in Accounts and keys signs in again.
 * A local stand-in for Anthropic signs in and answers; the browser is stood in for, and the User
 * pastes the code Anthropic's page shows, as they do.
 */

const USAGE = "Answers count toward your Claude Pro, Max or Team limits.";

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

/** A Claude plan saved before #3767, its sign-in not there (yet, or any more). */
const saveClaudePlan = (window: Page): Promise<string> =>
  saveProvider(window, { kind: "claude-account", modelId: "claude-sonnet-5-5" });

/** The saved plan's own page, from Settings › AI's Accounts and keys: its row. */
async function openSavedPlan(window: Page, providerId: string): Promise<Locator> {
  const settings = await openProviderRow(window, providerId);
  const row = settings.getByTestId("plans-claude-account");
  await expect(row).toBeVisible();
  return row;
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

test("Settings: Cancel keeps nothing; signed in, the row names the account and Sign out forgets it; expired, Sign in again", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await setWindowSize(app, window, 1100, 660);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const providerId = await saveClaudePlan(window);
    const row = await openSavedPlan(window, providerId);
    await expect(row.getByTestId("claude-plan-account")).toHaveText(USAGE);

    await row.getByTestId("plans-claude-sign-in").click();
    const notice = row.getByTestId("claude-plan-notice");
    // Two lines, the usage limits first, then what goes to Anthropic.
    const usage = notice.getByTestId("claude-plan-usage");
    const sends = notice.getByTestId("claude-plan-sends");
    await expect(usage).toHaveText(USAGE);
    // The interface is regular (#3766): the notice stands out by its ink, the line after it is grey.
    await expect(usage).toHaveCSS("font-weight", "400");
    await expect(usage).toHaveCSS("color", "rgb(23, 25, 28)");
    await expect(sends.locator("p")).toHaveText(
      "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to Anthropic. · Details",
    );
    await expect(sends).toHaveCSS("font-weight", "400");
    const [usageBox, sendsBox] = await Promise.all([usage.boundingBox(), sends.boundingBox()]);
    expect(usageBox?.y ?? 0).toBeLessThan(sendsBox?.y ?? 0);
    await expect(notice).not.toContainText("Claude Code");
    // The safe choice has the focus, and nothing has been sent.
    await expect(notice.getByTestId("claude-plan-cancel")).toBeFocused();
    expect(await urlsOpened(app)).toHaveLength(0);
    await expectInside(row, [usage, sends]);

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
    await expect(details).toBeFocused();

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

    const expired = await openSavedPlan(window, providerId);
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
    const row = await openSavedPlan(window, await saveClaudePlan(window));
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

test("in Chinese: the saved plan's row says the usage limits first, then what goes to Anthropic, and signs in where the code goes", async () => {
  const { app, window } = await launchApp(dataDir, { claude: fake.origin });
  try {
    await setWindowSize(app, window, 1100, 660);
    await interceptOpenExternal(app);
    await acceptPlainTextKeys(window);
    const row = await openSavedPlan(window, await saveClaudePlan(window));
    await setLanguage(window, "zh-CN");
    await row.getByTestId("plans-claude-sign-in").click();
    const notice = row.getByTestId("claude-plan-notice");
    const usage = notice.getByTestId("claude-plan-usage");
    const sends = notice.getByTestId("claude-plan-sends");
    await expect(usage).toHaveText("回答会计入你 Claude Pro、Max 或 Team 订阅的限额。");
    // The interface is regular (#3766): the notice stands out by its ink, the line after it is grey.
    await expect(usage).toHaveCSS("font-weight", "400");
    await expect(usage).toHaveCSS("color", "rgb(23, 25, 28)");
    await expect(sends.locator("p")).toHaveText(
      "你提问、修改或核对的内容，连同所需的笔记和文档内容，会发送给 Anthropic。 · 详情",
    );
    await expect(row.getByTestId("claude-plan-sign-in")).toHaveText("用 Claude 账号登录");
    await expectInside(row, [usage, sends]);
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
    // A key is no longer added in IncarnaMind (#3767): the way back is signing in again.
    await expect(refused).toHaveText("Claude refused this sign-in · Sign in again");

    fake.replies = [];
    fake.refuseRefresh = "invalid_grant";
    const expired = await askAndFail(window, "Who signed the lease?");
    await expect(expired).toHaveText("Your Claude sign-in has expired · Sign in again");
    for (const line of [limited, refused, expired]) await expect(line).not.toContainText("ChatGPT");

    await setLanguage(window, "zh-CN");
    await expect(limited).toHaveText("Claude 订阅的用量已达上限 · 换一个模型");
    await expect(refused).toHaveText("Claude 拒绝了这次登录 · 重新登录");
    await expect(expired).toHaveText("Claude 登录已过期 · 重新登录");

    fake.refuseRefresh = null;
    fake.expiresIn = 3600;
    await pointAndClick(window, expired.getByTestId("answer-error-action"));
    const settings = window.getByTestId("settings");
    await expect(settings).toHaveAttribute("data-page", "ai");
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
