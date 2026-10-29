import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askToChange,
  createDataFolder,
  dismissChatSetup,
  focusEditor,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  openPageMenu,
  paletteOffers,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * An edit the User asks for on the text applies at once (#880): ⌘J and the
 * selection menu's AI actions. A line over it says how many paragraphs changed, with Undo and
 * Review changes. The scripted model (src/main/fakeChat/edit.ts and
 * src/main/fakeChat/appliedEdits.ts) does what "replace X with Y" says, shortens
 * by dropping "very" and "really", gives back only the second paragraph
 * made formal, as Claude Haiku 5.5 did, deletes the second paragraph, and
 * writes a haiku like none of the text. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = "The tides here are very strong and really regular.";
const FIRST = "Tides rise twice a day along this coast.";
const SECOND = "It is a big harbour and a lot of boats do not leave at low water.";
const THIRD = "The harbour office posts the times each week.";
const FORMAL = "It is a considerable harbour and a great many boats do not leave at low water.";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

async function launch(width = 1440) {
  const running = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(running.window);
  await setWindowSize(running.app, running.window, width, 900);
  return running;
}

/** A new Mind with these paragraphs; its editor and paragraphs. */
async function mindWith(window: Page, lines: readonly string[]) {
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(line);
  }
  const paragraphs = editor.locator(":scope > p");
  await expect(paragraphs).toHaveText(lines.filter((line) => !line.startsWith("#")));
  return { editor, paragraphs };
}

async function selectAll(window: Page, editor: Locator) {
  await editor.click();
  await window.keyboard.press("ControlOrMeta+a");
}

const lineOf = (editor: Locator) => editor.getByTestId("applied-line");

test("⌘J applies the change at once as AI text, with Changed 1 paragraph · Undo ⌘Z · Review changes over it; ⌘Z takes it back and ⌘⇧Z does it again, in Chinese too", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const note = paragraphs.first();

  await slideSelect(window, note, TIDES);
  await askToChange(window, "replace strong with powerful");

  await expect(note).toHaveText("The tides here are very powerful and really regular.");
  await expect(note.locator("del.proposal-delete, ins.proposal-insert")).toHaveCount(0);
  await expect(note.locator(".generated-text")).toHaveText("powerful");
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  const line = lineOf(editor);
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await expect(line).toContainText(/Undo(⌘Z|Ctrl\+Z)/);
  await expect(line.getByTestId("applied-review")).toHaveText("Review changes");
  await expect(line).toHaveAttribute("title", "Why: Changed as you asked.");
  // Its Undo is under the paragraph, not at the sidebar's foot as well.
  await expect(window.getByTestId("undo-message")).toHaveCount(0);
  // Over the Block it changed.
  const lineBox = await line.boundingBox();
  const noteBox = await note.boundingBox();
  expect((lineBox?.y ?? 0) + (lineBox?.height ?? 0)).toBeLessThanOrEqual((noteBox?.y ?? 0) + 1);
  await motionSettled(window);
  await screenshot(window, "applied-en");

  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("applied-count")).toHaveText("修改了 1 个段落");
  await expect(line.getByTestId("applied-undo")).toHaveText("撤销");
  await expect(line.getByTestId("applied-review")).toHaveText("查看改动");
  await screenshot(window, "applied-zh");
  await setLanguage(window, "en");

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(note).toHaveText(TIDES);
  await expect(line).toHaveCount(0);
  await window.keyboard.press("ControlOrMeta+Shift+z");
  await expect(note).toHaveText("The tides here are very powerful and really regular.");
  await expect(note.locator("del.proposal-delete, ins.proposal-insert")).toHaveCount(0);
});

