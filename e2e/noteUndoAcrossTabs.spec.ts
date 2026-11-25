import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  askToChange,
  createDataFolder,
  dismissChatSetup,
  dragTabTo,
  firstTranscriptLine,
  focusSettled,
  gettingStarted,
  launchApp,
  mindWrittenBefore,
  motionSettled,
  newMind,
  pasteText,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  secondWindow,
  useLocalChatModel as selectLocalChatModel,
  setLanguage,
  setWindowSize,
  slideSelect,
  splitFromTabMenu,
  startRecording,
} from "./app";

/*
 * A Note's Undo across tab switches (#3115): each tab keeps its Note's history while it is open, so
 * showing another tab and coming back costs the Note nothing. A click on the Note's tab puts the
 * cursor back where it was, so ⌘Z there takes back what was typed; the Undo line an AI edit left is
 * there again; the history follows its tab to another group and through the groups merging; and
 * what someone else wrote meanwhile is never taken back.
 */

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const WORDS = {
  en: {
    folder: "Finance",
    first: "First sentence.",
    more: [" Two.", " Three."],
    applied: "Changed 1 paragraph",
  },
  "zh-CN": {
    folder: "财务",
    first: "第一句。",
    more: ["第二句。", "第三句。"],
    applied: "修改了 1 个段落",
  },
} as const;
type Language = keyof typeof WORDS;

const TIDES = "The tides here are very strong and really regular.";
const POWERFUL = "The tides here are very powerful and really regular.";

const shownEditor = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused] [data-testid="mind-editor"]:visible');
const groupEditor = (window: Page, index: number) =>
  window.getByTestId("tab-group").nth(index).getByTestId("mind-editor");
const shownTabs = (window: Page) =>
  window.locator('[data-testid="tab-group"][data-focused]').getByTestId("mind-tab");

async function launched(language: Language = "en", fakeChat = false) {
  const { app, window } = await launchApp(dataDir, { fakeChat });
  await setWindowSize(app, window, 1600, 900);
  await dismissChatSetup(window);
  if (fakeChat) await selectLocalChatModel(window);
  if (language !== "en") await setLanguage(window, language);
  return { app, window };
}

const folderNames = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.getLibrary()).groups.map((group) => group.name).sort();
  });

/** ⌘T: a new Note in a new tab of the focused group, in front. */
async function showNewTab(window: Page) {
  const tabs = window.getByTestId("mind-tab");
  const count = await tabs.count();
  await window.keyboard.press("ControlOrMeta+t");
  await expect(tabs).toHaveCount(count + 1);
  await expect(shownEditor(window)).toBeFocused();
  await motionSettled(window);
}

/** A click on the tab: its Note shows, the focus back in its text where the cursor was. */
async function backTo(window: Page, tab: Locator) {
  await pointAndClick(window, tab);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(shownEditor(window)).toBeFocused();
  await focusSettled(window, shownEditor(window));
}

/** The words of the Note's paragraphs, as the User reads them. */
const paragraphs = (editor: Locator) => editor.locator(":scope > p");

