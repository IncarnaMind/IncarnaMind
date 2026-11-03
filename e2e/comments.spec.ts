import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  runFromPalette,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/**
 * Comments on selected text (#328): made from the selection menu, ⌥⌘M or ⌘K;
 * shown beside their words and in the Mind's list; replied to, edited,
 * resolved, reopened and deleted with Undo; folded into a count under a narrow
 * Mind; kept through a restart; and never over the Citation checks' gutter.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

/** Where screenshots go, when the run was given a folder for them. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function screenshot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

const card = (window: Page) => window.locator('[data-testid^="comment-card-"]');

/** Folds the assistant: its 320px is most of the room a card beside the text needs. */
async function foldAssistant(window: Page) {
  const assistant = window.getByTestId("assistant");
  if (await assistant.getAttribute("data-folded")) return;
  const direct = window.getByTestId("assistant-fold");
  if (
    await direct
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await pointAndClick(window, direct.first());
  } else {
    await pointAndClick(window, window.getByTestId("assistant-more"));
    const item = window.getByTestId("assistant-menu-fold");
    if ((await item.count()) > 0) await pointAndClick(window, item);
    else {
      await window.keyboard.press("Escape");
      await runFromPalette(window, "Assistant: Fold");
    }
  }
  await expect(assistant).toHaveAttribute("data-folded", "true");
}

async function mindWith(window: Page, text: string) {
  await dismissChatSetup(window);
  await foldAssistant(window);
  await newMind(window);
  await window.keyboard.type(text);
  await motionSettled(window);
}

/** Selects the whole line the cursor is on with the keyboard. */
async function selectLine(window: Page) {
  await window.keyboard.press("Home");
  await window.keyboard.press("Shift+End");
}

test("a comment is added, answered, resolved, reopened and deleted, each with Undo, and stays through a restart", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1800, 900);
  await mindWith(window, "The tides here are strong.");
  const editor = window.getByTestId("mind-editor");

  // From the selection menu, with the mouse: Comment leaves a quiet underline and opens the card to type.
  await slideSelect(window, editor.locator("p").first(), "tides here");
  await pointAndClick(window, window.getByTestId("selection-comment"));
  await expect(card(window)).toHaveCount(1);
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await expect(editor.locator(".comment-mark")).toHaveText("tides here");
  await window.keyboard.type("Is this still true?");
  await pointAndClick(window, window.getByTestId("comment-save"));
  await expect(card(window)).toContainText("Is this still true?");

  // Edit your own comment: ⌘Z puts its first words back.
  await pointAndClick(window, window.locator('[data-testid^="comment-menu-"]').first());
  await pointAndClick(window, window.getByRole("menuitem", { name: "Edit" }));
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.press("ControlOrMeta+a");
  await window.keyboard.type("Is this still accurate?");
  await pointAndClick(window, window.getByTestId("comment-edit-save"));
  await expect(card(window)).toContainText("Is this still accurate?");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(card(window)).toContainText("Is this still true?");

  await screenshot(window, "comments-en-wide");

  // Typing before its words leaves it on them.
  await editor.click();
  await window.keyboard.press("Home");
  await window.keyboard.type("Note: ");
  await expect(editor.locator(".comment-mark")).toHaveText("tides here");
  await expect(card(window)).toHaveCount(1);

  // The card stands beside the text, clear of the 48px gutter the Citation checks use, and
  // wholly inside the page: never cut at its right edge.
  const frame = await window.locator(".mind-editor-frame").boundingBox();
  const page = await window.locator(".mind-column").boundingBox();
  const place = await window.locator("[data-comment-card]").boundingBox();
  if (!frame || !page || !place) throw new Error("The card isn't visible.");
  expect(place.x).toBeGreaterThanOrEqual(frame.x + frame.width + 48);
  expect(place.x + place.width).toBeLessThanOrEqual(page.x + page.width - 8);

  // Reply, then resolve: the card leaves the margin, and the list says it is resolved.
  await pointAndClick(window, window.locator('[data-testid^="comment-reply-"]').first());
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.type("Yes, checked.");
  await pointAndClick(window, window.locator('[data-testid^="comment-reply-send-"]').first());
  await expect(card(window)).toContainText("Yes, checked.");
  // Undo takes the reply back, and Redo puts it back.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(card(window)).not.toContainText("Yes, checked.");
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(card(window)).toContainText("Yes, checked.");
  await pointAndClick(window, window.locator('[data-testid^="comment-resolve-"]').first());
  await expect(card(window)).toHaveCount(0);
  // Undo brings it back open; resolving again closes it.
  await window.keyboard.press("ControlOrMeta+z");
  await expect(card(window)).toHaveCount(1);
  await pointAndClick(window, window.locator('[data-testid^="comment-resolve-"]').first());
  await expect(card(window)).toHaveCount(0);
  await pointAndClick(window, window.getByTestId("comments-count"));
  const list = window.getByTestId("comments-list");
  await expect(list).toBeVisible();
  await expect(list).toContainText("Resolved");
  await expect(list).toContainText("Is this still true?");

  // A click in the list goes to the text and opens the card; Reopen brings it back beside it.
  await pointAndClick(window, window.locator('[data-testid^="comments-row-"]').first());
  await expect(card(window)).toHaveCount(1);
  await pointAndClick(window, window.locator('[data-testid^="comment-resolve-"]').first());
  await expect(card(window)).toHaveCount(1);
  await pointAndClick(window, window.locator('[data-testid^="comment-resolve-"]').first());
  await expect(card(window)).toHaveCount(0);
  await pointAndClick(window, window.getByTestId("comments-count"));
  await pointAndClick(window, window.locator('[data-testid^="comments-row-"]').first());
  await pointAndClick(window, window.locator('[data-testid^="comment-resolve-"]').first());
  await expect(card(window)).toHaveCount(1);

  // Delete, with Undo from the line and from ⌘Z: the comment goes and comes back.
  await pointAndClick(window, window.locator('[data-testid^="comment-menu-"]').first());
  await pointAndClick(window, window.getByRole("menuitem", { name: "Delete" }));
  await expect(card(window)).toHaveCount(0);
  await pointAndClick(window, window.getByRole("button", { name: "Undo" }).first());
  await expect(card(window)).toHaveCount(1);

  // A restart keeps it on its words.
  await app.close();
  const restarted = await launchApp(dataDir);
  await setWindowSize(restarted.app, restarted.window, 1800, 900);
  await pointAndClick(restarted.window, restarted.window.getByTestId("mind-row").first());
  await expect(restarted.window.locator(".comment-mark")).toHaveText("tides here");
  await expect(card(restarted.window)).toContainText("Is this still true?");
  await restarted.app.close();
});

