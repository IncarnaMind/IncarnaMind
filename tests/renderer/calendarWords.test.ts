import { describe, expect, test } from "vitest";
import type { CalendarAccount, CalendarAttendee, CalendarEvent } from "../../src/core/api";
import {
  accountDetail,
  COMING_UP_SHOWN,
  comingUpRows,
  comingUpSpan,
  initialsOf,
  inviteNames,
  problemOf,
  rowTime,
  shortName,
  startsIn,
  whenLine,
  withLine,
} from "../../src/renderer/src/calendarWords";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const zh = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);
const H24 = { twelveHour: false };

/** Monday 9 November 2026, 09:00 on this computer's clock, whatever its zone. */
const NOW = new Date(2026, 10, 9, 9, 0);
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();

const person = (name: string, extra: Partial<CalendarAttendee> = {}): CalendarAttendee => ({
  name,
  email: null,
  self: false,
  ...extra,
});

const ME = person("Priya Raman", { self: true, email: "priya@example.com" });

function meeting(id: string, start: string, end: string, attendees = [ME]): CalendarEvent {
  return {
    id,
    title: `Meeting ${id}`,
    startsAt: start,
    endsAt: end,
    attendees,
    joinUrl: null,
    service: "google",
    mindId: null,
  };
}

describe("Coming up", () => {
  test("reads from now to the end of tomorrow on this computer's calendar", () => {
    const span = comingUpSpan(NOW);
    expect(span.from).toBe(NOW.toISOString());
    expect(span.to).toBe(new Date(2026, 10, 11).toISOString());
  });

  test("shows today's and tomorrow's Meetings that haven't ended, the first first, four at most", () => {
    const events = [
      meeting("later", at(10, 14), at(10, 15)),
      meeting("ended", at(9, 7), at(9, 8)),
      meeting("going", at(9, 8, 45), at(9, 9, 30)),
      meeting("soon", at(9, 9, 30), at(9, 9, 45)),
      meeting("afterTomorrow", at(11, 9), at(11, 10)),
      meeting("tomorrow", at(10, 9, 30), at(10, 9, 45)),
      meeting("evening", at(9, 18), at(9, 19)),
    ];
    expect(comingUpRows(events, NOW).map((each) => each.id)).toEqual([
      "going",
      "soon",
      "evening",
      "tomorrow",
    ]);
    expect(COMING_UP_SHOWN).toBe(4);
  });

  test("says a time today alone and tomorrow's with the day, in English and Chinese", () => {
    const today = meeting("a", at(9, 9, 30), at(9, 9, 45));
    const tomorrow = meeting("b", at(10, 14), at(10, 14, 30));
    expect(rowTime(today, NOW, "en", en, H24)).toBe("09:30");
    expect(rowTime(tomorrow, NOW, "en", en, H24)).toBe("Tomorrow 14:00");
    expect(rowTime(tomorrow, NOW, "zh-CN", zh, H24)).toBe("明天 14:00");
  });

  test("draws a person's initials as the prototype does: Dana Kim is DK, 张伟 is 伟", () => {
    expect(initialsOf("Dana Kim")).toBe("DK");
    expect(initialsOf("sam")).toBe("S");
    expect(initialsOf("张伟")).toBe("伟");
    expect(initialsOf("lena.ortiz@example.com")).toBe("LO");
    expect(shortName("Dana Kim")).toBe("Dana");
    expect(shortName("张伟")).toBe("张伟");
    expect(shortName("sam@example.com")).toBe("sam");
  });
});

