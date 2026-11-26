import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, Meeting } from "../src/core/api";
import { FAKE_LINES, FAKE_THEIR_LINES } from "../src/core/transcription/fake";
import { FAKE_CLOUD_LINES } from "../src/core/transcription/fakeCloud";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  expectSheetFootOneRow,
  firstTranscriptLine,
  focusSettled,
  launchApp,
  motionSettled,
  openMeetingDetails,
  openMeetingSheet,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  runCommand,
  setLanguage,
  setWindowSize,
  stopMeeting,
  useLocalChatModel,
} from "./app";
import { encode, film } from "./feel";
import { holdModel, modelHeld } from "./heldModel";

/**
 * The meeting's one page (#138, #2527, #3762): the meeting's control at the Note's foot raises
 * the Transcript as a sheet over the Note, with the words being said from the first one; and
 * after Stop, a bare page whose control raises the Transcript, the audio and the recording
 * details. Set INCARNAMIND_SCREENSHOTS to keep stills.
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
    transcript: "Transcript",
    show: /^Show the Transcript \(.+\)$/,
    hide: /^Hide the Transcript \(.+\)$/,
    tell: "Tell everyone you’re recording.",
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
    audio: /^Recorded \d+:\d{2} · Audio kept until .*\d:\d{2}/,
    deleteNow: "Delete audio now",
    confirm: "Delete this meeting’s audio for good? The note stays.",
    keep: "Keep it",
    details: "Recording details",
    showDetails: "Show recording details",
    heading: "Action items",
    lines: ["Launch date", "UK fee"],
    overview: "The call reviewed priorities and follow-through",
  },
  "zh-CN": {
    transcript: "转写稿",
    show: /^显示转写稿（.+）$/,
    hide: /^隐藏转写稿（.+）$/,
    tell: "告诉所有人你正在录音。",
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
    audio: /^已录制 \d+:\d{2} · 音频保留到.*\d:\d{2}/,
    deleteNow: "立即删除音频",
    confirm: "永久删除这次会议的音频？笔记会保留。",
    keep: "保留",
    details: "录制详情",
    showDetails: "显示录制详情",
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

/**
 * The control stands under the notes, on the text's edges: at its left with the Note's input to
 * its right, or centred on the text where the Note's foot holds no input.
 */
async function expectControlAtFoot(panel: Locator): Promise<void> {
  const ask = panel.locator(".meeting-foot-ask");
  const [control, measure, scroller, askBox, alone] = await Promise.all([
    panel.getByTestId("meeting-foot").boundingBox(),
    panel.getByTestId("mind-pane").locator(".mind-measure").first().boundingBox(),
    panel.getByTestId("mind-scroller").boundingBox(),
    ask.boundingBox(),
    ask.evaluate((element) => element.matches(":empty")),
  ]);
  if (!control || !measure || !scroller) throw new Error("The meeting's control isn't drawn.");
  expect(control.y).toBeGreaterThanOrEqual(scroller.y + scroller.height - 1);
  if (alone) {
    const middle = (box: { x: number; width: number }) => box.x + box.width / 2;
    expect(Math.abs(middle(control) - middle(measure))).toBeLessThanOrEqual(1);
    return;
  }
  if (!askBox) throw new Error("The Note's input isn't drawn.");
  expect(Math.abs(control.x - measure.x)).toBeLessThanOrEqual(1);
  expect(askBox.x).toBeGreaterThanOrEqual(control.x + control.width);
}

// protects=choosing the next recording while a stopped meeting's first fill finishes; no fill opens anything by itself (#3762)
// fails_when=something opens over the New menu as the fill ends, the menu closes, or a later fill raises the Transcript or a menu by itself
test("a first fill keeps the New menu open while choosing the next meeting, and no fill opens anything by itself", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await recordMeeting(window);
  await firstTranscriptLine(window);
  await holdModel(app, "holdCite", true);
  await stopMeeting(window);
  await expect.poll(() => modelHeld(app), { timeout: 30_000 }).toBe(true);
  await setLanguage(window, "zh-CN");
  const { panel } = await notePanel(window);
  await window.getByTestId("plus-menu").click();
  const record = window.getByTestId("plus-record-meeting");
  await record.hover();
  await holdModel(app, "holdCite", false);
  await expect(panel.getByTestId("meeting-fill-line")).toContainText(WORDS["zh-CN"].filled, {
    timeout: 30_000,
  });
  await expect(record).toBeVisible();
  await expect(panel.getByTestId("meeting-sheet")).toHaveCount(0);
  await record.click();
  await firstTranscriptLine(window);
  const next = await notePanel(window);
  await stopMeeting(window);
  await expect(next.panel.getByTestId("meeting-fill-line")).toContainText(WORDS["zh-CN"].filled, {
    timeout: 30_000,
  });
  await expect(window.getByRole("menu")).toHaveCount(0);
  await expect(next.panel.getByTestId("meeting-sheet")).toHaveCount(0);
  await app.close();
});

