import { describe, expect, test } from "vitest";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

/**
 * Why a request in a Note's conversation didn't run (#3765): one line of what happened, its action
 * a button of its own, and never a terminal, which the User never has to open.
 */
const lines = (messages: Record<string, string>) =>
  Object.entries(messages).filter(([key]) => key.startsWith("noteAsk.problem."));

describe("the lines that say why a request in a Note didn't run", () => {
  test.each([
    ["en", lines(en), /terminal/i],
    ["zh-CN", lines(zhCN), /终端/],
  ] as const)("%s: no line names a terminal", (_language, each, terminal) => {
    expect(each.length).toBeGreaterThan(10);
    expect(each.filter(([, text]) => terminal.test(text))).toEqual([]);
  });

  test("a line whose action is Try again doesn't say it again in its words", () => {
    for (const key of [
      "noteAsk.problem.plan-limit",
      "noteAsk.problem.timeout",
      "noteAsk.problem.stalled",
      "noteAsk.problem.compaction",
      "noteAsk.problem.failed",
      "noteAsk.problem.outside",
      "noteAsk.problem.unreadable",
      "noteAsk.problem.service",
    ] as const) {
      expect(en[key]).not.toMatch(/try again|send it again/i);
      expect(zhCN[key]).not.toMatch(/再试|再发送/);
    }
  });
});
