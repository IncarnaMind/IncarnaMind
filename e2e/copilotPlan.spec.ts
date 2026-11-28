import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createFakeGitHub,
  type FakeGitHub,
  LISTED_MODELS,
  LOGIN,
  USER_CODE,
} from "../tests/helpers/fakeGitHub";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  catchCopies,
  copied,
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

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const NO_OLLAMA = "http://127.0.0.1:9";

async function checkWidths(app: ElectronApplication, window: Page, target: Locator, name: string) {
  for (const language of ["en", "zh-CN"] as const) {
    await setLanguage(window, language);
    for (const width of [900, 1600]) {
      await setWindowSize(app, window, width, 900);
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeInViewport();
      expect(await target.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await screenshot(window, `${name}-${language}-${width}`);
    }
  }
  await setLanguage(window, "en");
  await setWindowSize(app, window, 900, 900);
}

let dataDir: string;
let github: FakeGitHub;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  github = await createFakeGitHub();
});
test.afterEach(async () => {
  await github.close();
  await removeDataFolder(dataDir);
});

const copilotAccount = (window: Page) =>
  window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await bridge.getCopilot()).account;
  });

/**
 * A Copilot plan saved before #3767, which no longer adds one in IncarnaMind, its sign-in not
 * there: its own page, from Settings › AI's Accounts and keys, and the plan's row on it.
 */
async function openSavedCopilot(window: Page): Promise<Locator> {
  const providerId = await saveProvider(window, {
    kind: "copilot",
    modelId: LISTED_MODELS[0]?.id ?? "",
  });
  const settings = await openProviderRow(window, providerId);
  const row = settings.getByTestId("plans-copilot");
  await expect(row).toBeVisible();
  return row;
}

async function askInANote(window: Page, question: string): Promise<void> {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
}

test("the saved plan's Sign in says what it costs and sends before anything is sent, shows GitHub's code, and Cancel keeps nothing; signed in, a Question is answered", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    copilot: github.origin,
    ollama: NO_OLLAMA,
  });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 900);
  await acceptPlainTextKeys(window);
  await catchCopies(window);
  const row = await openSavedCopilot(window);
  const settings = window.getByTestId("settings");

  await checkWidths(app, window, row, "settings-copilot-row");
  await expect(row).not.toContainText("Experimental");
  await pointAndClick(window, row.getByTestId("plans-copilot-sign-in"));

  const notice = row.getByTestId("copilot-notice");
  await expect(notice.getByRole("listitem")).toHaveText([
    "Answers count toward your Copilot plan’s usage limits.",
    "What you ask, edit or check, with the notes and the parts of your Documents it needs, goes to GitHub. · Details",
  ]);
  await expect(notice.getByTestId("copilot-sign-in")).toBeFocused();
  expect(github.requests).toEqual([]);
  await checkWidths(app, window, notice, "settings-copilot-notice");

  await notice.getByTestId("copilot-notice-sends-details").click();
  await expect(notice.getByTestId("copilot-notice-sends-list")).toHaveText(
    "Your Questions, the note you’re in, passages from your Documents, and Document text for Tags go to GitHub under your account.",
  );

  await notice.getByTestId("copilot-sign-in").focus();
  await window.keyboard.press("Enter");
  const waiting = row.getByTestId("copilot-waiting");
  await expect(waiting.getByTestId("copilot-code")).toHaveText(USER_CODE);
  await expect(waiting.getByTestId("copilot-copy-code")).toBeFocused();
  await expect(waiting).toContainText("Enter this code on GitHub’s page");
  await expect(waiting).toContainText("Waiting for you to approve it in the browser…");
  await expect(waiting).toContainText("Answers count toward your Copilot plan’s usage limits.");
  await expect.poll(() => urlsOpened(app)).toEqual([`${github.origin}/login/device`]);
  await pointAndClick(window, waiting.getByTestId("copilot-copy-code"));
  expect(await copied(window)).toBe(USER_CODE);
  await pointAndClick(window, waiting.getByTestId("copilot-reopen"));
  await expect.poll(() => urlsOpened(app)).toHaveLength(2);
  expect(github.requests[0]?.body).toEqual({
    client_id: "Ov23liF4c8fKcl0K4ziJ",
    scope: "read:user",
  });
  await checkWidths(app, window, waiting, "settings-copilot-code");

  await waiting.getByTestId("copilot-cancel").focus();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-notice")).toBeVisible();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });

  await pointAndClick(window, row.getByTestId("copilot-sign-in"));
  await expect(row.getByTestId("copilot-code")).toHaveText(USER_CODE);
  github.approve();
  await expect(row.getByTestId("plans-copilot-sign-out")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await askInANote(window, "What does my plan cover?");
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  expect(await copilotAccount(window)).toMatchObject({
    state: "signed-in",
    profile: "own",
    login: LOGIN,
  });
  await app.close();
});

