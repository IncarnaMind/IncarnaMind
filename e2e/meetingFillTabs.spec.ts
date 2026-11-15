import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import {
  clickEditItem,
  closeFirstFillPopover,
  createDataFolder,
  dismissChatSetup,
  firstTranscriptLine,
  focusSettled,
  launchApp,
  motionSettled,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  useLocalChatModel as selectLocalChatModel,
  setWindowSize,
  startRecording,
  undoMenuItem,
} from "./app";

/*
 * A call's filled note keeps its line and its Undo when the User only looks elsewhere: a Citation's
 * Transcript in another tab, its card, a switch back and forth (#3099). The line goes at the User's
 * own act in the Note, as before.
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
    speech: ["We confirmed the launch date", "We discussed the release checklist"],
    notes: ["Launch date", "UK fee"],
    actions: "Action items",
    typed: " today",
    filled: "Note filled in from the call · Undo",
    partial: "Note partly filled in · 1 item couldn’t be added · View Transcript · Undo",
    undone: "Fill-in undone · Fill in again",
  },
  "zh-CN": {
    speech: ["我们确认了上线日期", "我们讨论了后续分工"],
    notes: ["上线日期", "英国费用"],
    actions: "待办",
    typed: "今天",
    filled: "已补全笔记 · 撤销",
    partial: "笔记未能全部补全 · 1 项内容未能添加 · 查看转写稿 · 撤销",
    undone: "已撤销补全 · 重新补全",
  },
} as const;
type Language = keyof typeof WORDS;

const PARTIAL = "Meeting fill fixture: partial";

/** A call recorded, its notes typed, stopped and filled: the Note, its line, and its Blocks before the fill. */
async function filledCall(window: Page, language: Language, partial = false) {
  const words = WORDS[language];
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  await firstTranscriptLine(window);
  const notes = window.getByTestId("mind-editor");
  await pointAndClick(window, notes);
  await focusSettled(window, notes);
  for (const text of [...(partial ? [PARTIAL] : []), ...words.notes]) {
    await window.keyboard.type(text);
    await window.keyboard.press("Enter");
  }
  await window.keyboard.type(`## ${words.actions}`);
  const blocks = notes.locator(":scope > [data-id]");
  const original = await blocks.allTextContents();
  await window.evaluate(async (chosen) => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await core.updateSettings({ user: { language: chosen } });
  }, language);
  await pointAndClick(window, bar.getByTestId("meeting-stop"));
  const line = window.getByTestId("meeting-fill-line");
  await expect(line).toHaveText(partial ? words.partial : words.filled, { timeout: 30_000 });
  await closeFirstFillPopover(window);
  return { notes, line, blocks, original };
}

async function launched(language: Language) {
  const words = WORDS[language];
  const { app, window } = await launchApp(dataDir, {
    fakeChat: true,
    transcriber: { lines: [words.speech[0]], theirLines: [words.speech[1]] },
  });
  await setWindowSize(app, window, 1280, 860);
  await dismissChatSetup(window);
  await selectLocalChatModel(window);
  return { app, window };
}

/** The note's first Citation opens its Transcript in a tab of its own; then the note's tab, clicked. */
async function throughTheTranscript(window: Page, notes: Locator) {
  await pointAndClick(window, notes.getByTestId("citation-chip").first());
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await pointAndClick(window, card.getByTestId("citation-open"));
  await expect(window.locator("[data-quote-highlight]").first()).toBeInViewport();
  await backToTheNote(window, notes);
}

async function backToTheNote(window: Page, notes: Locator) {
  await pointAndClick(window, window.getByTestId("mind-tab").first());
  await expect(notes).toBeVisible();
  await motionSettled(window);
  // Back on the tab, the Citation clicked last has the focus again, and its card opens on focus.
  const card = window.getByTestId("citation-card");
  if (await card.isVisible()) {
    await window.keyboard.press("Escape");
    await expect(card).toBeHidden();
  }
}

const fillState = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings()).at(-1)?.fill?.state ?? null;
  });

