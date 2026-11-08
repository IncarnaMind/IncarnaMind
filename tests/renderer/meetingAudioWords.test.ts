import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Meeting } from "../../src/core/api";
import { audioSaid, canKeepAudio } from "../../src/renderer/src/meetingAudioWords";
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
