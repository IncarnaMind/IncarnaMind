import { describe, expect, test } from "vitest";
import { limitReason, stoppedLine } from "../../src/renderer/src/limitWords";
import type { Translate } from "../../src/renderer/src/objects";
import { translate } from "../../src/shared/i18n";

const en: Translate = (key, params) => translate("en", key, params);
const zh: Translate = (key, params) => translate("zh-CN", key, params);

describe("a limit's words on a sentence's card and under its Answer (#2311, #2962)", () => {
  test("the monthly cap is named with no amount, as the cap set now may not be the one that stopped the check", () => {
    expect(limitReason(en, "monthly-limit", "$0.25", null)).toBe(
      "Not checked: your monthly limit was reached before this sentence.",
    );
    expect(limitReason(zh, "monthly-limit", "$0.25", null)).toBe(
      "未核对：核对到这句之前，已达每月上限。",
    );
    expect(limitReason(en, "monthly-limit-unfinished", "$0.25", "Claude Fable 5")).toBe(
      "Not checked: your monthly limit was reached before Claude Fable 5 finished checking this sentence.",
    );
    expect(limitReason(zh, "monthly-limit-unfinished", "$0.25", "Claude Fable 5")).toBe(
      "未核对：Claude Fable 5 还没核对完这句，就已达每月上限。",
    );
    expect(limitReason(en, "monthly-limit-unfinished", "$0.25", null)).toBe(
      "Not checked: your monthly limit was reached before this sentence’s check finished.",
    );
    expect(limitReason(zh, "monthly-limit-unfinished", "$0.25", null)).toBe(
      "未核对：这句还没核对完，就已达每月上限。",
    );
  });

  test("the Answer's own limit keeps its amount, which is fixed", () => {
    expect(limitReason(en, "answer-limit", "$0.25", null)).toBe(
      "Not checked: this Answer’s $0.25 checking limit was reached before this sentence.",
    );
    expect(limitReason(en, "answer-limit-unfinished", "$0.25", "Claude Fable 5")).toBe(
      "Not checked: this Answer’s $0.25 checking limit was reached before Claude Fable 5 finished checking this sentence.",
    );
    expect(limitReason(zh, "answer-limit-unfinished", "$0.25", null)).toBe(
      "未核对：这句还没核对完，就已达本回答 $0.25 的核对上限。",
    );
  });

  test("another reason has no limit's words", () => {
    expect(limitReason(en, "small-model", "$0.25", "Claude Fable 5")).toBeNull();
    expect(limitReason(en, null, "$0.25", null)).toBeNull();
  });

  test("the line under the Answer: the cap with no amount, the Answer's limit with its own", () => {
    const stopped = { by: "monthly-limit" as const, checked: 12, total: 40 };
    expect(stoppedLine(en, stopped, "$0.25")).toBe(
      "12 of 40 sentences checked · Your monthly limit reached",
    );
    expect(stoppedLine(zh, stopped, "$0.25")).toBe("已核对 40 句中的 12 句 · 已达每月上限");
    expect(stoppedLine(en, { ...stopped, by: "answer-limit" }, "$0.25")).toBe(
      "12 of 40 sentences checked · This Answer’s $0.25 checking limit reached",
    );
    expect(stoppedLine(zh, { ...stopped, by: "answer-limit" }, "$0.25")).toBe(
      "已核对 40 句中的 12 句 · 已达本回答 $0.25 的核对上限",
    );
  });
});
