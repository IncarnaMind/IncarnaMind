import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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

/*
 * Using a GitHub Copilot plan (#876): first run's Other ways and Settings › Models list it, off
 * until the User signs in; its notice, the usage line first, is said before anything is sent;
 * GitHub's code waits in large type with Copy code; an organization's block says so with its ways
 * back. A local stand-in for GitHub signs in and answers. Set INCARNAMIND_SCREENSHOTS to a folder
 * to also save screenshots there.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** Nothing listens here: as if Ollama weren't on this computer. */
const NO_OLLAMA = "http://127.0.0.1:9";

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
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  await catchCopies(window);
  const card = await askFirstQuestion(window);

  const row = card.getByTestId("way-copilot");
  await expect(row).toContainText("Use my Copilot plan");
  await expect(row).toContainText("Pro, Pro+ or Business");
  await expect(row).toContainText("Experimental");
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await pointAndClick(window, row);

  const notice = card.getByTestId("copilot-notice");
  await expect(notice.getByRole("listitem")).toHaveText([
    "Answers count toward your Copilot plan’s usage limits.",
    "Experimental: GitHub may block this sign-in.",
    "Sends your questions and document text to GitHub. · Details",
  ]);
  // The experimental way starts on the safe choice.
  await expect(notice.getByTestId("copilot-cancel")).toBeFocused();
  expect(github.requests).toEqual([]);
  await screenshot(card, "setup-copilot-notice");

  await notice.getByTestId("copilot-notice-sends-details").click();
  await expect(notice.getByTestId("copilot-notice-sends-list")).toHaveText(
    "Your Questions, the Mind you’re in, Passages from your Documents, and Document text for Tags go to GitHub under your account.",
  );

  await pointAndClick(window, notice.getByTestId("copilot-sign-in"));
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
  await screenshot(card, "setup-copilot-code");

  await pointAndClick(window, waiting.getByTestId("copilot-cancel"));
  await expect(card.getByTestId("copilot-notice")).toBeVisible();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });

  await pointAndClick(window, card.getByTestId("copilot-sign-in"));
  await expect(card.getByTestId("copilot-code")).toHaveText(USER_CODE);
  github.approve();
  await continueSetup(window);
  await expect(assistantAnswers(window).first()).toHaveAttribute("data-status", "done", {
    timeout: 15_000,
  });
  expect(await copilotAccount(window)).toMatchObject({ state: "signed-in", login: LOGIN });
  await app.close();
});

test("first run: an organization's block says so, with an API key or another way, in English and Chinese", async () => {
  github.exchangePolicy = true;
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 1100, 900);
  await acceptPlainTextKeys(window);
  const card = await askFirstQuestion(window);
  await pointAndClick(window, card.getByTestId("way-copilot"));
  await pointAndClick(window, card.getByTestId("copilot-sign-in"));
  await expect(card.getByTestId("copilot-code")).toBeVisible();
  github.approve();

  const failure = card.getByTestId("copilot-failure");
  await expect(failure).toContainText("Your organization doesn’t allow this app");
  await expect(failure).toContainText(
    "Your organization’s Copilot policy blocks IncarnaMind. Ask an admin.",
  );
  await expect(failure.getByRole("button")).toHaveText([
    "Use an API key instead",
    "Choose another way",
  ]);
  await expect(failure.getByTestId("copilot-way-back-paste-api-key")).toBeFocused();
  expect(await copilotAccount(window)).toEqual({ state: "signed-out" });
  await screenshot(card, "setup-copilot-blocked");

  await setLanguage(window, "zh-CN");
  await expect(failure).toContainText("你所在的组织不允许使用此应用");
  await expect(failure.getByRole("button")).toHaveText(["改用 API 密钥", "换一种方式"]);
  await screenshot(card, "setup-copilot-blocked-zh");
  await setLanguage(window, "en");

  await pointAndClick(window, failure.getByTestId("copilot-way-back-paste-api-key"));
  await expect(card.getByTestId("setup-key")).toBeFocused();
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
  const settings = await openSettings(window, "models");
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
  await expect(account).toHaveText(`Copilot Pro+ · ${LOGIN}`);
  await expect(row.getByTestId("plans-copilot-sign-out")).toBeFocused();
  await expect(row).toContainText("Answers count toward your plan’s usage limits.");
  const signOut = row.getByTestId("plans-copilot-sign-out");
  const [accountBox, signOutBox] = await Promise.all([
    account.boundingBox(),
    signOut.boundingBox(),
  ]);
  if (!accountBox || !signOutBox) throw new Error("The row isn't laid out.");
  expect(signOutBox.x).toBeGreaterThan(accountBox.x + accountBox.width);
  await screenshot(row, "settings-copilot-signed-in");
  await setWindowSize(app, window, 1440, 900);
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
  // By keyboard: the Models page above the row is still settling, which moves a pointer's target.
  await row.getByTestId("plans-copilot-sign-in").focus();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-cancel")).toBeFocused();
  await window.keyboard.press("Shift+Tab");
  await expect(row.getByTestId("copilot-sign-in")).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.approve();

  const failure = row.getByTestId("copilot-failure");
  await expect(failure).toContainText("GitHub Copilot listed no models for this account");
  await expect(failure.getByRole("button")).toHaveText(["Try again", "Use an API key instead"]);
  await expect(row.getByTestId("plans-copilot-account")).toHaveText(`Copilot Pro+ · ${LOGIN}`);
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

test("signed in, an Answer GitHub refuses offers Sign in again: a new code even while signed in, Cancel keeps the sign-in and asks nothing, and once signed in the Answer is asked again", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 900, 760);
  await acceptPlainTextKeys(window);
  const settings = await openSettings(window, "models");
  const row = settings.getByTestId("plans-copilot");
  await expect(row).toContainText("Answers count toward your plan’s limits.");
  // By keyboard: the Models page above the row is still settling, which moves a pointer's target.
  await row.getByTestId("plans-copilot-sign-in").focus();
  await window.keyboard.press("Enter");
  await expect(row.getByTestId("copilot-cancel")).toBeFocused();
  await window.keyboard.press("Shift+Tab");
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

  await pointAndClick(window, line.getByTestId("answer-error-action"));
  await expect(settings).toHaveAttribute("data-page", "models");
  await expect(row.getByTestId("plans-copilot-account")).toHaveText(`Copilot Pro+ · ${LOGIN}`);
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
  await app.close();
});
