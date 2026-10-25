import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * An Answer whose reply ends with no text says so in place, under the
 * Question in the assistant, with Try again (#501); in English and Chinese. So does one whose
 * model wrote pages of working notes after its search instead of an Answer (#1344).
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

test("a blank reply is a problem line with Try again, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("Send a blank reply");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  const error = answer.getByTestId("answer-error");
  await expect(error).toHaveAttribute("data-error-kind", "no-answer");
  const line = error.getByRole("alert");
  await expect(line).toContainText("The model sent no Answer");
  await expect(line.getByRole("button")).toHaveText("Try again");

  await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
      user: { language: "zh-CN" },
    }),
  );
  await expect(line).toContainText("模型没有给出回答");
  await expect(line.getByRole("button")).toHaveText("重试");
});

test("a model that writes its working notes after its search shows no Answer, a line with Try again", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const file = join(home, "Tide tables.md");
  await writeFile(file, "# Tide tables\n\nSpring tides are the largest.\n");
  await addDocuments(window, [file]);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type("哪份文件读起来最快？边想边写");
  await window.keyboard.press("Enter");
  const answer = assistantAnswers(window).first();
  await expect(answer).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
  await expect(answer).not.toContainText("等一下");
  const error = answer.getByTestId("answer-error");
  await expect(error).toHaveAttribute("data-error-kind", "no-answer");
  const line = error.getByRole("alert");
  await expect(line).toContainText("The model sent no Answer");
  await expect(line.getByRole("button")).toHaveText("Try again");
  await app.close();
});
