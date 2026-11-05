import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  createDataFolder,
  dismissChatSetup,
  focusSettled,
  launchApp,
  pointAndClick,
  recordMeeting,
  removeDataFolder,
  useLocalChatModel as selectLocalChatModel,
  setWindowSize,
  startRecording,
} from "./app";

/** Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots there. */
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;

async function shot(window: Page, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
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
    partial: "Notes partly filled in",
    noAdditions: "No notes added",
    omittedOne: "1 item couldn’t be added",
    omittedTwo: "2 items couldn’t be added",
    transcript: "View Transcript",
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
    retry: "重试",
    speech: ["我们确认了上线日期", "我们讨论了后续分工"],
    notes: ["上线日期", "英国费用"],
  },
} as const;

const MACHINE_CONTROLS = /HEADINGS:|FACT P\d+_F|END OVERVIEW|"citations":|"supersedes":|\[\^\d+\]/;

const paragraphsIn = (notes: Locator) =>
  notes.locator(":scope > p").evaluateAll((all) =>
    all.map((each) => ({
      text: each.textContent,
      generated: each.querySelector(".generated-text") !== null,
      prose: [...each.querySelectorAll(".generated-text")]
        .map((node) => node.textContent ?? "")
        .join(""),
      citations: each.querySelectorAll('[data-testid="citation"]').length,
    })),
  );