test("Shorten from the menu applies at once; Review changes shows what it did, struck and underlined, over text that stays applied, each with Restore original; Done keeps the rest, and Undo all takes all back", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const note = paragraphs.first();
  const line = lineOf(editor);
  const removed = note.locator("del.applied-old");

  await slideSelect(window, note, TIDES);
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText("The tides here are strong and regular.");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");

  await pointAndClick(window, line.getByTestId("applied-review"));
  await expect(removed).toHaveText(["very ", "really "]);
  await expect(line.getByTestId("applied-count")).toHaveText("1 paragraph changed by Edit with AI");
  await expect(line.getByTestId("applied-undo-all")).toHaveText("Undo all");
  await expect(line.getByTestId("applied-done")).toHaveText("Done");
  await expect(note.locator(".applied-new")).toHaveCount(0);
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await motionSettled(window);
  await screenshot(window, "applied-review-en");

  // Restoring one leaves the other.
  const restores = note.getByTestId("change-restore");
  await expect(restores).toHaveText(["Restore original", "Restore original"]);
  await pointAndClick(window, restores.first());
  await expect(removed).toHaveText(["really "]);
  await expect(note).toContainText("are very strong");
  await expect(window.getByTestId("undo-message")).toHaveText("Restored the original");
  await expect(line.getByTestId("applied-count")).toHaveText("1 paragraph changed by Edit with AI");
  await pointAndClick(window, line.getByTestId("applied-done"));
  await expect(note).toHaveText("The tides here are very strong and regular.");
  await expect(removed).toHaveCount(0);
  await expect(line).toHaveCount(0);

  // Undo all, in Chinese.
  await setLanguage(window, "zh-CN");
  await slideSelect(window, note, "The tides here are very strong and regular.");
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText("The tides here are strong and regular.");
  await pointAndClick(window, line.getByTestId("applied-review"));
  await expect(line.getByTestId("applied-count")).toHaveText("用 AI 编辑修改的 1 个段落");
  await expect(line.getByTestId("applied-done")).toHaveText("完成");
  await expect(note.getByTestId("change-restore")).toHaveText("恢复原文");
  await pointAndClick(window, line.getByTestId("applied-undo-all"));
  await expect(note).toHaveText("The tides here are very strong and regular.");
  await expect(line).toHaveCount(0);
});

test("whole note selected, “make the second paragraph more formal”, the model gives back only that paragraph: it changes, the two it left out are kept, and Remove them takes them out; ⌘Z brings them back, and the line's Undo takes back the whole edit, at 1,100 px", async () => {
  const { window } = await launch(1100);
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD]);
  const line = lineOf(editor);
  const kept = editor.getByTestId("applied-kept");

  await selectAll(window, editor);
  await askToChange(window, "make the second paragraph more formal; leave the others as they are");

  await expect(paragraphs).toHaveText([FIRST, FORMAL, THIRD]);
  await expect(line.getByTestId("applied-count")).toHaveText(/^Changed \d+ paragraphs?$/);
  await expect(kept).toHaveText("Kept 2 paragraphs the edit left out·Remove them");
  // The line over the paragraph it changed, the kept one's over the first it kept.
  const keptBox = await kept.boundingBox();
  const firstBox = await paragraphs.first().boundingBox();
  expect((keptBox?.y ?? 0) + (keptBox?.height ?? 0)).toBeLessThanOrEqual((firstBox?.y ?? 0) + 1);
  const lineBox = await line.boundingBox();
  expect(lineBox?.y ?? 0).toBeGreaterThan((firstBox?.y ?? 0) + (firstBox?.height ?? 0) - 1);
  await motionSettled(window);
  await screenshot(window, "applied-kept-en-1100");
  await setLanguage(window, "zh-CN");
  await expect(kept).toHaveText("保留了这次修改漏掉的 2 个段落·删除它们");
  await screenshot(window, "applied-kept-zh-1100");
  await setLanguage(window, "en");

  await pointAndClick(window, kept.getByTestId("applied-remove-kept"));
  await expect(paragraphs).toHaveText([FORMAL]);
  await expect(kept).toHaveCount(0);
  await expect(window.getByTestId("undo-message")).toHaveText("Removed what the edit left out");
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([FIRST, FORMAL, THIRD]);

  await pointAndClick(window, line.getByTestId("applied-undo"));
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD]);
  await expect(line).toHaveCount(0);
});

