import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, Meeting } from "../src/core/api";
import { FAKE_CLOUD_LINES } from "../src/core/transcription/fakeCloud";
import {
  createDataFolder,
  dismissChatSetup,
  expectBarOneRow,
  focusSettled,
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
 * The meeting's one page (#138, #2527): Notes | Transcript in the recording bar, switched in place,
 * with the words being said from the first one; and after Stop, a bare page whose one chip holds
 * the views, the audio and the recording details. Set INCARNAMIND_SCREENSHOTS to keep stills.
 */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

/** With INCARNAMIND_SCREENSHOTS, a film of the flow, kept as the app closes. */
async function recordOnClose(app: ElectronApplication, window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  const stop = await film(window, resolve(SCREENSHOTS, `${name}-frames`));
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => {
    closing ??= (async () => {
      try {
        await stop();
        await encode(resolve(SCREENSHOTS, `${name}-frames`), resolve(SCREENSHOTS, `${name}.mp4`));
      } finally {
        await close();
      }
    })();
    return closing;
  };
}

const WORDS = {
  en: {
    notes: "Notes",
    transcript: "Transcript",
    views: "Meeting views",
    switchTip: /^Switch views \(\S+ \S+\)$/,
    beside: "Open beside",
    besideTip: "Open the Transcript beside",
    soon: "The transcript appears with its first line",
    showNotes: "Show Notes",
    showTranscript: "Show the Transcript",
    speakers: ["Me", "Them"],
    filled: "Note filled in from the call",
    filling: "Filling in the note…",
    undo: "Undo",
    undone: "Fill-in undone",
    again: "Fill in again",
    recorded: /^Recorded \d+:\d{2}$/,
    audio: /^Audio kept until .+\d{2}:\d{2}/,
    deleteNow: "Delete now",
    confirm: "Delete this meeting’s audio for good? The note stays.",
    keep: "Keep it",
    details: "Recording details",
    heading: "Action items",
    lines: ["Launch date", "UK fee"],
  },
  "zh-CN": {
    notes: "笔记",
    transcript: "转写稿",
    views: "会议视图",
    switchTip: /^切换视图（\S+ \S+）$/,
    beside: "在旁边打开",
    besideTip: "在旁边打开转写稿",
    soon: "第一句话转写后即可显示转写稿",
    showNotes: "显示笔记",
    showTranscript: "显示转写稿",
    speakers: ["我", "对方"],
    filled: "已补全笔记",
    filling: "正在补全笔记…",
    undo: "撤销",
    undone: "已撤销补全",
    again: "重新补全",
    recorded: /^已录制 \d+:\d{2}$/,
    audio: /^音频保留到 .+\d{2}:\d{2}/,
    deleteNow: "立即删除",
    confirm: "永久删除这次会议的音频？笔记会保留。",
    keep: "保留",
    details: "录制详情",
    heading: "待办",
    lines: ["上线日期", "英国费用"],
  },
} as const;

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const meetingsOf = (window: Page): Promise<Meeting[]> =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

/** The Note's tab and its panel, which every view of the meeting is drawn in. */
async function notePanel(window: Page): Promise<{ mindId: string; panel: Locator; tabs: number }> {
  const tab = window.locator('[data-testid="mind-tab"][aria-selected="true"]');
  await expect(tab).toHaveCount(1);
  const panelId = await tab.getAttribute("aria-controls");
  const mindId = await tab.getAttribute("data-mind-id");
  if (!panelId || !mindId) throw new Error("Expected the meeting Note's panel.");
  return {
    mindId,
    panel: window.locator(`[id="${panelId}"]`),
    tabs: await window.locator("[data-tab-id]").count(),
  };
}

/** Where the notes are: the editor's selection, and how far its page is scrolled. */
const notesPlace = (editor: Locator) =>
  editor.evaluate((element) => {
    const held = (element as unknown as { editor: Editor }).editor;
    const scroller = element.closest('[data-testid="mind-scroller"]');
    return {
      from: held.state.selection.from,
      to: held.state.selection.to,
      top: Math.round(scroller?.scrollTop ?? -1),
    };
  });

for (const language of ["en", "zh-CN"] as const) {
  // protects=during the call the bar's Notes | Transcript switches the page in place by mouse, ⌥⌘←/⌥⌘→ and ⌘K; the Transcript shows both sides' words being said before any line is finished, from a cloud service sending unfinished words; Notes comes back to its cursor and scroll; Open beside opens the Transcript in the next group (#138); fails_when=a new tab opens, the live view waits for a finished line, one side's words are missing, the notes lose their place, or the layout breaks at 900 or 1,440 px; no_claim=the real service's timing.
  test(`during the call, Notes | Transcript switch the page in place, the words being said show from the first, and Notes keeps its place (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, {
      transcriber: { cloud: { lineMs: 8000 } },
    });
    await setWindowSize(app, window, 1440, 660);
    await recordOnClose(app, window, `meeting-page-live-${language}`);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setTranscriptionKey({ route: "soniox", apiKey: "soniox-test-key" });
      await bridge.updateSettings({
        device: { transcriptionRoute: "soniox", meetingNoticeAccepted: true },
      });
    });

    const bar = await recordMeetingNow(window);
    const { panel, tabs, mindId } = await notePanel(window);
    const editor = panel.getByTestId("mind-editor");
    const switcher = bar.getByTestId("meeting-views");
    await expect(switcher).toHaveAttribute("aria-label", words.views);
    await expect(switcher).toHaveAttribute("title", words.switchTip);
    await expect(switcher.locator("label")).toHaveText([words.notes, words.transcript]);
    await expect(switcher.getByTestId("meeting-view-notes")).toBeChecked();
    // The Transcript carries the level bars.
    await expect(
      switcher.locator("label").filter({ hasText: words.transcript }).getByTestId("level-bars"),
    ).toBeVisible();
    await expectBarOneRow(bar);

    // The Transcript, at once and in place: the words being said, both sides', before any line is finished.
    await pointAndClick(window, switcher.locator("label").filter({ hasText: words.transcript }));
    const transcript = panel.getByTestId("meeting-note-transcript");
    await expect(transcript).toBeVisible();
    await expect(editor).toBeHidden();
    await expect(transcript).toBeFocused();
    await expect(window.locator("[data-tab-id]")).toHaveCount(tabs);
    await expect(panel.getByTestId("meeting-bar")).toHaveCount(1);
    await expect(transcript.getByTestId("meeting-bar")).toBeVisible();
    // What the words arriving every quarter second cost the page: no shift, no long task.
    await window.evaluate(() => {
      const feel = { shift: 0, longest: 0 };
      (globalThis as unknown as { liveFeel: typeof feel }).liveFeel = feel;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        })[]) {
          if (!entry.hadRecentInput) feel.shift += entry.value;
        }
      }).observe({ type: "layout-shift" });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          feel.longest = Math.max(feel.longest, entry.duration);
      }).observe({ type: "longtask" });
    });
    const partials = transcript.getByTestId("transcript-partial");
    await expect(partials).toHaveCount(2, { timeout: 15_000 });
    const firstWords = await partials.first().locator(".transcript-text").innerText();
    await expect
      .poll(() => partials.first().locator(".transcript-text").innerText())
      .not.toBe(firstWords);
    const feel = await window.evaluate(
      () => (globalThis as unknown as { liveFeel: { shift: number; longest: number } }).liveFeel,
    );
    test.info().annotations.push({ type: "live words", description: JSON.stringify(feel) });
    expect(feel.shift).toBeLessThanOrEqual(0.001);
    expect(feel.longest).toBeLessThan(1000);
    await expect(transcript.getByTestId("transcript-line")).toHaveCount(0);
    expect((await meetingsOf(window))[0]?.transcript?.lines).toBe(0);
    expect((await partials.getByTestId("transcript-speaker").allInnerTexts()).sort()).toEqual(
      [...words.speakers].sort(),
    );
    for (const said of await partials.locator(".transcript-text").allInnerTexts()) {
      expect(FAKE_CLOUD_LINES.some((line) => line.startsWith(said.trim()))).toBe(true);
    }
    const beside = transcript.getByTestId("meeting-transcript-beside");
    await expect(beside).toHaveText(words.beside);
    await expect(beside).toBeDisabled();
    await expect(beside).toHaveAttribute("title", words.soon);
    await shot(window, `meeting-page-live-transcript-${language}-1440`);

    // ⌥⌘← and ⌥⌘→, then ⌘K, switch it too.
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(transcript).toBeHidden();
    await expect(bar.getByTestId("meeting-view-notes")).toBeChecked();
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(panel.getByTestId("meeting-note-transcript")).toBeFocused();
    await runCommand(window, "meeting.showNotes", words.showNotes);
    await expect(editor).toBeFocused();
    await runCommand(window, "meeting.showTranscript", words.showTranscript);
    await expect(panel.getByTestId("meeting-note-transcript")).toBeVisible();
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(editor).toBeFocused();

    // Notes come back to the cursor and the scroll the User left.
    await focusSettled(window, editor);
    for (let line = 1; line <= 40; line++) {
      await window.keyboard.type(`${words.lines[line % 2]} ${line}`);
      await window.keyboard.press("Enter");
    }
    const tenth = editor.locator(":scope > p").nth(9);
    await pointAndClick(window, tenth);
    await window.keyboard.press("End");
    const scroller = panel.getByTestId("mind-scroller");
    let before = await notesPlace(editor);
    const settled = async () => {
      const now = await notesPlace(editor);
      const still = now.top === before.top;
      before = now;
      return still;
    };
    await expect.poll(settled).toBe(true);
    await scroller.evaluate((element) => {
      element.scrollTop = 240;
    });
    await expect.poll(settled).toBe(true);
    expect(before.top).toBeGreaterThan(0);
    await pointAndClick(window, switcher.locator("label").filter({ hasText: words.transcript }));
    await expect(editor).toBeHidden();
    await pointAndClick(window, switcher.locator("label").filter({ hasText: words.notes }));
    await expect(editor).toBeFocused();
    expect(await notesPlace(editor)).toEqual(before);
    await window.keyboard.type("!");
    await expect(tenth).toHaveText(/10!$/);

    // Lines arrive; Open beside opens the Transcript in the next group, the page back on the notes.
    await pointAndClick(window, switcher.locator("label").filter({ hasText: words.transcript }));
    await expect(transcript.getByTestId("transcript-line").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(beside).toBeEnabled();
    await expect(beside).toHaveAttribute("title", words.besideTip);

    // At 900 px: the bar on one row, the Transcript's words keep their width.
    await setWindowSize(app, window, 900, 660);
    await expectBarOneRow(bar);
    const widths = await transcript
      .getByTestId("transcript-line")
      .first()
      .evaluate((line) => ({
        line: line.getBoundingClientRect().width,
        text: line.querySelector(".transcript-text")?.getBoundingClientRect().width ?? 0,
      }));
    expect(widths.text).toBeGreaterThan(widths.line / 2);
    await shot(window, `meeting-page-live-transcript-${language}-900`);
    await setWindowSize(app, window, 1440, 660);

    await pointAndClick(window, beside);
    const besideTab = window.getByTestId("document-tab");
    await expect(besideTab).toHaveCount(1);
    await expect(editor).toBeVisible();
    await expect(bar.getByTestId("meeting-view-notes")).toBeChecked();
    const noteGroup = await window
      .locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`)
      .getAttribute("data-group-id");
    const besideGroup = await besideTab.getAttribute("data-group-id");
    expect(besideGroup).not.toBeNull();
    expect(besideGroup).not.toBe(noteGroup);
    await shot(window, `meeting-page-beside-${language}-1440`);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    await expect(panel.getByTestId("meeting-bar")).toHaveCount(0);
    await app.close();
  });

  // protects=after Stop the page stays bare: the bar goes, the fill shows only at the place it writes, with its Undo line that goes on the next keystroke; ⌘Z takes back exactly the fill and ⇧⌘Z puts it back; the one chip holds the views, the audio's line and the recording details, and opens by itself only after the first fill (#2527, #138); fails_when=a line stays above the notes, ⌘Z takes back the User's own heading, the popover opens twice or never, or a string is wrong; no_claim=a real model's fill.
  test(`after Stop the page stays bare, the chip holds the rest, and ⌘Z takes back the fill (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, language === "en" ? 1440 : 900, 660);
    await recordOnClose(app, window, `meeting-page-after-${language}`);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ device: { meetingNoticeAccepted: true } });
    });

    for (const round of [1, 2]) {
      const bar = await recordMeetingNow(window);
      const { panel, mindId } = await notePanel(window);
      const editor = panel.getByTestId("mind-editor");
      await pointAndClick(window, editor);
      await focusSettled(window, editor);
      for (const text of words.lines) {
        await window.keyboard.insertText(text);
        await window.keyboard.press("Enter");
      }
      await window.keyboard.type("## ");
      await window.keyboard.insertText(words.heading);
      await expect(editor.locator("h2")).toHaveText(words.heading);
      const typed = await editor.evaluate((element) =>
        JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
      );
      await expect
        .poll(
          async () =>
            (await meetingsOf(window)).find((each) => each.mindId === mindId)?.transcript?.lines ??
            0,
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(2);

      // What shows while it fills, wherever it shows, is seen.
      await window.evaluate(() => {
        const seen: { text: string; inNotes: boolean; writing: boolean }[] = [];
        (globalThis as unknown as { fillSeen: typeof seen }).fillSeen = seen;
        new MutationObserver(() => {
          for (const line of document.querySelectorAll('[data-testid="meeting-fill-line"]')) {
            seen.push({
              text: line.textContent ?? "",
              inNotes: line.closest('[data-testid="mind-editor"]') !== null,
              writing: line.querySelector(".answer-writing") !== null,
            });
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await pointAndClick(window, bar.getByTestId("meeting-stop"));
      await expect(bar).toBeHidden();
      const line = panel.getByTestId("meeting-fill-line");
      await expect(line).toHaveText(`${words.filled} · ${words.undo}`, {
        timeout: 30_000,
        useInnerText: false,
      });
      const seen = await window.evaluate(
        () =>
          (
            globalThis as unknown as {
              fillSeen: { text: string; inNotes: boolean; writing: boolean }[];
            }
          ).fillSeen,
      );
      expect(seen.every((each) => each.inNotes)).toBe(true);
      expect(seen.filter((each) => each.text === words.filling).every((each) => each.writing)).toBe(
        true,
      );
      // Nothing above the notes: no bar, no Transcript or audio line, no details.
      const page = panel.getByTestId("mind-pane");
      await expect(panel.getByTestId("meeting-bar")).toHaveCount(0);
      await expect(page.getByTestId("meeting-transcript-line")).toHaveCount(0);
      await expect(page.getByTestId("meeting-audio")).toHaveCount(0);
      await expect(page.getByTestId("meeting-details-toggle")).toHaveCount(0);
      await expect(line.locator("xpath=ancestor::*[@data-testid='mind-editor']")).toHaveCount(1);

      const chip = panel.getByTestId("meeting-view-chip");
      await expect(chip).toHaveText(words.recorded);
      const menu = panel.getByTestId("meeting-view-menu");
      if (round === 1) {
        // The first fill on this computer opens it, once, and the User keeps their place.
        await expect(menu).toBeVisible();
        await expect(menu.getByTestId("meeting-audio")).toContainText(words.audio);
        await expect(menu.getByTestId("meeting-audio-delete")).toHaveText(words.deleteNow);
        await expect(menu.locator(":focus")).toHaveCount(0);
        await shot(window, `meeting-page-chip-first-${language}`);
        await window.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      } else {
        await expect(menu).toBeHidden();
      }

      // The chip's views, its audio's Delete now (asked first) and the recording details.
      await pointAndClick(window, chip);
      await expect(menu).toBeVisible();
      await expect(menu.locator('[role="menuitemradio"]')).toHaveText([
        words.notes,
        words.transcript,
      ]);
      await expect(menu.getByTestId("meeting-details-toggle")).toHaveText(words.details);
      await pointAndClick(window, menu.getByTestId("meeting-details-toggle"));
      await expect(menu.getByTestId("meeting-details")).toBeVisible();
      await pointAndClick(window, menu.getByTestId("meeting-audio-delete"));
      const confirm = menu.getByTestId("meeting-audio-confirm");
      await expect(confirm).toContainText(words.confirm);
      await expect(confirm.getByTestId("meeting-audio-delete-confirm")).toBeFocused();
      await pointAndClick(window, confirm.getByTestId("meeting-audio-keep"));
      await expect(menu.getByTestId("meeting-audio")).toContainText(words.audio);
      await pointAndClick(window, menu.getByTestId("meeting-view-transcript"));
      await expect(menu).toBeHidden();
      await expect(chip).toHaveText(words.transcript);
      await expect(panel.getByTestId("meeting-note-transcript")).toBeVisible();
      await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
      await expect(editor).toBeFocused();
      await expect(chip).toHaveText(words.recorded);

      if (round === 1) {
        // ⌘Z in the note takes back exactly the fill, ⇧⌘Z puts it back, and so does its line's Undo.
        const filledJson = await editor.evaluate((element) =>
          JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
        );
        await window.keyboard.press("ControlOrMeta+z");
        await expect
          .poll(() =>
            editor.evaluate((element) =>
              JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
            ),
          )
          .toBe(typed);
        await expect(line).toHaveText(`${words.undone} · ${words.again}`, { useInnerText: false });
        await window.keyboard.press("ControlOrMeta+Shift+z");
        await expect
          .poll(() =>
            editor.evaluate((element) =>
              JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
            ),
          )
          .toBe(filledJson);
        await expect(line).toHaveText(`${words.filled} · ${words.undo}`, { useInnerText: false });
        await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
        await expect
          .poll(() =>
            editor.evaluate((element) =>
              JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
            ),
          )
          .toBe(typed);
        await window.keyboard.press("ControlOrMeta+Shift+z");
        await expect(line).toHaveText(`${words.filled} · ${words.undo}`, { useInnerText: false });
        await shot(window, `meeting-page-filled-${language}`);
        // The line goes on the next keystroke; ⌘Z then takes back that key, not the fill.
        await pointAndClick(window, editor.locator("h2").first());
        await window.keyboard.press("End");
        await window.keyboard.type("x");
        await expect(line).toHaveCount(0);
        await window.keyboard.press("ControlOrMeta+z");
        await expect(editor.locator("h2").first()).toHaveText(words.heading);
        await expect
          .poll(() =>
            editor.evaluate((element) =>
              JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
            ),
          )
          .toBe(filledJson);
      }
    }
    await app.close();
  });
}
