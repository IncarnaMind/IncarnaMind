import { describe, expect, test } from "vitest";
import type { Checkpoint } from "../../src/core/api";
import {
  beforeAiChange,
  byDay,
  reasonLabel,
  versionLabel,
} from "../../src/renderer/src/historyLabels";
import { translate } from "../../src/shared/i18n";

/* What History's picker says of each version, in English and Chinese. */

const now = new Date(2026, 9, 9, 17, 0);
const checkpoint = (id: string, at: Date, reason: Checkpoint["reason"]): Checkpoint => ({
  id,
  mindId: "mind",
  reason,
  createdAt: at.toISOString(),
  name: null,
  file: null,
});
const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

describe("History's labels", () => {
  test("a version is its day and time, and why it was saved unless it was a pause", () => {
    const accepted = checkpoint("a", new Date(2026, 9, 9, 10, 42), "accept");
    expect(versionLabel(accepted, now, "en", en)).toMatch(/^Friday 9 Oct, 10:42( am)?$/);
    expect(reasonLabel(accepted, en)).toBe("before AI edits");
    expect(versionLabel(accepted, now, "zh-CN", zh)).toMatch(/^10月9日星期五 (上午)?10:42$/);
    expect(reasonLabel(accepted, zh)).toBe("接受修订前");
    const idle = checkpoint("b", new Date(2026, 9, 9, 10, 31), "idle");
    expect(reasonLabel(idle, en)).toBeNull();
    // Last year's says its year.
    expect(
      versionLabel(checkpoint("c", new Date(2025, 11, 31, 9, 5), "idle"), now, "en", en),
    ).toMatch(/^Wednesday, 31 Dec 2025, (09:05|9:05 am)$/);
  });

  test("the spark marks those saved before an AI change, not a pause, a restore or a person's changes", () => {
    expect(beforeAiChange({ reason: "accept" })).toBe(true);
    expect(beforeAiChange({ reason: "regenerate" })).toBe(true);
    expect(beforeAiChange({ reason: "compare" })).toBe(true);
    expect(beforeAiChange({ reason: "idle" })).toBe(false);
    expect(beforeAiChange({ reason: "restore" })).toBe(false);
    expect(beforeAiChange({ reason: "others" })).toBe(false);
  });

  test("versions group by the day they were saved, newest first", () => {
    const list = [
      checkpoint("a", new Date(2026, 9, 9, 16, 5), "idle"),
      checkpoint("b", new Date(2026, 9, 9, 15, 12), "enhance"),
      checkpoint("c", new Date(2026, 9, 8, 18, 30), "others"),
    ];
    expect(
      byDay(list, now, "en").map((group) => [group.day, group.checkpoints.map((each) => each.id)]),
    ).toEqual([
      ["Friday 9 Oct", ["a", "b"]],
      ["Thursday 8 Oct", ["c"]],
    ]);
  });
});