test("Remove them, then Review changes: only the edit's own change is shown again, and the heading and the paragraph outside the selection stay", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const NEXT = "The next meeting is in May.";
  const { editor, paragraphs } = await mindWith(window, [
    "## Harbour notes",
    FIRST,
    SECOND,
    THIRD,
    NEXT,
  ]);
  const heading = editor.locator(":scope > h2");
  await expect(heading).toHaveText("Harbour notes");
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD, NEXT]);
  const line = lineOf(editor);

  await slideSelect(window, paragraphs.first(), FIRST, { line: paragraphs.nth(2), words: THIRD });
  await askToChange(window, "make the second paragraph more formal; leave the others as they are");
  await expect(paragraphs).toHaveText([FIRST, FORMAL, THIRD, NEXT]);
  await pointAndClick(window, editor.getByTestId("applied-remove-kept"));
  await expect(paragraphs).toHaveText([FORMAL, NEXT]);

  await pointAndClick(window, line.getByTestId("applied-review"));
  await expect(line.getByTestId("applied-count")).toHaveText(
    /paragraphs? changed by Edit with AI$/,
  );
  await expect(paragraphs.first().locator(".applied-new").first()).toBeVisible();
  await expect(paragraphs.first().locator("del.applied-old").first()).toBeVisible();
  await expect(heading).toHaveText("Harbour notes");
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.last()).toHaveText(NEXT);

  await pointAndClick(window, line.getByTestId("applied-done"));
  await expect(line).toHaveCount(0);
  await expect(heading).toHaveText("Harbour notes");
  await expect(paragraphs).toHaveText([FORMAL, NEXT]);
});

test("an edit that would remove most of what was selected, and can't be mapped onto it, waits for the User through typing elsewhere: Discard leaves the text, Apply applies it", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD, "Notes:"]);
  const line = lineOf(editor);
  const selectThree = () =>
    slideSelect(window, paragraphs.first(), "Tides rise", {
      line: paragraphs.nth(2),
      words: "each week.",
    });

  await selectThree();
  await askToChange(window, "replace it all with a haiku");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "Waiting for you: this edit removes most of your selection",
  );
  // Each paragraph written anew reads whole, its old text one line above it, struck on a click (#1028).
  const was = editor.getByTestId("change-was-line").first();
  await expect(was).toBeVisible();
  await expect(editor.locator("del.proposal-delete").first()).toBeHidden();
  await pointAndClick(window, was.getByTestId("change-was"));
  await expect(editor.locator("del.proposal-delete").first()).toBeVisible();
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await motionSettled(window);
  await screenshot(window, "applied-held-en");
  await setLanguage(window, "zh-CN");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "等你确认：这次修改会删掉选中的大部分内容",
  );
  await expect(line.getByTestId("applied-apply")).toHaveText("应用");
  await expect(line.getByTestId("applied-discard")).toHaveText("放弃");
  await setLanguage(window, "en");

  // A screen reader hears the change the cursor is in, and no more once the cursor is out of it.
  const spoken = window.getByTestId("proposal-spoken");
  await pointAndClick(window, editor.locator("ins.proposal-insert").first());
  await expect(spoken).toContainText("Suggested change");

  // Typing elsewhere leaves it waiting for its own Apply or Discard, not for Accept all.
  await pointAndClick(window, paragraphs.last());
  await expect(spoken).not.toContainText("Suggested change");
  await window.keyboard.press("End");
  await window.keyboard.type(" tide tables");
  await expect(paragraphs.last()).toHaveText("Notes: tide tables");
  await expect(line.getByTestId("applied-discard")).toBeVisible();
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);

  await pointAndClick(window, line.getByTestId("applied-discard"));
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD, "Notes: tide tables"]);
  await expect(line).toHaveCount(0);

  await selectThree();
  await askToChange(window, "replace it all with a haiku");
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(paragraphs).toHaveText([
    "Gulls wheel, crying",
    "salt wind on stone",
    "night falls soft",
    "Notes: tide tables",
  ]);
  await expect(line.getByTestId("applied-count")).toHaveText(/^Changed \d+ paragraphs?$/);
  await expect(spoken).toHaveText(/^Changed \d+ paragraphs?$/);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD, "Notes: tide tables"]);
});