/** Whether the call's audio is kept until the User deletes it. */
const audioKept = (window: Page) =>
  window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings()).at(-1)?.audio.keptUntilDeleted ?? null;
  });

/** The note's first Citation opens its Transcript in a tab of its own, which stays in front. */
async function toTheTranscriptTab(window: Page, notes: Locator) {
  await pointAndClick(window, notes.getByTestId("citation-chip").first());
  const card = window.getByTestId("citation-card");
  await expect(card).toBeVisible();
  await pointAndClick(window, card.getByTestId("citation-open"));
  await expect(window.locator("[data-quote-highlight]").first()).toBeInViewport();
  await motionSettled(window);
}

/**
 * Edit › Undo here doesn't name the fill, and ⌘Z, or the menu's Undo where a test's key can't reach
 * it, takes back nothing of the fill.
 */
async function undoLeavesTheFill(
  app: ElectronApplication,
  window: Page,
  language: Language,
  how: "key" | "menu",
) {
  await expect
    .poll(async () => (await undoMenuItem(app)).label)
    .toBe(translate(language, "menu.undo"));
  if (how === "key") await window.keyboard.press("ControlOrMeta+z");
  else await clickEditItem(app, "edit.undo");
  await motionSettled(window);
  expect(await fillState(window)).toBe("filled");
}

/** The chip shows one of the Note's views in its tab. */
async function showView(window: Page, view: "notes" | "mine" | "transcript") {
  await pointAndClick(window, window.getByTestId("meeting-view-chip"));
  await pointAndClick(window, window.getByTestId(`meeting-view-${view}`));
  const menu = window.getByTestId("meeting-view-menu");
  if (await menu.isVisible()) await window.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await motionSettled(window);
}

