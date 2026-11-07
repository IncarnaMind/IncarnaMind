import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  askToChange,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  openPageMenu,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  reviewedWords,
  runCommand,
  setWindowSize,
  slideSelect,
  startRecording,
  useLocalChatModel,
} from "./app";

let dataDir: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
});

test("a meeting's ⌘K views retain its editor; assistant return and page Review changes reveal Notes before focusing it", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(app, window, 900, 660);
  await dismissChatSetup(window);
  const bar = await startRecording(window, await recordMeeting(window), { notice: true });
  const editor = window.getByTestId("mind-editor");
  const paragraph = editor.locator(":scope > p");
  const original = "The tides here are very strong and really regular.";
  await pointAndClick(window, editor);
  await focusSettled(window, editor);
  await window.keyboard.type(original);
  await expect(paragraph).toHaveText([original]);

  const core = await coreOf(window);
  await expect
    .poll(
      async () => (await core.evaluate((bridge) => bridge.listMeetings()))[0]?.transcript?.lines,
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await pointAndClick(window, bar.getByTestId("meeting-stop"));
  await expect(bar).toBeHidden();
  await expect
    .poll(
      async () => {
        const [meeting] = await core.evaluate((bridge) => bridge.listMeetings());
        return { transcript: meeting?.transcript?.state, fill: meeting?.fill?.problem?.kind };
      },
      { timeout: 30_000 },
    )
    .toEqual({ transcript: "saved", fill: "no-model" });
  await useLocalChatModel(window);

  const tab = window.getByTestId("mind-tab");
  await expect(tab).toHaveCount(1);
  const tabId = await tab.getAttribute("data-tab-id");
  const panelId = await tab.getAttribute("aria-controls");
  const mindId = await tab.getAttribute("data-mind-id");
  if (!tabId || !panelId || !mindId) throw new Error("Expected the Meeting's Note tab and panel.");
  const panel = window.locator(`[id="${panelId}"]`);
  const transcript = panel.getByTestId("meeting-note-transcript");
  const chip = panel.getByTestId("meeting-view-chip");
  const caretPrefix = "The tides here are very strong";
  await slideSelect(window, paragraph, "strong");
  await window.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      editor.evaluate((element) => {
        const { doc, selection } = (element as unknown as { editor: Editor }).editor.state;
        return {
          before: doc.textBetween(0, selection.from),
          collapsed: selection.empty,
          after: doc.textBetween(selection.to, doc.content.size),
        };
      }),
    )
    .toEqual({ before: caretPrefix, collapsed: true, after: " and really regular." });

  const retained = await editor.evaluateHandle((element, id) => {
    const heldEditor = (element as unknown as { editor: Editor }).editor;
    type Observation = {
      phase: string;
      kind: "focus" | "input";
      data: string | null;
      visible: boolean;
      transcriptVisible: boolean;
      focused: boolean;
      selection: { from: number; to: number };
    };
    const state = { phase: "", events: [] as Observation[] };
    const observe = (kind: Observation["kind"], data: string | null) => {
      if (!state.phase) return;
      const shownTranscript = document
        .getElementById(id)
        ?.querySelector('[data-testid="meeting-note-transcript"]');
      state.events.push({
        phase: state.phase,
        kind,
        data,
        visible: element.checkVisibility(),
        transcriptVisible: shownTranscript?.checkVisibility() ?? false,
        focused: document.activeElement === element,
        selection: { from: heldEditor.state.selection.from, to: heldEditor.state.selection.to },
      });
    };
    const onFocus = () => observe("focus", null);
    const onInput = (event: Event) => {
      if (event instanceof InputEvent) observe("input", event.data);
    };
    element.addEventListener("focus", onFocus, true);
    element.addEventListener("beforeinput", onInput, true);
    return {
      element,
      editor: heldEditor,
      state,
      dispose() {
        element.removeEventListener("focus", onFocus, true);
        element.removeEventListener("beforeinput", onInput, true);
      },
    };
  }, panelId);
  const noteState = () =>
    retained.evaluate(({ element, editor: held }) => ({
      connected: element.isConnected,
      sameEditor: (element as unknown as { editor: Editor }).editor === held,
      document: held.state.doc.toJSON(),
      selection: { from: held.state.selection.from, to: held.state.selection.to },
    }));
  const expectSameTab = async () => {
    await expect(tab).toHaveAttribute("data-tab-id", tabId);
    await expect(tab).toHaveAttribute("data-mind-id", mindId);
    await expect(tab).toHaveAttribute("aria-controls", panelId);
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(window.getByTestId("document-tab")).toHaveCount(0);
  };

  try {
    const before = await noteState();
    expect(before.connected && before.sameEditor).toBe(true);
    expect(before.selection.from).toBe(before.selection.to);
    await test.info().attach("retained-note-before", {
      body: JSON.stringify(before, null, 2),
      contentType: "application/json",
    });
    await runCommand(window, "meeting.showTranscript", "Show the Transcript");
    await expect(transcript.getByTestId("transcript-line").first()).toBeVisible();
    await expect(editor).toBeHidden();
    await expect(chip).toContainText("Transcript");
    expect(await noteState()).toEqual(before);
    await expectSameTab();

    await runCommand(window, "meeting.showNotes", "Show Notes");
    await expect(editor).toBeVisible();
    await expect(transcript).toHaveCount(0);
    expect(await noteState()).toEqual(before);
    await expectSameTab();

    await runCommand(window, "meeting.showTranscript", "Show the Transcript");
    await expect(transcript).toBeVisible();
    await expect(editor).toBeHidden();
    await window.keyboard.press("ControlOrMeta+j");
    const composer = window.getByTestId("composer-input");
    await expect(composer).toBeFocused();
    const draft = "Keep this question for later";
    await window.keyboard.type(draft);
    expect(await noteState()).toEqual(before);
    await retained.evaluate(({ state }) => {
      state.phase = "assistant";
    });
    await window.keyboard.press("Escape");
    await window.keyboard.type("x");

    await expect(paragraph).toHaveText([original.replace("strong", "strongx")]);
    await expect(editor).toBeFocused();
    await expect(transcript).toHaveCount(0);
    await expect(window.getByTestId("assistant")).not.toHaveAttribute("data-folded");
    await expect(composer).toHaveValue(draft);
    const assistantEvents = await retained.evaluate(({ state }) => state.events);
    expect(assistantEvents).toEqual([
      {
        phase: "assistant",
        kind: "focus",
        data: null,
        visible: true,
        transcriptVisible: false,
        focused: true,
        selection: before.selection,
      },
      {
        phase: "assistant",
        kind: "input",
        data: "x",
        visible: true,
        transcriptVisible: false,
        focused: true,
        selection: before.selection,
      },
    ]);
    const afterTyping = await noteState();
    expect(afterTyping.selection).toEqual({
      from: before.selection.from + 1,
      to: before.selection.to + 1,
    });
    await expectSameTab();
    await retained.evaluate(({ state }) => {
      state.phase = "";
    });
    await window.keyboard.press("ControlOrMeta+z");
    await expect(paragraph).toHaveText([original]);
    const undone = await noteState();
    expect(undone.document).toEqual(before.document);
    expect(undone.connected && undone.sameEditor).toBe(true);
    await expectSameTab();

    await slideSelect(window, paragraph, original);
    await askToChange(window, "replace strong with powerful");
    const edited = original.replace("strong", "powerful");
    await expect(paragraph).toHaveText([edited]);
    await expect(editor.getByTestId("applied-review")).toBeVisible();
    const beforeReview = await noteState();
    await runCommand(window, "meeting.showTranscript", "Show the Transcript");
    await expect(transcript).toBeVisible();
    await expect(editor).toBeHidden();
    expect(await noteState()).toEqual(beforeReview);
    const menu = await openPageMenu(window);
    await expect(menu.getByTestId("page-review-changes")).toHaveText("Review changes");
    await retained.evaluate(({ state }) => {
      state.phase = "review";
    });
    await pointAndClick(window, menu.getByTestId("page-review-changes"));

    await expect(editor).toBeFocused();
    await expect(transcript).toHaveCount(0);
    await expect(paragraph.locator("del.applied-old")).toHaveText(["strong"]);
    await expect(paragraph.locator(".applied-new")).toHaveText(["powerful"]);
    await expect(editor.getByTestId("change-restore")).toHaveText(["Restore original"]);
    await expect.poll(() => reviewedWords(paragraph)).toBe(edited);
    const afterReview = await noteState();
    expect(afterReview.document).toEqual(beforeReview.document);
    expect(afterReview.connected && afterReview.sameEditor).toBe(true);
    expect(afterReview.selection.from).toBe(afterReview.selection.to);
    expect(
      await retained.evaluate(({ editor: held }) =>
        held.state.doc.textBetween(0, held.state.selection.from),
      ),
    ).toBe("The tides here are very ");
    expect(
      await retained.evaluate(({ state }) =>
        state.events.filter((event) => event.phase === "review"),
      ),
    ).toEqual([
      {
        phase: "review",
        kind: "focus",
        data: null,
        visible: true,
        transcriptVisible: false,
        focused: true,
        selection: afterReview.selection,
      },
    ]);
    await expectSameTab();
  } finally {
    await test.info().attach("native-focus-events", {
      body: JSON.stringify(await retained.evaluate(({ state }) => state.events), null, 2),
      contentType: "application/json",
    });
    await retained.evaluate((held) => held.dispose());
    await retained.dispose();
  }
});
