import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, Meeting } from "../src/core/api";
import { FAKE_LINES, FAKE_THEIR_LINES } from "../src/core/transcription/fake";
import { FAKE_CLOUD_LINES } from "../src/core/transcription/fakeCloud";
import {
  acceptPlainTextKeys,
  closeFirstFillPopover,
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
    mine: "My notes",
    transcript: "Transcript",
    views: "Meeting views",
    switchTip: /^Switch views \(outside a table: \S+ \S+\)$/,
    beside: "Open in a split on the right",
    besideTip: "Open the Transcript in a split on the right",
    soon: "The transcript appears with its first line",
    showNotes: "Show notes",
    showTranscript: "Show the Transcript",
    speakers: ["Me", "Them"],
    filled: "Note filled in from the call",
    filling: "Filling in the note…",
    undo: "Undo",
    undone: "Fill-in undone",
    again: "Fill in again",
    recorded: /^Recorded \d+:\d{2}$/,
    audio: /^Audio kept until .*\d:\d{2}/,
    deleteNow: "Delete now",
    confirm: "Delete this meeting’s audio for good? The note stays.",
    keep: "Keep it",
    details: "Recording details",
    heading: "Action items",
    lines: ["Launch date", "UK fee"],
    overview: "The call reviewed priorities and follow-through",
  },
  "zh-CN": {
    notes: "笔记",
    mine: "我的笔记",
    transcript: "转写稿",
    views: "会议视图",
    switchTip: /^切换视图（表格外：\S+ \S+）$/,
    beside: "在右侧一栏中打开",
    besideTip: "在右侧一栏中打开转写稿",
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
    audio: /^音频保留到.*\d:\d{2}/,
    deleteNow: "立即删除",
    confirm: "永久删除这次会议的音频？笔记会保留。",
    keep: "保留",
    details: "录制详情",
    heading: "待办",
    lines: ["上线日期", "英国费用"],
    // The fake transcription speaks English in either language, and the fill follows it.
    overview: "The call reviewed priorities and follow-through",
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

/** Where the core says the fill of the Note's meeting is. */
const fillStateOf = async (window: Page, mindId: string) =>
  (await meetingsOf(window)).find((each) => each.mindId === mindId)?.fill?.state;

/** The Note as its editor holds it, as JSON. */
const noteJson = (editor: Locator) =>
  editor.evaluate((element) =>
    JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
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
    await acceptPlainTextKeys(window);
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
      .getByTestId("transcript-turn")
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

  // protects=with the cursor in a table ⌥⌘← and ⌥⌘→ are the table's (a column is added, the view stays), and ⌘K still switches the views from inside one (#2682); fails_when=the keys switch the page instead of adding a column, the view moves, or Show the Transcript and Show notes do nothing with the cursor in a table; no_claim=the hint's wording, which the first test reads.
  test(`in a table, ⌥⌘← and ⌥⌘→ add a column and the view stays; ⌘K still switches (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 660);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        device: { meetingNoticeAccepted: true },
      }),
    );

    const bar = await recordMeetingNow(window);
    const { panel } = await notePanel(window);
    const editor = panel.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await focusSettled(window, editor);
    await window.keyboard.insertText(words.lines[0]);
    await editor.evaluate((dom) => {
      const { editor: held } = dom as unknown as { editor: Editor };
      held.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    });
    const columns = () => editor.locator("table tr").first().locator("td, th").count();
    await expect.poll(columns).toBe(2);
    const switcher = bar.getByTestId("meeting-views");
    await expect(switcher).toHaveAttribute("title", words.switchTip);

    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect.poll(columns).toBe(3);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect.poll(columns).toBe(4);
    await expect(bar.getByTestId("meeting-view-notes")).toBeChecked();
    await expect(editor).toBeVisible();

    await runCommand(window, "meeting.showTranscript", words.showTranscript);
    await expect(panel.getByTestId("meeting-note-transcript")).toBeVisible();
    await runCommand(window, "meeting.showNotes", words.showNotes);
    await expect(editor).toBeVisible();

    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    await app.close();
  });

  // protects=on this computer, a streaming model's words being said show in the Transcript view before any line is finished, both sides' (#138, #2662); fails_when=the live view waits for a finished line, or one side's words are missing; no_claim=the real streaming model, which the packaged spec reads.
  test(`on this computer, the Transcript shows a streaming model's words being said, before any line (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, {
      transcriber: { live: true, maxSpeechMs: 15_000 },
    });
    await setWindowSize(app, window, 900, 660);
    await dismissChatSetup(window);
    await setLanguage(window, language);
    await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.updateSettings({
        device: { meetingNoticeAccepted: true },
      }),
    );

    const bar = await recordMeetingNow(window);
    const { panel } = await notePanel(window);
    await pointAndClick(
      window,
      bar.getByTestId("meeting-views").locator("label").filter({ hasText: words.transcript }),
    );
    const transcript = panel.getByTestId("meeting-note-transcript");
    const partials = transcript.getByTestId("transcript-partial");
    await expect(partials).toHaveCount(2);
    await expect(transcript.getByTestId("transcript-line")).toHaveCount(0);
    expect((await partials.getByTestId("transcript-speaker").allInnerTexts()).sort()).toEqual(
      [...words.speakers].sort(),
    );
    for (const said of await partials.locator(".transcript-text").allInnerTexts()) {
      expect(
        [...FAKE_LINES, ...FAKE_THEIR_LINES].some((line) => line.startsWith(said.trim())),
      ).toBe(true);
    }
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    await app.close();
  });

  // protects=with the Note open twice, words the User types into the fill in one copy stay when ⌘Z runs in the other, and that copy's line no longer offers Undo of a fill changed elsewhere (#2527); fails_when=⌘Z in the other copy takes the fill's words, the typed ones with them, or its line still says Undo; no_claim=two windows, which the unit tests cover.
  test(`with the Note open twice, words typed into the fill in one copy stay when the other undoes (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ device: { meetingNoticeAccepted: true } });
    });
    const bar = await recordMeetingNow(window);
    const { panel, mindId } = await notePanel(window);
    const editor = panel.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await focusSettled(window, editor);
    await window.keyboard.insertText(words.lines[0]);
    await expect
      .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    const line = panel.getByTestId("meeting-fill-line");
    await expect(line).toHaveText(`${words.filled} · ${words.undo}`, {
      timeout: 30_000,
      useInnerText: false,
    });
    await closeFirstFillPopover(window);

    // The same Note again, in a split on the right.
    await pointAndClick(window, editor.locator("p").first());
    await window.keyboard.press("ControlOrMeta+Alt+Backslash");
    const tabs = window.locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`);
    await expect(tabs).toHaveCount(2);
    const panelIds = await tabs.evaluateAll((each) =>
      each.map((tab) => tab.getAttribute("aria-controls")),
    );
    const firstId = await panel.getAttribute("id");
    const otherId = panelIds.find((id) => id !== null && id !== firstId);
    if (!otherId) throw new Error("Expected the Note's second copy.");
    const other = window.locator(`[id="${otherId}"]`).getByTestId("mind-editor");
    await expect(other).toBeVisible();
    await expect(line).toHaveText(`${words.filled} · ${words.undo}`, { useInnerText: false });

    // Words typed into a Block the fill wrote, in the second copy.
    const added = (await meetingsOf(window))[0]?.fill?.addedBlockIds ?? [];
    expect(added.length).toBeGreaterThan(0);
    const blockText = (copy: Locator) =>
      copy.evaluate((element, id) => {
        let text: string | null = null;
        (element as unknown as { editor: Editor }).editor.state.doc.forEach((node) => {
          if (node.attrs.id === id) text = node.textContent;
        });
        return text;
      }, added[0]);
    const before = await blockText(other);
    expect(before).not.toBeNull();
    await other.evaluate((element, id) => {
      const held = (element as unknown as { editor: Editor }).editor;
      let at = -1;
      held.state.doc.forEach((node, offset) => {
        if (at >= 0 || node.attrs.id !== id) return;
        if (node.isTextblock) at = offset + node.nodeSize - 1;
        node.descendants((child, pos) => {
          if (at < 0 && child.isTextblock) at = offset + 1 + pos + child.nodeSize - 1;
        });
      });
      held.commands.focus(at);
    }, added[0]);
    await expect(other).toBeFocused();
    const typedInFill = language === "en" ? " Dana agreed" : "小王同意了";
    await window.keyboard.insertText(typedInFill);
    await expect.poll(() => blockText(editor)).toBe(`${before}${typedInFill}`);
    await expect(line).toHaveCount(0);

    // ⌘Z in the first copy leaves them, and the fill's own words, in both.
    await pointAndClick(window, editor.locator("p").first());
    await window.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => blockText(editor)).toBe(`${before}${typedInFill}`);
    await expect.poll(() => blockText(other)).toBe(`${before}${typedInFill}`);
    await expect(line).toHaveCount(0);
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
      await motionSettled(window);
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
        words.mine,
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
      await expect(chip).toHaveText(words.mine);
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
        await expect.poll(() => fillStateOf(window, mindId)).toBe("undone");
        await window.keyboard.press("ControlOrMeta+Shift+z");
        await expect
          .poll(() =>
            editor.evaluate((element) =>
              JSON.stringify((element as unknown as { editor: Editor }).editor.getJSON()),
            ),
          )
          .toBe(filledJson);
        await expect(line).toHaveText(`${words.filled} · ${words.undo}`, { useInnerText: false });
        await expect.poll(() => fillStateOf(window, mindId)).toBe("filled");
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
        await expect.poll(() => noteJson(editor)).toBe(filledJson);

        // Taken back, the core knows: Fill in again fills anew, and ⇧⌘Z can't bring the first back.
        await window.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => noteJson(editor)).toBe(typed);
        await expect.poll(() => fillStateOf(window, mindId)).toBe("undone");
        await pointAndClick(window, line.getByTestId("meeting-fill-again"));
        await pointAndClick(window, editor.locator("h2").first());
        await window.keyboard.press("ControlOrMeta+Shift+z");
        await expect(line).toHaveText(`${words.filled} · ${words.undo}`, {
          timeout: 30_000,
          useInnerText: false,
        });
        await expect.poll(() => fillStateOf(window, mindId)).toBe("filled");
        await window.keyboard.press("ControlOrMeta+Shift+z");
        await expect(editor.locator("p").filter({ hasText: words.overview })).toHaveCount(1);
      }
    }
    await app.close();
  });
}