async function expectActionsFit(line: Locator): Promise<void> {
  await expect(line).toBeInViewport();
  const actions = line.getByRole("button");
  await expect(actions).toHaveCount(2);
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

for (const language of ["en", "zh-CN"] as const) {
  // protects=after Stop, typed lines and an Action items heading are filled in place as cited AI text, Summary and Decisions follow, and one Undo restores the heading and lines in English and Chinese (#142, #2306); fails_when=a section is missing or repeated, typed text changes, additions are uncited or not AI text, or Undo leaves an addition; no_claim=a real model's wording or allocation of facts.
  test(`after Stop, typed lines and an Action items heading are filled in place, sections follow, and one Undo restores them (${language})`, async () => {
    const words = LINES[language];
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await setWindowSize(app, window, 1280, 900);
    await dismissChatSetup(window);
    await selectLocalChatModel(window);

    const bar = await startRecording(window, await recordMeeting(window), { notice: true });
    await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
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
    await expect(notes.locator("p")).toHaveText(words.notes);
    const blocks = notes.locator(":scope > *");
    const original = await blocks.allTextContents();

    // The menus above are named in English; what follows Stop is read in the language chosen.
    await window.evaluate(async (chosen) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ user: { language: chosen } });
    }, language);
    await pointAndClick(window, bar.getByTestId("meeting-stop"));
    const line = window.getByTestId("meeting-fill-line");
    await expect(line).toContainText(words.filled, { timeout: 30_000 });
    await expect(line.getByTestId("meeting-fill-undo")).toHaveText(words.undo);
    const added = notes.locator(".generated-text");
    await expect(notes.locator("h2")).toHaveText([words.actions, words.summary, words.decisions]);
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
    const canonical = paragraphs[paragraphs.findIndex((each) => each.text === words.notes[0]) + 1];
    const secondary = paragraphs[paragraphs.findIndex((each) => each.text === words.notes[1]) + 1];
    if (!canonical || !secondary) throw new Error("Missing canonical fact or its line reference");
    expect(canonical.prose.trim()).not.toBe("");
    expect(paragraphs.filter((each) => each.prose === canonical.prose)).toHaveLength(1);
    const actionReference = (await actions.locator(".generated-text").allTextContents()).join("");
    expect(actionReference.trim()).not.toBe("");
    expect(secondary.prose).toBe(actionReference);
    expect(actionReference).not.toBe(canonical.prose);
    await expect(notes).not.toContainText(MACHINE_CONTROLS);
    await expect(notes.locator('[data-testid="citation"]:not([data-check="found"])')).toHaveCount(
      0,
    );

    await pointAndClick(window, line.getByTestId("meeting-fill-undo"));
    await expect(added).toHaveCount(0);
    await expect(blocks).toHaveText(original);
    await expect(notes.locator("h2")).toHaveText([words.actions]);
    await expect(notes.locator("p")).toHaveText(words.notes);
    await expect(notes.getByTestId("citation")).toHaveCount(0);
    await expect(line).toContainText(words.undone);
    await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.again);
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
        await setWindowSize(app, window, language === "en" ? 1280 : 900, 900);
        await dismissChatSetup(window);
        await selectLocalChatModel(window);
        const bar = await startRecording(window, await recordMeeting(window), { notice: true });
        await expect(bar.getByTestId("meeting-transcript-toggle")).toBeEnabled({ timeout: 20_000 });
        const notes = window.getByTestId("mind-editor");
        await pointAndClick(window, notes);
        await focusSettled(window, notes);
        for (const text of [control, ...words.notes]) {
          await window.keyboard.type(text);
          await window.keyboard.press("Enter");
        }
        await window.keyboard.type(`## ${words.actions}`);
        await expect(notes.locator("h2")).toHaveText([words.actions]);
        await expect(notes.locator("p")).toHaveText([control, ...words.notes]);
        const blocks = notes.locator(":scope > *");
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
        await expect(line).not.toContainText(words.filled);
        await expect(line).toHaveAttribute("role", outcome === "partial" ? "status" : "alert");
        const transcript = line.getByTestId("meeting-fill-transcript");
        await expect(transcript).toHaveText(words.transcript);
        await expect(transcript).toBeEnabled();
        await expectActionsFit(line);
        await expect(notes).not.toContainText(MACHINE_CONTROLS);
        await expect(notes).not.toContainText("An unrecorded meeting detail");
        const controlNote = notes.locator(":scope > p").filter({ hasText: control });
        await expect(controlNote).toHaveText(control);
        await expect(controlNote.locator(".generated-text")).toHaveCount(0);
        const meeting = await window.evaluate(async () => {
          const core = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await core.listMeetings()).find((meeting) => meeting.kind === "meeting");
        });
        expect(meeting?.fill).toMatchObject({
          state: outcome === "partial" ? "filled" : "failed",
          omitted: outcome === "partial" ? 1 : 2,
          unfinishedParts: 0,
        });
        if (!meeting?.transcript)
          throw new Error("Expected the recorded Meeting's saved Transcript");
        if (outcome === "partial") {
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
          const actionReference = notes.locator("h2:not(:has(.generated-text)) + p");
          await expect(actionReference).toHaveCount(1);
          await expect(actionReference.getByTestId("citation")).toHaveAttribute(
            "data-check",
            "found",
          );
          const referenceWords = (
            await actionReference.locator(".generated-text").allTextContents()
          ).join("");
          expect(referenceWords.trim()).not.toBe("");
          expect(words.speech.some((said) => referenceWords.includes(said))).toBe(false);
          await expect(
            notes.locator('[data-testid="citation"]:not([data-check="found"])'),
          ).toHaveCount(0);
          await expect(line.getByTestId("meeting-fill-undo")).toHaveText(words.undo);
          await expect(line.getByTestId("meeting-fill-again")).toHaveCount(0);
        } else {
          await expect(notes.locator(".generated-text")).toHaveCount(0);
          await expect(notes.getByTestId("citation")).toHaveCount(0);
          await expect(blocks).toHaveText(original);
          await expect(line.getByTestId("meeting-fill-undo")).toHaveCount(0);
          await expect(line.getByTestId("meeting-fill-again")).toHaveText(words.retry);
        }
        await pointAndClick(window, transcript);
        const viewer = window.getByTestId("viewer-transcript");
        await expect(viewer).toBeVisible();
        await expect(viewer).toContainText(new RegExp(words.speech.join("|")));
        await expect(
          window.locator(
            `[data-testid="document-tab"][data-document-id="${meeting.transcript.documentId}"]`,
          ),
        ).toBeVisible();
        const noteTab = window.locator(
          `[data-testid="mind-tab"][data-mind-id="${meeting.mindId}"]`,
        );
        await expect(noteTab).toBeVisible();
        await pointAndClick(window, noteTab);
        await expect(noteTab).toHaveAttribute("aria-selected", "true");
        await expect(notes).toBeVisible();
        await expect(controlNote).toHaveText(control);
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
            ).toMatchObject({ state: "failed", omitted: 2, unfinishedParts: 0 });
            await expect(blocks).toHaveText(original);
            await expect(notes.locator(".generated-text")).toHaveCount(0);
            await expect(notes.getByTestId("citation")).toHaveCount(0);
            await expect(line.getByTestId("meeting-fill-undo")).toHaveCount(0);
            await expect(transcript).toHaveText(words.transcript);
            await expect(retry).toHaveText(words.retry);
            await expect(retry).toBeEnabled();
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
