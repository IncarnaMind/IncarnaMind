import { DOMParser } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Meeting } from "../../src/core/api";
import {
  audioSaid,
  canKeepAudio,
  stoppedBeforeEndSaid,
  useAudioSaid,
} from "../../src/renderer/src/meetingAudioWords";
import { translate } from "../../src/shared/i18n";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

const meeting = (audio: Partial<Meeting["audio"]>): Meeting =>
  ({
    status: "stopped",
    audio: { kept: true, expiresAt: null, deletedAt: null, keptUntilDeleted: false, ...audio },
  }) as Meeting;

describe("A Meeting's audio line (#687)", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Europe/London";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  // protects=the line's three states in English and Chinese, as the issue words them: kept until a time today, tomorrow or on a later day, kept until the User deletes it, and deleted on a date; Keep audio only while the audio would go; fails_when=a state reads otherwise, the day is counted in hours, or Keep audio is offered for kept or deleted audio; no_claim=where the line shows, which the window spec covers.
  test("says until when, that it is kept, or when it was deleted, in both languages", () => {
    const now = { now: new Date("2026-10-14T16:00:00+01:00"), twelveHour: false };
    const tomorrow = meeting({ expiresAt: "2026-10-15T09:54:00+01:00" });
    expect(audioSaid(tomorrow, en, "en", now)).toBe("Audio kept until 09:54 tomorrow");
    expect(audioSaid(tomorrow, zh, "zh-CN", now)).toBe("音频保留到明天 09:54");
    expect(canKeepAudio(tomorrow)).toBe(true);
    const today = meeting({ expiresAt: "2026-10-14T23:30:00+01:00" });
    expect(audioSaid(today, en, "en", now)).toBe("Audio kept until 23:30 today");
    expect(audioSaid(today, zh, "zh-CN", now)).toBe("音频保留到今天 23:30");
    const later = meeting({ expiresAt: "2026-10-16T09:00:00+01:00" });
    expect(audioSaid(later, en, "en", now)).toBe("Audio kept until 16 Oct, 09:00");

    const kept = meeting({ keptUntilDeleted: true });
    expect(audioSaid(kept, en, "en", now)).toBe("Audio kept");
    expect(audioSaid(kept, zh, "zh-CN", now)).toBe("音频已保留");
    expect(canKeepAudio(kept)).toBe(false);

    const deleted = meeting({ kept: false, deletedAt: "2026-10-14T09:00:00Z" });
    expect(audioSaid(deleted, en, "en", now)).toBe("Audio deleted on 14 Oct");
    expect(audioSaid(deleted, zh, "zh-CN", now)).toBe("音频已于10月14日删除");
    expect(canKeepAudio(deleted)).toBe(false);
    expect(audioSaid(meeting({ kept: false }), en, "en", now)).toBe("No audio was recorded");
  });
});

describe("A stopped Meeting whose transcription stopped before its end (#2957)", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Europe/London";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const at = (now: string) => ({ now: new Date(now), twelveHour: false });

  // protects=the line says the recording is kept only while its audio is, and until when, as the audio line words the day; audio deleted, or whose time has come and the sweep hasn't deleted yet, gets the plain line; fails_when=the line promises a recording that is gone or about to go, or names the wrong day; no_claim=where the line shows, which the window spec covers.
  test.each([
    [
      "kept until the User deletes it",
      meeting({ keptUntilDeleted: true }),
      at("2026-10-14T16:00:00+01:00"),
      "Transcription stopped before the end. Your recording is kept.",
      "转写中途停止，录音已保留。",
    ],
    [
      "due to be deleted today",
      meeting({ expiresAt: "2026-10-14T23:30:00+01:00" }),
      at("2026-10-14T16:00:00+01:00"),
      "Transcription stopped before the end. Your recording is kept until 23:30 today.",
      "转写中途停止，录音保留到今天 23:30。",
    ],
    [
      "due to be deleted tomorrow",
      meeting({ expiresAt: "2026-10-15T09:54:00+01:00" }),
      at("2026-10-14T16:00:00+01:00"),
      "Transcription stopped before the end. Your recording is kept until 09:54 tomorrow.",
      "转写中途停止，录音保留到明天 09:54。",
    ],
    [
      "already deleted",
      meeting({ kept: false, deletedAt: "2026-10-14T09:00:00Z" }),
      at("2026-10-14T16:00:00+01:00"),
      "Transcription stopped.",
      "转写已停止。",
    ],
    [
      "past its time a few minutes ago, not deleted yet",
      meeting({ expiresAt: "2026-10-14T15:55:00+01:00" }),
      at("2026-10-14T16:00:00+01:00"),
      "Transcription stopped.",
      "转写已停止。",
    ],
    [
      "past its time before midnight, not deleted yet",
      meeting({ expiresAt: "2026-10-14T23:55:00+01:00" }),
      at("2026-10-15T00:10:00+01:00"),
      "Transcription stopped.",
      "转写已停止。",
    ],
  ])("%s", (_state, stopped, now, english, chinese) => {
    expect(stoppedBeforeEndSaid(stopped, en, "en", now)).toBe(english);
    expect(stoppedBeforeEndSaid(stopped, zh, "zh-CN", now)).toBe(chinese);
  });
});

describe("The audio line across midnight (#687)", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  // protects=the line shown reads the clock again every minute, so "tomorrow" becomes "today" at midnight with nothing else changing; fails_when=the line keeps the day it was first drawn on; no_claim=the popover's own drawing, which the window spec covers.
  test('"tomorrow" turns to "today" at midnight on its own', async () => {
    process.env.TZ = "Europe/London";
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-14T23:58:30+01:00"));
    const document = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", document.defaultView);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div", {});
    document.body.append(container);
    const kept = meeting({ expiresAt: "2026-10-15T09:54:00+01:00" });
    function Line() {
      return createElement("p", null, useAudioSaid(kept, en, "en"));
    }
    const root = createRoot(container);
    await act(() => root.render(createElement(Line)));
    expect(container.textContent).toMatch(/ tomorrow$/);
    await act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(container.textContent).toMatch(/ today$/);
    await act(() => root.unmount());
  });
});
