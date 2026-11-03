import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  acceptPlainTextKeys,
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
} from "./app";

/**
 * A reply that says the calculation Tool confirmed a figure when no `calculate` call worked one
 * out (#1796): the line under it, in English and Chinese, and the one ask as a step of its own.
 * Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

let dataDir: string;
let sources: string;
let home: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  home = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

async function setUp(window: Page): Promise<void> {
  await dismissChatSetup(window);
  await acceptPlainTextKeys(window);
  // A model measured to use calculate (ADR-0021): the scripted model answers in its place.
  await window.evaluate(async () => {
    const core = (
      globalThis as unknown as {
        incarnamind: { saveChatProvider(input: unknown): Promise<unknown> };
      }
    ).incarnamind;
    await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
  });
  await writeFile(
    join(sources, "Cedar.md"),
    "# Cedar\n\nTotal Net Debt 310; EBITDA 95 (GBP m, final). Cap 3.50:1.\n",
  );
  await addDocuments(window, [join(sources, "Cedar.md")]);
}

test("a reply that says the calculation Tool confirmed a figure keeps a line, and its one ask is a step", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await setUp(window);

  const answer = await askInAssistant(window, "What is the leverage? claims a calculation");

  await expect(answer.getByTestId("assistant-answer-text")).toContainText(
    "The calculation tool confirmed 3.26x.",
  );
  const line = answer.getByTestId("answer-unrun-calculate");
  await expect(line).toContainText("No calculation ran: IncarnaMind didn’t calculate");
  await expect(line.getByTestId("answer-unrun-retry")).toBeVisible();
  if (SCREENSHOTS) await answer.screenshot({ path: join(SCREENSHOTS, "unrun-tool-line-en.png") });
  await pointAndClick(window, answer.getByTestId("answer-steps"));
  await expect(answer.getByTestId("answer-asked-again")).toContainText(
    "Asked again: the reply said figures were calculated, and no calculation had run",
  );
  if (SCREENSHOTS) await answer.screenshot({ path: join(SCREENSHOTS, "asked-again-step-en.png") });
  await app.close();
});

test("in Chinese, the line and the ask say so in Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true, home });
  await setWindowSize(app, window, 1440, 900);
  await setUp(window);
  await window.evaluate(async () => {
    const core = (
      globalThis as unknown as {
        incarnamind: { updateSettings(input: unknown): Promise<unknown> };
      }
    ).incarnamind;
    await core.updateSettings({ user: { language: "zh-CN" } });
  });

  const answer = await askInAssistant(window, "杠杆率是多少？声称已计算");

  await expect(answer.getByTestId("assistant-answer-text")).toContainText(
    "计算工具已确认：杠杆率为 3.26 倍。",
  );
  const line = answer.getByTestId("answer-unrun-calculate");
  await expect(line).toContainText("未运行计算：这条回答中算出的数字不是 IncarnaMind 计算得出的");
  if (SCREENSHOTS) await answer.screenshot({ path: join(SCREENSHOTS, "unrun-tool-line-zh.png") });
  await pointAndClick(window, answer.getByTestId("answer-steps"));
  await expect(answer.getByTestId("answer-asked-again")).toContainText(
    "已重新回答：回答中称已计算数字，但当时并未运行计算",
  );
  if (SCREENSHOTS) await answer.screenshot({ path: join(SCREENSHOTS, "asked-again-step-zh.png") });
  await app.close();
});