/** Where the caret is: the words of its line and its place in them. */
const caret = (window: Page) =>
  window.evaluate(() => {
    const selection = getSelection();
    return {
      words: selection?.anchorNode?.textContent ?? null,
      offset: selection?.anchorOffset ?? null,
    };
  });

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  // protects=the issue's own steps: typed in a Note, another tab shown with ⌘T, the Note's tab clicked, ⌘Z with no click in the text takes the typing back and leaves a Folder made earlier, ⇧⌘Z puts it back, and the same through several switches in a row, each a step of its own (#3115); fails_when=⌘Z after coming back takes back nothing, takes the Folder back, or several switches lose the steps before them; no_claim=AI edits, which the next test holds.
  test(`typed, another tab shown, the Note's tab clicked: ⌘Z takes the typing back, ⇧⌘Z puts it back, through several switches (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      await window.keyboard.press("ControlOrMeta+Shift+n");
      // The name field takes the focus a moment after the key: typed sooner, the first letter is lost.
      await expect(window.getByTestId("folder-rename-field")).toBeFocused();
      await window.keyboard.type(words.folder);
      await window.keyboard.press("Enter");
      await expect.poll(() => folderNames(window)).toEqual([words.folder]);
      await newMind(window);
      const editor = shownEditor(window);
      await window.keyboard.type(words.first);
      const note = window.getByTestId("mind-tab").first();
      await showNewTab(window);
      await backTo(window, note);

      await window.keyboard.press("ControlOrMeta+z");
      await expect(editor).not.toContainText(words.first);
      expect(await folderNames(window)).toEqual([words.folder]);
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect(paragraphs(editor)).toHaveText([words.first]);

      const other = window.getByTestId("mind-tab").nth(1);
      for (const typed of words.more) {
        await window.keyboard.press("ControlOrMeta+End");
        await window.keyboard.type(typed);
        await backTo(window, other);
        await backTo(window, note);
      }
      const all = `${words.first}${words.more.join("")}`;
      await expect(paragraphs(editor)).toHaveText([all]);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(paragraphs(editor)).toHaveText([`${words.first}${words.more[0]}`]);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(paragraphs(editor)).toHaveText([words.first]);
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect(paragraphs(editor)).toHaveText([`${words.first}${words.more[0]}`]);
      expect(await folderNames(window)).toEqual([words.folder]);
    } finally {
      await app.close();
    }
  });

  // protects=the Undo line an AI edit leaves over its paragraph is there again after a tab switch, with the same words, and ⌘Z right after coming back takes the edit back and the line with it, ⇧⌘Z does it again, as with no switch (#3115); fails_when=the line is gone after the switch, or ⌘Z there takes back nothing or something else; no_claim=a real model's edit.
  test(`an AI edit's Undo line and its ⌘Z are the same after a tab switch (${language})`, async () => {
    const { app, window } = await launched(language, true);
    try {
      await newMind(window);
      const editor = shownEditor(window);
      await window.keyboard.type(TIDES);
      const paragraph = paragraphs(editor).first();
      await slideSelect(window, paragraph, TIDES);
      await askToChange(window, "replace strong with powerful");
      await expect(paragraph).toHaveText(POWERFUL);
      const line = editor.getByTestId("applied-line");
      await expect(line.getByTestId("applied-count")).toHaveText(words.applied);
      const before = await line.innerText();

      const note = window.getByTestId("mind-tab").first();
      await showNewTab(window);
      await backTo(window, note);
      await expect(line.getByTestId("applied-count")).toHaveText(words.applied);
      expect(await line.innerText()).toBe(before);

      await window.keyboard.press("ControlOrMeta+z");
      await expect(paragraph).toHaveText(TIDES);
      await expect(line).toHaveCount(0);
      await window.keyboard.press("ControlOrMeta+Shift+z");
      await expect(paragraph).toHaveText(POWERFUL);
      await expect(paragraph.locator("del.proposal-delete, ins.proposal-insert")).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
}

// protects=Redo outlives a switch too: a step taken back before showing another tab is done again with ⇧⌘Z after coming back (#3115); fails_when=⇧⌘Z after the switch does nothing; no_claim=the app's own Redo of other changes.
test("a step taken back before a switch is done again with ⇧⌘Z after it", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    const editor = shownEditor(window);
    await window.keyboard.type("Base.");
    const note = window.getByTestId("mind-tab").first();
    await showNewTab(window);
    const other = window.getByTestId("mind-tab").nth(1);
    await backTo(window, note);
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.type(" Added.");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(editor)).toHaveText(["Base."]);
    await backTo(window, other);
    await backTo(window, note);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(paragraphs(editor)).toHaveText(["Base. Added."]);
  } finally {
    await app.close();
  }
});

/** The menu of this tab, opened by a right-click on it, as a person opens it. */
async function menuOf(window: Page, tab: Locator): Promise<Locator> {
  await pointAndClick(window, tab, { button: "right" });
  const menu = tab.getByTestId("tab-actions");
  await expect(menu).toBeVisible();
  return menu;
}

/** The tab of the Note in front, with its id: it is the same tab wherever it goes. */
async function tabOfNote(window: Page, mindId: string) {
  const tab = window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);
  await expect(tab).toHaveCount(1);
  return { tab, id: await tab.getAttribute("data-tab-id") };
}

