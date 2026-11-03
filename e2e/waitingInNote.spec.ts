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
 * The Answer's card and the Note's bar are two facts (#1897): the card says what this request
 * did, and when other changes wait in the Note too, it adds the Note's own count. The scripted
 * model (src/main/fakeChat/minds.ts) rewrites the User's notes "to be clearer" as changes that
 * wait, and adds "a section on the risks" at once. Set INCARNAMIND_SCREENSHOTS to a folder to
 * also save screenshots.
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

const NOTES = [
  "Tides rise twice a day along this coast.",
  "The harbour office posts the times each week.",
];

async function writeMind(window: Page, title: string, notes: readonly string[]): Promise<void> {
  await newMind(window);
  await nameMind(window, title);
  await enterContent(window);
  for (const [index, note] of notes.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(note);
  }
}

test("a change applied beside others waiting in the Note says how many wait there, with Review at the change; alone it says nothing more, in English and Chinese", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeMind(window, "Harbour notes", NOTES);
  const editor = window.getByTestId("mind-editor");

  // A change applied with nothing else waiting: the card is as it was.
  const alone = await askInAssistant(window, "Add a section on the risks");
  await expect(alone.getByTestId("mind-changes-title")).toContainText("Changed");
  await expect(alone.getByTestId("mind-changes-in-note")).toHaveCount(0);

  // Changes that wait: the card names its own, and nothing about the Note beyond them.
  const held = await askInAssistant(window, "Rewrite the intro to be clearer");
  await expect(held.getByTestId("mind-changes-left")).toHaveText(/changes waiting/);
  await expect(held.getByTestId("mind-changes-in-note")).toHaveCount(0);
  const count = Number(/\d+/.exec(await held.getByTestId("mind-changes-left").innerText())?.[0]);
  expect(count).toBeGreaterThan(1);

  // A change applied at once beside them: the Note's count, in the Note's own number.
  const applied = await askInAssistant(window, "Add a section on the risks");
  const inNote = applied.getByTestId("mind-changes-in-note");
  await expect(inNote).toHaveText(
    count === 1 ? "· 1 change waiting in this note" : `· ${count} changes waiting in this note`,
  );
  await screenshot(window, "waiting-in-note-en");

  await pointAndClick(window, applied.getByTestId("mind-changes-note-review"));
  await expect(editor).toBeFocused();

  await setLanguage(window, "zh-CN");
  await expect(inNote).toHaveText(`· 本笔记有 ${count} 处修订待处理`);
  await screenshot(window, "waiting-in-note-zh");
});
