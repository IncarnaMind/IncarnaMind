import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * One count for every surface (#1335, #1358): what changed is counted by paragraph, each
 * paragraph once, and what waits is counted by change, the same on the page, in the assistant's
 * line and on its card. The scripted model (src/main/fakeChat/minds.ts) writes a summary page of
 * two paragraphs and, asked to retell it, gives the whole new text of three, as a model asked to
 * make it longer does. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const SPRING = "Spring tides come at new and full moon, when the Sun and the Moon pull together.";
const NEAP = "Neap tides come in between, at the quarter moons.";
const RETOLD = [
  "Spring tides come at new and full moon, when the Sun and the Moon line up.",
  "Neap tides come in between, at the quarter moons, when they pull apart.",
  "Both follow the Moon's cycle.",
];

test("a summary written anew as three paragraphs is 3 changed on the Mind's line, the Answer's card and Review changes, and Undo takes it back, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await askInAssistant(window, "write a summary page");
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText([SPRING, NEAP]);

  const answer = await askInAssistant(window, "Retell the summary in three paragraphs");

  await expect(paragraphs).toHaveText(RETOLD);
  const line = editor.getByTestId("applied-line");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 3 paragraphs");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Changed 3 paragraphs in “Summary”",
  );
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await screenshot(window, "counts-written-anew-en");
  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 3 个段落");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText("已修改“Summary”中的 3 段");
  await screenshot(window, "counts-written-anew-zh");
  await setLanguage(window, "en");

  await pointAndClick(window, line.getByTestId("applied-review"));
  await expect(line.getByTestId("applied-count")).toHaveText(
    "3 paragraphs changed by the assistant",
  );
  await screenshot(window, "counts-written-anew-review-en");
  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("applied-count")).toHaveText("助手修改的 3 个段落");
  await setLanguage(window, "en");
  await pointAndClick(window, line.getByTestId("applied-done"));
  await expect(paragraphs).toHaveText(RETOLD);

  await pointAndClick(window, answer.getByTestId("mind-changes-undo"));
  await expect(paragraphs).toHaveText([SPRING, NEAP]);
  await expect(answer.getByTestId("mind-changes-undone")).toHaveText("Undone");
});

const NOTES = [
  "Tides rise twice a day along this coast.",
  "The harbour office posts the times each week.",
];

test("changes that wait are the same number on the change card, the Answer's line and its card, after accepting one and after Undo, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await newMind(window);
  await nameMind(window, "Harbour notes");
  await enterContent(window);
  await window.keyboard.type(NOTES[0] ?? "");
  await window.keyboard.press("Enter");
  await window.keyboard.type(NOTES[1] ?? "");
  const editor = window.getByTestId("mind-editor");
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText(NOTES);

  // Most of the User's own text rewritten waits for them, in a line of its own, not in the Mind's bar.
  const answer = await askInAssistant(window, "Rewrite the intro to be clearer");

  const left = answer.getByTestId("mind-changes-left");
  const title = answer.getByTestId("mind-changes-title");
  const card = window.getByTestId("change-bar");
  await expect(title).toHaveText("Changed 2 paragraphs in “Harbour notes”");
  await expect(left).toHaveText("· 2 changes waiting");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await pointAndClick(window, editor.locator("ins.proposal-insert").first());
  await expect(card).toHaveAccessibleName("Change 1 of 2");
  await screenshot(window, "counts-waiting-en");

  await pointAndClick(window, card.getByTestId("change-accept"));
  await expect(left).toHaveText("· 1 change waiting");
  await expect(title).toHaveText("Changed 2 paragraphs in “Harbour notes”");
  await pointAndClick(window, editor.locator("ins.proposal-insert").first());
  await expect(card).toHaveAccessibleName("Change 1 of 1");

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(left).toHaveText("· 2 changes waiting");
  await pointAndClick(window, editor.locator("ins.proposal-insert").first());
  await expect(card).toHaveAccessibleName("Change 1 of 2");

  await setLanguage(window, "zh-CN");
  await expect(left).toHaveText("· 2 处修订待确认");
  await expect(title).toHaveText("在“Harbour notes”中修改了 2 个段落");
  await expect(card).toHaveAccessibleName("第 1 处修订，共 2 处");
  await screenshot(window, "counts-waiting-zh");
  await setLanguage(window, "en");

  await pointAndClick(window, editor.getByTestId("applied-line").getByTestId("applied-apply"));
  await expect(editor.getByTestId("applied-count")).toHaveText("Changed 2 paragraphs");
  await expect(answer.getByTestId("mind-changes-title")).toHaveText(
    "Changed 2 paragraphs in “Harbour notes”",
  );
});
