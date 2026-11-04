import { describe, expect, test } from "vitest";
import type { DeletedItem } from "../../src/core/api";
import { daysLeft, lostSentences, whenDeleted } from "../../src/renderer/src/deletedItems";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * What Recently deleted shows of an item, with the clock given rather than read:
 * the days left, when it was deleted, and what a confirmation says is lost.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00");
const ago = (ms: number): Pick<DeletedItem, "deletedAt"> => ({
  deletedAt: new Date(NOW.getTime() - ms).toISOString(),
});

describe("days left", () => {
  test("30 on the day it was deleted, one fewer each day, and never below 1 while listed", () => {
    expect(daysLeft(ago(0), NOW)).toBe(30);
    expect(daysLeft(ago(DAY), NOW)).toBe(29);
    expect(daysLeft(ago(10 * DAY + 1000), NOW)).toBe(20);
    expect(daysLeft(ago(29 * DAY + 1000), NOW)).toBe(1);
    expect(daysLeft(ago(30 * DAY - 1000), NOW)).toBe(1);
    expect(daysLeft(ago(31 * DAY), NOW)).toBe(1);
  });
});

describe("when it was deleted", () => {
  const say = (language: "en" | "zh-CN") => (key: MessageKey, params?: MessageParams) =>
    translate(language, key, params);

  test("says Today with the time, Yesterday, then the date, in each language", () => {
    expect(whenDeleted(ago(60 * 60 * 1000), NOW, "en", say("en"))).toMatch(/^Today, \d/);
    expect(whenDeleted(ago(24 * 60 * 60 * 1000), NOW, "en", say("en"))).toBe("Yesterday");
    expect(whenDeleted(ago(24 * 60 * 60 * 1000), NOW, "zh-CN", say("zh-CN"))).toBe("昨天");
    expect(whenDeleted(ago(8 * DAY), NOW, "en", say("en"))).toBe("4 Oct");
    expect(whenDeleted(ago(8 * DAY), NOW, "zh-CN", say("zh-CN"))).toContain("10月");
    expect(whenDeleted(ago(400 * DAY), NOW, "en", say("en"))).toMatch(/2025/);
  });
});

describe("what a confirmation says is lost", () => {
  const name = (item: { name: string }) => item.name;

  test("names one of a kind and counts several, each kind once, Documents first", () => {
    const items = [
      { kind: "tag", name: "Shortlist" },
      { kind: "document", name: "Invoice 4471" },
      { kind: "document", name: "Lease" },
      { kind: "mind", name: "Budget" },
    ] as const;
    expect(lostSentences(items, name)).toEqual([
      { key: "deleted.lost.document", params: { count: 2 } },
      { key: "deleted.lost.mind.one", params: { name: "Budget" } },
      { key: "deleted.lost.tag.one", params: { name: "Shortlist" } },
    ]);
  });

  test("reads as the issue says, in both languages", () => {
    const items = [
      { kind: "document", name: "A" },
      { kind: "document", name: "B" },
      { kind: "document", name: "C" },
    ] as const;
    const [sentence] = lostSentences(items, name);
    if (!sentence) throw new Error("No sentence.");
    expect(translate("en", sentence.key, sentence.params)).toBe(
      "IncarnaMind forgets the text it read from 3 Documents and their Tags.",
    );
    expect(translate("en", "deleted.confirm.foot")).toBe(
      "This can’t be undone. Your files stay where they are.",
    );
    expect(translate("zh-CN", sentence.key, sentence.params)).toContain("3 个文档");
  });
});

describe("what a Meeting's note loses with it (#1253)", () => {
  const name = (item: { name: string }) => item.name;
  const say =
    (language: "en" | "zh-CN") => (sentence: { key: MessageKey; params: MessageParams }) =>
      translate(language, sentence.key, sentence.params);

  test("its recording, its Transcript or both, after the note's own sentence; a plain note says only its text", () => {
    const meeting = (recording: boolean, transcript: boolean) =>
      ({ kind: "mind", name: "Weekly call", meeting: { recording, transcript } }) as const;
    const plain = { kind: "mind", name: "Tide tables" } as const;

    expect(lostSentences([meeting(true, true)], name).map(say("en"))).toEqual([
      "Your text in “Weekly call” is gone.",
      "Its recording and Transcript are deleted too.",
    ]);
    expect(lostSentences([meeting(false, true)], name).map(say("zh-CN"))).toEqual([
      "“Weekly call”中你写的内容将丢失。",
      "会议的转写稿也将彻底删除。",
    ]);
    expect(lostSentences([meeting(true, false)], name).map(say("en"))).toEqual([
      "Your text in “Weekly call” is gone.",
      "Its recording is deleted too.",
    ]);
    expect(lostSentences([plain], name).map(say("en"))).toEqual([
      "Your text in “Tide tables” is gone.",
    ]);
    expect(lostSentences([plain, meeting(true, false)], name).map(say("zh-CN"))).toEqual([
      "这 2 篇笔记中你写的内容将丢失。",
      "其中会议的录音也将彻底删除。",
    ]);
  });
});