test("under Review changes, a paragraph that arrives after an edit's new Block at the Mind's end stays when that Block is restored", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, THIRD]);
  const line = lineOf(editor);

  await slideSelect(window, paragraphs.last(), THIRD);
  await askToChange(window, "add a closing paragraph");
  await expect(paragraphs).toHaveText([FIRST, THIRD, "That is all for now."]);
  await pointAndClick(window, line.getByTestId("applied-review"));

  await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const [mind] = (await bridge.listMinds()).toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    await bridge.addToNote({
      mindId: mind?.id ?? "",
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Added later." }] }],
      origin: null,
      model: null,
    });
  });
  await expect(paragraphs.last()).toHaveText("Added later.");

  await pointAndClick(window, editor.getByTestId("change-restore"));
  await expect(paragraphs).toHaveText([FIRST, THIRD, "Added later."]);
});

test("“delete the second paragraph” applies at once", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD]);
  const line = lineOf(editor);

  await selectAll(window, editor);
  await askToChange(window, "delete the second paragraph");
  await expect(paragraphs).toHaveText([FIRST, THIRD]);
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 1 paragraph");
  await expect(editor.getByTestId("applied-kept")).toHaveCount(0);
});

test("text typed elsewhere while a slow edit streams in stays, and one ⌘Z takes back the whole edit", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const lines = [
    "The tides here are very strong and really regular.",
    "The moon is really bright over the harbour tonight.",
    "Harbours are very busy in the spring and really quiet in winter.",
  ];
  const { editor, paragraphs } = await mindWith(window, [...lines, "Notes:"]);
  const line = lineOf(editor);

  await slideSelect(window, paragraphs.first(), "The tides", {
    line: paragraphs.nth(2),
    words: "quiet in winter.",
  });
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("Shorten this slowly");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("selection-edit-working")).toBeVisible();
  await pointAndClick(window, paragraphs.last());
  await focusSettled(window, editor);
  await expect(window.getByTestId("menu-edit-line")).toBeVisible();
  await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await expect
    .poll(() =>
      paragraphs
        .last()
        .evaluate((paragraph) => paragraph.contains(getSelection()?.anchorNode ?? null)),
    )
    .toBe(true);
  await window.keyboard.type(" typed meanwhile");
  await expect(paragraphs.last()).toHaveText("Notes: typed meanwhile");
  await expect(line.getByTestId("applied-count")).toHaveText("Changed 3 paragraphs", {
    timeout: 30_000,
  });
  await expect(window.getByTestId("menu-edit-line")).toHaveCount(0);
  await expect(paragraphs.last()).toHaveText("Notes: typed meanwhile");

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([...lines, "Notes: typed meanwhile"]);
  await expect(line).toHaveCount(0);
});

test("on a slow computer, where the core's reply comes before the edit's last paragraph, the edit still applies whole, at once and from Apply, and one ⌘Z takes it all back", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD]);
  const line = lineOf(editor);
  // The window six times slower: its copy of the Mind then takes the core's reply before the
  // edit's last update, as CI's Mac did.
  const devtools = await window.context().newCDPSession(window);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 6 });

  await selectAll(window, editor);
  await askToChange(window, "replace harbour with port");
  const ported = [FIRST, SECOND.replace("harbour", "port"), THIRD.replace("harbour", "port")];
  await expect(paragraphs).toHaveText(ported);
  await expect(editor.locator("del.proposal-delete, ins.proposal-insert")).toHaveCount(0);
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD]);

  await selectAll(window, editor);
  await askToChange(window, "replace it all with a haiku");
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(paragraphs).toHaveText([
    "Gulls wheel, crying",
    "salt wind on stone",
    "night falls soft",
  ]);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD]);
});