describe("The event's bar", () => {
  const people = [
    ME,
    person("Dana Kim"),
    person("Sam Okafor"),
    person("Lena Ortiz"),
    person("张伟"),
  ];

  test("names who is in it besides the User", () => {
    expect(withLine([ME], en)).toBe("");
    expect(withLine([ME, person("Dana Kim")], en)).toBe("with Dana");
    expect(withLine(people.slice(0, 3), en)).toBe("with Dana and Sam");
    expect(withLine(people, en)).toBe("with Dana, Sam and 2 others");
    expect(withLine(people, zh)).toBe("与 Dana、Sam 等 4 人");
    expect(withLine([ME, person("张伟")], zh)).toBe("与 张伟");
  });

  test("says when it is and with whom, in English and Chinese", () => {
    const standup = { startsAt: at(9, 9, 30), endsAt: at(9, 9, 45), attendees: people };
    expect(whenLine(standup, NOW, "en", en, H24)).toBe(
      "Today, 09:30–09:45 · with Dana, Sam and 2 others",
    );
    expect(whenLine(standup, NOW, "zh-CN", zh, H24)).toBe(
      "今天 09:30–09:45 · 与 Dana、Sam 等 4 人",
    );
    const alone = { startsAt: at(10, 14), endsAt: at(10, 15), attendees: [ME] };
    expect(whenLine(alone, NOW, "en", en, H24)).toBe("Tomorrow, 14:00–15:00");
    const later = { startsAt: at(12, 14), endsAt: at(12, 15), attendees: [ME] };
    expect(whenLine(later, NOW, "en", en, H24)).toBe("12 November, 14:00–15:00");
  });

  test("counts down within the hour, says it is starting for its first minutes, then nothing", () => {
    const standup = { startsAt: at(9, 9, 30), endsAt: at(9, 10) };
    expect(startsIn(standup, new Date(2026, 10, 9, 8, 0), en)).toBeNull();
    expect(startsIn(standup, new Date(2026, 10, 9, 8, 31), en)).toBe("Starts in 59 min");
    expect(startsIn(standup, new Date(2026, 10, 9, 9, 18), en)).toBe("Starts in 12 min");
    expect(startsIn(standup, new Date(2026, 10, 9, 9, 18), zh)).toBe("12 分钟后开始");
    expect(startsIn(standup, new Date(2026, 10, 9, 9, 30), en)).toBe("Starting now");
    expect(startsIn(standup, new Date(2026, 10, 9, 9, 33), zh)).toBe("马上开始");
    expect(startsIn(standup, new Date(2026, 10, 9, 9, 40), en)).toBeNull();
  });
});

describe("Settings › Meetings › Calendars", () => {
  const account = (extra: Partial<CalendarAccount> = {}): CalendarAccount => ({
    id: "a",
    service: "google",
    name: "priya@example.com",
    calendars: [
      { id: "1", name: "Work", counted: true, group: null },
      { id: "2", name: "Family", counted: true, group: null },
      { id: "3", name: "Holidays", counted: false, group: null },
    ],
    syncedAt: at(9, 8, 55),
    problem: null,
    consentServiceId: "https://www.googleapis.com",
    ...extra,
  });

  test("says how many of an account's calendars count", () => {
    expect(accountDetail(account(), en)).toBe("priya@example.com · 2 of 3 calendars count");
    expect(accountDetail(account(), zh)).toBe("priya@example.com · 显示 3 个日历中的 2 个");
    expect(accountDetail(account({ service: "mac", name: null }), en)).toBe(
      "2 of 3 calendars count",
    );
    expect(accountDetail(account({ calendars: [] }), en)).toBe("No calendars");
    expect(
      accountDetail(
        account({ calendars: [{ id: "1", name: "Work", counted: true, group: null }] }),
        en,
      ),
    ).toBe("priya@example.com · 1 of 1 calendar counts");
  });

  test("says each problem in one line with the one action that fixes it", () => {
    const said = (problem: NonNullable<CalendarAccount["problem"]>, extra = {}) =>
      problemOf(account({ problem, ...extra }), problem, "en", en, { ...H24, now: NOW });
    expect(said("offline")).toEqual({
      words: "Couldn’t reach Google Calendar · last read 08:55",
      fix: "sync",
    });
    expect(said("offline", { syncedAt: null }).words).toBe("Couldn’t reach Google Calendar");
    expect(said("sign-in")).toEqual({
      words: "Signed out of Google Calendar",
      fix: "sign-in",
    });
    expect(said("local-mode")).toEqual({
      words: "Paused: “Keep everything on this computer” is on.",
      fix: null,
    });
    expect(said("not-allowed").fix).toBe("allow");
    expect(said("denied", { service: "mac", name: null })).toEqual({
      words:
        "IncarnaMind can’t read your calendars. Allow it in System Settings › Privacy & Security › Calendars.",
      fix: "system-settings",
    });
    expect(said("failed")).toEqual({ words: "Couldn’t read Google Calendar", fix: "sync" });
    expect(
      problemOf(account({ problem: "denied", service: "mac" }), "denied", "zh-CN", zh, H24).words,
    ).toBe("IncarnaMind 没有读取日历的权限。可在“系统设置 › 隐私与安全性 › 日历”中允许。");
  });
});

describe("Speaker names from the invite", () => {
  test("offers the invite's people but the User, and none a Speaker already has", () => {
    const attendees = [
      ME,
      person("Dana Kim"),
      person("Sam Okafor"),
      person("dana kim"),
      person(" "),
      person("张伟"),
    ];
    expect(inviteNames(attendees, ["Me", "Speaker 1", "Sam Okafor"])).toEqual(["Dana Kim", "张伟"]);
    expect(inviteNames([ME], ["Me"])).toEqual([]);
  });
});
