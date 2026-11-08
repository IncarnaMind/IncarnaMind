import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, Meeting } from "../src/core/api";
import { FAKE_LINES, FAKE_THEIR_LINES } from "../src/core/transcription/fake";
import {
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
} from "./app";
import { encode, film } from "./feel";

/** Set INCARNAMIND_SCREENSHOTS to keep stills and post-startup videos there. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function recordOnClose(app: ElectronApplication, window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  const frames = resolve(SCREENSHOTS, `${name}-frames`);
  const video = resolve(SCREENSHOTS, `${name}.mp4`);
  const stop = await film(window, frames);
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => {
    closing ??= (async () => {
      try {
        await stop();
        await encode(frames, video);
      } finally {
        await close();
      }
    })();
    return closing;
  };
}

async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

const LINES = {
  en: {
    filled: "Note filled in",
    undo: "Undo",
    undone: "Fill-in undone",
    again: "Fill in again",
    summary: "Summary",
    decisions: "Decisions",
    actions: "Action items",
    partial: "Note partly filled in",
    noAdditions: "No notes added",
    omittedOne: "1 item couldn’t be added",
    omittedTwo: "2 items couldn’t be added",
    transcript: "View Transcript",
    viewNotes: "Notes",
    viewTranscript: "Transcript",
    viewLabel: "Meeting views",
    recordedChip: /^Recorded \d+:\d{2}(?::\d{2})?$/,
    retry: "Try again",
    speech: ["We confirmed the launch date", "We discussed the release checklist"],
    notes: ["Launch date", "UK fee"],
  },
  "zh-CN": {
    filled: "已补全笔记",
    undo: "撤销",
    undone: "已撤销补全",
    again: "重新补全",
    summary: "摘要",
    decisions: "决定",
    actions: "待办",
    partial: "笔记未能全部补全",
    noAdditions: "未添加笔记",
    omittedOne: "1 项内容未能添加",
    omittedTwo: "2 项内容未能添加",
    transcript: "查看转写稿",
    viewNotes: "笔记",
    viewTranscript: "转写稿",
    viewLabel: "会议视图",
    recordedChip: /^已录制 \d+:\d{2}(?::\d{2})?$/,
    retry: "重试",
    speech: ["我们确认了上线日期", "我们讨论了后续分工"],
    notes: ["上线日期", "英国费用"],
  },
} as const;

const MACHINE_CONTROLS = /HEADINGS:|FACT P\d+_F|END OVERVIEW|"citations":|"supersedes":|\[\^\d+\]/;

const documentBlocks = (notes: Locator) => notes.locator(":scope > [data-id]");

const paragraphsIn = (notes: Locator) =>
  notes.locator(":scope > p[data-id]").evaluateAll((all) =>
    all.map((each) => ({
      text: each.textContent,
      generated: each.querySelector(".generated-text") !== null,
      prose: [...each.querySelectorAll(".generated-text")]
        .map((node) => node.textContent ?? "")
        .join(""),
      citations: each.querySelectorAll('[data-testid="citation"]').length,
    })),
  );

async function expectActionsFit(line: Locator, count = 2): Promise<void> {
  await expect(line).toBeInViewport();
  const actions = line.getByRole("button");
  await expect(actions).toHaveCount(count);
  for (const action of await actions.all()) {
    await expect(action).toBeInViewport({ ratio: 1 });
  }
  const layout = await line.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const pane = element.closest('[data-testid="mind-scroller"]');
    if (!pane) throw new Error("Expected the Meeting actions inside the Note's scroll pane");
    const paneBounds = pane.getBoundingClientRect();
    const top = Math.max(bounds.top, paneBounds.top + pane.clientTop, 0);
    const bottom = Math.min(
      bounds.bottom,
      paneBounds.top + pane.clientTop + pane.clientHeight,
      window.innerHeight,
    );
    return {
      noOverflow: element.scrollWidth <= element.clientWidth + 1,
      contained: [...element.querySelectorAll("button")].every((button) => {
        const box = button.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.left >= bounds.left - 1 &&
          box.right <= bounds.right + 1 &&
          box.top >= top - 1 &&
          box.bottom <= bottom + 1
        );
      }),
    };
  });
  expect(layout).toEqual({ noOverflow: true, contained: true });
}

async function recordedMeeting(window: Page): Promise<Meeting> {
  const meeting = await window.evaluate(async () => {
    const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    return (await core.listMeetings()).find((each) => each.kind === "meeting");
  });
  if (!meeting?.transcript) throw new Error("Expected the recorded Meeting's saved Transcript");
  return meeting;
}

async function expectFillPlace(notes: Locator, addedBlockIds: readonly string[]): Promise<void> {
  await expect(notes.getByTestId("meeting-fill-line")).toHaveCount(1);
  const place = await notes.evaluate(
    (editor, ids) => {
      const line = editor.querySelector('[data-testid="meeting-fill-line"]');
      const slot = line?.closest('[data-testid="meeting-fill-place"]');
      if (!line || !slot) throw new Error("Expected the content-local fill slot");
      const first = [...editor.querySelectorAll("[data-id]")].find((block) =>
        ids.includes(block.getAttribute("data-id") ?? ""),
      );
      return {
        noneditable: slot.getAttribute("contenteditable") === "false",
        notAContentBlock: !slot.hasAttribute("data-id"),
        outsideBar: line.closest('[data-testid="meeting-bar"]') === null,
        withinEditor: slot.parentElement === editor,
        survivingAnchor: first?.getAttribute("data-id") ?? null,
        adjacent: first ? slot.nextElementSibling === first : slot.nextElementSibling === null,
        before: first
          ? line.getBoundingClientRect().bottom <= first.getBoundingClientRect().top + 1
          : slot === editor.lastElementChild,
      };
    },
    [...addedBlockIds],
  );
  expect(place).toEqual({
    noneditable: true,
    notAContentBlock: true,
    outsideBar: true,
    withinEditor: true,
    survivingAnchor: addedBlockIds.length > 0 ? expect.any(String) : null,
    adjacent: true,
    before: true,
  });
}

async function chooseMeetingView(
  window: Page,
  panel: Locator,
  words: (typeof LINES)[keyof typeof LINES],
  view: "notes" | "transcript",
): Promise<void> {
  const chip = panel.getByTestId("meeting-view-chip");
  await expect(chip).toBeInViewport({ ratio: 1 });
  await chip.focus();
  await chip.press("Enter");
  await expect(window.getByTestId("meeting-view-menu")).toHaveAttribute(
    "aria-label",
    words.viewLabel,
  );
  const notes = window.getByTestId("meeting-view-notes");
  const transcript = window.getByTestId("meeting-view-transcript");
  await expect(notes).toHaveText(words.viewNotes);
  await expect(transcript).toHaveText(words.viewTranscript);
  await expect(notes).toHaveAttribute("role", "menuitemradio");
  await expect(transcript).toHaveAttribute("role", "menuitemradio");
  await expect(view === "notes" ? transcript : notes).toHaveAttribute("aria-checked", "true");
  await window.keyboard.press("Home");
  await expect(notes).toBeFocused();
  // My notes sits between them.
  if (view === "transcript") {
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("ArrowDown");
  }
  const choice = view === "notes" ? notes : transcript;
  await expect(choice).toBeFocused();
  await choice.press("Enter");
  await expect(choice).toBeHidden();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await expect(chip).toHaveText(view === "notes" ? words.recordedChip : words.viewTranscript);
}

async function ownTranscriptRoundTrip(
  window: Page,
  notes: Locator,
  meeting: Meeting,
  words: (typeof LINES)[keyof typeof LINES],
  speech: readonly string[],
  open: (panel: Locator) => Promise<void>,
  name: string,
): Promise<void> {
  const noteTab = window.locator(`[data-testid="mind-tab"][data-mind-id="${meeting.mindId}"]`);
  await expect(noteTab).toHaveAttribute("aria-selected", "true");
  const tabId = await noteTab.getAttribute("data-tab-id");
  const groupId = await noteTab.getAttribute("data-group-id");
  const panelId = await noteTab.getAttribute("aria-controls");
  if (!tabId || !groupId || !panelId || !meeting.transcript?.documentId)
    throw new Error("Expected the recorded Note's tab, panel and Transcript identities");
  const panel = window.locator(`[id="${panelId}"]`);
  const tabIds = () =>
    window
      .locator("[data-tab-id]")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id")).sort());
  const originalTabs = await tabIds();
  const originalBlocks = await documentBlocks(notes).allTextContents();
  const retained = await notes.evaluateHandle((element) => {
    const editor = (element as HTMLElement & { editor?: Editor }).editor;
    if (!editor) throw new Error("Expected the Note's existing editor");
    return {
      element,
      editor,
      selection: editor.state.selection.toJSON(),
      document: editor.getJSON(),
    };
  });
  try {
    const serialized = await retained.evaluate(({ document }) => JSON.stringify(document));
    for (const status of [words.filled, words.partial, words.noAdditions]) {
      expect(serialized).not.toContain(status);
    }
    await expect(panel.getByTestId("meeting-view-chip")).toHaveText(words.recordedChip);
    await open(panel);
    const transcript = panel.getByTestId("meeting-note-transcript");
    await expect(transcript).toHaveAttribute("data-document-id", meeting.transcript.documentId);
    const viewer = transcript.getByTestId("viewer-transcript");
    await expect(viewer).toBeVisible();
    await expect(panel.getByTestId("meeting-view-chip")).toContainText(words.viewTranscript);
    const cue = viewer.getByTestId("transcript-line").first();
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute("data-start", /^\d+$/);
    expect(speech).toContain((await cue.innerText()).trim());
    await expect(notes).toBeHidden();
    expect(await retained.evaluate(({ element }) => element.isConnected)).toBe(true);
    await expect(noteTab).toHaveAttribute("aria-selected", "true");
    await expect(noteTab).toHaveAttribute("data-tab-id", tabId);
    await expect(noteTab).toHaveAttribute("data-group-id", groupId);
    expect(await tabIds()).toEqual(originalTabs);
    await expect(
      window.locator(
        `[data-testid="document-tab"][data-document-id="${meeting.transcript.documentId}"]`,
      ),
    ).toHaveCount(0);
    await shot(window, `${name}-transcript`);
    await chooseMeetingView(window, panel, words, "notes");
    await expect(notes).toBeVisible();
    await expect(transcript).toBeHidden();
    expect(
      await retained.evaluate(({ element, editor, selection, document }) => ({
        connected: element.isConnected,
        sameEditor: (element as HTMLElement & { editor?: Editor }).editor === editor,
        sameElement:
          element.closest('[role="tabpanel"]')?.querySelector('[data-testid="mind-editor"]') ===
          element,
        sameSelection:
          JSON.stringify(editor.state.selection.toJSON()) === JSON.stringify(selection),
        sameDocument: JSON.stringify(editor.getJSON()) === JSON.stringify(document),
      })),
    ).toEqual({
      connected: true,
      sameEditor: true,
      sameElement: true,
      sameSelection: true,
      sameDocument: true,
    });
    await expect(noteTab).toHaveAttribute("aria-selected", "true");
    expect(await tabIds()).toEqual(originalTabs);
    await expect(documentBlocks(notes)).toHaveText(originalBlocks);
    const chip = panel.getByTestId("meeting-view-chip");
    await expect(chip).toBeInViewport({ ratio: 1 });
    await chip.focus();
    await chip.press("Enter");
    await expect(window.getByTestId("meeting-view-notes")).toBeVisible();
    await expect(window.getByTestId("meeting-view-notes")).toHaveAttribute("aria-checked", "true");
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("meeting-view-notes")).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(chip).toHaveText(words.recordedChip);
    await shot(window, `${name}-notes-restored`);
  } finally {
    await retained.dispose();
  }
}

for (const language of ["en", "zh-CN"] as const) {
  // protects=after Stop, the call's action is written whole under the typed Action items heading and each typed line gets a pointer to it, all cited AI text, Summary and Decisions follow, and one Undo restores the heading and lines in English and Chinese (#142, #2306); fails_when=a section is missing or repeated, typed text changes, additions are uncited or not AI text, or Undo leaves an addition; no_claim=a real model's wording or allocation of facts.
  test(`after Stop, typed lines and an Action items heading are filled in place, sections follow, and one Undo restores them (${language})`, async () => {
    const words = LINES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, language === "en" ? 1440 : 900, 900);
    await recordOnClose(app, window, `meeting-fill-sections-${language}`);
    await dismissChatSetup(window);
    await selectLocalChatModel(window);

    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await firstTranscriptLine(window);
    const notes = window.getByTestId("mind-editor");
    await pointAndClick(window, notes);
    await focusSettled(window, notes);
    for (const text of words.notes) {
      await window.keyboard.type(text);
      await window.keyboard.press("Enter");
    }
    await window.keyboard.type(`## ${words.actions}`);
    const heading = notes.locator("h2:not(:has(.generated-text))");
    await expect(heading).toHaveText(words.actions);
    await expect(notes.locator(":scope > p[data-id]")).toHaveText(words.notes);
    const blocks = documentBlocks(notes);
    const original = await blocks.allTextContents();

    // The menus above are named in English; what follows Stop is read in the language chosen.
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    const line = window.getByTestId("meeting-fill-line");
    await expect(line).toContainText(words.filled, { timeout: 30_000 });
    await closeFirstFillPopover(window);
    await expect(line.getByTestId("meeting-fill-undo")).toHaveText(words.undo);
    const meeting = await recordedMeeting(window);
    expect(meeting.fill).toMatchObject({ state: "filled", omitted: 0, unfinishedParts: 0 });
    const addedBlockIds = meeting.fill?.addedBlockIds;
    if (!addedBlockIds?.length) throw new Error("Expected the fill's actual added Block IDs");
    await expectFillPlace(notes, addedBlockIds);
    await expectActionsFit(line, 1);
    const added = notes.locator(".generated-text");
    // The typed heading stays as typed; the sections take the call's language, here English (#2770).
    await expect(notes.locator("h2")).toHaveText([
      words.actions,
      LINES.en.summary,
      LINES.en.decisions,
    ]);
    await expect(heading).toHaveText(words.actions);
    const actions = notes.locator("h2:not(:has(.generated-text)) + p");
    await expect(actions).toHaveCount(1);
    await expect(actions.locator(".generated-text")).not.toHaveCount(0);
    await expect(actions.getByTestId("citation")).toHaveCount(1);
    await shot(window, `meeting-fill-sections-${language}`);
    const paragraphs = await paragraphsIn(notes);
    for (const text of words.notes) {
      const userAt = paragraphs.findIndex((each) => each.text === text);
      expect(userAt).toBeGreaterThanOrEqual(0);
      expect(paragraphs[userAt]).toMatchObject({ generated: false, citations: 0 });
      expect(paragraphs[userAt + 1]).toMatchObject({ generated: true, citations: 1 });
    }
    const whole = (await actions.locator(".generated-text").allTextContents()).join("");
    expect(whole.trim()).not.toBe("");
    expect(paragraphs.filter((each) => each.prose === whole)).toHaveLength(1);
    const [first, second] = words.notes.map(
      (text) => paragraphs[paragraphs.findIndex((each) => each.text === text) + 1],
    );
    if (!first || !second) throw new Error("Missing a typed line's pointer to the action");
    expect(first.prose.trim()).not.toBe("");
    expect(second.prose).toBe(first.prose);
    expect(first.prose).not.toBe(whole);
    await expect(notes).not.toContainText(MACHINE_CONTROLS);
    await expect(notes.locator('[data-testid="citation"]:not([data-check="found"])')).toHaveCount(
      0,
    );

    await ownTranscriptRoundTrip(
      window,
      notes,
      meeting,
      words,
      [...FAKE_LINES, ...FAKE_THEIR_LINES],
      (panel) => chooseMeetingView(window, panel, words, "transcript"),
      `meeting-fill-sections-${language}`,
    );
    await expectFillPlace(notes, addedBlockIds);
    await expectActionsFit(line, 1);

    await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
    await expect(added).toHaveCount(0);
    await expect(blocks).toHaveText(original);
    await expect(notes.locator("h2")).toHaveText([words.actions]);
    await expect(notes.locator(":scope > p[data-id]")).toHaveText(words.notes);
    await expect(notes.getByTestId("citation")).toHaveCount(0);
    await expect(line).toContainText(words.undone);
    await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.again);
    await expectFillPlace(notes, []);
    await app.close();
  });
}

for (const language of ["en", "zh-CN"] as const) {
  for (const outcome of ["partial", "empty"] as const) {
    test(`after Stop, ${outcome === "partial" ? "safe additions stay with Transcript and one Undo" : "no safe additions offer Transcript and Retry, never Undo"} (${language})`, async () => {
      const words = LINES[language];
      const control =
        outcome === "partial" ? "Meeting fill fixture: partial" : "Meeting fill fixture: empty";
      const { app, window } = await launchApp(dataDir, {
        fakeChat: true,
        transcriber: { lines: [words.speech[0]], theirLines: [words.speech[1]] },
      });
      try {
        const width =
          outcome === "partial" ? (language === "en" ? 900 : 1440) : language === "en" ? 1440 : 900;
        await setWindowSize(app, window, width, 900);
        await recordOnClose(app, window, `meeting-fill-${outcome}-${language}`);
        await dismissChatSetup(window);
        await selectLocalChatModel(window);
        const bar = await startRecording(window, await recordMeeting(window), { notice: true });
        await firstTranscriptLine(window);
        const notes = window.getByTestId("mind-editor");
        await pointAndClick(window, notes);
        await focusSettled(window, notes);
        for (const text of [control, ...words.notes]) {
          await window.keyboard.type(text);
          await window.keyboard.press("Enter");
        }
        await window.keyboard.type(`## ${words.actions}`);
        await expect(notes.locator("h2")).toHaveText([words.actions]);
        await expect(notes.locator(":scope > p[data-id]")).toHaveText([control, ...words.notes]);
        const blocks = documentBlocks(notes);
        const original = await blocks.allTextContents();
        await window.evaluate(async (chosen) => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          await core.updateSettings({ user: { language: chosen } });
        }, language);
        await pointAndClick(window, bar.getByTestId("meeting-stop"));
        const line = window.getByTestId("meeting-fill-line");
        await expect(line).toContainText(
          outcome === "partial" ? words.partial : words.noAdditions,
          { timeout: 30_000 },
        );
        await expect(line).toContainText(
          outcome === "partial" ? words.omittedOne : words.omittedTwo,
        );
        if (outcome === "partial") await closeFirstFillPopover(window);
        await expect(line).not.toContainText(words.filled);
        await expect(line).toHaveAttribute("role", outcome === "partial" ? "status" : "alert");
        const transcript = line.getByTestId("meeting-fill-transcript");
        await expect(transcript).toHaveText(words.transcript);
        await expect(transcript).toBeEnabled();
        await expectActionsFit(line);
        await expect(notes).not.toContainText(MACHINE_CONTROLS);
        await expect(notes).not.toContainText("An unrecorded meeting detail");
        const controlNote = notes.locator(":scope > p[data-id]").filter({ hasText: control });
        await expect(controlNote).toHaveText(control);
        await expect(controlNote.locator(".generated-text")).toHaveCount(0);
        const meeting = await recordedMeeting(window);
        expect(meeting?.fill).toMatchObject({
          state: outcome === "partial" ? "filled" : "failed",
          omitted: outcome === "partial" ? 1 : 2,
          unfinishedParts: 0,
        });
        const addedBlockIds = meeting.fill?.addedBlockIds;
        if (outcome === "partial") {
          if (!addedBlockIds?.length)
            throw new Error("Expected the retained fill's added Block IDs");
          await expectFillPlace(notes, addedBlockIds);
          const paragraphs = await paragraphsIn(notes);
          for (const text of [control, ...words.notes]) {
            expect(paragraphs.filter((paragraph) => paragraph.text === text)).toEqual([
              { text, generated: false, prose: "", citations: 0 },
            ]);
          }
          const generated = paragraphs.filter((paragraph) => paragraph.generated);
          const canonical = generated.filter((paragraph) =>
            words.speech.some((said) => paragraph.prose.includes(said)),
          );
          expect(canonical).toHaveLength(1);
          expect(canonical[0]?.citations).toBe(1);
          const action = notes.locator("h2:not(:has(.generated-text)) + p");
          await expect(action).toHaveCount(1);
          await expect(action.getByTestId("citation")).toHaveAttribute("data-check", "found");
          expect((await action.locator(".generated-text").allTextContents()).join("")).toBe(
            canonical[0]?.prose,
          );
          for (const text of words.notes) {
            const pointer = paragraphs[paragraphs.findIndex((each) => each.text === text) + 1];
            expect(pointer).toMatchObject({ generated: true, citations: 1 });
            expect(pointer?.prose.trim()).not.toBe("");
            expect(words.speech.some((said) => pointer?.prose.includes(said))).toBe(false);
          }
          await expect(
            notes.locator('[data-testid="citation"]:not([data-check="found"])'),
          ).toHaveCount(0);
          await expect(line.getByTestId("meeting-fill-undo")).toHaveText(words.undo);
          await expect(line.getByTestId("meeting-fill-again")).toHaveCount(0);
        } else {
          expect(addedBlockIds).toEqual([]);
          await expectFillPlace(notes, []);
          await expect(notes.locator(".generated-text")).toHaveCount(0);
          await expect(notes.getByTestId("citation")).toHaveCount(0);
          await expect(blocks).toHaveText(original);
          await expect(line.getByTestId("meeting-fill-undo")).toHaveCount(0);
          await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.retry);
        }
        await shot(window, `meeting-fill-${outcome}-${language}`);
        await ownTranscriptRoundTrip(
          window,
          notes,
          meeting,
          words,
          words.speech,
          () => pointAndClick(window, transcript),
          `meeting-fill-${outcome}-${language}`,
        );
        await expect(controlNote).toHaveText(control);
        await expectFillPlace(notes, addedBlockIds ?? []);
        await expectActionsFit(line);
        if (outcome === "partial") {
          const undo = line.getByTestId("meeting-fill-undo");
          await undo.focus();
          await expect(undo).toBeFocused();
          await undo.press("Enter");
          await expect(notes.locator(".generated-text")).toHaveCount(0);
          await expect(notes.getByTestId("citation")).toHaveCount(0);
          await expect(blocks).toHaveText(original);
          await expect(line).toContainText(words.undone);
          await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.again);
          await expectFillPlace(notes, []);
        } else {
          await expect(blocks).toHaveText(original);
          const retry = line.getByTestId("meeting-fill-again");
          await expect(retry).toBeEnabled();
          const attempt = await window.evaluateHandle((meetingId) => {
            const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
            const observed = { filling: false, failed: false };
            const stop = core.on("meetings.changed", (meetings) => {
              const state = meetings.find((each) => each.id === meetingId)?.fill?.state;
              if (state === "filling") observed.filling = true;
              if (observed.filling && state === "failed") observed.failed = true;
            });
            return { observed, stop };
          }, meeting.id);
          try {
            await retry.focus();
            await expect(retry).toBeFocused();
            await retry.press("Enter");
            await expect
              .poll(() => attempt.evaluate(({ observed }) => observed), { timeout: 30_000 })
              .toEqual({ filling: true, failed: true });
            await expect(line).toContainText(words.noAdditions);
            await expect(line).toContainText(words.omittedTwo);
            await expect(line).not.toContainText(words.filled);
            await expect(line).toHaveAttribute("role", "alert");
            expect(
              await window.evaluate(async (meetingId) => {
                const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
                return (await core.listMeetings()).find((each) => each.id === meetingId)?.fill;
              }, meeting.id),
            ).toMatchObject({ state: "failed", omitted: 2, unfinishedParts: 0, addedBlockIds: [] });
            await expect(blocks).toHaveText(original);
            await expect(notes.locator(".generated-text")).toHaveCount(0);
            await expect(notes.getByTestId("citation")).toHaveCount(0);
            await expect(line.getByTestId("meeting-fill-undo")).toHaveCount(0);
            await expect(transcript).toHaveText(words.transcript);
            await expect(retry).toHaveText(words.retry);
            await expect(retry).toBeEnabled();
            await expectFillPlace(notes, []);
            await expectActionsFit(line);
          } finally {
            try {
              await attempt.evaluate(({ stop }) => stop());
            } finally {
              await attempt.dispose();
            }
          }
        }
      } finally {
        await app.close();
      }
    });
  }
}
