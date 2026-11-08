import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge, Meeting } from "../src/core/api";
import {
  closeFirstFillPopover,
  createDataFolder,
  dismissChatSetup,
  interceptSaveDialog,
  launchApp,
  motionSettled,
  openPageMenu,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";
import { encode, film } from "./feel";

/**
 * A meeting's audio after the call (#687): kept a day, its line in the meeting's popover saying
 * until when, Keep audio keeping it until the User deletes it with one Undo, Delete now asking
 * first, and Save recording… writing it where the User chooses. Set INCARNAMIND_SCREENSHOTS to
 * keep stills and a film.
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
    notice: "Audio stays on this computer; deleted within a day.",
    until: /^Audio kept until \d{1,2}:\d{2}( ?[ap]\.?m\.?)? tomorrow$/i,
    keep: "Keep audio",
    kept: "Audio kept",
    keptLine: "Keeping this meeting’s audio",
    deleteNow: "Delete now",
    deleteAudio: "Delete audio",
    deleted: /^Audio deleted on \d{1,2} [A-Z][a-z]{2}$/,
    save: "Save recording…",
    saved: "Saved the recording",
    deletedReason: "This meeting’s audio was deleted",
  },
  "zh-CN": {
    notice: "音频只存在这台电脑上，一天内删除。",
    until: /^音频保留到明天 (上午|下午)?\d{1,2}:\d{2}$/,
    keep: "保留音频",
    kept: "音频已保留",
    keptLine: "已保留这场会议的音频",
    deleteNow: "立即删除",
    deleteAudio: "删除音频",
    deleted: /^音频已于\d{1,2}月\d{1,2}日删除$/,
    save: "另存录音…",
    saved: "已另存录音",
    deletedReason: "这场会议的音频已删除",
  },
} as const;

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/** The meeting's popover, opened from its chip, with its audio row. */
async function audioRow(window: Page): Promise<Locator> {
  const menu = window.getByTestId("meeting-view-menu");
  if (!(await menu.isVisible()))
    await pointAndClick(window, window.getByTestId("meeting-view-chip"));
  await expect(menu).toBeVisible();
  return menu.getByTestId("meeting-audio");
}

/** The popover holds in the window: nothing of it cut off at an edge. */
async function expectInWindow(window: Page, element: Locator): Promise<void> {
  const box = await element.boundingBox();
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box) throw new Error("Not shown.");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height);
}

