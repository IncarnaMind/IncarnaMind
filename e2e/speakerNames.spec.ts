import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import {
  closeFirstFillPopover,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  pointAndClick,
  recordMeetingNow,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  turnOf,
  useLocalChatModel,
} from "./app";
import { encode, film } from "./feel";

/**
 * Who speaks a line of a saved Meeting's Transcript (#138): its Speaker's name opens a menu of the
 * Meeting's people, "New speaker…" and "Apply to all"; a choice applies at once with one Undo, F2
 * and ⌘K reach it, and the Note's Citations show the name. Set INCARNAMIND_SCREENSHOTS to keep
 * stills and a film of the flow.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function recordOnClose(app: ElectronApplication, window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  const frames = resolve(SCREENSHOTS, `${name}-frames`);
  const stop = await film(window, frames);
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => {
    closing ??= (async () => {
      try {
        await stop();
        await encode(frames, resolve(SCREENSHOTS, `${name}.mp4`));
      } finally {
        await close();
      }
    })();
    return closing;
  };
}

const WORDS = {
  en: {
    me: "Me",
    them: "Them",
    who: "Who speaks this part?",
    newSpeaker: "New speaker…",
    all: "Apply to all",
    name: "Dana Whitfield",
    label: "Speaker 9",
    allSet: "Dana Whitfield speaks every line by this speaker",
    set: "Dana Whitfield speaks this part",
    change: "Change who speaks",
    showTranscript: "Show the Transcript",
    showNotes: "Show notes",
  },
  "zh-CN": {
    me: "我",
    them: "对方",
    who: "这一段是谁说的？",
    newSpeaker: "新建发言人…",
    all: "全部应用",
    name: "王丽",
    label: "发言人 9",
    allSet: "这位发言人的每一行都已改为 王丽 说的",
    set: "已改为 王丽 说的",
    change: "更改发言人",
    showTranscript: "显示转写稿",
    showNotes: "显示笔记",
  },
} as const;

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/** Each turn's Speaker, in order. */
const speakersOf = (lines: Locator) => lines.getByTestId("transcript-speaker").allInnerTexts();

/** The first turn a Speaker speaks. */
const turnBy = (window: Page, lines: Locator, speaker: string) =>
  lines
    .getByTestId("transcript-turn")
    .filter({ has: window.getByTestId("transcript-speaker").getByText(speaker, { exact: true }) })
    .first();

/** The menu fits in the window at its width: nothing of it is cut off at an edge. */
async function expectInWindow(window: Page, menu: Locator): Promise<void> {
  const box = await menu.boundingBox();
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box) throw new Error("The menu isn't shown.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
}