test("after a comment is deleted, Comment on its words makes a new one", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1800, 900);
  await mindWith(window, "The margin moved.");
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor.locator("p").first());
  await selectLine(window);
  await pointAndClick(window, window.getByTestId("selection-comment"));
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.type("First remark.");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(card(window)).toContainText("First remark.");

  // Its record goes, its mark stays as the anchor Undo would restore it to.
  await pointAndClick(window, window.locator('[data-testid^="comment-menu-"]').first());
  await pointAndClick(window, window.getByRole("menuitem", { name: "Delete" }));
  await expect(card(window)).toHaveCount(0);

  // Commenting the same words again makes a new comment, rather than finding the deleted one.
  await pointAndClick(window, editor.locator("p").first());
  await selectLine(window);
  await pointAndClick(window, window.getByTestId("selection-comment"));
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.type("Second remark.");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(card(window)).toContainText("Second remark.");
  await app.close();
});

test("the keys add a comment, a narrow Mind folds the cards into a count, and deleted words say Text removed with Undo", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1800, 900);
  await mindWith(window, "Margins recovered this quarter.");
  const editor = window.getByTestId("mind-editor");
  await pointAndClick(window, editor.locator("p").first());
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await window.keyboard.type("Costs fell.");
  await motionSettled(window);
  await expect(editor.locator("p")).toHaveText(["Margins recovered this quarter.", "Costs fell."]);

  // ⌥⌘M on macOS, Ctrl+Alt+M elsewhere, as Word and Google Docs add a comment.
  await selectLine(window);
  await expect(window.getByTestId("selection-menu")).toBeVisible();
  await window.keyboard.press(process.platform === "darwin" ? "Alt+Meta+m" : "Control+Alt+m");
  await expect(card(window)).toHaveCount(1);
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.type("Check the margin.");
  await window.keyboard.press("ControlOrMeta+Enter");
  await expect(card(window)).toContainText("Check the margin.");

  // The command list finds Comment too (⌘K on selected text is the link's, so Search opens it);
  // Esc leaves the draft unadded.
  await pointAndClick(window, editor.locator("p").first());
  await selectLine(window);
  await pointAndClick(window, window.getByTestId("sidebar-search"));
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type("Comment");
  await pointAndClick(
    window,
    window.getByTestId("palette").locator('[data-key="command:comment.add"]'),
  );
  await expect(card(window)).toHaveCount(2);
  await window.keyboard.press("Escape");
  await expect(card(window)).toHaveCount(1);

  // A Mind without the room folds the cards into the count: at 1440 as well as at 900.
  await setWindowSize(app, window, 1440, 900);
  await expect(window.locator("[data-comment-card]")).toHaveCount(0);
  await expect(window.getByTestId("comments-count")).toBeVisible();
  await screenshot(window, "comments-en-1440");
  await setWindowSize(app, window, 900, 900);
  await screenshot(window, "comments-en-narrow");
  await expect(window.locator("[data-comment-card]")).toHaveCount(0);
  await expect(window.getByTestId("comments-count")).toBeVisible();
  await pointAndClick(window, window.getByTestId("comments-count"));
  await expect(window.getByTestId("comments-list")).toContainText("Check the margin.");

  // All the words deleted: the comment stays in the list as Text removed, and Undo brings both back.
  await setWindowSize(app, window, 1800, 900);
  await pointAndClick(window, editor.locator("p").nth(1));
  await selectLine(window);
  await window.keyboard.press("Backspace");
  await expect(editor.locator(".comment-mark")).toHaveCount(0);
  await expect(card(window)).toHaveCount(0);
  await pointAndClick(window, window.getByTestId("comments-count"));
  await expect(window.getByTestId("comments-list")).toContainText("Text removed");
  await window.keyboard.press("Escape");
  await pointAndClick(window, editor.locator("p").first());
  await window.keyboard.press("ControlOrMeta+Z");
  await expect(editor.locator(".comment-mark")).toBeVisible();
  await expect(card(window)).toContainText("Check the margin.");
  await app.close();
});