test("declining GitHub approval says so where it signs in and offers Try again, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 900);
  await acceptPlainTextKeys(window);
  const row = await openSavedCopilot(window);
  await pointAndClick(window, row.getByTestId("plans-copilot-sign-in"));
  await expect(row.getByTestId("copilot-sign-in")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.deny();

  const failure = row.getByTestId("copilot-failure");
  await expect(failure).toContainText("You declined on GitHub’s page");
  await expect(failure.getByRole("button").first()).toHaveText("Try again");
  await expect(failure.getByTestId("copilot-way-back-try-again")).toBeFocused();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await checkWidths(app, window, failure, "settings-copilot-declined");
  await setLanguage(window, "zh-CN");
  await expect(failure).toContainText("你在 GitHub 页面上拒绝了授权");
  await expect(failure.getByRole("button").first()).toHaveText("重试");
  await setLanguage(window, "en");
  await failure.getByTestId("copilot-way-back-try-again").focus();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.deny();
  await expect(failure).toBeVisible();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await app.close();
});

test("an account GitHub says has no Copilot plan is told so where it signs in, in English and Chinese, and nothing is kept", async () => {
  github.modelsRefusal = {
    status: 403,
    body: { error: { message: "No access to GitHub Copilot found.", code: "no_copilot_access" } },
  };
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 900);
  await acceptPlainTextKeys(window);
  const row = await openSavedCopilot(window);
  await pointAndClick(window, row.getByTestId("plans-copilot-sign-in"));
  await expect(row.getByTestId("copilot-sign-in")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.approve();

  const failure = row.getByTestId("copilot-failure");
  await expect(failure).toContainText("Your GitHub account has no Copilot plan");
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await setLanguage(window, "zh-CN");
  await expect(failure).toContainText("你的 GitHub 账号没有 Copilot 订阅");
  await setLanguage(window, "en");
  await app.close();
});

test("Settings › AI: the saved Copilot plan opens its notice before signing in, then shows the account with no plan tier, with Sign out", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    copilot: github.origin,
    ollama: NO_OLLAMA,
  });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 760);
  await acceptPlainTextKeys(window);
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("> Settings AI");
  await expect(window.getByTestId("palette").getByTestId("palette-item").first()).toContainText(
    "Settings: AI",
  );
  await window.keyboard.press("Enter");
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "ai");
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  const row = await openSavedCopilot(window);
  await expect(row).toContainText("GitHub Copilot Pro, Pro+, Business or Enterprise");
  await expect(row).toContainText("Answers count toward your plan’s limits.");

  await pointAndClick(window, row.getByTestId("plans-copilot-sign-in"));
  await expect(row.getByTestId("copilot-notice-usage")).toHaveText(
    "Answers count toward your Copilot plan’s usage limits.",
  );
  expect(github.requests).toEqual([]);
  await pointAndClick(window, row.getByTestId("copilot-sign-in"));
  await expect(row.getByTestId("copilot-code")).toHaveText(USER_CODE);
  github.approve();

  const account = row.getByTestId("plans-copilot-account");
  await expect(account).toHaveText(`Signed in to GitHub as ${LOGIN}`);
  await expect(row.getByText("Experimental", { exact: true })).toHaveCount(0);
  await expect(row.getByTestId("plans-copilot-sign-out")).toBeFocused();
  await expect(row).toContainText("Answers count toward your plan’s usage limits.");
  const signOut = row.getByTestId("plans-copilot-sign-out");
  const [accountBox, signOutBox] = await Promise.all([
    account.boundingBox(),
    signOut.boundingBox(),
  ]);
  if (!accountBox || !signOutBox) throw new Error("The row isn't laid out.");
  expect(signOutBox.x).toBeGreaterThan(accountBox.x + accountBox.width);
  await checkWidths(app, window, row, "settings-copilot-signed-in");
  await setWindowSize(app, window, 1600, 900);
  await expect(signOut).toBeInViewport();
  await screenshot(row, "settings-copilot-signed-in-wide");

  await setLanguage(window, "zh-CN");
  await expect(row).toContainText("GitHub Copilot Pro、Pro+、Business 或 Enterprise");
  await expect(account).toHaveText(`已登录 GitHub：${LOGIN}`);
  await expect(row).toContainText("回答会计入订阅的用量限额。");
  await screenshot(row, "settings-copilot-signed-in-zh");
  await setLanguage(window, "en");

  await pointAndClick(window, signOut);
  await expect(row.getByTestId("plans-copilot-sign-in")).toBeVisible();
  await expect(row).not.toContainText(LOGIN);
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await app.close();
});

