import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import { parseClockTime } from "../src/shared/clock";
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
  useLocalChatModel,
} from "./app";
import { encode, film } from "./feel";

/**
 * A saved Meeting's Transcript plays from a clicked word while its audio is kept, and a line
 * splits at a word to say who spoke the rest (#138). The app starts muted: nothing is heard on
 * the computer the spec runs on. Set INCARNAMIND_SCREENSHOTS to keep stills and a film.
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
    tip: "Click a word to hear it.",
    playHere: "Play from here",
    pause: "Pause (Space)",
    play: "Play (Space)",
    spaceToPause: "Space to pause",
    whoRest: "Who speaks the rest?",
    newSpeaker: "New speaker…",
    name: "Sam",
    split: "Split the line",
    splitCommand: "Split the line here",
    showTranscript: "Show the Transcript",
  },
  "zh-CN": {
    tip: "点一个词，从那里开始播放。",
    playHere: "从这里播放",
    pause: "暂停（空格）",
    play: "播放（空格）",
    spaceToPause: "按空格暂停",
    whoRest: "后半句是谁说的？",
    newSpeaker: "新建发言人…",
    name: "王丽",
    split: "已拆分这一行",
    splitCommand: "在此处拆分这一行",
    showTranscript: "显示转写稿",
  },
} as const;

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/** A line's start and end, in ms, as its `data-line` names it. */
async function spanOf(line: Locator): Promise<{ startMs: number; endMs: number }> {
  const [start, end] = ((await line.getAttribute("data-line")) ?? "").split("-");
  return { startMs: Number(start), endMs: Number(end) };
}

/** Where the player says it is, in ms, to the second it shows. */
async function playerAt(player: Locator): Promise<number> {
  const [at] = (await player.getByTestId("transcript-player-time").innerText()).split(" / ");
  return parseClockTime(at ?? "") ?? Number.NaN;
}

/** Fully inside the box of `outer`, as laid out now. */
async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  const box = await inner.boundingBox();
  const frame = await outer.boundingBox();
  if (!box || !frame) throw new Error("Not shown.");
  expect(box.x).toBeGreaterThanOrEqual(frame.x);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
  expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
}