// protects=the history follows its tab inside the window: Move to new group, a drag into another group and its non-drag twin Move left, and the groups merging in a narrow window and splitting again keep the tab's id and its history, so ⌘Z after each takes back what was typed before it (#3115); fails_when=a move or the merge makes ⌘Z take back nothing; no_claim=a second window, which has its own.
test("the history follows its tab: Move to new group, a drag, Move left, and the groups merging and splitting", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    const mindId = await shownEditor(window)
      .locator("xpath=ancestor::*[@data-testid='mind-pane']")
      .getAttribute("data-mind-id");
    if (!mindId) throw new Error("No Note in front.");
    await window.keyboard.type("Moved.");
    await showNewTab(window);
    const { tab, id } = await tabOfNote(window, mindId);
    await backTo(window, tab);
    const typeMore = async (typed: string) => {
      const editor = shownEditor(window);
      await expect(paragraphs(editor)).toHaveText(["Moved."]);
      await window.keyboard.press("ControlOrMeta+End");
      await window.keyboard.type(typed);
      await expect(paragraphs(editor)).toHaveText([`Moved.${typed}`]);
    };

    await typeMore(" Before the move.");
    let menu = await menuOf(window, tab);
    await pointAndClick(window, menu.getByTestId("tab.moveRight"));
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    expect((await tabOfNote(window, mindId)).id).toBe(id);
    await backTo(window, tab);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(shownEditor(window))).toHaveText(["Moved."]);

    await typeMore(" Before the drag.");
    const strip = window.getByTestId("tab-group").first().getByTestId("tab-strip");
    const box = await strip.boundingBox();
    if (!box) throw new Error("The first group's strip isn't shown.");
    await dragTabTo(window, tab, { x: box.x + box.width - 40, y: box.y + box.height / 2 });
    await expect(window.getByTestId("tab-group")).toHaveCount(1);
    expect((await tabOfNote(window, mindId)).id).toBe(id);
    await backTo(window, tab);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(shownEditor(window))).toHaveText(["Moved."]);

    menu = await menuOf(window, tab);
    await pointAndClick(window, menu.getByTestId("tab.moveRight"));
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    await backTo(window, tab);
    await typeMore(" Before Move left.");
    menu = await menuOf(window, tab);
    await pointAndClick(window, menu.getByTestId("tab.moveLeft"));
    await expect(window.getByTestId("tab-group")).toHaveCount(1);
    expect((await tabOfNote(window, mindId)).id).toBe(id);
    await backTo(window, tab);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(shownEditor(window))).toHaveText(["Moved."]);

    await typeMore(" Before the merge.");
    menu = await menuOf(window, tab);
    await pointAndClick(window, menu.getByTestId("tab.moveRight"));
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    // The other group is focused, so the merged strip shows its tab, not the Note.
    await pointAndClick(window, window.getByTestId("tab-group").first().getByTestId("mind-tab"));
    await setWindowSize(app, window, 950, 900);
    await expect(window.getByTestId("tab-groups")).toHaveAttribute("data-merged", "true");
    await expect(window.locator(`[data-testid="mind-pane"][data-mind-id="${mindId}"]`)).toHaveCount(
      0,
    );
    await setWindowSize(app, window, 1600, 900);
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    expect((await tabOfNote(window, mindId)).id).toBe(id);
    await backTo(window, tab);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(shownEditor(window))).toHaveText(["Moved."]);
  } finally {
    await app.close();
  }
});

// protects=an AI edit made in another tab of the Note while this tab shows something else is no step of this tab's: back here, ⌘Z takes back what was typed here, and the edit's words stay (#3115); fails_when=⌘Z here takes back the other tab's edit, or loses this tab's typing; no_claim=the edit's own line in the other tab.
test("an AI edit made in another tab while this one is hidden: ⌘Z here takes back only what was typed here", async () => {
  const { app, window } = await launched("en", true);
  try {
    await newMind(window);
    const first = shownEditor(window);
    await window.keyboard.type(TIDES);
    await window.keyboard.press("Enter");
    await window.keyboard.type("Mine:");
    await splitFromTabMenu(window);
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    await motionSettled(window);
    const note = window.getByTestId("tab-group").first().getByTestId("mind-tab").first();
    await backTo(window, note);
    await showNewTab(window);
    await backTo(window, note);
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.type(" typed here");
    await expect(paragraphs(first).nth(1)).toHaveText("Mine: typed here");
    await showNewTab(window);

    const other = groupEditor(window, 1);
    const tidesThere = paragraphs(other).first();
    await slideSelect(window, tidesThere, TIDES);
    await askToChange(window, "replace strong with powerful");
    await expect(tidesThere).toHaveText(POWERFUL);

    await backTo(window, note);
    const back = shownEditor(window);
    await expect(paragraphs(back).first()).toHaveText(POWERFUL);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(back).nth(1)).toHaveText("Mine:");
    await expect(paragraphs(back).first()).toHaveText(POWERFUL);
    await expect(paragraphs(other).first()).toHaveText(POWERFUL);
  } finally {
    await app.close();
  }
});

