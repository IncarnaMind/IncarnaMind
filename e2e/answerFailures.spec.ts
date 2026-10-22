import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * An Answer that can't be made says why in its line, with the one action that fits, in English
 * and Chinese; the log keeps the provider's status and words, never what they quote (#1487).
 */

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
  const answer = answers.last();
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
  await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "models");
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("settings")).toBeHidden();

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