for (const language of ["en", "zh-CN"] as const) {
  // protects=during the call the control at the Note's foot raises the Transcript as a sheet over the Note by mouse, ⌥⌘←/⌥⌘→, ⌘K and folds it with Esc back to its chevron; the sheet shows both sides' words being said before any line is finished, from a cloud service sending unfinished words; the notes under it keep their cursor and scroll; Open beside is off until the first line and opens the Transcript in the next group (#138, #3762); fails_when=a new tab opens, the live view waits for a finished line, one side's words are missing, the notes lose their place, the focus is lost on folding, or the sheet's foot breaks at 900 or 1,440 px; no_claim=the real service's timing.
  test(`during the call, the control raises the Transcript sheet over the Note, the words being said show from the first, and the notes keep their place (${language})`, async () => {
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
      await bridge.updateSettings({ device: { transcriptionRoute: "soniox" } });
    });

    const control = await recordMeeting(window);
    const { panel, tabs, mindId } = await notePanel(window);
    const editor = panel.getByTestId("mind-editor");
    const raise = control.getByTestId("meeting-foot-transcript");
    await expectControlAtFoot(panel);
    await expect(raise).toHaveAttribute("aria-expanded", "false");
    await expect(raise).toHaveAccessibleName(words.show);
    await expect(control.getByTestId("meeting-foot-level").getByTestId("level-bars")).toBeVisible();

    // The Transcript, at once, over the Note: the words being said, both sides', before any line is finished.
    await pointAndClick(window, raise);
    const sheet = panel.getByTestId("meeting-sheet");
    await expect(sheet).toBeVisible();
    await expect(raise).toHaveAttribute("aria-expanded", "true");
    await expect(raise).toHaveAccessibleName(words.hide);
    // The Note and its input stay under it: the sheet lies over the notes.
    await expect(editor).toBeVisible();
    await expect(window.locator("[data-tab-id]")).toHaveCount(tabs);
    await expect(sheet.getByTestId("meeting-sheet-time")).toHaveText(/\d+:\d{2}$/);
    await expect(sheet.locator(".meeting-sheet-consent")).toHaveText(words.tell);
    await expectSheetFootOneRow(sheet);
    const transcript = sheet.getByTestId("viewer-transcript");
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
    // Before the first line there is nothing to open beside, and it says why.
    const beside = sheet.getByTestId("meeting-sheet-beside");
    await expect(beside).toBeDisabled();
    await expect(beside).toHaveAttribute("title", words.soon);
    await shot(window, `meeting-page-live-transcript-${language}-1440`);

    // ⌥⌘← and ⌥⌘→, then ⌘K, raise and fold it too; Esc folds it back to its chevron.
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(sheet).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(raise).toHaveAttribute("aria-expanded", "false");
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(sheet).toBeFocused();
    await runCommand(window, "meeting.showNotes", words.showNotes);
    await expect(sheet).toBeHidden();
    await expect(editor).toBeFocused();
    await runCommand(window, "meeting.showTranscript", words.showTranscript);
    await expect(sheet).toBeVisible();
    await expect(sheet).toBeFocused();
    await expect(window.getByRole("tooltip")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(raise).toBeFocused();
    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect(sheet).toBeVisible();
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(editor).toBeFocused();

    // The notes under the sheet keep the cursor and the scroll the User left.
    await focusSettled(window, editor);
    for (let line = 1; line <= 40; line++) {
      await window.keyboard.type(`${words.lines[line % 2]} ${line}`);
      await window.keyboard.press("Enter");
    }
    const tenth = editor.locator(":scope > p").nth(9);
    await pointAndClick(window, tenth);
    await window.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
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
    await pointAndClick(window, raise);
    await expect(sheet).toBeVisible();
    expect(await notesPlace(editor)).toEqual(before);
    await pointAndClick(window, raise);
    await expect(sheet).toBeHidden();
    expect(await notesPlace(editor)).toEqual(before);
    await pointAndClick(window, raise);
    await expect(sheet).toBeVisible();
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect(editor).toBeFocused();
    expect(await notesPlace(editor)).toEqual(before);
    await window.keyboard.type("!");
    await expect(tenth).toHaveText(/10!$/);

    // Lines arrive; Open beside opens the Transcript in the next group, the sheet folded back.
    await pointAndClick(window, raise);
    await expect(transcript.getByTestId("transcript-line").first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(beside).toBeEnabled();
    await expect(beside).toHaveAttribute("title", words.besideTip);

    // At 900 px: the sheet's foot on one row, the Transcript's words keep their width.
    await setWindowSize(app, window, 900, 660);
    await expectSheetFootOneRow(sheet);
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
    await expect(sheet).toBeHidden();
    await expect(editor).toBeVisible();
    await expect(raise).toHaveAttribute("aria-expanded", "false");
    const noteGroup = await window
      .locator(`[data-testid="mind-tab"][data-mind-id="${mindId}"]`)
      .getAttribute("data-group-id");
    const besideGroup = await besideTab.getAttribute("data-group-id");
    expect(besideGroup).not.toBeNull();
    expect(besideGroup).not.toBe(noteGroup);
    await shot(window, `meeting-page-beside-${language}-1440`);
    await stopMeeting(window);
    await expect(raise).toHaveText(words.transcript);
    await app.close();
  });

  // protects=with the cursor in a table ⌥⌘← and ⌥⌘→ are the table's (a column is added, the Transcript stays down), and ⌘K still raises and folds the Transcript from inside one (#2682); fails_when=the keys raise the sheet instead of adding a column, or Show the Transcript and Show notes do nothing with the cursor in a table; no_claim=the control's name, which the first test reads.
  test(`in a table, ⌥⌘← and ⌥⌘→ add a column and the Transcript stays down; ⌘K still raises it (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir);
    await setWindowSize(app, window, 1440, 660);
    await dismissChatSetup(window);
    await setLanguage(window, language);

    const control = await recordMeeting(window);
    const { panel } = await notePanel(window);
    const editor = panel.getByTestId("mind-editor");
    const sheet = panel.getByTestId("meeting-sheet");
    await pointAndClick(window, editor);
    await focusSettled(window, editor);
    await window.keyboard.insertText(words.lines[0]);
    await editor.evaluate((dom) => {
      const { editor: held } = dom as unknown as { editor: Editor };
      held.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    });
    const columns = () => editor.locator("table tr").first().locator("td, th").count();
    await expect.poll(columns).toBe(2);

    await window.keyboard.press("ControlOrMeta+Alt+ArrowRight");
    await expect.poll(columns).toBe(3);
    await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
    await expect.poll(columns).toBe(4);
    await expect(sheet).toHaveCount(0);
    await expect(control.getByTestId("meeting-foot-transcript")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(editor).toBeVisible();

    await runCommand(window, "meeting.showTranscript", words.showTranscript);
    await expect(sheet).toBeVisible();
    await runCommand(window, "meeting.showNotes", words.showNotes);
    await expect(sheet).toHaveCount(0);
    await expect(editor).toBeVisible();

    await stopMeeting(window);
    await app.close();
  });

  // protects=on this computer, a streaming model's words being said show in the Transcript sheet before any line is finished, both sides' (#138, #2662); fails_when=the live view waits for a finished line, or one side's words are missing; no_claim=the real streaming model, which the packaged spec reads.
  test(`on this computer, the Transcript shows a streaming model's words being said, before any line (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, {
      transcriber: { live: true, maxSpeechMs: 15_000 },
    });
    await setWindowSize(app, window, 900, 660);
    await dismissChatSetup(window);
    await setLanguage(window, language);

    await recordMeeting(window);
    const transcript = (await openMeetingSheet(window)).getByTestId("viewer-transcript");
    const partials = transcript.getByTestId("transcript-partial");
    await expect(partials).toHaveCount(2);
    await expect(transcript.getByTestId("transcript-line")).toHaveCount(0);
    expect((await partials.getByTestId("transcript-speaker").allInnerTexts()).sort()).toEqual(
      [...words.speakers].sort(),
    );
    const speakerColor = await partials
      .getByTestId("transcript-speaker")
      .first()
      .evaluate((speaker) => getComputedStyle(speaker).color);
    await expect(partials.locator(".transcript-text").first()).toHaveCSS("color", speakerColor);
    for (const said of await partials.locator(".transcript-text").allInnerTexts()) {
      expect(
        [...FAKE_LINES, ...FAKE_THEIR_LINES].some((line) => line.startsWith(said.trim())),
      ).toBe(true);
    }
    await stopMeeting(window);
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
    await recordMeeting(window);
    const { panel, mindId } = await notePanel(window);
    const editor = panel.getByTestId("mind-editor");
    await pointAndClick(window, editor);
    await focusSettled(window, editor);
    await window.keyboard.insertText(words.lines[0]);
    await expect
      .poll(async () => (await meetingsOf(window))[0]?.transcript?.lines ?? 0, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    await stopMeeting(window);
    const line = panel.getByTestId("meeting-fill-line");
    await expect(line).toHaveText(`${words.filled} · ${words.undo}`, {
      timeout: 30_000,
      useInnerText: false,
    });

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

  // protects=after Stop the page stays bare: the control says Transcript, the fill shows only at the place it writes, with its Undo line that goes on the next keystroke; ⌘Z takes back exactly the fill and ⇧⌘Z puts it back; the control raises the Transcript, whose recording details hold the audio's line, nothing opening by itself after a fill (#2527, #138, #3762); fails_when=a line stays above the notes, ⌘Z takes back the User's own heading, anything rises by itself after the fill, or a string is wrong; no_claim=a real model's fill.
  test(`after Stop the page stays bare, the control raises the rest, and ⌘Z takes back the fill (${language})`, async () => {
    const words = WORDS[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, language === "en" ? 1440 : 900, 660);
    await recordOnClose(app, window, `meeting-page-after-${language}`);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);

    for (const round of [1, 2]) {
      await motionSettled(window);
      const control = await recordMeeting(window);
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
      await stopMeeting(window);
      const raise = control.getByTestId("meeting-foot-transcript");
      await expect(raise).toHaveText(words.transcript);
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
      // Nothing above the notes or over the control: no bar, no Transcript or audio line, no details.
      const page = panel.getByTestId("mind-pane");
      await expect(panel.getByTestId("meeting-bar")).toHaveCount(0);
      await expect(panel.getByTestId("meeting-transcript-line")).toHaveCount(0);
      await expect(page.getByTestId("meeting-audio")).toHaveCount(0);
      await expect(page.getByTestId("meeting-details-toggle")).toHaveCount(0);
      await expect(line.locator("xpath=ancestor::*[@data-testid='mind-editor']")).toHaveCount(1);
      // The fill opens nothing by itself, the first time on this computer or after.
      await expect(panel.getByTestId("meeting-sheet")).toHaveCount(0);
      await expect(window.getByRole("menu")).toHaveCount(0);
      if (round === 1) await shot(window, `meeting-page-stopped-${language}`);

      // The control raises the Transcript; its recording details hold the audio's Delete now
      // (asked first) and the capture's lines.
      const sheet = await openMeetingSheet(window);
      await expect(raise).toHaveAttribute("aria-expanded", "true");
      await expect(sheet.getByTestId("meeting-details-toggle")).toHaveAccessibleName(
        words.showDetails,
      );
      const details = await openMeetingDetails(window);
      await expect(details.getByTestId("meeting-details")).toHaveAttribute(
        "aria-label",
        words.details,
      );
      const audio = details.getByTestId("meeting-audio");
      await expect(audio).toContainText(words.audio);
      await expect(audio.getByTestId("meeting-audio-delete")).toHaveText(words.deleteNow);
      await pointAndClick(window, audio.getByTestId("meeting-audio-delete"));
      const confirm = details.getByTestId("meeting-audio-confirm");
      await expect(confirm).toContainText(words.confirm);
      await expect(confirm.getByTestId("meeting-audio-delete-confirm")).toBeFocused();
      await pointAndClick(window, confirm.getByRole("button", { name: words.keep, exact: true }));
      await expect(audio).toContainText(words.audio);
      await expect(sheet).toBeVisible();
      if (round === 1) await shot(window, `meeting-page-details-${language}`);
      // ⌥⌘← goes to My notes, then to the notes, with the focus in them.
      await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
      await expect(sheet).toBeHidden();
      await expect(editor.locator("p").filter({ hasText: words.overview })).toBeHidden();
      await window.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
      await expect(editor).toBeFocused();
      await expect(editor.locator("p").filter({ hasText: words.overview })).toBeVisible();
      await expect(raise).toHaveAttribute("aria-expanded", "false");

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
