import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  tabMenu,
  useLocalChatModel,
} from "./app";

/*
 * New Mind under an Answer (#1559): the Answer as it is, its Citations checked, at once in the
 * empty Mind in front, or else in a new Mind beside it, named by its first line, a name another
 * Mind has taking a number. The scripted model answers from the Document with a Citation. Set
 * INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

test("New Mind isn't offered in the empty Mind in front, where Add to note names it; with text in front it makes new Minds named by the Answer's first line, numbered apart, its Citation checked and nothing left to accept", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  const tabs = window.getByTestId("mind-tab");
  await expect(tabs).toHaveCount(1);

  const answer = await askInAssistant(window, "When do spring tides happen?");
  const button = answer.getByTestId("answer-new-mind");
  // It would fill this same empty Mind, as the named Add to note does.
  await expect(button).toHaveCount(0);
  await pointAndClick(window, answer.getByTestId("answer-add"));
  await expect(editor.getByTestId("citation").first()).toHaveAttribute("data-check", "found");
  await expect(tabs).toHaveCount(1);
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  // Named by its first line a moment after the Answer is in.
  await expect(frontMindName(window)).not.toHaveText(/^(Untitled|未命名)$/);
  const first = (await frontMindName(window).textContent())?.trim() ?? "";
  await screenshot(window, "new-mind-filled");

  // With text in front, a new Mind beside it, named by the same first line, so numbered.
  await pointAndClick(window, button);
  await expect(tabs).toHaveCount(2);
  await expect(frontMindName(window)).toHaveText(`${first} 2`);
  await expect(editor.getByTestId("citation").first()).toHaveAttribute("data-check", "found");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await pointAndClick(window, button);
  await expect(tabs).toHaveCount(3);
  await expect(frontMindName(window)).toHaveText(`${first} 3`);
  await screenshot(window, "new-mind-numbered");

  await setLanguage(window, "zh-CN");
  await expect(button).toHaveText("新建 Mind");
});

test("by the keyboard: Tab reaches New Mind, which an empty Mind in front doesn't offer; with text in front, or only a divider, Enter makes a new Mind beside it, which Delete takes back; ⌘K finds it by the button's name", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  const citations = editor.getByTestId("citation");
  const tabs = window.getByTestId("mind-tab");
  const answer = await askInAssistant(window, "When do spring tides happen?");
  const button = answer.getByTestId("answer-new-mind");
  await expect(button).toHaveCount(0);

  // With text in front, Enter makes a new Mind beside it, after Add to note ▾ in the Tab order.
  await editor.click();
  await window.keyboard.type("Harbour notes");
  await expect(button).toHaveText("New Mind");
  await answer.getByTestId("answer-add-to").focus();
  await window.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await window.keyboard.press("Enter");
  await expect(tabs).toHaveCount(2);
  await expect(citations.first()).toHaveAttribute("data-check", "found");
  const made = (await frontMindName(window).textContent())?.trim() ?? "";
  // Making a Mind leaves nothing to undo here: the focus stays on New Mind, in the assistant.
  await expect(button).toBeFocused();

  // Delete takes the made Mind back, with its tab.
  await pointAndClick(window, (await tabMenu(window)).getByTestId("mind.delete"));
  await expect(tabs).toHaveCount(1);
  await expect(window.getByTestId("undo-message")).toHaveText(
    `Moved “${made}” to Recently deleted`,
  );

  // A Mind holding only a divider isn't empty: New Mind makes another beside it.
  await newMind(window);
  await expect(tabs).toHaveCount(2);
  await window.keyboard.type("/divider");
  await expect(window.getByTestId("slash-item-divider")).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(editor.locator("hr")).toHaveCount(1);
  await pointAndClick(window, button);
  await expect(tabs).toHaveCount(3);
  await expect(citations.first()).toHaveAttribute("data-check", "found");

  // ⌘K finds it by the button's name, in English and Chinese.
  const entry = window
    .getByTestId("palette")
    .locator('[data-key="command:assistant.lastToNewMind"]');
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Write the Answer");
  await expect(entry).toHaveText(/Write the Answer as a note/);
  await expect(entry).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(tabs).toHaveCount(4);
  await setLanguage(window, "zh-CN");
  await window.keyboard.press("ControlOrMeta+k");
  await window.keyboard.type("把回答写成笔记");
  await expect(entry).toHaveText(/把回答写成笔记/);
  await window.keyboard.press("Escape");
});
