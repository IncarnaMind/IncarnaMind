import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { createFakeGitHub, type FakeGitHub } from "../tests/helpers/fakeGitHub";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  createDataFolder,
  interceptOpenExternal,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * An Answer a sign-in route stopped says so in the route's own words, with its ways back, and
 * never ChatGPT's. A local stand-in for GitHub and Copilot signs in and answers, so no account
 * and no network are used. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there.
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

async function signInToCopilot(window: Page): Promise<void> {
  await acceptPlainTextKeys(window);
  await window.evaluate(() => {
    void (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.signInToCopilot();
  });
  const copilot = () =>
    window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getCopilot(),
    );
  await expect.poll(async () => (await copilot()).deviceCode !== null).toBe(true);
  github.approve();
  await expect.poll(async () => (await copilot()).account.state).toBe("signed-in");
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.saveChatProvider({
      kind: "copilot",
      modelId: "gpt-5.5",
    });
  });
}

test("an organization's policy stops a Copilot Answer: GitHub's line, an API key or another model", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 1100, 800);
  await signInToCopilot(window);
  const refusal = {
    kind: "error" as const,
    status: 403,
    body: JSON.stringify({
      error: { message: "Copilot is disabled by your organization's policy." },
    }),
  };
  github.replies.push(refusal, refusal, refusal, refusal);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("What does my plan cover?");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).last();
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });

  const line = answer.getByTestId("answer-error");
  await expect(line).toHaveText(
    "Your organization doesn’t allow this app · Use an API key instead · Use another model",
  );
  await expect(line).not.toContainText("ChatGPT");
  await screenshot(answer, "copilot-policy-line");
  await pointAndClick(window, line.getByTestId("answer-error-also"));
  await expect(window.getByTestId("composer-model-menu")).toBeVisible();
  await window.keyboard.press("Escape");

  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText("你所在的组织不允许使用此应用 · 改用 API 密钥 · 换一个模型");
  await screenshot(answer, "copilot-policy-line-zh");

  await pointAndClick(window, line.getByTestId("answer-error-action"));
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
  await app.close();
});

test("signed out of Copilot, the lines name GitHub Copilot with its ways back, and Sign in with GitHub opens its place in Settings › Models", async () => {
  const { app, window } = await launchApp(dataDir, { copilot: github.origin, ollama: NO_OLLAMA });
  await interceptOpenExternal(app);
  await setWindowSize(app, window, 1100, 800);
  await signInToCopilot(window);
  await window.evaluate(async () => {
    await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.signOutOfCopilot();
  });
  await newMind(window);

  const readiness = window.getByTestId("chat-readiness");
  await expect(readiness).toHaveText(
    "You’re not signed in to GitHub Copilot · Sign in with GitHub · Use an API key instead",
  );
  await window.getByTestId("mind-editor").click();
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("What does my plan cover?");
  await window.keyboard.press("Enter");
  const refused = window.getByTestId(/^(composer|answer)-not-ready$/);
  await expect(refused).toHaveText(
    "You’re not signed in to GitHub Copilot · Sign in with GitHub · Use an API key instead",
  );
  await screenshot(window, "copilot-readiness-lines");

  await pointAndClick(window, refused.getByRole("button", { name: "Sign in with GitHub" }));
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "models");
  await expect(window.getByTestId("plans-settings")).toBeInViewport();
  await expect(settings.getByRole("note")).toHaveText("You’re not signed in to GitHub Copilot.");
  const row = settings.getByTestId("plans-copilot");
  await expect(row).toBeInViewport();
  await pointAndClick(window, row.getByTestId("copilot-sign-in"));
  await expect(row.getByTestId("copilot-code")).toBeVisible();
  github.approve();
  await expect(row.getByTestId("plans-copilot-sign-out")).toBeVisible();
  await expect(window.getByTestId("chat-readiness")).toBeHidden();
  await app.close();
});