const fillState = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings()).at(-1)?.fill?.state ?? null;
  });

// protects=the core writing into a Note while its tab is hidden, a call's notes filled in after Stop from ⌘K, is no step of the tab's: back on the Note, ⌘Z takes back the User's own last typing and the filled-in notes stay (#3115); fails_when=⌘Z after coming back takes back the fill, or loses the User's typing; no_claim=the fill's own Undo, which meetingFillTabs.spec.ts holds.
test("the core fills a call's notes while its tab is hidden: ⌘Z after coming back takes back only the User's typing", async () => {
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: {
      lines: ["We confirmed the launch date"],
      theirLines: ["We discussed the release checklist"],
    },
  });
  try {
    await setWindowSize(app, window, 1600, 900);
    await dismissChatSetup(window);
    await selectLocalChatModel(window);
    await startRecording(window, await recordMeeting(window), { notice: true });
    await firstTranscriptLine(window);
    const notes = shownEditor(window);
    await pointAndClick(window, notes);
    await focusSettled(window, notes);
    await window.keyboard.type("Launch date");
    await window.keyboard.press("Enter");
    await window.keyboard.type("UK fee");
    const typed = await paragraphs(notes).allTextContents();
    const note = window.getByTestId("mind-tab").first();
    await showNewTab(window);
    await runCommand(window, "meeting.stop", "Stop recording");
    await expect.poll(() => fillState(window), { timeout: 30_000 }).toBe("filled");

    await backTo(window, note);
    const back = shownEditor(window);
    const written = back.locator(".generated-text");
    const filled = await written.allTextContents();
    expect(filled.length).toBeGreaterThan(0);
    expect(typed.length).toBeGreaterThan(0);
    await back.focus();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(back.getByText("UK fee")).toHaveCount(0);
    await expect(written).toHaveText(filled);
    expect(await fillState(window)).toBe("filled");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(back.getByText("UK fee")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

// protects=another window typing in the Note while its tab here is hidden: back here, ⌘Z takes back only what was typed here, and the other window's words stay in both (#3115); fails_when=⌘Z here takes back or deletes the other window's words, or loses this window's typing; no_claim=the other window's own Undo.
test("another window types in the Note while its tab here is hidden: ⌘Z here takes back only what was typed here", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    const first = shownEditor(window);
    await window.keyboard.type("Here.");
    const note = window.getByTestId("mind-tab").first();
    await showNewTab(window);

    const second = await secondWindow(app);
    // The second window opens with the tabs the first had: the Note's is the first.
    await second.getByTestId("mind-tab").first().click();
    const theirs = second.getByTestId("mind-editor").first();
    await expect(paragraphs(theirs)).toHaveText(["Here."]);
    await theirs.click();
    await second.keyboard.press("ControlOrMeta+End");
    await second.keyboard.type(" There.");
    await expect(paragraphs(theirs)).toHaveText(["Here. There."]);

    await backTo(window, note);
    await expect(paragraphs(first)).toHaveText(["Here. There."]);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraphs(first)).toHaveText([" There."]);
    await expect(paragraphs(theirs)).toHaveText([" There."]);
  } finally {
    await app.close();
  }
});