test("the interface is Chinese: 批注, 回复, 解决 and 原文已删除", async () => {
  const { app, window } = await launchApp(dataDir);
  await setWindowSize(app, window, 1800, 900);
  await mindWith(window, "本季度的利润率回升了。");
  await setLanguage(window, "zh-CN");
  const editor = window.getByTestId("mind-editor");
  await slideSelect(window, editor.locator("p").first(), "利润率");
  await pointAndClick(window, window.getByTestId("selection-comment"));
  await expect(window.getByTestId("comment-save")).toBeVisible();
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.type("请核对这个数字。");
  await pointAndClick(window, window.getByTestId("comment-save"));
  await expect(card(window)).toContainText("请核对这个数字。");
  await expect(window.locator('[data-testid^="comment-reply-"]').first()).toHaveText("回复");
  await expect(window.locator('[data-testid^="comment-resolve-"]').first()).toHaveText("解决");
  await expect(window.getByTestId("comments-count")).toContainText("批注");
  await screenshot(window, "comments-zh-wide");
  await pointAndClick(window, window.getByTestId("comments-count"));
  await expect(window.getByTestId("comments-list")).toContainText("批注");
  await window.keyboard.press("Escape");
  await setWindowSize(app, window, 1440, 900);
  await expect(window.locator("[data-comment-card]")).toHaveCount(0);
  await screenshot(window, "comments-zh-1440");
  await setWindowSize(app, window, 900, 900);
  await screenshot(window, "comments-zh-narrow");
  await expect(window.locator("[data-comment-card]")).toHaveCount(0);
  await app.close();
});

test("Address with the assistant answers the comment in the text, with one Undo, and replies to it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 1800, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await foldAssistant(window);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  await window.keyboard.type("The tides here are strong.");
  await motionSettled(window);
  await slideSelect(window, editor.locator("p").first(), "tides here");
  await pointAndClick(window, window.getByTestId("selection-comment"));
  await expect(window.locator(".comment-field").first()).toBeFocused();
  await window.keyboard.type("Make this about waves.");
  await pointAndClick(window, window.getByTestId("comment-save"));

  await pointAndClick(window, window.locator('[data-testid^="comment-menu-"]').first());
  await pointAndClick(window, window.getByRole("menuitem", { name: "Address with the assistant" }));
  // The scripted model changes the passage the comment is on, and the thread says it did.
  await expect(editor.locator("p").first()).toContainText("(edited)");
  await expect(card(window)).toContainText("Answered in the text.");

  // One Undo: the edit goes, and the comment can then be resolved.
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(editor.locator("p").first()).toHaveText("The tides here are strong.");
  await app.close();
});
