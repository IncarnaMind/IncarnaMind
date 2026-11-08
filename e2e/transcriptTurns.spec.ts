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
  recordMeeting,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  startRecording,
  turnOf,
  useLocalChatModel,
} from "./app";
import { encode, film } from "./feel";

/**
 * A Transcript reads like a script: one Speaker's lines one after another are one turn, with one
 * name and one time, in paragraphs broken at sentence ends. The app starts muted. Set
 * INCARNAMIND_SCREENSHOTS to keep stills and a film.
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

/**
 * What the User says, a line each two seconds, as an engine that cuts long speech gives it: some
 * lines end inside a sentence, one inside a Chinese word.
 */
const WORDS = {
  en: {
    lines: [
      "We looked at the launch plan again this morning.",
      "The budget holds at one point two million",
      "for the year, and the review moves to Friday.",
      "Partner preview stays on the twenty-eighth of October.",
      "Press waits for the new date",
      "before anything goes out.",
      "Mats checks the briefing date with the agency this week.",
      "Then we sign.",
    ],
    joined: "one point two million for the year",
    speaker: "Speaker ?",
    name: "Dana Whitfield",
    set: "Dana Whitfield speaks this part",
    whoRest: "Who speaks the rest?",
    added: "Added to the note",
  },
  "zh-CN": {
    lines: [
      "我们今天上午又看了一遍发布计划。",
      "全年的预算维持在一百二十万，评审改到",
      "周五。",
      "合作伙伴预览仍在十月二十八日。",
      "这个级",
      "别的支出需要财务再确认一下。",
      "马茨本周和代理商确认简报日期。",
      "然后我们签约。",
    ],
    joined: "这个级别的支出",
    speaker: "发言人 ?",
    name: "王丽",
    set: "已改为 王丽 说的",
    whoRest: "后半句是谁说的？",
    added: "已加入笔记",
  },
} as const;

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/** Each paragraph of a turn, as its words read. */
const paragraphsOf = (turn: Locator) => turn.locator(".transcript-text").allInnerTexts();

/** Fully inside the box of `outer`, side to side. */
async function expectWithin(inner: Locator, outer: Locator): Promise<void> {
  const box = await inner.boundingBox();
  const frame = await outer.boundingBox();
  if (!box || !frame) throw new Error("Not shown.");
  expect(box.x).toBeGreaterThanOrEqual(frame.x);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
}