// protects=a click on a Note's tab puts the cursor back where it was and the view where it was left, without scrolling to the cursor (#3115); fails_when=the Note opens at its top, the cursor goes to its start, or putting it back scrolls the Note; no_claim=other kinds of tab, whose content takes no focus when it opens.
test("a click on a Note's tab: the cursor where it was, and the scroll where it was left", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    const lines = Array.from(
      { length: 300 },
      (_, index) => `Paragraph ${index + 1}: the harbour office posts the tide times each week.`,
    );
    await pasteText(app, window, lines.join("\n"));
    const editor = shownEditor(window);
    await expect(paragraphs(editor)).toHaveCount(300);
    const tenth = paragraphs(editor).nth(9);
    await pointAndClick(window, tenth);
    await focusSettled(window, editor);
    for (let step = 0; step < 4; step++) await window.keyboard.press("ArrowLeft");
    const at = await caret(window);
    expect(at.words).toBe(lines[9]);
    const scroller = window.locator(
      '[data-testid="tab-group"][data-focused] [data-testid="mind-scroller"]',
    );
    // The cursor goes out of view as a person scrolls down, away from it.
    await scroller.hover();
    await window.mouse.wheel(0, 4000);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(2000);
    await expect(tenth).not.toBeInViewport();
    const left = await scroller.evaluate((element) => Math.round(element.scrollTop));

    const note = window.getByTestId("mind-tab").first();
    await showNewTab(window);
    await backTo(window, note);
    await expect(paragraphs(shownEditor(window))).toHaveCount(300);
    expect(await caret(window)).toEqual(at);
    const now = await scroller.evaluate((element) => Math.round(element.scrollTop));
    expect(Math.abs(now - left)).toBeLessThanOrEqual(2);
    await expect(paragraphs(shownEditor(window)).nth(9)).not.toBeInViewport();
  } finally {
    await app.close();
  }
});

// protects=the keyboard's ways to a tab: Ctrl+Tab and ⌃1 (Alt+1 off the Mac) put the focus in the Note's text where the cursor was; ⌘W closing another tab does the same, as it did; on the tab list, an arrow and Enter keep the focus on the tab (#3115); fails_when=a shortcut leaves the focus nowhere or the cursor at the Note's start, or the tab list's keys move the focus off the tab; no_claim=⌘1–⌘3, which go to a group's tab by design.
test("Ctrl+Tab, ⌃1 and ⌘W put the focus in the Note's text where it was; the tab list's keys keep it on the tab", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    await window.keyboard.type("First line here.");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Second line here.");
    const editor = shownEditor(window);
    await pointAndClick(window, paragraphs(editor).nth(1));
    await focusSettled(window, editor);
    for (let step = 0; step < 6; step++) await window.keyboard.press("ArrowLeft");
    const at = await caret(window);
    expect(at).toEqual({ words: "Second line here.", offset: "Second line here.".length - 6 });

    await showNewTab(window);
    await window.keyboard.press("Control+Tab");
    await expect(shownTabs(window).first()).toHaveAttribute("aria-selected", "true");
    await expect(shownEditor(window)).toBeFocused();
    expect(await caret(window)).toEqual(at);

    await window.keyboard.press("Control+Tab");
    await expect(shownTabs(window).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(shownEditor(window)).toBeFocused();
    await window.keyboard.press(process.platform === "darwin" ? "Control+1" : "Alt+1");
    await expect(shownTabs(window).first()).toHaveAttribute("aria-selected", "true");
    await expect(shownEditor(window)).toBeFocused();
    expect(await caret(window)).toEqual(at);

    await window.keyboard.press("Control+Tab");
    await expect(shownEditor(window)).toBeFocused();
    await window.keyboard.press("ControlOrMeta+w");
    await expect(window.getByTestId("mind-tab")).toHaveCount(1);
    await expect(shownEditor(window)).toBeFocused();
    expect(await caret(window)).toEqual(at);

    await showNewTab(window);
    await shownTabs(window).nth(1).focus();
    await window.keyboard.press("ArrowLeft");
    await expect(shownTabs(window).first()).toHaveAttribute("aria-selected", "true");
    await expect(shownTabs(window).first()).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(shownTabs(window).first()).toBeFocused();
  } finally {
    await app.close();
  }
});

/**
 * In a new Note, the User's own sentence, then, back from another tab, a Block made after it by its
 * Markdown (`## ` or `- `), its words "Plan". Gives the Note's tab.
 */
async function earlierThenMade(window: Page, markdown: string): Promise<Locator> {
  await newMind(window);
  await window.keyboard.type("Earlier.");
  const note = window.getByTestId("mind-tab").first();
  await showNewTab(window);
  await backTo(window, note);
  await window.keyboard.press("Enter");
  await window.keyboard.type(`${markdown}Plan`);
  return note;
}