/** ⌘Z in the note on My notes leaves the fill, and says where to undo it. */
async function myNotesLeavesTheFill(window: Page, notes: Locator, language: Language) {
  await showView(window, "mine");
  await pointAndClick(window, notes.locator(":scope > p[data-id]:visible").first());
  await window.keyboard.press("ControlOrMeta+z");
  await expect(window.getByTestId("undo-line")).toHaveText(
    `${translate(language, "meetings.mine.fillUndo")} · ${translate(language, "meetings.views.showNotes")}`,
  );
  expect(await fillState(window)).toBe("filled");
}

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  // protects=a Citation's Transcript opened in another tab, and switches back and forth, leave the filled note's line where it was; its Undo takes the notes back to exactly what the User wrote (#3099); fails_when=the line is gone after a switch, or Undo leaves a written part or takes a User's line; no_claim=a real model's notes.
  test(`a: back from the Transcript's tab, the line stays, and Undo gives back the User's own notes (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await throughTheTranscript(window, notes);
      await expect(line).toHaveText(words.filled);
      const transcriptTab = window.getByTestId("document-tab").first();
      await pointAndClick(window, transcriptTab);
      await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
      await backToTheNote(window, notes);
      await expect(line).toHaveText(words.filled);

      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
      expect(await fillState(window)).toBe("undone");
    } finally {
      await app.close();
    }
  });

  // protects=⌘Z after coming back, with nothing done in the Note since, takes the fill back as the Note's own step, as the line's Undo does (#3099, #3115); fails_when=⌘Z does nothing, or takes back more than the fill; no_claim=the Edit menu's name for it.
  test(`b: back from the Transcript's tab, ⌘Z takes the fill back (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await throughTheTranscript(window, notes);
      await expect(line).toHaveText(words.filled);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=a Citation's card opened from the keyboard and closed, without leaving the tab, leaves the line and its Undo (#3099); fails_when=the card takes the line away; no_claim=what the card says.
  test(`c: a Citation's card opened and closed leaves the line (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await notes.getByTestId("citation-chip").first().focus();
      const card = window.getByTestId("citation-card");
      await expect(card).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(card).toBeHidden();
      await expect(line).toHaveText(words.filled);
      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=a step the User went on from is no longer on top: typed before a switch, no line comes back and ⌘Z there doesn't take the fill back (#3099); fails_when=a line, or the fill's Undo, comes back after the User typed; no_claim=the User's typing before a switch, whose Undo is #3115's.
  test(`d: typed before a switch, no line comes back (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line } = await filledCall(window, language);
      await pointAndClick(window, notes.locator(":scope > p[data-id]").first());
      await window.keyboard.press("End");
      await window.keyboard.type(words.typed);
      await expect(line).toHaveCount(0);
      await throughTheTranscript(window, notes);
      await expect(line).toHaveCount(0);
      await window.keyboard.press("ControlOrMeta+z");
      await motionSettled(window);
      expect(await fillState(window)).toBe("filled");
    } finally {
      await app.close();
    }
  });

  // protects=typed after coming back, the line goes, and ⌘Z takes the typing back first, then the fill, which stays under it on the app's Undo (#3099); fails_when=the line stays after typing, or ⌘Z takes the fill back before the typing; no_claim=the Edit menu's names.
  test(`d: typed after coming back, ⌘Z takes the typing back, then the fill (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await throughTheTranscript(window, notes);
      await expect(line).toHaveText(words.filled);
      const own = notes.locator(":scope > p[data-id]").first();
      await pointAndClick(window, own);
      await window.keyboard.press("End");
      await window.keyboard.type(words.typed);
      await expect(line).toHaveCount(0);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(own).toHaveText(original[0] ?? "");
      expect(await fillState(window)).toBe("filled");
      // The fill is the Note's next step now, and the Edit menu's Undo takes it back.
      await clickEditItem(app, "edit.undo");
      await expect(blocks).toHaveText(original);
      expect(await fillState(window)).toBe("undone");
    } finally {
      await app.close();
    }
  });

  // protects=closing the tab ends the offer: the Note opened again shows no line, and My notes shows the User's own notes (#3099); fails_when=a line, or an Undo of the fill, stands on the Note opened later; no_claim=Reopen closed tab.
  test(`e: the tab closed and the Note opened again: no line (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line } = await filledCall(window, language);
      const tab = window.getByTestId("mind-tab").first();
      await tab.hover();
      await pointAndClick(window, tab.getByTestId("tab-close"));
      await expect(notes).toHaveCount(0);
      await pointAndClick(window, window.getByRole("treeitem").first());
      await expect(notes).toBeVisible();
      await motionSettled(window);
      await expect(line).toHaveCount(0);
      await pointAndClick(window, window.getByTestId("meeting-view-chip"));
      await pointAndClick(window, window.getByTestId("meeting-view-mine"));
      await expect(notes.locator(".generated-text:visible")).toHaveCount(0);
      await expect(notes.locator(":scope > p[data-id]:visible")).toHaveText([...words.notes]);
      await expect(line).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  // protects=the partly filled line keeps its Undo through a switch to the Transcript's tab and back, and Undo gives back the User's own notes (#3099); fails_when=the line or its Undo is gone, or Undo leaves a written part; no_claim=what was left out.
  test(`f: the partly filled line, back from the Transcript's tab (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language, true);
      await throughTheTranscript(window, notes);
      await expect(line).toHaveText(words.partial);
      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=the fill's Undo is reached only where its text shows: on the Transcript's own tab, Edit › Undo doesn't name it and ⌘Z leaves it; back on the note the line and its Undo are as before (#3099); fails_when=⌘Z on the Transcript's tab takes the fill back out of sight, or the menu names it there; no_claim=what else that tab's Undo takes back.
  test(`g: on the Transcript's own tab, ⌘Z leaves the fill (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await toTheTranscriptTab(window, notes);
      await undoLeavesTheFill(app, window, language, "key");
      await backToTheNote(window, notes);
      await expect(line).toHaveText(words.filled);
      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=the same from another Note's tab with nothing of its own to undo: Edit › Undo there leaves the fill (#3099); fails_when=the menu's Undo in another Note takes the fill back; no_claim=that Note's own Undo.
  test(`h: in another Note's tab, Undo leaves the fill (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await window.keyboard.press("ControlOrMeta+t");
      await expect(window.getByTestId("mind-tab")).toHaveCount(2);
      await expect(notes).toBeVisible();
      await motionSettled(window);
      // The new Note's own history is empty: ⌘Z there goes on to the Edit menu's Undo.
      await undoLeavesTheFill(app, window, language, "menu");
      await backToTheNote(window, notes);
      await expect(line).toHaveText(words.filled);
      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=the chip's Transcript view and My notes hide the fill's text: ⌘Z on the Transcript view leaves the fill, and the User's own lines behind it, and the menu doesn't name it; ⌘Z in the note on My notes leaves the fill and says to undo it from Notes (#138); back on Notes the line and its Undo are as before (#3099); fails_when=⌘Z takes the fill back while its text is hidden, the browser's own undo takes back the User's typing out of sight, or My notes stops saying where to undo it; no_claim=My notes' other steps.
  test(`i: on the Transcript view and My notes, ⌘Z leaves the fill (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await showView(window, "transcript");
      await undoLeavesTheFill(app, window, language, "key");
      await myNotesLeavesTheFill(window, notes, language);
      await showView(window, "notes");
      await expect(line).toHaveText(words.filled);
      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=a fill kept in the tab's history through a tab switch keeps My notes' rule: ⌘Z in the note there leaves it and says to undo it from Notes; back on Notes, its line's Undo takes it back (#138, #3099, #3115); fails_when=⌘Z on My notes takes the fill back unseen; no_claim=the Transcript's tab, which g holds.
  test(`i: back from the Transcript's tab, My notes keeps the fill (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await throughTheTranscript(window, notes);
      await myNotesLeavesTheFill(window, notes, language);
      await showView(window, "notes");
      await expect(line).toHaveText(words.filled);
      await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=the fill's Undo keeps its place in the order of changes: a change made after the fill, here Keep audio, is taken back first, through the chip's Transcript view and a tab switch, and Edit › Undo names each in turn (#3099); fails_when=the fill jumps ahead of the later change, or ⌘Z skips it; no_claim=Keep audio's own Undo, which meetingAudio holds.
  test(`j: a change made after the fill is taken back first, after a view switch and a tab switch (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes, line, blocks, original } = await filledCall(window, language);
      await pointAndClick(window, window.getByTestId("meeting-view-chip"));
      await pointAndClick(window, window.getByTestId("meeting-audio-keep-for-good"));
      await expect.poll(() => audioKept(window)).toBe(true);
      const menu = window.getByTestId("meeting-view-menu");
      if (await menu.isVisible()) await window.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await showView(window, "transcript");
      await showView(window, "notes");
      await throughTheTranscript(window, notes);
      await expect(line).toHaveText(words.filled);

      const named = (key: "meetings.command.keepAudio" | "meetings.fill.undoName") =>
        translate(language, "menu.undo.named", { action: translate(language, key) });
      await window.getByTestId("meeting-view-chip").focus();
      await expect
        .poll(async () => (await undoMenuItem(app)).label)
        .toBe(named("meetings.command.keepAudio"));
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => audioKept(window)).toBe(false);
      expect(await fillState(window)).toBe("filled");
      await expect
        .poll(async () => (await undoMenuItem(app)).label)
        .toBe(named("meetings.fill.undoName"));
      await window.keyboard.press("ControlOrMeta+z");
      await expect(line).toHaveText(words.undone);
      await expect(blocks).toHaveText(original);
    } finally {
      await app.close();
    }
  });

  // protects=closing the Note's tab takes the fill's Undo away with it: ⌘Z afterwards leaves the fill, and Edit › Undo doesn't name it (#3099); fails_when=⌘Z after the tab closed takes the fill back unseen; no_claim=Reopen closed tab.
  test(`k: the Note's tab closed, ⌘Z leaves the fill (${language})`, async () => {
    const { app, window } = await launched(language);
    try {
      const { notes } = await filledCall(window, language);
      const tab = window.getByTestId("mind-tab").first();
      await tab.hover();
      await pointAndClick(window, tab.getByTestId("tab-close"));
      await expect(notes).toHaveCount(0);
      await undoLeavesTheFill(app, window, language, "key");
    } finally {
      await app.close();
    }
  });
}
