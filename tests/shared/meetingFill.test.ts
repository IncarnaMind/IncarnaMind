import { describe, expect, test } from "vitest";
import type { MeetingFill } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { isPartialMeetingFill } from "../../src/shared/meetingFill";

const fillOf = (fill: Partial<MeetingFill> = {}): MeetingFill => ({
  state: "filled",
  mode: "sections",
  local: false,
  problem: null,
  ...fill,
});

describe("partial meeting-fill status", () => {
  test("no fill and old complete fills have no incompleteness signal", () => {
    expect(isPartialMeetingFill(null)).toBe(false);
    expect(isPartialMeetingFill(fillOf())).toBe(false);
    expect(isPartialMeetingFill(fillOf({ omitted: 0, unfinishedParts: 0 }))).toBe(false);
  });

  test.each([
    { omitted: 1 },
    { omitted: 3 },
    { unfinishedParts: 1 },
    { unfinishedParts: 2 },
    { problem: { kind: "model", message: "Unknown-size malformed frame" } },
    { omitted: 1, unfinishedParts: 2 },
  ] satisfies Partial<MeetingFill>[])("recognizes the producer's signal %j", (fill) => {
    expect(isPartialMeetingFill(fillOf(fill))).toBe(true);
  });

  test.each([
    ["en", "Notes partly filled in for Project review"],
    ["zh-CN", "已为“Project review”补全部分笔记"],
  ] as const)("the partial notification in %s preserves the meeting's name", (language, text) => {
    expect(translate(language, "meetings.fill.notify.partial", { meeting: "Project review" })).toBe(
      text,
    );
  });
});
