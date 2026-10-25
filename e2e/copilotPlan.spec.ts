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
  continueSetup,
  copied,
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

async function askFirstQuestion(window: Page): Promise<Locator> {
  await newMind(window);
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What does my plan cover?");
  await window.keyboard.press("Enter");
  const card = window.getByTestId("model-setup");
  await expect(card).toBeVisible();
  await pointAndClick(window, card.getByTestId("setup-other"));
  return card;
}

test("first run: Use my Copilot plan says what it costs and sends before anything is sent, shows GitHub's code, and Cancel keeps nothing; signed in, the Question is answered", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    copilot: github.origin,
    ollama: NO_OLLAMA,
  });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 900);
  await acceptPlainTextKeys(window);
  await catchCopies(window);
  const card = await askFirstQuestion(window);

  const row = card.getByTestId("way-copilot");
  await checkWidths(app, window, row, "setup-copilot-row");
  await expect(row).toContainText("Use my Copilot plan");
  await expect(row).toContainText("Pro, Pro+ or Business");
  await expect(row).not.toContainText("Experimental");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await pointAndClick(window, row);

  const notice = card.getByTestId("copilot-notice");
  await expect(notice.getByRole("listitem")).toHaveText([
    "Answers count toward your Copilot plan’s usage limits.",
    "Sends your questions and document text to GitHub. · Details",
  ]);
  await expect(notice.getByTestId("copilot-sign-in")).toBeFocused();
  expect(github.requests).toEqual([]);
  await checkWidths(app, window, notice, "setup-copilot-notice");

  await notice.getByTestId("copilot-notice-sends-details").click();
  await expect(notice.getByTestId("copilot-notice-sends-list")).toHaveText(
    "Your Questions, the Mind you’re in, Passages from your Documents, and Document text for Tags go to GitHub under your account.",
  );

  await notice.getByTestId("copilot-sign-in").focus();
  await window.keyboard.press("Enter");
  const waiting = card.getByTestId("copilot-waiting");
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
  await checkWidths(app, window, waiting, "setup-copilot-code");

  await waiting.getByTestId("copilot-cancel").focus();
  await window.keyboard.press("Enter");
  await expect(card.getByTestId("copilot-notice")).toBeVisible();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });

  await pointAndClick(window, card.getByTestId("copilot-sign-in"));
  await expect(card.getByTestId("copilot-code")).toHaveText(USER_CODE);
  github.approve();
  await continueSetup(window);
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

test("first run: declining GitHub approval offers retry and an API key, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await pointAndClick(window, card.getByTestId("way-copilot"));
  await window.keyboard.press("Enter");
  await expect(card.getByTestId("copilot-code")).toBeVisible();
  github.deny();

  const failure = card.getByTestId("copilot-failure");
  await expect(failure).toContainText("You declined on GitHub’s page");
  await expect(failure.getByRole("button")).toHaveText(["Try again", "Use an API key instead"]);
  await expect(failure.getByTestId("copilot-way-back-try-again")).toBeFocused();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await checkWidths(app, window, failure, "setup-copilot-declined");
  await setLanguage(window, "zh-CN");
  await expect(failure).toContainText("你在 GitHub 页面上拒绝了授权");
  await expect(failure.getByRole("button")).toHaveText(["重试", "改用 API 密钥"]);
  await setLanguage(window, "en");
  await failure.getByTestId("copilot-way-back-try-again").focus();
  await window.keyboard.press("Enter");
  await expect(card.getByTestId("copilot-code")).toBeVisible();
  github.deny();
  await expect(failure).toBeVisible();
  await pointAndClick(window, failure.getByTestId("copilot-way-back-paste-api-key"));
  await expect(card.getByTestId("provider-form")).toBeVisible();
  await app.close();
});

test("Settings › Models: the Copilot plan opens its notice before signing in, then names the plan and account, with Sign out", async () => {
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
  await window.keyboard.type("> Settings Models");
  await expect(window.getByTestId("palette").getByTestId("palette-item").first()).toContainText(
    "Models",
  );
  await window.keyboard.press("Enter");
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "models");
  const row = settings.getByTestId("plans-copilot");
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
  await expect(account).toHaveText(`GitHub Copilot · ${LOGIN}`);
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
  await expect(row).toContainText("回答会计入订阅的用量限额。");
  await screenshot(row, "settings-copilot-signed-in-zh");
  await setLanguage(window, "en");

  await pointAndClick(window, signOut);
  await expect(row.getByTestId("plans-copilot-sign-in")).toBeVisible();
  await expect(row).not.toContainText(LOGIN);
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await app.close();
});

test("Settings › Models: signed in but with no model listed, the row says so with Try again, and isn't ready until a model is chosen", async () => {
  github.listedModels = [];
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    copilot: github.origin,
    ollama: NO_OLLAMA,
  });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 760);
  await acceptPlainTextKeys(window);
  const settings = await openSettings(window, "models");
  const row = settings.getByTestId("plans-copilot");
  await expect(row).toContainText("Answers count toward your plan’s limits.");
  await row.getByTestId("plans-copilot-sign-in").focus();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-sign-in")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.approve();

  const failure = row.getByTestId("copilot-failure");
  await expect(failure).toContainText("GitHub Copilot listed no models for this account");
  await expect(failure.getByRole("button")).toHaveText(["Try again", "Use an API key instead"]);
  await expect(row.getByTestId("plans-copilot-account")).toHaveText(`GitHub Copilot · ${LOGIN}`);
  await expect(row).not.toContainText("Answers count toward your plan’s usage limits.");
  await screenshot(row, "settings-copilot-no-models");

  github.listedModels = LISTED_MODELS;
  await pointAndClick(window, failure.getByTestId("copilot-way-back-try-again"));
  await expect(failure).toBeHidden();
  await expect(row).toContainText("Answers count toward your plan’s usage limits.");
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await bridge.listChatProviders()).map((provider) => provider.kind);
      }),
    )
    .toContain("copilot");
  await app.close();
});

test("own sign-in: refusal, cancel and retry; the API-selected experimental profile still answers", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 760);
  await acceptPlainTextKeys(window);
  const settings = await openSettings(window, "models");
  const row = settings.getByTestId("plans-copilot");
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
  await expect(line).toHaveText(
    "GitHub didn’t let IncarnaMind use your Copilot plan · Sign in again · Use an API key instead",
  );

  await checkWidths(app, window, line, "answer-copilot-refused");
  await setLanguage(window, "zh-CN");
  await expect(line).toContainText("GitHub 不允许 IncarnaMind 使用你的 Copilot 订阅");
  await expect(line).toContainText("改用 API 密钥");
  await setLanguage(window, "en");
  await line.getByTestId("answer-error-action").focus();
  await window.keyboard.press("Enter");
  await expect(settings).toHaveAttribute("data-page", "models");
  await expect(row.getByTestId("plans-copilot-account")).toHaveText(`GitHub Copilot · ${LOGIN}`);
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
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Can my plan still answer?");
  await window.keyboard.press("Enter");
  await expect(assistantAnswers(window).last()).toHaveAttribute("data-status", "done");
  expect(
    github.requests.filter((request) => request.path === "/chat/completions").at(-1)?.headers,
  ).toMatchObject({ "editor-version": "vscode/1.99.3", "copilot-integration-id": "vscode-chat" });
  await app.close();
});
