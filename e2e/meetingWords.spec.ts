import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openSettings,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  startRecording,
} from "./app";

/**
 * Words to know in Settings › Meetings (#1031): names the transcriber on this computer is told at
 * each meeting's start, added, renamed in place and removed with Undo, in English and Chinese;
 * and the script Transcripts write Chinese in.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const settingsOf = (window: Page) =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.getSettings(),
  );

const rowNames = (section: Locator) => section.getByTestId("meeting-word-name");

async function addWord(window: Page, section: Locator, word: string): Promise<void> {
  const field = section.getByTestId("meeting-words-field");
  await pointAndClick(window, field);
  await window.keyboard.type(word);
  await window.keyboard.press("Enter");
  await expect(field).toHaveValue("");
}

test("Words to know: words are added at the top, renamed by double-click and F2, and removed with Undo, in English and Chinese", async () => {
  const { window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  const settings = await openSettings(window, "meetings");
  const section = settings.getByTestId("meeting-words");
  await expect(section.getByRole("heading", { name: "Words to know" })).toBeVisible();
  await expect(section.getByTestId("meeting-words-list")).toHaveCount(0);

  await addWord(window, section, "Lindqvist");
  const field = section.getByTestId("meeting-words-field");
  await pointAndClick(window, field);
  await window.keyboard.type("星河科技");
  await pointAndClick(window, section.getByTestId("meeting-words-add"));
  await expect(rowNames(section)).toHaveText(["星河科技", "Lindqvist"]);

  // A word already there, whatever its case, isn't added twice: it stays typed, to be changed.
  await pointAndClick(window, field);
  await window.keyboard.type("lindqvist");
  await window.keyboard.press("Enter");
  await expect(section.getByTestId("meeting-words-problem")).toHaveText(
    "“lindqvist” is in the list already.",
  );
  await expect(field).toHaveValue("lindqvist");
  await expect(rowNames(section)).toHaveText(["星河科技", "Lindqvist"]);
  await field.fill("");
  await expect(section.getByTestId("meeting-words-problem")).toHaveCount(0);

  // Renamed where it is: a double-click, Enter saves; F2, Esc keeps the name.
  await rowNames(section).nth(1).hover();
  await rowNames(section).nth(1).dblclick();
  const renaming = section.getByTestId("meeting-word-field");
  await expect(renaming).toBeFocused();
  await window.keyboard.type("Sofia Lindqvist");
  await window.keyboard.press("Enter");
  await expect(rowNames(section)).toHaveText(["星河科技", "Sofia Lindqvist"]);
  await expect(section.getByTestId("undo-message")).toHaveText(
    "Renamed “Lindqvist” to “Sofia Lindqvist”",
  );
  await rowNames(section).first().focus();
  await window.keyboard.press("F2");
  await expect(renaming).toBeFocused();
  await window.keyboard.type("星河科技集团");
  await window.keyboard.press("Escape");
  await expect(rowNames(section)).toHaveText(["星河科技", "Sofia Lindqvist"]);
  await rowNames(section).first().focus();
  await window.keyboard.press("F2");
  await window.keyboard.type("星河科技集团");
  await window.keyboard.press("Enter");
  await expect(rowNames(section)).toHaveText(["星河科技集团", "Sofia Lindqvist"]);
  expect((await settingsOf(window)).user.meetingWords).toEqual(["星河科技集团", "Sofia Lindqvist"]);

  // Removed at once, with Undo there, which puts it back where it was.
  const remove = section.getByRole("button", { name: "Remove “Sofia Lindqvist”" });
  await pointAndClick(window, remove);
  await expect(rowNames(section)).toHaveText(["星河科技集团"]);
  await expect(section.getByTestId("undo-message")).toHaveText(
    "Removed “Sofia Lindqvist” from Words to know",
  );
  await pointAndClick(window, section.getByTestId("undo-action"));
  await expect(rowNames(section)).toHaveText(["星河科技集团", "Sofia Lindqvist"]);
  // Delete on a focused word removes it too.
  await rowNames(section).nth(1).focus();
  await window.keyboard.press("Delete");
  await expect(rowNames(section)).toHaveText(["星河科技集团"]);
  await expect(rowNames(section).first()).toBeFocused();

  // In Chinese, the same list in Chinese words.
  await setLanguage(window, "zh-CN");
  await expect(section.getByRole("heading", { name: "要识别的词" })).toBeVisible();
  await addWord(window, section, "王丽");
  await expect(rowNames(section)).toHaveText(["王丽", "星河科技集团"]);
  await pointAndClick(window, section.getByRole("button", { name: "移除“星河科技集团”" }));
  await expect(section.getByTestId("undo-message")).toHaveText(
    "已从要识别的词中移除“星河科技集团”",
  );
  await expect(rowNames(section)).toHaveText(["王丽"]);
  await pointAndClick(window, section.getByTestId("undo-action"));
  await expect(rowNames(section)).toHaveText(["王丽", "星河科技集团"]);
  await rowNames(section).first().dblclick();
  await window.keyboard.type("王丽丽");
  await window.keyboard.press("Enter");
  await expect(rowNames(section)).toHaveText(["王丽丽", "星河科技集团"]);
  await expect(section.getByTestId("undo-message")).toHaveText("已将“王丽”重命名为“王丽丽”");

  // The script follows the interface, Simplified here, until another is chosen.
  const script = settings.getByTestId("meeting-script");
  await expect(script).toHaveValue("simplified");
  await expect(script.locator("option:checked")).toHaveText("简体");
  await script.selectOption("traditional");
  await expect.poll(async () => (await settingsOf(window)).chineseScript).toBe("traditional");
  await expect(script.locator("option:checked")).toHaveText("繁体");
});

test("⌘K opens Words to know with its field ready, and a word told there is written right in a meeting's Transcript", async () => {
  const { window } = await launchApp(dataDir, { transcriber: { mishears: { Dana: "Donna" } } });
  await dismissChatSetup(window);
  await runCommand(window, "settings.meetingWords", "Words to know");
  const section = window.getByTestId("meeting-words");
  await expect(section.getByTestId("meeting-words-field")).toBeFocused();
  await window.keyboard.type("Dana");
  await window.keyboard.press("Enter");
  await expect(section.getByTestId("meeting-word-name")).toHaveText(["Dana"]);
  await closeSettings(window);

  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const toggle = bar.getByTestId("meeting-transcript-toggle");
  await expect(toggle).toBeEnabled({ timeout: 20_000 });
  await pointAndClick(window, toggle);
  const transcript = window.getByTestId("viewer-transcript");
  // The other side's third line names Dana, whom the engine hears as Donna unless told.
  await expect(transcript.getByText("Dana is joining us from the Leeds office.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(transcript.getByText(/Donna/)).toHaveCount(0);
});