test("own sign-in: refusal, cancel and retry; the API-selected experimental profile still answers", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 760);
  await acceptPlainTextKeys(window);
  const row = await openSavedCopilot(window);
  const settings = window.getByTestId("settings");
  await expect(row).toContainText("Answers count toward your plan’s limits.");
  await row.getByTestId("plans-copilot-sign-in").focus();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-sign-in")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.approve();
  await expect(row.getByTestId("plans-copilot-sign-out")).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  const refusal = {
    kind: "error" as const,
    status: 403,
    body: JSON.stringify({ message: "Resource not accessible by integration" }),
  };
  github.replies.push(refusal, refusal, refusal, refusal);
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What does my plan cover?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const line = answer.getByTestId("answer-error");
  // A key is no longer added in IncarnaMind (#3767): Sign in again is the line's one way back.
  await expect(line).toHaveText(
    "GitHub didn’t let IncarnaMind use your Copilot plan · Sign in again",
  );

  await checkWidths(app, window, line, "answer-copilot-refused");
  await setLanguage(window, "zh-CN");
  await expect(line).toContainText("GitHub 不允许 IncarnaMind 使用你的 Copilot 订阅");
  await expect(line).not.toContainText("改用 API 密钥");
  await setLanguage(window, "en");
  await line.getByTestId("answer-error-action").focus();
  await window.keyboard.press("Enter");
  await expect(settings).toHaveAttribute("data-page", "ai");
  await expect(row.getByTestId("plans-copilot-account")).toHaveText(
    `Signed in to GitHub as ${LOGIN}`,
  );
  await pointAndClick(window, row.getByTestId("copilot-sign-in"));
  await expect(row.getByTestId("copilot-code")).toHaveText(USER_CODE);
  await screenshot(row, "settings-copilot-sign-in-again");
  await pointAndClick(window, row.getByTestId("copilot-cancel"));
  await expect(row.getByTestId("copilot-notice")).toBeVisible();
  expect(await copilotAccount(window)).toMatchObject({ state: "signed-in", login: LOGIN });

  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(answer).toHaveAttribute("data-status", "failed");

  github.replies.length = 0;
  await pointAndClick(window, line.getByTestId("answer-error-action"));
  await expect(row.getByTestId("copilot-notice")).toBeVisible();
  await pointAndClick(window, row.getByTestId("copilot-sign-in"));
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.approve();
  await expect(row.getByTestId("copilot-notice")).toBeHidden();
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 15_000 });

  const fallback = window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return bridge.signInToCopilot({ profile: "editor" });
  });
  await expect(row.getByTestId("copilot-code")).toHaveText(USER_CODE);
  github.approve();
  expect(await fallback).toMatchObject({ ok: true, status: { account: { profile: "editor" } } });
  await expect(row.getByTestId("plans-copilot-account")).toHaveText(`Copilot Pro+ · ${LOGIN}`);
  await expect(row.getByText("Experimental", { exact: true })).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Can my plan still answer?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window)).toHaveCount(2);
  await expect(assistantAnswers(window).nth(1)).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  expect(
    github.requests.filter((request) => request.path === "/chat/completions").at(-1)?.headers,
  ).toMatchObject({ "editor-version": "vscode/1.99.3", "copilot-integration-id": "vscode-chat" });
  await app.close();
});