for (const language of ["en", "zh-CN"] as const) {
  test.describe(`A meeting's audio after the call (${language})`, () => {
    let dataDir: string;
    test.beforeEach(async () => {
      dataDir = await createDataFolder();
    });
    test.afterEach(async () => {
      await removeDataFolder(dataDir);
    });

    // protects=the first recording's notice says the audio is deleted within a day; after Stop the meeting's popover says until when tomorrow, with Keep audio and Delete now, at 1,440 and 900 px; Keep audio makes it "Audio kept" with one Undo, and ⌘K reaches it; Save recording… from the Note's menu writes a playable WAV where the save dialog says; Delete now asks first and leaves "Audio deleted on" a date with no action, Save recording… then disabled with its reason; in English and Chinese; fails_when=a state reads otherwise, an action is offered where it can't act, Keep audio takes two Undos, the file isn't written, or the popover is cut off; no_claim=the day's end itself, which the core tests cover with a fake clock.
    test("the audio line's three states, Keep audio, Save recording and Delete now", async () => {
      const words = WORDS[language];
      const { app, window } = await launchApp(dataDir, { fakeChat: true });
      await setWindowSize(app, window, 1440, 900);
      await recordOnClose(app, window, `meeting-audio-${language}`);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);

      // The first recording's notice says how long the audio stays.
      const start = await recordMeeting(window);
      await pointAndClick(window, start.getByTestId("meeting-start-record"));
      const notice = window.getByTestId("meeting-notice");
      await expect(notice).toContainText(words.notice);
      await shot(window, `meeting-audio-notice-${language}`);
      await notice.getByTestId("meeting-notice-start").click();
      const bar = window.getByTestId("meeting-bar");
      await expect(bar).toHaveAttribute("data-status", "recording");
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(4);
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.fill?.state, { timeout: 30_000 })
        .toBe("filled");
      await closeFirstFillPopover(window);

      // Kept until tomorrow, with Keep audio and Delete now.
      let row = await audioRow(window);
      await expect(row.locator("p")).toHaveText(words.until);
      await expect(row.getByTestId("meeting-audio-keep-for-good")).toHaveText(words.keep);
      await expect(row.getByTestId("meeting-audio-delete")).toHaveText(words.deleteNow);
      await expectInWindow(window, window.getByTestId("meeting-view-menu"));
      await shot(window, `meeting-audio-until-1440-${language}`);
      // Opened again at the new width, where the window now puts it.
      await window.keyboard.press("Escape");
      await setWindowSize(app, window, 900, 720);
      row = await audioRow(window);
      await expectInWindow(window, window.getByTestId("meeting-view-menu"));
      await shot(window, `meeting-audio-until-900-${language}`);

      // Keep audio: kept until deleted, one Undo; ⌘K reaches it too.
      await pointAndClick(window, row.getByTestId("meeting-audio-keep-for-good"));
      row = await audioRow(window);
      await expect(row.locator("p")).toHaveText(words.kept);
      await expect(row.getByTestId("meeting-audio-keep-for-good")).toHaveCount(0);
      await expect(row.getByTestId("meeting-audio-delete")).toHaveText(words.deleteNow);
      await expect(window.getByTestId("undo-line")).toContainText(words.keptLine);
      await expectInWindow(window, window.getByTestId("meeting-view-menu"));
      await shot(window, `meeting-audio-kept-900-${language}`);
      await window.getByTestId("undo-action").click();
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.audio.keptUntilDeleted)
        .toBe(false);
      await window.keyboard.press("Escape");
      await runCommand(window, "meeting.keepAudio", words.keep);
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.audio.keptUntilDeleted)
        .toBe(true);
      await setWindowSize(app, window, 1440, 900);
      row = await audioRow(window);
      await expect(row.locator("p")).toHaveText(words.kept);
      await shot(window, `meeting-audio-kept-1440-${language}`);
      await window.keyboard.press("Escape");

      // Save recording… from the Note's menu: one WAV where the save dialog says.
      const folder = await mkdtemp(join(tmpdir(), "incarnamind-recording-"));
      const path = join(folder, "Call.wav");
      await interceptSaveDialog(app, path);
      const pageMenu = await openPageMenu(window);
      await expect(pageMenu.getByTestId("meeting.saveRecording")).toHaveText(words.save);
      await pointAndClick(window, pageMenu.getByTestId("meeting.saveRecording"));
      await expect(window.getByTestId("copied-line")).toContainText(words.saved);
      expect(existsSync(path)).toBe(true);
      const wav = readFileSync(path);
      expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
      expect(wav.length).toBeGreaterThan(44 + 16_000 * 2);

      // Delete now asks first, then the line says when, with no action.
      row = await audioRow(window);
      await pointAndClick(window, row.getByTestId("meeting-audio-delete"));
      const confirm = window.getByTestId("meeting-audio-confirm");
      await expect(confirm.getByTestId("meeting-audio-delete-confirm")).toHaveText(
        words.deleteAudio,
      );
      await pointAndClick(window, confirm.getByTestId("meeting-audio-delete-confirm"));
      row = await audioRow(window);
      await expect(row.locator("p")).toHaveText(words.deleted);
      await expect(row.getByRole("menuitem")).toHaveCount(0);
      await shot(window, `meeting-audio-deleted-1440-${language}`);
      await window.keyboard.press("Escape");
      await setWindowSize(app, window, 900, 720);
      row = await audioRow(window);
      await expectInWindow(window, window.getByTestId("meeting-view-menu"));
      await shot(window, `meeting-audio-deleted-900-${language}`);
      await window.keyboard.press("Escape");
      const after = await openPageMenu(window);
      const save = after.getByTestId("meeting.saveRecording");
      await expect(save).toHaveAttribute("aria-disabled", "true");
      await expect(save).toHaveAttribute("title", words.deletedReason);
      await window.keyboard.press("Escape");
      await app.close();
    });
  });
}