// protects=a heading the User made, which another tab of the Note then typed in, is no longer taken back by the first tab's ⌘Z: the other tab's words stay in both, and ⌘Z goes on to the User's own change before it (#3115); fails_when=⌘Z in the first tab deletes the heading with the other tab's words, or takes back nothing; no_claim=what Undo leaves of a heading no one else typed in.
test("a heading made here and typed in by another tab: ⌘Z here keeps the other tab's words and takes back the change before", async () => {
  const { app, window } = await launched();
  try {
    await earlierThenMade(window, "## ");
    const first = shownEditor(window);
    const heading = first.locator(":scope > h2");
    await expect(heading).toHaveText("Plan");
    await splitFromTabMenu(window);
    await expect(window.getByTestId("tab-group")).toHaveCount(2);
    await motionSettled(window);
    const other = groupEditor(window, 1);
    const theirs = other.locator(":scope > h2");
    await pointAndClick(window, theirs);
    await focusSettled(window, other);
    await window.keyboard.press("ControlOrMeta+End");
    await window.keyboard.type(" from the other tab");
    await expect(heading).toHaveText("Plan from the other tab");

    const note = window.getByTestId("tab-group").first().getByTestId("mind-tab").first();
    await backTo(window, note);
    await window.keyboard.press("ControlOrMeta+z");
    await expect(first).not.toContainText("Earlier.");
    await expect(heading).toHaveText("Plan from the other tab");
    await expect(theirs).toHaveText("Plan from the other tab");
    await expect(other).not.toContainText("Earlier.");
  } finally {
    await app.close();
  }
});

// protects=a bullet the User made, which another window then typed in while the Note's tab here was hidden, is no longer taken back by ⌘Z here: the other window's words stay in both, and ⌘Z goes on to the User's own change before it (#3115); fails_when=⌘Z here deletes the bullet with the other window's words, or takes back nothing; no_claim=the other window's own Undo.
test("a bullet made here and typed in by another window while hidden: ⌘Z here keeps the window's words and takes back the change before", async () => {
  const { app, window } = await launched();
  try {
    const note = await earlierThenMade(window, "- ");
    const first = shownEditor(window);
    const bullet = first.locator(":scope > ul li");
    await expect(bullet).toHaveText("Plan");
    await showNewTab(window);

    const second = await secondWindow(app);
    await second.getByTestId("mind-tab").first().click();
    const theirs = second.getByTestId("mind-editor").first();
    const theirBullet = theirs.locator(":scope > ul li");
    await expect(theirBullet).toHaveText("Plan");
    await theirBullet.locator("p").click();
    await second.keyboard.press("ControlOrMeta+End");
    await second.keyboard.type(" from the window");
    await expect(theirBullet).toHaveText("Plan from the window");

    await backTo(window, note);
    await expect(bullet).toHaveText("Plan from the window");
    await window.keyboard.press("ControlOrMeta+z");
    await expect(first).not.toContainText("Earlier.");
    await expect(bullet).toHaveText("Plan from the window");
    await expect(theirBullet).toHaveText("Plan from the window");
    await expect(theirs).not.toContainText("Earlier.");
  } finally {
    await app.close();
  }
});

/** How far a Block's top is below the top of the Note's scroller, in whole pixels. */
const offsetInView = (block: Locator) =>
  block.evaluate((element) => {
    const view = element.closest('[data-testid="mind-scroller"]');
    if (!view) throw new Error("The Block isn't in a Note's scroller.");
    return Math.round(element.getBoundingClientRect().top - view.getBoundingClientRect().top);
  });

