import { describe, expect, test } from "vitest";
import type { CaptureHealth, CaptureHealthEvent, Meeting } from "../../src/core/api";
import { captureLines, unsavedAudioMs } from "../../src/renderer/src/captureHealth";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/* A Meeting's recording details (#161), as they read in English and Chinese. */

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);
const AT = "2026-10-06T09:00:00.000Z";

const meetingWith = (
  health: Partial<CaptureHealth>,
  {
    transcribed = true,
    saveError = null,
  }: { transcribed?: boolean; saveError?: string | null } = {},
): Meeting =>
  ({
    id: "m1",
    saveError,
    transcript: transcribed ? { state: "live" } : null,
    health: { realTimeFactor: null, measuredMs: 0, keepsUp: null, events: [], ...health },
  }) as Meeting;

const EVENTS: CaptureHealthEvent[] = [
  { at: AT, atMs: 64_000, kind: "switched", from: "local", to: "cloud", reason: "behind" },
  {
    at: AT,
    atMs: 70_000,
    kind: "audioLost",
    source: "microphone",
    cause: "full",
    durationMs: 20_000,
  },
  { at: AT, atMs: 70_000, kind: "audioLost", source: "system", cause: "full", durationMs: 10_000 },
  { at: AT, atMs: 95_000, kind: "restarted", gapMs: 3_400 },
  { at: AT, atMs: 120_000, kind: "notTranscribed", durationMs: 400 },
  { at: AT, atMs: 130_000, kind: "behind" },
  { at: AT, atMs: 150_000, kind: "switched", from: "cloud", to: "local", reason: "failed" },
  { at: AT, atMs: 180_000, kind: "audioRecovered", parts: 4, durationMs: 30_000 },
  {
    at: AT,
    atMs: 190_000,
    kind: "audioLost",
    source: "microphone",
    cause: "stalled",
    durationMs: 1_500,
  },
];

describe("A Meeting's recording details", () => {
  test("how fast it was transcribed, then what happened, each at its time in the Meeting", () => {
    const meeting = meetingWith({
      realTimeFactor: 0.42,
      measuredMs: 60_000,
      keepsUp: true,
      events: EVENTS,
    });
    expect(captureLines(meeting, en).map(({ atMs, text }) => [atMs, text])).toEqual([
      [null, "Transcribed on this computer at 2.4× real time"],
      [64_000, "Switched to cloud transcription: this computer fell behind"],
      [70_000, "20 s of microphone audio lost: the disk was full"],
      [70_000, "10 s of the computer’s sound lost: the disk was full"],
      [95_000, "Transcription restarted, leaving a 3 s gap"],
      [120_000, "1 s of speech couldn’t be transcribed"],
      [130_000, "Live text fell behind; the rest is transcribed after the meeting"],
      [150_000, "Switched back to transcribing on this computer: the cloud dropped"],
      [180_000, "IncarnaMind closed while recording; the 30 s saved before then was recovered"],
      [190_000, "2 s of microphone audio lost: no sound came in"],
    ]);
    expect(captureLines(meeting, zh).map(({ text }) => text)).toEqual([
      "在这台电脑上转写，速度是实时的 2.4 倍",
      "已改用云端转写：这台电脑跟不上",
      "丢失了 20 秒麦克风音频：磁盘已满",
      "丢失了 10 秒电脑声音：磁盘已满",
      "转写已重新启动，留下 3 秒空缺",
      "有 1 秒的语音无法转写",
      "实时转写跟不上，其余部分在会议结束后转写",
      "已改回在这台电脑上转写：云端连接中断",
      "录制时 IncarnaMind 关闭了，已恢复此前保存的 30 秒",
      "丢失了 2 秒麦克风音频：这段时间没有收到声音",
    ]);
  });

  test("a slow computer says it can't keep up; nothing measured or lost says so", () => {
    const slow = meetingWith({ realTimeFactor: 2, measuredMs: 30_000, keepsUp: false });
    expect(captureLines(slow, en).map((line) => line.text)).toEqual([
      "Transcribed here at 0.5× real time, too slow to keep up",
      "No audio was lost",
    ]);
    expect(captureLines(slow, zh)[0]?.text).toBe("在这台电脑上转写，速度是实时的 0.5 倍，跟不上");
    expect(captureLines(meetingWith({}), zh).map((line) => line.text)).toEqual([
      "尚未测出转写速度",
      "没有丢失音频",
    ]);
    // Where this copy can't transcribe, there is no speed to tell.
    expect(
      captureLines(meetingWith({}, { transcribed: false }), en).map((line) => line.text),
    ).toEqual(["No audio was lost"]);
  });

  test("the problem line counts the audio that couldn't be saved once, and waits while saving still fails", () => {
    const meeting = meetingWith({ events: EVENTS });
    // The microphone's 20 s and the computer's sound's 10 s at the same time; a crash and a stall don't count.
    expect(unsavedAudioMs(meeting)).toBe(20_000);
    expect(unsavedAudioMs(meetingWith({ events: EVENTS }, { saveError: "No space left" }))).toBe(0);
    expect(en("meetings.health.unsaved", { duration: "20 s" })).toBe(
      "20 s of audio couldn’t be saved, so it’s not transcribed.",
    );
    expect(zh("meetings.health.unsaved", { duration: "20 秒" })).toBe(
      "有 20 秒的音频无法保存，转写稿中缺少这部分。",
    );
  });
});
