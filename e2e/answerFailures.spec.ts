import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  assistantAnswers,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  interceptOpenExternal,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  urlsOpened,
  useLocalChatModel,
} from "./app";

/*
 * An Answer that can't be made says why in its line, with the one action that fits, in English
 * and Chinese; the log keeps the provider's status and words, never what they quote (#1487).
 * An account with no credit is sent to the provider's billing page (#1290). Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(target: Page | Locator, name: string): Promise<void> {
  if (SCREENSHOTS) await target.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(home);
});

const logOf = () => readFile(join(dataDir, "logs", "incarnamind.log"), "utf8");

async function askFailing(window: Page, question: string) {
  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.nth(before);
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  return answer;
}

test("a refused request and an overloaded provider each say why, with the action that fits, in English and Chinese, and the log keeps their status", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  // Asking again can't help a request the provider refused: another model can.
  const refused = await askFailing(window, "Send a refused request about the zanzibar codeword");
  const refusal = refused.getByTestId("answer-error");
  await expect(refusal).toHaveAttribute("data-error-kind", "refused");
  const line = refusal.getByRole("alert");
  await expect(line).toContainText("Ollama refused this request");
  await expect(line.getByRole("button")).toHaveText("Choose another model");
  await setLanguage(window, "zh-CN");
  await expect(line).toContainText("Ollama 拒绝了这个请求");
  await expect(line.getByRole("button")).toHaveText("换一个模型");
  await setLanguage(window, "en");
  await line.getByRole("button").click();
  // The menu is the composer's, where the Question was asked: no Settings page opens (#1848).
  await expect(window.getByTestId("composer-model-menu")).toBeVisible();
  await expect(window.getByTestId("settings")).toBeHidden();
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("composer-model-menu")).toBeHidden();

  // A provider overloaded as its reply begins: Try again writes the Answer.
  const overloaded = await askFailing(window, "Is the provider overloaded today?");
  const busy = overloaded.getByTestId("answer-error");
  await expect(busy).toHaveAttribute("data-error-kind", "provider");
  await expect(busy).toContainText("Ollama ran into a problem");
  await setLanguage(window, "zh-CN");
  await expect(busy).toContainText("Ollama 出错了");
  await expect(busy.getByRole("button")).toHaveText("重试");
  await setLanguage(window, "en");
  await expect(busy.getByRole("button")).toHaveText("Try again");
  await busy.getByRole("button").click();
  await expect(overloaded).toHaveAttribute("data-status", "done", { timeout: 15_000 });
  await expect(overloaded.getByTestId("answer-error")).toHaveCount(0);

  // A model on this computer has no credit to run out of: whatever its server says, it refused.
  const local = (await askFailing(window, "Is the account out of credit?")).getByTestId(
    "answer-error",
  );
  await expect(local).toContainText("Ollama refused this request");
  await expect(local.getByRole("button")).toHaveText("Choose another model");

  await expect
    .poll(logOf)
    .toMatch(
      / WARN {2}answer\.failed answerId=\S+ errorKind=refused status=400 message="messages\.0\.content: \[redacted\] can't be taken"/,
    );
  const log = await logOf();
  expect(log).toMatch(
    / WARN {2}answer\.failed answerId=\S+ errorKind=provider status=529 message=Overloaded/,
  );
  expect(log).not.toContain("zanzibar");
  await app.close();
});

test("an account out of credit, a refused key, a rate limit and no connection each say why, with the action that fits, in English and Chinese, at a narrow width too", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1100, 900);
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  await interceptOpenExternal(app);
  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.saveChatProvider({
      kind: "openai",
      modelId: "gpt-6.1-sol",
      apiKey: "key-not-real",
    });
  });
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  // No credit: trying again fails the same way, so the line sends the User to add some.
  const credit = await askFailing(window, "Is the account out of credit?");
  const noCredit = credit.getByTestId("answer-error");
  await expect(noCredit).toHaveAttribute("data-error-kind", "out-of-credit");
  const creditLine = noCredit.getByRole("alert");
  const creditAction = noCredit.getByTestId("answer-error-action");
  const changeKey = noCredit.getByTestId("answer-error-key");
  await expect(changeKey).toHaveText("Use another key");
  await expect(creditLine).toContainText("No credit on this key");
  await expect(creditAction).toHaveText("Add credit ↗");
  await screenshot(noCredit, "out-of-credit-en");
  await setLanguage(window, "zh-CN");
  await expect(creditLine).toContainText("这个密钥没有额度");
  await expect(creditAction).toHaveText("充值 ↗");
  await expect(changeKey).toHaveText("换一个密钥");
  await screenshot(noCredit, "out-of-credit-zh");
  await creditAction.focus();
  await window.keyboard.press("Enter");
  await expect
    .poll(() => urlsOpened(app))
    .toEqual(["https://platform.openai.com/settings/organization/billing/overview"]);
  await setLanguage(window, "en");
  // Sent to add credit, the User's next step is asking again: still no credit, the page is offered again.
  await expect(creditAction).toHaveText("Try again");
  await pointAndClick(window, creditAction);
  await expect(creditAction).toHaveText("Add credit ↗");

  await runCommand(window, "answer.useAnotherKey", "Use another key");
  const settings = window.getByTestId("settings");
  await expect(settings).toHaveAttribute("data-page", "models");
  await expect(settings.getByTestId("provider-page-title")).toHaveText("OpenAI");
  await expect(settings.getByTestId("provider-page-key")).toBeFocused();
  await expect(settings.getByTestId("provider-key-refused")).toHaveText("No credit on this key");
  await closeSettings(window);
  await runCommand(window, "answer.addCredit", "Add credit");
  await expect.poll(() => urlsOpened(app)).toHaveLength(2);

  // A key the provider doesn't know: the fix is the key.
  const key = (await askFailing(window, "Is this the wrong key?")).getByTestId("answer-error");
  await expect(key).toHaveAttribute("data-error-kind", "auth");
  await expect(key).toContainText("was refused");
  await expect(key.getByRole("button")).toHaveText("Check the key");

  // A rate limit and a lost connection pass: Try again, and again with the same line.
  const limited = await askFailing(window, "Too many requests today?");
  const limit = limited.getByTestId("answer-error");
  await expect(limit).toHaveAttribute("data-error-kind", "rate-limit");
  await expect(limit).toContainText("OpenAI is limiting requests right now");
  await expect(limit.getByRole("button")).toHaveText("Try again");
  await pointAndClick(window, limit.getByRole("button"));
  await expect(limited).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  await expect(limited.getByTestId("answer-error")).toHaveCount(1);
  await expect(limited.getByTestId("answer-error")).toContainText("limiting requests");

  const offline = (await askFailing(window, "Is there no connection?")).getByTestId("answer-error");
  await expect(offline).toHaveAttribute("data-error-kind", "network");
  await expect(offline).toContainText("Couldn’t reach OpenAI. Check your internet connection");
  await expect(offline.getByRole("button")).toHaveText("Try again");

  // The line and its button stay inside a narrow window, with the Chinese words too.
  await setWindowSize(app, window, 900, 700);
  await setLanguage(window, "zh-CN");
  for (const failure of [noCredit, limit, offline]) {
    await failure.scrollIntoViewIfNeeded();
    const line = failure.getByRole("alert");
    const button = line.getByRole("button").first();
    await expect(button).toBeVisible();
    const [lineBox, buttonBox, size] = await Promise.all([
      line.boundingBox(),
      button.boundingBox(),
      window.evaluate(() => ({ width: innerWidth })),
    ]);
    expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(size.width);
    expect((lineBox?.x ?? 0) + (lineBox?.width ?? 0)).toBeLessThanOrEqual(size.width);
  }
  await screenshot(noCredit, "out-of-credit-narrow-zh");
  await setLanguage(window, "en");

  await expect
    .poll(logOf)
    .toMatch(
      / WARN {2}answer\.failed answerId=\S+ errorKind=out-of-credit status=429 message="You exceeded your current quota, please check your plan and billing details\."/,
    );
  const log = await logOf();
  expect(log).toMatch(/ errorKind=auth status=401 message="Incorrect API key provided\."/);
  expect(log).toMatch(/ errorKind=rate-limit status=429 /);
  expect(log).not.toContain("key-not-real");
  await app.close();
});
