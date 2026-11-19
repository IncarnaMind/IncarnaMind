import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type {
  CoreBridge,
  Meeting,
  MeetingSpeakerReviewResult,
  TranscriptSpeakers,
} from "../src/core/api";
import { readVtt } from "../src/core/documents/formats/vtt";
import { paddedClockTime } from "../src/shared/clock";
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
import { encode, film } from "./feel";

type AudioRead = Parameters<CoreBridge["readMeetingAudio"]>[0];

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
      let cacheReads = 0;
      let release: (() => void) | undefined;
      const channels = [
        "getMeetingSpeakerReview",
        "reviewMeetingSpeakers",
        "cancelMeetingSpeakerReview",
      ];
      for (const method of channels) ipcMain.removeHandler(`core:${method}`);
      ipcMain.handle("core:getMeetingSpeakerReview", (_event, id: string) => {
        if (id !== meetingId) throw new Error("Unexpected meeting.");
        return {
          available: true,
          reason: null,
          durationMs: 9000,
          ...(runs >= 4 ? { cached: true, estimatedUsd: 0 } : { estimatedUsd: 0.003 }),
        };
      });
      ipcMain.handle("core:reviewMeetingSpeakers", (_event, input) => {
        if (input.meetingId !== meetingId || input.confirmed !== true) {
          throw new Error("The upload was not confirmed for this meeting.");
        }
        if (runs >= 4) {
          if (input.reuseOnly !== true)
            throw new Error("The cached review must be read without uploading.");
          cacheReads++;
          return { ...result, suggestions: [] };
        }
        runs++;
        if (runs === 1) {
          return new Promise((resolve) => {
            release = () => resolve(result);
          });
        }
        if (runs === 3) throw new Error("Soniox is temporarily unavailable.");
        return runs === 4 ? { ...result, suggestions: [] } : result;
      });
      ipcMain.handle("core:cancelMeetingSpeakerReview", (_event, id: string) => {
        if (id !== meetingId) throw new Error("Unexpected meeting.");
        release?.();
      });
      const audioReads: AudioRead[] = [];
      const audioChannel = "core:readMeetingAudio";
      const handler = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (event: unknown, input: AudioRead) => unknown>;
        }
      )._invokeHandlers.get(audioChannel);
      if (!handler) throw new Error("The audio handler is missing.");
      ipcMain.removeHandler(audioChannel);
      ipcMain.handle(audioChannel, (event, input: AudioRead) => {
        audioReads.push(input);
        return handler(event, input);
      });
      Object.assign(globalThis, {
        speakerReviewActivity: () => ({ runs, cacheReads, audioReads }),
      });
    },
    { meetingId, result },
  );
  return () =>
    app.evaluate(() =>
      (
        globalThis as unknown as {
          speakerReviewActivity(): { runs: number; cacheReads: number; audioReads: AudioRead[] };
        }
      ).speakerReviewActivity(),
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
  const artifacts = process.env.INCARNAMIND_SCREENSHOTS;
  let stopFilming: (() => Promise<void>) | undefined;
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
    const activity = await reviewService(app, meeting.id, result);
    await runCommand(window, "meeting.showTranscript", "Show the Transcript");
    const embedded = window.getByTestId("meeting-note-transcript");
    const trigger = embedded.getByRole("button", { name: "Review speakers…" });
    if (artifacts) stopFilming = await film(window, resolve(artifacts, "speaker-review-frames"));
    await pointAndClick(window, trigger);
    const panel = embedded.getByRole("region", { name: "Review speakers" });
    await expect(panel).toContainText("Send this meeting’s computer audio to Soniox");
    await expect(panel).toContainText("Your microphone track stays here.");
    await expect(panel).toContainText("Under $0.01");
    expect((await activity()).runs).toBe(0);
    await shot(window, "speaker-review-confirm-en-wide");
    await window.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(panel).toHaveCount(0);
    expect((await activity()).runs).toBe(0);

    await runCommand(window, "meeting.reviewSpeakers", "Review speakers…");
    await expect(panel).toBeFocused();
    await panel.getByRole("button", { name: "Send to Soniox and review" }).press("Enter");
    await expect(panel.getByText("Reviewing speakers…")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel review" }).press("Enter");
    await expect(panel.getByText("Speaker review cancelled.")).toBeVisible();
    expect((await activity()).runs).toBe(1);
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
    const listened = result.suggestions[2];
    if (!listened || listened.startMs === 0) throw new Error("Missing a later line to play.");
    const clip = {
      meetingId: meeting.id,
      fromMs: listened.startMs,
      toMs: listened.endMs,
      source: "system",
    };
    await window.evaluate(() => {
      const sources: AudioBufferSourceNode[] = [];
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        const source = create.call(this);
        sources.push(source);
        return source;
      };
      Object.assign(globalThis, { reviewAudioSources: sources });
    });
    await external
      .getByRole("listitem")
      .nth(2)
      .getByRole("button", { name: /^Listen to computer audio from / })
      .press("Enter");
    const player = window.getByTestId("transcript-player");
    await expect(player).toBeVisible();
    await expect.poll(async () => (await activity()).audioReads).toEqual([clip]);
    // Keep the replay check independent of the machine's audio renderer.
    await expect
      .poll(() =>
        window.evaluate(() => {
          const { reviewAudioSources } = globalThis as unknown as {
            reviewAudioSources: AudioBufferSourceNode[];
          };
          return reviewAudioSources.length;
        }),
      )
      .toBe(1);
    await window.evaluate(() => {
      const { reviewAudioSources } = globalThis as unknown as {
        reviewAudioSources: AudioBufferSourceNode[];
      };
      reviewAudioSources[0]?.dispatchEvent(new Event("ended"));
    });
    const end = paddedClockTime(listened.endMs);
    await expect(player.getByTestId("transcript-player-time")).toHaveText(`${end} / ${end}`);
    await expect(player).not.toHaveAttribute("data-playing", "true");
    const togglePlayer = player.getByTestId("transcript-player-toggle");
    await togglePlayer.press("Enter");
    await expect.poll(async () => (await activity()).audioReads).toEqual([clip, clip]);
    await expect(player).toHaveAttribute("data-playing", "true");
    await togglePlayer.press("Enter");
    await expect(player).not.toHaveAttribute("data-playing", "true");
    await togglePlayer.press("Enter");
    await expect(player).toHaveAttribute("data-playing", "true");
    expect((await activity()).audioReads).toEqual([clip, clip]);

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
    expect((await activity()).runs).toBe(2);
    if (artifacts && stopFilming) {
      await stopFilming();
      stopFilming = undefined;
      await encode(
        resolve(artifacts, "speaker-review-frames"),
        resolve(artifacts, "speaker-review.mp4"),
      );
    }

    await setLanguage(window, "zh-CN");
    await setWindowSize(app, window, 900, 720);
    const chinese = window.getByRole("region", { name: "复核发言人" });
    await expect(chinese.getByText("逐条确认发言人修改建议。")).toBeVisible();
    await expect(chinese.getByText("这行在复核后已更改。")).toBeVisible();
    const rect = await chinese.boundingBox();
    expect(rect && rect.x + rect.width).toBeLessThanOrEqual(900);
    await shot(window, "speaker-review-results-zh-narrow");
    const keptRow = chinese.getByText("已保留当前发言人", { exact: true });
    await keptRow.scrollIntoViewIfNeeded();
    await expect(keptRow).toBeInViewport();

    await window.evaluate(async (mindId) => {
      const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await api.deleteMind(mindId);
    }, meeting.mindId);
    await expect.poll(async () => (await meetings(window)).length).toBe(0);
    await expect(chinese).toHaveCount(0);
    await window.evaluate(async (mindId) => {
      const api = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await api.restore([{ kind: "mind", id: mindId }], { reopen: true });
    }, meeting.mindId);
    await expect.poll(async () => (await meetings(window)).length).toBe(1);
    const note = window
      .getByTestId("mind-list-item")
      .and(window.locator(`[data-mind-id="${meeting.mindId}"]`));
    await pointAndClick(window, note);
    await pointAndClick(window, window.getByTestId("meeting-view-chip"));
    await pointAndClick(window, window.getByTestId("meeting-view-transcript"));
    const restored = window.getByTestId("meeting-note-transcript");
    await restored.getByRole("button", { name: "复核发言人…" }).press("Enter");
    await expect(restored.getByRole("button", { name: "发送给 Soniox 并复核" })).toBeVisible();
    await expect(
      restored.getByRole("region", { name: "复核发言人" }).getByRole("listitem"),
    ).toHaveCount(0);
    expect((await activity()).runs).toBe(2);
    await restored.getByRole("button", { name: "发送给 Soniox 并复核" }).press("Enter");
    await expect(restored.getByText("未能完成发言人复核。")).toBeVisible();
    await restored.getByRole("button", { name: "重试" }).press("Enter");
    await restored.getByRole("button", { name: "发送给 Soniox 并复核" }).press("Enter");
    await expect(restored.getByText("没有发言人修改建议。")).toBeVisible();
    await restored.getByRole("button", { name: "重新复核…" }).press("Enter");
    await expect(restored.getByText("已有复核结果，无需重新上传或付费。")).toBeVisible();
    await restored.getByRole("button", { name: "查看已有建议" }).press("Enter");
    await expect(restored.getByText("没有发言人修改建议。")).toBeVisible();
    expect(await activity()).toMatchObject({ runs: 4, cacheReads: 1 });
  } finally {
    await stopFilming?.();
    await app.close();
    await removeDataFolder(dataDir);
  }
});