for (const language of ["en", "zh-CN"] as const) {
  test.describe(`Who speaks a Transcript's turn (${language})`, () => {
    let dataDir: string;
    test.beforeEach(async () => {
      dataDir = await createDataFolder();
    });
    test.afterEach(async () => {
      await removeDataFolder(dataDir);
    });

    // protects=on a saved Transcript a Speaker's name opens the menu of the Meeting's people, New speaker… and Apply to all; a new name for every line by "Them" shows on each of their lines, the User's stay "Me", and the Note's Citations of them show it; F2 on a line and ⌘K open its turn's menu, a pick moves that turn alone and keeps the focus on the line, and ⌘Z takes back each choice in turn; the menu fits at 1,100 px in English and Chinese; fails_when=the menu is missing or cut off, a choice waits for the core, "Me" changes with "Them", a Citation keeps the old name, or ⌘Z leaves a name; no_claim=the speaker pass, which the core tests cover, and a real model's fill.
    test("a Speaker is named from the line, by mouse, F2 and ⌘K, the Citations follow, and ⌘Z takes each choice back", async () => {
      const words = WORDS[language];
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await setWindowSize(app, window, 1100, 720);
      await recordOnClose(app, window, `speaker-names-${language}`);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await window.evaluate(async () => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.updateSettings({ device: { meetingNoticeAccepted: true } });
      });

      const bar = await recordMeetingNow(window);
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(6);
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.fill?.state, { timeout: 30_000 })
        .toBe("filled");
      await closeFirstFillPopover(window);
      await shot(window, `speakers-notes-before-${language}`);

      await runCommand(window, "meeting.showTranscript", words.showTranscript);
      const transcript = window.getByTestId("meeting-note-transcript");
      const lines = transcript.getByTestId("transcript-lines");
      await expect(lines.getByTestId("transcript-line").first()).toBeVisible();
      const before = await speakersOf(lines);
      expect(new Set(before)).toEqual(new Set([words.me, words.them]));
      await shot(window, `speakers-transcript-before-${language}`);

      // The mouse: the first "Them" turn's name, Apply to all, and a new name.
      const theirName = turnBy(window, lines, words.them).getByTestId("transcript-speaker");
      await expect(theirName).toHaveAttribute("title", words.change);
      await pointAndClick(window, theirName);
      // Each turn has its menu; the one open is the turn's whose name was chosen.
      const menu = window.locator('[data-testid="speaker-menu"]:popover-open');
      await expect(menu).toBeVisible();
      await expect(menu.getByText(words.who)).toBeVisible();
      await expect(menu.getByTestId("speaker-choice")).toHaveText([words.me, words.them]);
      await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveText(words.them);
      await expect(menu.getByTestId("speaker-new")).toHaveText(words.newSpeaker);
      await expect(menu.getByTestId("speaker-all")).toContainText(words.all);
      await expectInWindow(window, menu);
      await shot(window, `speakers-menu-${language}`);
      await pointAndClick(window, menu.getByTestId("speaker-all"));
      await expect(menu.getByTestId("speaker-all")).toHaveAttribute("aria-checked", "true");
      await pointAndClick(window, menu.getByTestId("speaker-new"));
      const field = menu.getByTestId("speaker-name");
      await expect(field).toBeFocused();
      // A label's words aren't a name: the field says so, and the menu stays.
      await window.keyboard.insertText(words.label);
      await window.keyboard.press("Enter");
      await expect(menu.getByTestId("speaker-name-refused")).toContainText(words.label);
      await field.fill("");
      await expect(menu.getByTestId("speaker-name-refused")).toHaveCount(0);
      await window.keyboard.insertText(words.name);
      await window.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      const named = before.map((each) => (each === words.them ? words.name : each));
      await expect.poll(() => speakersOf(lines)).toEqual(named);
      await expect(window.getByTestId("undo-line")).toContainText(words.allSet);
      await shot(window, `speakers-transcript-named-${language}`);

      // The keyboard: F2 on the User's first line, which the filled notes cite, opens its turn's
      // menu; a pick moves that turn alone, and the focus stays on the line.
      const firstMine = turnBy(window, lines, words.me).getByTestId("transcript-line").first();
      const mine = lines.locator(`[data-line="${await firstMine.getAttribute("data-line")}"]`);
      const mineSpeaker = turnOf(mine).getByTestId("transcript-speaker");
      await mine.focus();
      await window.keyboard.press("F2");
      await expect(menu).toBeVisible();
      await expect(menu.locator(":focus")).toHaveText(words.me);
      await window.keyboard.press("ArrowDown");
      await expect(menu.locator(":focus")).toHaveText(words.name);
      await window.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(mineSpeaker).toHaveText(words.name);
      await expect(mine).toBeFocused();
      const turnsBy = (speakers: string[], speaker: string) =>
        speakers.filter((each) => each === speaker).length;
      expect(turnsBy(await speakersOf(lines), words.me)).toBe(turnsBy(named, words.me) - 1);
      await expect(window.getByTestId("undo-line")).toContainText(words.set);

      // ⌘K reaches it for the line in focus, and Esc closes it with nothing changed.
      await mine.focus();
      await runCommand(window, "meeting.changeSpeaker", words.change);
      await expect(menu).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);

      // The notes' Citations of that line say who speaks it now, from the label each keeps.
      await runCommand(window, "meeting.showNotes", words.showNotes);
      const chips = window.getByTestId("mind-editor").getByTestId("citation-chip-text");
      await expect(chips.first()).toBeVisible();
      const at = await chips.first().innerText();
      expect(at).toMatch(new RegExp(`^${words.name} · \\d+:\\d{2}$`));
      await shot(window, `speakers-notes-named-${language}`);

      // ⌘Z, outside the notes' text, takes back the one line, and its Citations follow; then
      // every line's name.
      await runCommand(window, "meeting.showTranscript", words.showTranscript);
      await mine.focus();
      await window.keyboard.press("ControlOrMeta+z");
      await expect(mineSpeaker).toHaveText(words.me);
      await runCommand(window, "meeting.showNotes", words.showNotes);
      await expect(chips.first()).toHaveText(at.replace(words.name, words.me));
      await runCommand(window, "meeting.showTranscript", words.showTranscript);
      await mine.focus();
      await window.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => speakersOf(lines)).toEqual(before);
      await app.close();
    });
  });
}
