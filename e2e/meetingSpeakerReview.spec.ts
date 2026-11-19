import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type {
  CoreBridge,
  Meeting,
  MeetingSpeakerReviewResult,
  TranscriptSpeakers,
} from "../src/core/api";
import { readVtt } from "../src/core/documents/formats/vtt";
import { lineKey } from "../src/shared/speakers";
import {
  useLocalChatModel as chooseLocalChatModel,
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
} from "./app";

const meetings = (window: Page) =>
  window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listMeetings(),
  );

async function reviewService(
  app: ElectronApplication,
  meetingId: string,
  result: MeetingSpeakerReviewResult,
) {
  await app.evaluate(
    ({ ipcMain }, { meetingId, result }) => {
      let runs = 0;
      let release: (() => void) | undefined;
      const channels = [
        "getMeetingSpeakerReview",
        "reviewMeetingSpeakers",
        "cancelMeetingSpeakerReview",
      ];
      for (const method of channels) ipcMain.removeHandler(`core:${method}`);
      ipcMain.handle("core:getMeetingSpeakerReview", (_event, id: string) => {
        if (id !== meetingId) throw new Error("Unexpected meeting.");
        return { available: true, reason: null, estimatedUsd: 0.003, durationMs: 9000 };
      });
      ipcMain.handle("core:reviewMeetingSpeakers", (_event, input) => {
        if (input.meetingId !== meetingId || input.confirmed !== true) {
          throw new Error("The upload was not confirmed for this meeting.");
        }
        runs++;
        if (runs === 1) {
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
        }
        return result;
      });
      ipcMain.handle("core:cancelMeetingSpeakerReview", (_event, id: string) => {
        if (id !== meetingId) throw new Error("Unexpected meeting.");
        release?.();
      });
      Object.assign(globalThis, { speakerReviewRuns: () => runs });
    },
    { meetingId, result },
  );
  return () =>
    app.evaluate(() =>
      (globalThis as unknown as { speakerReviewRuns(): number }).speakerReviewRuns(),
    );
}

async function shot(window: Page, name: string) {
  const directory = process.env.INCARNAMIND_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await motionSettled(window);
  await window.screenshot({ path: join(directory, `${name}.png`) });
}