/** Waits for the Note's scroll to come to rest, as a wheel's scroll eases out. */
async function scrollSettled(scroller: Locator): Promise<void> {
  let last = -1;
  await expect
    .poll(async () => {
      const now = await scroller.evaluate((element) => element.scrollTop);
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
}

/** The words of the Note's first paragraph wholly in view, a line below the view's top. */
const lineInView = (scroller: Locator) =>
  scroller.evaluate((view) => {
    const top = view.getBoundingClientRect().top + 40;
    const shown = [...view.querySelectorAll('[data-testid="mind-editor"] > p')].find(
      (paragraph) => paragraph.getBoundingClientRect().top >= top,
    );
    return shown?.textContent ?? null;
  });

// protects=a tall Note with an Answer and a table above the place the User left, drawn again when its tab shows, comes back with the same line at the same place in the view, once the Blocks drawn after the text have their size (#3115); fails_when=the Answer or the table drawn after the scroll is put back moves the line the User left; no_claim=the cursor, which the test above holds.
test("a tall Note with an Answer and a table above: back in its tab, the line left is where it was in the view", async () => {
  const { app, window } = await launched();
  try {
    const lines = Array.from(
      { length: 200 },
      (_, index) => `Paragraph ${index + 1}: the harbour office posts the tide times each week.`,
    );
    const answer = Array.from(
      { length: 12 },
      () => "Spring tides come at new moon and at full moon, when the Sun and Moon line up.",
    ).join(" ");
    await mindWrittenBefore(window, "Tall", [
      { question: "When are spring tides?", answer },
      { note: "Intro" },
      ...lines.map((note) => ({ note })),
    ]);
    await window.getByTestId("mind-list-item").filter({ hasText: "Tall" }).click();
    const editor = shownEditor(window);
    await expect(editor.getByTestId("answer")).toContainText("Spring tides");
    const intro = paragraphs(editor).filter({ hasText: "Intro" });
    await pointAndClick(window, intro);
    await focusSettled(window, editor);
    await window.keyboard.press("End");
    await window.keyboard.press("Enter");
    await window.keyboard.type("/table");
    await window.keyboard.press("Enter");
    await expect(editor.locator("table td").first()).toBeVisible();

    const scroller = window.locator(
      '[data-testid="tab-group"][data-focused] [data-testid="mind-scroller"]',
    );
    await scroller.hover();
    await window.mouse.wheel(0, 3000);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(2000);
    await scrollSettled(scroller);
    const line = await lineInView(scroller);
    if (!line?.startsWith("Paragraph")) throw new Error(`No paragraph in view: ${line}`);
    const before = await offsetInView(editor.getByText(line, { exact: true }));

    const note = window.getByTestId("mind-tab").first();
    await showNewTab(window);
    await pointAndClick(window, note);
    await expect(note).toHaveAttribute("aria-selected", "true");
    const back = shownEditor(window);
    await expect(back.getByTestId("answer")).toContainText("Spring tides");
    await expect(back.locator("table td").first()).toBeVisible();
    await motionSettled(window);
    await scrollSettled(scroller);
    const again = back.getByText(line, { exact: true });
    await expect(again).toBeInViewport();
    const now = await offsetInView(again);
    expect(
      Math.abs(now - before),
      `${before}px from the top before, ${now}px after`,
    ).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
  }
});

// protects=the menu of the Note's shown tab, opened by a right-click, leaves the focus where it was: on the tab, not in the Note's text, once the menu closes, by Escape or by an item such as Pin, so a ⌘Z there reaches the app's Undo rather than the Note's (#3115); fails_when=a right-click on the tab puts the focus in the Note's text; no_claim=what the menu's items do.
test("a right-click on the shown tab, its menu closed or an item chosen, leaves the focus on the tab", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    await window.keyboard.type("Typed here.");
    const tab = shownTabs(window).first();
    await tab.focus();
    let menu = await menuOf(window, tab);
    await window.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(tab).toBeFocused();

    menu = await menuOf(window, tab);
    await pointAndClick(window, menu.getByTestId("tab.pin"));
    await expect(menu).toBeHidden();
    await expect(tab).toHaveAttribute("data-pinned", "true");
    await expect(tab).toBeFocused();
  } finally {
    await app.close();
  }
});

// protects=back in a Note by a click on its tab, the cursor where it was is the one ⌘J and Esc come back to from the assistant, not the Note's end (#3115); fails_when=Esc from the composer puts the cursor at the Note's end; no_claim=what the assistant does with the Question.
test("back in a Note by its tab, ⌘J then Esc come back to the cursor where it was", async () => {
  const { app, window } = await launched();
  try {
    await newMind(window);
    await window.keyboard.type("First line here.");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Second line here.");
    const editor = shownEditor(window);
    await pointAndClick(window, paragraphs(editor).first());
    await focusSettled(window, editor);
    for (let step = 0; step < 6; step++) await window.keyboard.press("ArrowLeft");
    const at = await caret(window);
    expect(at).toEqual({ words: "First line here.", offset: "First line here.".length - 6 });

    const note = window.getByTestId("mind-tab").first();
    await showNewTab(window);
    await backTo(window, note);
    expect(await caret(window)).toEqual(at);
    await window.keyboard.press("ControlOrMeta+j");
    await expect(window.getByTestId("composer-input")).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(shownEditor(window)).toBeFocused();
    expect(await caret(window)).toEqual(at);
  } finally {
    await app.close();
  }
});