test("an edit whose last update never reaches the window waits as changes to review, says so in English and Chinese, and the next edit can be asked", async () => {
  const { app, window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD]);
  // The window misses the edit's second update, as when taking it in fails.
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents) return;
    const send = contents.send.bind(contents);
    let tagged = 0;
    contents.send = (channel: string, ...args: unknown[]) => {
      const [name, payload] = args as [string, { cause?: unknown } | undefined];
      if (name === "mind.update" && payload?.cause && ++tagged === 2) return;
      send(channel, ...args);
    };
  });

  await selectAll(window, editor);
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("replace harbour with port");
  await window.keyboard.press("Enter");
  const problem = window.getByTestId("edit-problem");
  await expect(problem).toHaveText(
    /This edit arrived too late to apply\. Accept or reject its changes\./,
    { timeout: 15_000 },
  );
  await expect(window.getByTestId("edit-pending")).toHaveCount(0);
  await expect(editor.locator("del.proposal-delete").first()).toBeVisible();
  await expect(window.getByTestId("proposals-bar")).toBeVisible();
  await setLanguage(window, "zh-CN");
  await expect(problem).toContainText("这次修改送达太慢，没有直接应用。请接受或拒绝这些修订。");
  await setLanguage(window, "en");

  await pointAndClick(window, window.getByTestId("proposals-reject-all"));
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD]);
  // Nothing waits on it any more: the next edit is asked, not refused.
  await slideSelect(window, paragraphs.first(), "Tides rise");
  await window.keyboard.press("ControlOrMeta+j");
  await window.keyboard.type("replace coast with shore");
  await window.keyboard.press("Enter");
  await expect(window.getByTestId("selection-edit-working")).toBeVisible();
});