async function savedMeeting(window: Page): Promise<Meeting> {
  const bar = await recordMeetingNow(window);
  await expect
    .poll(async () => (await meetings(window))[0]?.transcript?.lines ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(8);
  await pointAndClick(window, bar.getByTestId("meeting-stop"));
  await expect
    .poll(async () => (await meetings(window))[0]?.fill?.state, { timeout: 30_000 })
    .toBe("filled");
  await closeFirstFillPopover(window);
  const meeting = (await meetings(window))[0];
  if (!meeting?.transcript?.savedPath || !meeting.transcript.documentId) {
    throw new Error("The meeting transcript was not saved.");
  }
  return meeting;
}

// protects=the two views of a saved Meeting share the speaker review, Soniox is named with the audio and its cost before confirmation, pending work can be cancelled and late results are ignored, named speakers are preserved, the original line can be heard, and a choice is undoable; fails_when=opening or declining sends audio, a cancelled result reappears, the wrong line changes, or the kept line changes; no_claim=which person Soniox heard.
test("A saved Meeting asks before speaker review and shares its per-line choices between views", async () => {
  const dataDir = await createDataFolder();
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  try {
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await chooseLocalChatModel(window);
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.updateSettings({ device: { meetingNoticeAccepted: true } });
    });
    const meeting = await savedMeeting(window);
    const documentId = meeting.transcript?.documentId;
    const savedPath = meeting.transcript?.savedPath;
    if (!documentId || !savedPath) throw new Error("Missing transcript.");
    const { contentHash } = await window.evaluate(
      (id) =>
        (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.readDocumentText(id),
      documentId,
    );
    const cues = readVtt(await readFile(savedPath, "utf8"))
      .cues.filter((cue) => cue.speaker === "Them")
      .slice(0, 3);
    expect(cues).toHaveLength(3);
    const result = {
      documentId,
      contentHash,
      suggestions: cues.map(({ startMs, endMs, text }) => ({
        startMs,
        endMs,
        text,
        fileLabel: "Them",
        currentLabel: "Them",
        suggestedLabel: "Speaker 2",
      })),
    };
    const metadata: TranscriptSpeakers = { labels: { Them: "Dana" }, lines: {} };
    const setSpeakers = (speakers: TranscriptSpeakers) =>
      window.evaluate(
        (input) =>
          (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.setTranscriptSpeakers(
            input,
          ),
        { documentId, speakers },
      );
    await setSpeakers(metadata);
    const runs = await reviewService(app, meeting.id, result);
    await runCommand(window, "meeting.showTranscript", "Show the Transcript");
    const embedded = window.getByTestId("meeting-note-transcript");
    const trigger = embedded.getByRole("button", { name: "Review speakers…" });
    await pointAndClick(window, trigger);
    const panel = embedded.getByRole("region", { name: "Review speakers" });
    await expect(panel).toContainText("Send this meeting’s computer audio to Soniox");
    await expect(panel).toContainText("Your microphone track stays here.");
    await expect(panel).toContainText("Under $0.01");
    expect(await runs()).toBe(0);
    await shot(window, "speaker-review-confirm-en-wide");
    await window.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(panel).toHaveCount(0);
    expect(await runs()).toBe(0);

    await runCommand(window, "meeting.reviewSpeakers", "Review speakers…");
    await expect(panel).toBeFocused();
    await panel.getByRole("button", { name: "Send to Soniox and review" }).press("Enter");
    await expect(panel.getByText("Reviewing speakers…")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel review" }).press("Enter");
    await expect(panel.getByText("Speaker review cancelled.")).toBeVisible();
    expect(await runs()).toBe(1);
    await panel.getByRole("button", { name: "Try again" }).press("Enter");
    await panel.getByRole("button", { name: "Send to Soniox and review" }).press("Enter");
    await expect(panel.getByRole("listitem")).toHaveCount(3);
    await expect(panel.getByRole("listitem").first()).toContainText("Dana → Speaker 2");
    await expect(panel.getByRole("listitem").first()).toContainText(
      result.suggestions[0]?.text ?? "",
    );

    const beside = embedded.getByTestId("meeting-transcript-beside");
    await pointAndClick(window, beside);
    const externalTrigger = window.getByRole("button", { name: "Review speakers…" }).last();
    await pointAndClick(window, externalTrigger);
    const external = window.getByRole("region", { name: "Review speakers" });
    await expect(external.getByRole("listitem")).toHaveCount(3);
    await expect(panel).toHaveCount(0);
    const second = result.suggestions[1];
    if (!second) throw new Error("Missing second line.");
    await setSpeakers({
      ...metadata,
      lines: { [lineKey(second.startMs, second.fileLabel)]: "Speaker 3" },
    });
    await expect(external.getByRole("listitem").nth(1)).toContainText(
      "This line changed since the review.",
    );
    await external
      .getByRole("button", { name: /^Listen from / })
      .first()
      .press("Enter");
    await expect(window.getByTestId("transcript-player")).toBeVisible();

    await external
      .getByRole("listitem")
      .first()
      .getByRole("button", { name: "Accept" })
      .press("Enter");
    await expect(external.getByRole("listitem").first()).toContainText("Accepted");
    await external
      .getByRole("listitem")
      .nth(2)
      .getByRole("button", { name: "Keep current speaker" })
      .press("Enter");
    await expect(external.getByRole("listitem").nth(2)).toContainText("Current speaker kept");
    await expect(window.getByTestId("undo-line")).toContainText("Speaker 2");
    await window.keyboard.press("ControlOrMeta+z");
    const kept = () =>
      window.evaluate(async (id) => {
        const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        return (await api.listDocuments()).find((document) => document.id === id)?.speakers;
      }, documentId);
    await expect.poll(kept).toEqual({
      labels: metadata.labels,
      lines: { [lineKey(second.startMs, second.fileLabel)]: "Speaker 3" },
    });
    expect(await runs()).toBe(2);

    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 720);
    const chinese = window.getByRole("region", { name: "复核发言人" });
    await expect(chinese.getByText("逐条确认发言人修改建议。")).toBeVisible();
    await expect(chinese.getByText("这行在复核后已更改。")).toBeVisible();
    const rect = await chinese.boundingBox();
    expect(rect && rect.x + rect.width).toBeLessThanOrEqual(900);
    await shot(window, "speaker-review-results-zh-narrow");
  } finally {
    await app.close();
    await removeDataFolder(dataDir);
  }
});