for (const language of ["en", "zh-CN"] as const) {
  test.describe(`A Transcript reads like a script (${language})`, () => {
    let dataDir: string;
    test.beforeEach(async () => {
      dataDir = await createDataFolder();
    });
    test.afterEach(async () => {
      await removeDataFolder(dataDir);
    });

    // protects=one Speaker's lines are one turn with one name and one time, live and saved: it grows in place while recording, and reads in paragraphs broken only at a sentence's end; lines an engine cut inside a sentence or a Chinese word read whole, without a space between Chinese characters; each line keeps its own time, the keys move line by line across paragraphs, a word plays from where it was said, Add to note sits beside the line aimed at and adds it, the turn's Speaker menu names every line of it with one Undo, and a split's rest by someone else is a turn of its own with the first Speaker's next lines a new turn after it; at 900 and 1,440 px in English and Chinese; fails_when=a turn is cut by a timer or re-drawn as lines arrive, a paragraph breaks inside a sentence, "这个级|别" reads with a space or a cut, a line loses its time, the keys skip a paragraph, Add to note adds another line, or the interjection joins the turn; no_claim=where a cloud route cuts its lines, which the core tests cover, and the sound itself.
    test("one Speaker's lines are one turn in paragraphs, live and saved, with keys, play, Add to note, the Speaker menu and a split", async () => {
      test.setTimeout(240_000);
      const words = WORDS[language];
      const { app, window } = await launchApp(dataDir, {
        fakeChat: true,
        switches: ["--mute-audio"],
        transcriber: { lines: words.lines },
      });
      await setWindowSize(app, window, 1440, 900);
      await recordOnClose(app, window, `transcript-turns-${language}`);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);

      // In a room, one microphone: whoever speaks is "Speaker ?" until the User says who.
      const start = await recordMeeting(window);
      await start.getByTestId("meeting-start-audio").selectOption("me");
      const bar = await startRecording(window, start, { notice: true });
      await pointAndClick(window, bar.getByTestId("meeting-views").locator("label").nth(1));
      const transcript = window.getByTestId("meeting-note-transcript");
      const turns = transcript.getByTestId("transcript-turn");
      const lines = transcript.getByTestId("transcript-line");
      await expect(lines.nth(2)).toBeVisible({ timeout: 30_000 });

      // Live: one turn, drawn once, that takes each new line in place.
      await expect(turns).toHaveCount(1);
      await turns.first().evaluate((turn) => {
        turn.setAttribute("data-seen", "");
      });
      await expect
        .poll(async () => (await paragraphsOf(turns.first())).length, { timeout: 90_000 })
        .toBeGreaterThanOrEqual(2);
      await expect(turns).toHaveCount(1);
      await expect(turns.first()).toHaveAttribute("data-seen", "");
      await expect(turns.first().getByTestId("transcript-speaker")).toHaveText(words.speaker);
      await shot(window, `turns-live-${language}-1440`);

      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      await expect
        .poll(async () => (await meetingsOf(window))[0]?.fill?.state, { timeout: 60_000 })
        .toBe("filled");
      await closeFirstFillPopover(window);
      // The page stays on the Transcript the User was reading.
      await expect(lines.first()).toBeVisible();

      // Saved: still one turn, in paragraphs that end at a sentence's end, the cut lines whole.
      const turn = turns.first();
      await expect(turns).toHaveCount(1);
      const paragraphs = await paragraphsOf(turn);
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);
      for (const paragraph of paragraphs) expect(paragraph.trim()).toMatch(/[.。]$/u);
      expect(paragraphs.join(" ")).toContain(words.joined);
      const starts = await lines.evaluateAll((all) =>
        all.map((each) => Number(each.getAttribute("data-start"))),
      );
      expect(starts.length).toBeGreaterThan(paragraphs.length);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(new Set(starts).size).toBe(starts.length);
      await shot(window, `turns-saved-${language}-1440`);

      // The keys go line by line, from the first paragraph into the next.
      const firstParagraph = turn
        .locator(".transcript-text")
        .first()
        .getByTestId("transcript-line");
      const inFirst = await firstParagraph.count();
      await lines.first().focus();
      for (let line = 1; line <= inFirst; line++) {
        await window.keyboard.press("ArrowDown");
        await expect(lines.nth(line)).toBeFocused();
      }
      await expect(
        turn.locator(".transcript-text").nth(1).getByTestId("transcript-line").first(),
      ).toBeFocused();

      // Add to note sits beside the line aimed at, and adds that line.
      const aimed = lines.nth(3);
      await aimed.hover();
      const add = turn.getByTestId("transcript-add");
      await expect(add).toHaveAttribute("aria-label", new RegExp(words.lines[3] as string));
      const [lineBox, addBox] = await Promise.all([aimed.boundingBox(), add.boundingBox()]);
      if (!lineBox || !addBox) throw new Error("Not shown.");
      expect(Math.abs(addBox.y - lineBox.y)).toBeLessThan(lineBox.height);
      await pointAndClick(window, add);
      await expect(window.getByTestId("transcript-added")).toHaveText(words.added);

      // The turn's Speaker names every line of it, and one ⌘Z takes it back.
      const speaker = turn.getByTestId("transcript-speaker");
      await pointAndClick(window, speaker);
      const menu = window.locator('[data-testid="speaker-menu"]:popover-open');
      await expect(menu).toBeVisible();
      await shot(window, `turns-speaker-menu-${language}-1440`);
      await pointAndClick(window, menu.getByTestId("speaker-new"));
      await window.keyboard.insertText(words.name);
      await window.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(turns).toHaveCount(1);
      await expect(speaker).toHaveText(words.name);
      await expect(window.getByTestId("undo-line")).toContainText(words.set);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(speaker).toHaveText(words.speaker);

      // A word plays from where it was said; Enter there splits the line, and the rest, by
      // someone else, is a turn of its own, the User's next lines a turn after it.
      const split = lines.nth(4);
      const at = Number(await split.getAttribute("data-start"));
      await pointAndClick(window, split.locator("[data-word]").nth(1));
      const player = transcript.getByTestId("transcript-player");
      await expect(player).toBeVisible();
      await window.keyboard.press("Escape");
      await expect(player).toHaveCount(0);
      await window.keyboard.press("Enter");
      await expect(menu).toBeVisible();
      await expect(menu.getByText(words.whoRest)).toBeVisible();
      await pointAndClick(window, menu.getByTestId("speaker-new"));
      await window.keyboard.insertText(words.name);
      await window.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await expect(turns).toHaveCount(3);
      await expect(turns.getByTestId("transcript-speaker")).toHaveText([
        words.speaker,
        words.name,
        words.speaker,
      ]);
      const rest = lines.nth(5);
      await expect(turnOf(rest).getByTestId("transcript-speaker")).toHaveText(words.name);
      expect(Number(await rest.getAttribute("data-start"))).toBeGreaterThan(at);
      await shot(window, `turns-interjection-${language}-1440`);

      // At 900 px the turns hold: time, name and words inside the Transcript.
      await setWindowSize(app, window, 900, 700);
      for (const each of await turns.all()) await expectWithin(each, transcript);
      await shot(window, `turns-interjection-${language}-900`);
      await window.keyboard.press("ControlOrMeta+z");
      await expect(turns).toHaveCount(1);
      await shot(window, `turns-saved-${language}-900`);
      await app.close();
    });
  });
}
