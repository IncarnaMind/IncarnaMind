import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  addToNote,
  askInAssistant,
  clickEndOf,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * AI text (#95): what the AI writes into a Mind stays in the Answer's ink
 * until the User types over it or marks it as theirs, with the mouse or the
 * keyboard, and Undo takes that back. What the User types in it, an input
 * method's text included, is theirs alone. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

/** DESIGN.md: the User's writing in `ink`, AI text in `ink-answer`. */
const INK = "rgb(23, 25, 28)";
const AI_INK = "rgb(59, 64, 72)";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const setLanguage = (window: Page, language: "en" | "zh-CN") =>
  window.evaluate(
    (value) =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        user: { language: value },
      }),
    language,
  );

/** How the text holding `words` is drawn, and whether it is AI text. */
function inkOf(line: Locator, words: string): Promise<{ color: string; ai: boolean }> {
  return line.evaluate((element, wanted) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.includes(wanted)) continue;
      return {
        color: getComputedStyle(parent).color,
        ai: parent.closest(".generated-text") !== null,
      };
    }
    throw new Error(`"${wanted}" isn't in the line.`);
  }, words);
}

const MINE = { color: INK, ai: false };
const AI = { color: AI_INK, ai: true };

/** A Mind with a line of the User's, then the scripted Answer added to the note under it. */
async function mindWithAnswer(window: Page) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("My own line.");
  await window.keyboard.press("Enter");
  await addToNote(window, await askInAssistant(window, "How do tides work?"));
  const own = editor.locator(":scope > p").first();
  const line = editor.locator(":scope > p").nth(1);
  await expect(line).toHaveText("This is a scripted Answer to: How do tides work?");
  return { editor, own, line };
}

test("an Answer added to a note is AI text until typed over or marked as mine, by mouse or keyboard, with Undo", async () => {
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const { editor, own, line } = await mindWithAnswer(window);
  expect(await inkOf(own, "My own line.")).toEqual(MINE);
  expect(await inkOf(line, "Answer to")).toEqual(AI);
  // Its code is AI text too.
  await expect(editor.locator("pre .generated-text")).not.toHaveCount(0);
  await screenshot(window, "ai-text-en");

  // Typed inside it, and over words of it: only what was typed is the User's.
  await slideSelect(window, line, "Answer");
  await window.keyboard.press("ArrowLeft");
  await window.keyboard.type("short ");
  await slideSelect(window, line, "tides work");
  await window.keyboard.type("seas turn");
  await expect(line).toHaveText("This is a scripted short Answer to: How do seas turn?");
  expect(await inkOf(line, "short ")).toEqual(MINE);
  expect(await inkOf(line, "seas turn")).toEqual(MINE);
  expect(await inkOf(line, "Answer to")).toEqual(AI);
  await screenshot(window, "ai-text-typed-en");

  // Mark as mine from the selection menu, with the mouse; Undo takes it back.
  await slideSelect(window, line, "Answer to");
  const menu = window.getByTestId("selection-menu");
  const mine = menu.getByTestId("selection-action-mark-as-mine");
  await expect(mine).toHaveText("Mark as mine");
  await screenshot(window, "mark-as-mine-en");
  await pointAndClick(window, mine);
  await expect.poll(() => inkOf(line, "Answer to")).toEqual(MINE);
  await expect(window.getByTestId("undo-line")).toContainText("Marked as yours");
  await expect(mine).toBeHidden();
  await screenshot(window, "marked-as-mine-en");
  await window.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => inkOf(line, "Answer to")).toEqual(AI);

  // By keyboard: selected with the keys, ⌘/ into the menu, up from the Edit with AI field at its foot.
  const last = editor.locator(":scope > p", { hasText: "That is all." });
  await clickEndOf(window, last);
  for (let index = 0; index < "all.".length; index++) {
    await window.keyboard.press("Shift+ArrowLeft");
  }
  await expect(mine).toBeVisible();
  await window.keyboard.press("ControlOrMeta+/");
  await expect(menu.getByTestId("selection-turn-into")).toBeFocused();
  await window.keyboard.press("End");
  await expect(menu.getByTestId("selection-edit-handoff")).toBeFocused();
  await window.keyboard.press("ArrowUp");
  await expect(menu.getByTestId("selection-edit-field")).toBeFocused();
  await window.keyboard.press("ArrowUp");
  await expect(mine).toBeFocused();
  await window.keyboard.press("Enter");
  await expect.poll(() => inkOf(last, "all.")).toEqual(MINE);
  expect(await inkOf(last, "That is ")).toEqual(AI);

  // In Chinese, once Esc has closed the menu.
  await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await setLanguage(window, "zh-CN");
  await slideSelect(window, line, "scripted");
  await expect(mine).toHaveText("标为我写的");
  await screenshot(window, "mark-as-mine-zh");
  await pointAndClick(window, mine);
  await expect(window.getByTestId("undo-line")).toContainText("已标为你写的");
  await expect.poll(() => inkOf(line, "scripted")).toEqual(MINE);
});

test("what an input method writes inside AI text, or over a selection of it, is the User's", async () => {
  const { window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const { line } = await mindWithAnswer(window);
  const session = await window.context().newCDPSession(window);
  try {
    // At a cursor inside a word's run.
    await slideSelect(window, line, "Answer");
    await window.keyboard.press("ArrowLeft");
    await session.send("Input.imeSetComposition", {
      text: "chao",
      selectionStart: 4,
      selectionEnd: 4,
    });
    await session.send("Input.insertText", { text: "潮汐" });
    // Over selected words of it.
    await slideSelect(window, line, "tides work");
    await session.send("Input.imeSetComposition", {
      text: "hai",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await session.send("Input.insertText", { text: "海浪" });
  } finally {
    await session.detach();
  }
  await expect(line).toHaveText("This is a scripted 潮汐Answer to: How do 海浪?");
  expect(await inkOf(line, "潮汐")).toEqual(MINE);
  expect(await inkOf(line, "海浪")).toEqual(MINE);
  expect(await inkOf(line, "Answer to")).toEqual(AI);
});