/** The getting-started steps shown, as on a first run, so their Hide is a change of the app's with Undo. */
const showSteps = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    const now = (await core.getSettings()).device.gettingStarted;
    await core.updateSettings({
      device: { gettingStarted: { ...now, started: true, hidden: false } },
    });
  });

const stepsHidden = async (window: Page) => (await gettingStarted(window)).hidden;

// protects=in a Note's text ⌘Z takes back the Note's own typing first and, with nothing of the Note's left, the app's change; ⇧⌘Z does the typing again first and then the app's change, each once; a tab's name field keeps ⌘Z for its own text, the app's change staying (#3115); fails_when=⌘Z in the text stops at the Note's history, takes the app's change first, a step is done twice or lost, or the name field's ⌘Z takes back the app's change; no_claim=the Edit menu's names.
test("in a Note's text ⌘Z takes back the typing, then the app's change, ⇧⌘Z the same way round, and a tab's name field keeps its own", async () => {
  const { app, window } = await launched();
  try {
    await showSteps(window);
    await newMind(window);
    const editor = shownEditor(window);
    await window.keyboard.type("Typed.");
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("Hide the getting-started steps");
    await expect(window.getByTestId("palette-item").first()).toContainText(
      "Hide the getting-started steps",
    );
    await window.keyboard.press("Enter");
    await expect.poll(() => stepsHidden(window)).toBe(true);
    await expect(editor).toBeFocused();

    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).not.toContainText("Typed.");
    expect(await stepsHidden(window)).toBe(true);
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => stepsHidden(window)).toBe(false);
    await expect(editor).not.toContainText("Typed.");

    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(paragraphs(editor)).toHaveText(["Typed."]);
    expect(await stepsHidden(window)).toBe(false);
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => stepsHidden(window)).toBe(true);
    await expect(paragraphs(editor)).toHaveText(["Typed."]);

    await shownTabs(window).first().getByTestId("tab-title").dblclick();
    const name = window.getByTestId("tab-rename");
    await expect(name).toBeFocused();
    const taken = await window.evaluate(() => {
      const mac = /Mac/.test(navigator.platform);
      const event = new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      });
      document.activeElement?.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(taken).toBe(false);
    await window.keyboard.press("ControlOrMeta+z");
    await window.keyboard.press("Escape");
    await expect(name).toHaveCount(0);
    expect(await stepsHidden(window)).toBe(true);
    await expect(paragraphs(editor)).toHaveText(["Typed."]);
  } finally {
    await app.close();
  }
});

// protects=typing in a Note ends the app's Redo, as any new change does: an app change taken back before the typing is never done again by ⇧⌘Z or Ctrl+Y pressed in the Note's text once the Note has nothing left to do again (#3115); fails_when=the key pressed once too many does the earlier app change again; no_claim=the Edit menu's Redo item, which reads the same list.
test("typing in a Note ends the app's Redo: ⇧⌘Z pressed once too many leaves an app change taken back before as it was", async () => {
  const { app, window } = await launched();
  try {
    await showSteps(window);
    await newMind(window);
    const editor = shownEditor(window);
    await window.keyboard.type("First.");
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("Hide the getting-started steps");
    await expect(window.getByTestId("palette-item").first()).toContainText(
      "Hide the getting-started steps",
    );
    await window.keyboard.press("Enter");
    await expect.poll(() => stepsHidden(window)).toBe(true);
    await expect(editor).toBeFocused();
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).not.toContainText("First.");
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => stepsHidden(window)).toBe(false);

    await window.keyboard.type("Typed.");
    await expect(editor).toContainText("Typed.");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    expect(await stepsHidden(window)).toBe(false);

    await window.keyboard.press("ControlOrMeta+z");
    await expect(editor).not.toContainText("Typed.");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor).toContainText("Typed.");
    await window.keyboard.press("ControlOrMeta+Shift+z");
    if (process.platform !== "darwin") await window.keyboard.press("Control+y");
    expect(await stepsHidden(window)).toBe(false);
    await expect(editor).toContainText("Typed.");
  } finally {
    await app.close();
  }
});
