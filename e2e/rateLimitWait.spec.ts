import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
 * An Answer whose request a rate limit refused with a stated wait (#2944) waits it, its line says
 * when it resumes in Tags' words, in English and Chinese, and the Answer lands once the wait is
 * over. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
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

test("an Answer refused for a few seconds says when it resumes, in English and Chinese, then lands", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  const answers = assistantAnswers(window);
  const before = await answers.count();
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Please slow down and say when high water comes");
  await window.keyboard.press("Enter");
  await expect(answers).toHaveCount(before + 1);
  const answer = answers.nth(before);

  const live = answer.getByTestId("answer-steps-live");
  await expect(live).toContainText("Rate limit reached · resumes at");
  await screenshot(answer, "rate-limit-wait-en");
  await setLanguage(window, "zh-CN");
  await expect(live).toContainText("已达到速率上限 ·");
  await screenshot(answer, "rate-limit-wait-zh");
  await setLanguage(window, "en");

  // Nothing is asked of the User: once the wait is over the Answer is written.
  await expect(answer).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(answer.getByTestId("answer-error")).toHaveCount(0);
  await app.close();
});
