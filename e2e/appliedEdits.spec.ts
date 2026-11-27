import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { translate } from "../src/shared/i18n";
import {
  askToChange,
  checkpointsOfNewestNote,
  createDataFolder,
  dismissChatSetup,
  focusEditor,
  focusSettled,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

/*
 * An edit the User asks for on the text applies at once (#880): ⌘J and the
 * selection menu's AI actions. A line over it says what changed, with Undo. The scripted model
 * (src/main/fakeChat/edit.ts and src/main/fakeChat/appliedEdits.ts) does what "replace X with Y"
 * says, shortens by dropping "very" and "really", gives back only the second paragraph
 * made formal, as Claude Haiku 5.5 did, deletes the second paragraph, and
 * writes a haiku like none of the text. Set INCARNAMIND_SCREENSHOTS to a
 * folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const screenshot = async (window: Page, name: string) => {
  if (SCREENSHOTS) await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
};

const TIDES = "The tides here are very strong and really regular.";
const TIDES_START = "The tides here are…";
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

test("⌘J applies the change at once as AI text, with Changed the paragraph “…” · Undo ⌘Z over it; ⌘Z takes it back and ⌘⇧Z does it again, in Chinese too", async () => {
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
  await expect(line.getByTestId("applied-count")).toHaveText(
    translate("en", "edit.applied.named", { start: TIDES_START }),
  );
  await expect(line).toContainText(/Undo(⌘Z|Ctrl\+Z)/);
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
  await expect(line.getByTestId("applied-count")).toHaveText(
    translate("zh-CN", "edit.applied.named", { start: TIDES_START }),
  );
  await expect(line.getByTestId("applied-undo")).toHaveText("撤销");
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

test("Shorten from the menu applies at once, and the line's Undo takes it back", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const note = paragraphs.first();
  const line = lineOf(editor);

  await slideSelect(window, note, TIDES);
  await pointAndClick(window, window.getByTestId("selection-action-shorten"));
  await expect(note).toHaveText("The tides here are strong and regular.");
  await expect(line.getByTestId("applied-count")).toHaveText(
    translate("en", "edit.applied.named", { start: TIDES_START }),
  );
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await motionSettled(window);
  await screenshot(window, "applied-shorten-en");

  await pointAndClick(window, line.getByTestId("applied-undo"));
  await expect(note).toHaveText(TIDES);
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
  await expect(line.getByTestId("applied-count")).toHaveText(
    translate("en", "edit.applied.named", { start: "It is a considerable…" }),
  );
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

test("Remove them leaves the heading and the paragraph outside the selection as they are", async () => {
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

  await slideSelect(window, paragraphs.first(), FIRST, { line: paragraphs.nth(2), words: THIRD });
  await askToChange(window, "make the second paragraph more formal; leave the others as they are");
  await expect(paragraphs).toHaveText([FIRST, FORMAL, THIRD, NEXT]);
  await pointAndClick(window, editor.getByTestId("applied-remove-kept"));

  await expect(paragraphs).toHaveText([FORMAL, NEXT]);
  await expect(heading).toHaveText("Harbour notes");
  await expect(editor.getByTestId("applied-kept")).toHaveCount(0);
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
    "Waiting for you: this edit takes text out of your selection",
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
    "等你确认：这次修改会删掉选中的一部分内容",
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

// Value: protects=a typed request that asks for no removal waits when the reply quotes a whole paragraph as taken out, as a suggested change with Apply and Discard and nothing else new on the screen (#2333); fails_when=the paragraph goes at once, or the line has no Apply and Discard, or a bar or dialog appears; why_new=no spec had the app's small model read the User's words; seam=the scripted model answers the removal question from the words "delete", "remove", "drop", "cut"; no_claim=how a real model reads a request.
test("a typed request that names no removal waits when the reply takes a paragraph out: Discard leaves the text, Apply takes the paragraph out, and Undo brings it back", async () => {
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
  await askToChange(window, "restructure the notes");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "Waiting for you: this edit takes text out of your selection",
  );
  await expect(line.getByTestId("applied-apply")).toBeVisible();
  await expect(line.getByTestId("applied-discard")).toBeVisible();
  await expect(window.getByTestId("proposals-bar")).toHaveCount(0);
  await motionSettled(window);
  await screenshot(window, "applied-held-asked-nothing-out-en");

  await pointAndClick(window, line.getByTestId("applied-discard"));
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD, "Notes:"]);
  await expect(line).toHaveCount(0);

  await selectThree();
  await askToChange(window, "restructure the notes");
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(paragraphs).toHaveText([FIRST, SECOND, "Notes:"]);
  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD, "Notes:"]);
});

// Value: protects=Apply on an edit held back, and an edit that applies at once, each save a Checkpoint before the text changes (#2796); fails_when=the change goes in with no new version in History; why_new=no spec counted versions around Apply; seam=none; no_claim=what the version holds.
test("Apply on an edit held back saves a version first, as an edit that applies at once does", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD, "Notes:"]);
  const line = lineOf(editor);

  await slideSelect(window, paragraphs.first(), "Tides rise", {
    line: paragraphs.nth(2),
    words: "each week.",
  });
  await askToChange(window, "replace it all with a haiku");
  await expect(line.getByTestId("applied-count")).toHaveText(
    "Waiting for you: this edit takes text out of your selection",
  );
  const held = await checkpointsOfNewestNote(window);
  await pointAndClick(window, line.getByTestId("applied-apply"));
  await expect(paragraphs.first()).toHaveText("Gulls wheel, crying");
  await expect.poll(() => checkpointsOfNewestNote(window)).toBe(held + 1);

  const applied = await checkpointsOfNewestNote(window);
  await slideSelect(window, paragraphs.last(), "Notes:");
  await askToChange(window, "replace Notes with Remarks");
  await expect(paragraphs.last()).toHaveText("Remarks:");
  await expect.poll(() => checkpointsOfNewestNote(window)).toBe(applied + 1);
});

test("“delete the second paragraph” applies at once, said as the paragraph removed, and ⌘Z puts it back", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [FIRST, SECOND, THIRD]);
  const line = lineOf(editor);

  await selectAll(window, editor);
  await askToChange(window, "delete the second paragraph");
  await expect(paragraphs).toHaveText([FIRST, THIRD]);
  await expect(line.getByTestId("applied-count")).toHaveText(
    "Removed the paragraph “It is a big…” (1 sentence)",
  );
  await expect(editor.getByTestId("applied-kept")).toHaveCount(0);

  await editor.focus();
  await window.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs).toHaveText([FIRST, SECOND, THIRD]);
  await expect(line).toHaveCount(0);
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

test("by the keyboard alone: ⌘J, Undo from ⌘K; Apply from ⌘K for an edit held back", async () => {
  const { window } = await launch();
  await useLocalChatModel(window);
  const { editor, paragraphs } = await mindWith(window, [TIDES]);
  const note = paragraphs.first();
  const line = lineOf(editor);

  await window.keyboard.press("ControlOrMeta+a");
  await askToChange(window, "replace strong with mighty");
  await expect(note).toHaveText("The tides here are very mighty and really regular.");
  await expect(line).toBeVisible();
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

test("typed elsewhere after ⌘J, the line goes, and ⌘Z and ⌘⇧Z of the typing leave the edit's own words as they are", async () => {
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
  await expect(line).toBeVisible();
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
  await editor.focus();
  await expect(async () => {
    if ((await paragraphs.last().textContent()) !== TYPED) {
      await window.keyboard.press("ControlOrMeta+Shift+z");
    }
    await expect(paragraphs).toHaveText([POWERFUL, FIRST, TYPED]);
  }).toPass();
});
