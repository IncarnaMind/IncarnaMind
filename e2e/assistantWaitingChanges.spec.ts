import { expect, type Page, test } from "@playwright/test";
import {
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  enterContent,
  launchApp,
  nameMind,
  newMind,
  openSteps,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * When changes wait in a Mind that the assistant can't revise, it changes
 * nothing and says so: the step names why, and a line under the Answer says
 * how many wait, with Review, which brings the Mind up at its first change.
 * The changes that wait are the assistant's rewrite of most of the User's own
 * text, held back for them (the scripted "Rewrite the intro to be clearer"),
 * whose proposals are an edit's, not its own Blocks; the scripted model
 * (src/main/fakeChat) then calls edit_mind for a request to shorten, which
 * meets them.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function writeMind(window: Page, title: string, note: string): Promise<void> {
  await newMind(window);
  await enterContent(window);
  await nameMind(window, title);
  await window.keyboard.type(note);
  await expect(window.getByTestId("mind-editor").locator("p")).toHaveText([note]);
}

test("over changes it can't revise, the assistant changes nothing, says why, and Review shows them; in English and Chinese; the line goes once none wait", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setLanguage(window, "en");
  await setWindowSize(app, window, 1100, 800);
  await writeMind(window, "Q3 review", "The quarter was very good, and sales were really strong.");
  const editor = window.getByTestId("mind-editor");
  // A rewrite of most of the User's own text waits for them, as an Edit with AI's does.
  await askInAssistant(window, "Rewrite the intro to be clearer");
  const held = editor.getByTestId("applied-line");
  await expect(held.getByTestId("applied-discard")).toBeVisible();

  const refused = await askInAssistant(window, "Could you shorten the summary?");

  const line = refused.getByTestId("answer-waiting-changes");
  await expect(line).toHaveText(
    /^\d+ changes are waiting in “Q3 review”\. Accept or reject them first\? · Review$/,
  );
  const timeline = await openSteps(window, refused);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(
    /Couldn’t change “Q3 review”: \d+ changes are waiting there/,
  );
  // The line sits under the Answer's text, inside the assistant, once the steps have opened.
  await expect
    .poll(async () => {
      const text = await refused.getByTestId("assistant-answer-text").boundingBox();
      const shown = await line.boundingBox();
      return shown !== null && text !== null && shown.y >= text.y + text.height;
    })
    .toBe(true);

  await pointAndClick(window, line.getByTestId("answer-waiting-review"));
  await expect(editor).toBeFocused();

  await setLanguage(window, "zh-CN");
  await expect(line).toHaveText(/^“Q3 review”中有 \d+ 处修订待确认。先接受或拒绝它们？· 审阅$/);
  await expect(timeline.getByTestId("answer-mind-call")).toHaveText(
    /无法修改“Q3 review”：其中有 \d+ 处修订待确认/,
  );

  await pointAndClick(window, held.getByTestId("applied-discard"));
  await expect(line).toHaveCount(0);
});