/** Runs a command from ⌘K by the keyboard: its words, then Enter. */
async function fromPalette(window: Page, id: string, words: string) {
  await window.keyboard.press("ControlOrMeta+k");
  await expect(window.getByTestId("palette-search")).toBeFocused();
  await window.keyboard.type(`>${words}`);
  await expect(window.getByTestId("palette").locator(`[data-key="command:${id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await window.keyboard.press("Enter");
}

test("by the keyboard alone: ⌘J, Review changes from ⌘K, ⌘⌫ restores the change, Undo from ⌘K; Apply from ⌘K for an edit held back", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const note = paragraphs.first();
  const line = lineOf(editor);

  await window.keyboard.press("ControlOrMeta+a");
  await askToChange(window, "replace strong with powerful");
  await expect(note).toHaveText("The tides here are very powerful and really regular.");
  await fromPalette(window, "edit.reviewApplied", "Review changes");
  await expect(line.getByTestId("applied-count")).toHaveText("1 paragraph changed by Edit with AI");
  await expect(note.getByTestId("change-restore")).toBeVisible();
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(note).toHaveText(TIDES);
  await expect(line).toHaveCount(0);

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+a");
  await askToChange(window, "replace strong with mighty");
  await expect(note).toHaveText("The tides here are very mighty and really regular.");
  await fromPalette(window, "edit.undoApplied", "Undo the AI edit");
  await expect(note).toHaveText(TIDES);
  await expect(line).toHaveCount(0);

  const held = await mindWith(window, [FIRST, SECOND, THIRD]);
  await window.keyboard.press("ControlOrMeta+a");
  await askToChange(window, "replace it all with a haiku");
  const heldLine = lineOf(held.editor);
  await expect(heldLine.getByTestId("applied-apply")).toBeVisible();
  await fromPalette(window, "edit.applyHeld", "Apply the waiting edit");
  await expect(heldLine.getByTestId("applied-count")).toHaveText(/^Changed \d+ paragraphs?$/);
  await expect(window.getByTestId("proposal-spoken")).toHaveText(/^Changed \d+ paragraphs?$/);
  await expect(held.paragraphs).toHaveText([
    "Gulls wheel, crying",
    "salt wind on stone",
    "night falls soft",
  ]);
});

const toTheEnd = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";

test("typed elsewhere after ⌘J, by the keyboard alone: the line goes, Review changes stays in ⌘K through ⌘Z and ⌘⇧Z of the typing, ⌘⌫ restores the change and leaves the typing, one ⌘Z takes the Restore back, and a second edit's Review shows its own change alone", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES, FIRST]);
  const note = paragraphs.first();
  const line = lineOf(editor);
  const POWERFUL = "The tides here are very powerful and really regular.";
  const TYPED = "Typed by hand.";

  await window.keyboard.press("ControlOrMeta+a");
  await askToChange(window, "replace strong with powerful");
  await expect(note).toHaveText(POWERFUL);
  await expect(line.getByTestId("applied-review")).toBeVisible();
  await focusEditor(window, editor);
  await window.keyboard.press(toTheEnd);
  await window.keyboard.press("Enter");
  await window.keyboard.type(TYPED);
  await expect(paragraphs).toHaveText([POWERFUL, FIRST, TYPED]);
  await expect(line).toHaveCount(0);

  await expect(async () => {
    if ((await paragraphs.count()) > 2) await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs).toHaveText([POWERFUL, FIRST]);
  }).toPass();
  expect(await paletteOffers(window, "edit.reviewApplied", "Review changes")).toBe(1);
  await editor.focus();
  await expect(async () => {
    if ((await paragraphs.last().textContent()) !== TYPED) {
      await window.keyboard.press("ControlOrMeta+Shift+z");
    }
    await expect(paragraphs).toHaveText([POWERFUL, FIRST, TYPED]);
  }).toPass();

  await fromPalette(window, "edit.reviewApplied", "Review changes");
  await expect(line.getByTestId("applied-count")).toHaveText("1 paragraph changed by Edit with AI");
  await expect(editor.getByTestId("change-restore")).toHaveCount(1);
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(paragraphs).toHaveText([TIDES, FIRST, TYPED]);
  await expect(line).toHaveCount(0);
  await expect(window.getByTestId("undo-message")).toHaveText("Restored the original");
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([POWERFUL, FIRST, TYPED]);

  await window.keyboard.press("ControlOrMeta+a");
  await askToChange(window, "replace regular with steady");
  const STEADY = "The tides here are very powerful and really steady.";
  await expect(note).toHaveText(STEADY);
  await focusEditor(window, editor);
  await window.keyboard.press(toTheEnd);
  await window.keyboard.type(" Again.");
  await expect(paragraphs.last()).toHaveText(`${TYPED} Again.`);
  await fromPalette(window, "edit.reviewApplied", "Review changes");
  await expect(editor.getByTestId("change-restore")).toHaveCount(1);
  await expect(note.locator(".applied-new")).toHaveText("steady");
  await window.keyboard.press("ControlOrMeta+Backspace");
  await expect(paragraphs).toHaveText([POWERFUL, FIRST, `${TYPED} Again.`]);
});

test("Review changes lives with the Mind's editor: once its tab has shown another Mind and comes back, ⌘K and the Mind's ⋯ no longer offer it", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const POWERFUL = "The tides here are very powerful and really regular.";

  await slideSelect(window, paragraphs.first(), TIDES);
  await askToChange(window, "replace strong with powerful");
  await expect(paragraphs.first()).toHaveText(POWERFUL);
  const box = await paragraphs.first().boundingBox();
  const end = { x: (box?.width ?? 2) - 2, y: (box?.height ?? 8) - 4 };
  await paragraphs.first().click({ position: end });
  await focusSettled(window, editor);
  await window.keyboard.press("Enter");
  await window.keyboard.type("Typed.");
  await expect(lineOf(editor)).toHaveCount(0);
  expect(await paletteOffers(window, "edit.reviewApplied", "Review changes")).toBe(1);
  const menu = await openPageMenu(window);
  await expect(menu.getByTestId("page-review-changes")).toHaveText("Review changes");
  await window.keyboard.press("Escape");

  await newMind(window);
  await pointAndClick(window, window.getByTestId("mind-tab").first());
  await expect(paragraphs).toHaveText([POWERFUL, "Typed."]);
  expect(await paletteOffers(window, "edit.reviewApplied", "Review changes")).toBe(0);
  const again = await openPageMenu(window);
  await expect(again.getByTestId("page-style")).toBeVisible();
  await expect(again.getByTestId("page-review-changes")).toHaveCount(0);
});

/** Pastes HTML where the cursor is, as a copy from IncarnaMind arrives: AI text stays AI text. */
const pasteHtml = (editor: Locator, html: string) =>
  editor.evaluate((element, pasted) => {
    const data = new DataTransfer();
    data.setData("text/html", pasted);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, html);

/** The text before the editor's own caret, as a paste reads it; null while the selection isn't a caret. */
const beforeCaret = (editor: Locator) =>
  editor.evaluate((element) => {
    const { state } = (
      element as unknown as {
        editor: {
          state: {
            selection: { empty: boolean; from: number };
            doc: { textBetween(from: number, to: number): string };
          };
        };
      }
    ).editor;
    return state.selection.empty ? state.doc.textBetween(0, state.selection.from) : null;
  });

test("a copy of an AI change pasted beside it is never restored: with the change itself edited, Review changes isn't offered", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const note = paragraphs.first();

  await slideSelect(window, note, TIDES);
  await askToChange(window, "replace strong with powerful");
  await expect(note).toHaveText("The tides here are very powerful and really regular.");
  await slideSelect(window, note, "powerful");
  await window.keyboard.press("ArrowRight");
  await expect.poll(() => beforeCaret(editor)).toBe("The tides here are very powerful");
  await pasteHtml(editor, "<span data-generated>powerful</span>");
  await expect(note).toHaveText("The tides here are very powerfulpowerful and really regular.");
  await slideSelect(window, note, "wer");
  await window.keyboard.type("x");
  const edited = "The tides here are very poxfulpowerful and really regular.";
  await expect(note).toHaveText(edited);

  expect(await paletteOffers(window, "edit.reviewApplied", "Review changes")).toBe(0);
  await expect(note).toHaveText(edited);
});

test("after Shorten, a word it took out comes back only while the words either side are as the edit left them: an edited neighbour says “You changed this since”, the untouched one restores, and with its paragraph's words deleted since no Review is offered", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES, FIRST]);
  const note = paragraphs.first();

  await slideSelect(window, note, TIDES);
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText("The tides here are strong and regular.");
  await slideSelect(window, note, "regular");
  await window.keyboard.type("steady");
  await expect(note).toHaveText("The tides here are strong and steady.");

  await fromPalette(window, "edit.reviewApplied", "Review changes");
  await expect(note.getByTestId("change-restore")).toHaveCount(1);
  await expect(note.getByTestId("change-changed-since")).toHaveText("You changed this since");
  await pointAndClick(window, note.getByTestId("change-restore"));
  await pointAndClick(window, lineOf(editor).getByTestId("applied-done"));
  await expect(note).toHaveText("The tides here are very strong and steady.");

  await slideSelect(window, note, "The tides here are very strong and steady.");
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText("The tides here are strong and steady.");
  await slideSelect(window, note, "The tides here are strong and steady.");
  await window.keyboard.press("Backspace");
  await expect(paragraphs).toHaveText(["", FIRST]);
  expect(await paletteOffers(window, "edit.reviewApplied", "Review changes")).toBe(0);
  await expect(paragraphs).toHaveText(["", FIRST]);
});