for (const language of ["en", "zh-CN"] as const) {
  test.describe(`Playing a Transcript from a word, and splitting a line (${language})`, () => {
    let dataDir: string;
    test.beforeEach(async () => {
      dataDir = await createDataFolder();
    });
    test.afterEach(async () => {
      await removeDataFolder(dataDir);
    });

    // protects=while a saved Meeting's audio is kept, its words say "Play from here", a tip says so once, and a click plays from that word: the player shows where it is within the clicked line, Space pauses and plays again from the line, and Esc closes it; Enter at a word splits the line, asks who speaks the rest, and one ⌘Z sets the line back; Right puts the caret on a line's words and Esc keeps the rest's Speaker; ⌘K splits and plays; once the audio is deleted words don't offer to play and nothing breaks; at 1,100 px in English and Chinese the player sits inside the Transcript; fails_when=a click doesn't play or plays from outside its line, Space scrolls instead of pausing, Enter adds to the note with a caret, the split asks nothing, Undo takes two steps, or a word offers to play once the audio is gone; no_claim=the sound itself (the app is muted), and word times from a cloud service, which the core tests cover.
    test("a word plays from where it was said, and a line splits at a word with one Undo", async () => {
      const words = WORDS[language];
      const { app, window } = await launchApp(dataDir, {
        fakeChat: true,
        switches: ["--mute-audio"],
      });
      await setWindowSize(app, window, 1100, 720);
      await recordOnClose(app, window, `transcript-play-split-${language}`);
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
        .toBeGreaterThanOrEqual(14);
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.fill?.state, { timeout: 30_000 })
        .toBe("filled");
      await closeFirstFillPopover(window);
      await runCommand(window, "meeting.showTranscript", words.showTranscript);
      const transcript = window.getByTestId("meeting-note-transcript");
      const lines = transcript.getByTestId("transcript-line");
      await expect(lines.first()).toBeVisible();
      const count = await lines.count();

      // The tip says how, once; every word offers to play from where it was said.
      const tip = transcript.getByTestId("tip");
      await expect(tip).toHaveText(words.tip);
      const line = lines.nth(1);
      const word = line.locator("[data-word]").nth(3);
      await expect(word).toHaveAttribute("title", words.playHere);
      await shot(window, `transcript-word-${language}`);

      // A click plays from the word: the player says where, within the clicked line, and on by
      // no more than the time since.
      const clicked = Date.now();
      await pointAndClick(window, word);
      const player = transcript.getByTestId("transcript-player");
      await expect(player).toBeVisible();
      await expect(tip).toHaveCount(0);
      const toggle = player.getByTestId("transcript-player-toggle");
      await expect(toggle).toHaveAttribute("title", words.pause);
      await expect(player).toContainText(words.spaceToPause);
      const { startMs, endMs } = await spanOf(line);
      const at = await playerAt(player);
      expect(at).toBeGreaterThanOrEqual(startMs - 1250);
      expect(at).toBeLessThanOrEqual(endMs + (Date.now() - clicked));
      // Each word washed as being said is in a line said then: two at once when two people talk.
      const playing = await transcript.evaluate((root) => ({
        time: root.querySelector("[data-testid='transcript-player-time']")?.textContent ?? "",
        lines: [...root.querySelectorAll("[data-word][data-playing]")].map(
          (each) => each.closest("[data-line]")?.getAttribute("data-line") ?? "",
        ),
      }));
      const now = parseClockTime(playing.time.split(" / ")[0] ?? "") ?? Number.NaN;
      expect(playing.lines.length).toBeGreaterThan(0);
      for (const each of playing.lines) {
        const [from, to] = each.split("-").map(Number);
        expect(now).toBeGreaterThan((from ?? 0) - 1000);
        expect(now).toBeLessThanOrEqual(to ?? 0);
      }
      await expect(word).toHaveAttribute("data-caret", "true");
      await expectInside(player, transcript);
      await shot(window, `transcript-play-${language}`);

      // Space pauses and plays again, from the line; Esc closes the player.
      await expect(line).toBeFocused();
      const scrolled = await transcript
        .getByTestId("viewer-transcript")
        .evaluate((each) => each.scrollTop);
      await window.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("title", words.play);
      await window.keyboard.press("Space");
      await expect(toggle).toHaveAttribute("title", words.pause);
      expect(
        await transcript.getByTestId("viewer-transcript").evaluate((each) => each.scrollTop),
      ).toBe(scrolled);
      await window.keyboard.press("Escape");
      await expect(player).toHaveCount(0);
      await expect(word).toHaveAttribute("data-caret", "true");

      // Enter at the word splits the line there and asks who speaks the rest.
      const before = await line.locator("[data-word]").allInnerTexts();
      await window.keyboard.press("Enter");
      await expect(lines).toHaveCount(count + 1);
      const menu = window.locator('[data-testid="speaker-menu"]:popover-open');
      await expect(menu).toBeVisible();
      await expect(menu.getByText(words.whoRest)).toBeVisible();
      await shot(window, `transcript-split-${language}`);
      await pointAndClick(window, menu.getByTestId("speaker-new"));
      await window.keyboard.insertText(words.name);
      await window.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      const head = lines.nth(1);
      const rest = lines.nth(2);
      await expect(head.locator("[data-word]")).toHaveText(before.slice(0, 3));
      await expect(rest.locator("[data-word]")).toHaveText(before.slice(3));
      await expect(rest.getByTestId("transcript-speaker")).toHaveText(words.name);
      expect((await spanOf(rest)).startMs).toBeGreaterThan(startMs);
      await expect(window.getByTestId("undo-line")).toContainText(words.split);
      await expect(rest).toBeFocused();
      await shot(window, `transcript-split-named-${language}`);

      // One ⌘Z sets the line back whole, its Speaker as before.
      await window.keyboard.press("ControlOrMeta+z");
      await expect(lines).toHaveCount(count);
      await expect(lines.nth(1).locator("[data-word]")).toHaveText(before);

      // The keyboard: Right puts the caret on the line's words, Enter splits there, and Esc in
      // the menu keeps the rest with the same Speaker.
      const speaker = await lines.nth(1).getByTestId("transcript-speaker").innerText();
      await lines.nth(1).focus();
      await window.keyboard.press("ArrowRight");
      await expect(lines.nth(1).locator("[data-word]").first()).toHaveAttribute(
        "data-caret",
        "true",
      );
      await window.keyboard.press("Enter");
      await expect(lines).toHaveCount(count);
      await window.keyboard.press("ArrowRight");
      await window.keyboard.press("ArrowRight");
      await expect(lines.nth(1).locator("[data-word]").nth(2)).toHaveAttribute(
        "data-caret",
        "true",
      );
      await window.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(lines).toHaveCount(count + 1);
      await expect(lines.nth(2).getByTestId("transcript-speaker")).toHaveText(speaker);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(lines).toHaveCount(count);

      // ⌘K: the caret's line splits, and plays from the caret.
      await pointAndClick(window, lines.nth(1).locator("[data-word]").nth(2));
      await window.keyboard.press("Escape");
      await expect(player).toHaveCount(0);
      await runCommand(window, "meeting.playFromHere", words.playHere);
      await expect(player).toBeVisible();
      await runCommand(window, "meeting.splitLine", words.splitCommand);
      await expect(menu).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(lines).toHaveCount(count + 1);

      // Once the audio is deleted, words don't offer to play, and the player goes.
      await window.evaluate(
        async (meetingId) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await bridge.deleteMeetingAudio(meetingId);
        },
        (await meetingsOf(window))[0]?.id ?? "",
      );
      await expect(player).toHaveCount(0);
      const gone = lines.nth(4).locator("[data-word]").nth(1);
      await expect(gone).not.toHaveAttribute("title", words.playHere);
      await pointAndClick(window, gone);
      await expect(gone).toHaveAttribute("data-caret", "true");
      await expect(player).toHaveCount(0);
      await expect(lines).toHaveCount(count + 1);
      await shot(window, `transcript-audio-deleted-${language}`);
      await app.close();
    });
  });
}
