import { describe, expect, test } from "vitest";
import type { AnswerToolCall } from "../../src/core/api";
import { figuresOf, uncalculatedWords } from "../../src/renderer/src/answerFigures";
import { translate } from "../../src/shared/i18n";

const call = (extra: Partial<AnswerToolCall>): AnswerToolCall => ({
  id: "c1",
  tool: "calculate",
  source: "documents",
  input: {},
  status: "done",
  resultCount: 2,
  ...extra,
});

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

// protects=#2313: an Answer's end names each figure it couldn't calculate and says why, with the language's list pattern, in English and Chinese, and an Answer written before the names keeps its count alone; fails_when=a figure is unnamed, a raw marker shows, or three figures read "a and b and c"; no_claim=the number formatted by the figure card for a calculated figure.
describe("An Answer's figures it couldn't calculate", () => {
  test("names the figure and why, in English and Chinese", () => {
    const one = figuresOf([
      call({ uncalculated: 1, uncalculatedFigures: [{ marker: 3, written: "6.55" }] }),
    ]);
    expect(uncalculatedWords(one, en, "en")).toBe(
      "1 figure couldn’t be calculated: 6.55. It was written without a calculation IncarnaMind could check.",
    );
    expect(uncalculatedWords(one, zh, "zh-CN")).toBe(
      "1 个数字未能计算：6.55。写入时没有可核对的算式。",
    );
  });

  test("lists three figures in the language's pattern, never as a and b and c", () => {
    const three = figuresOf([
      call({
        uncalculated: 3,
        uncalculatedFigures: [
          { marker: 3, written: "6.55" },
          { marker: 7, written: "4.2" },
          { marker: 9, written: "7.1" },
        ],
      }),
    ]);
    expect(uncalculatedWords(three, en, "en")).toBe(
      "3 figures couldn’t be calculated: 6.55, 4.2, and 7.1. They were written without a calculation IncarnaMind could check.",
    );
    expect(uncalculatedWords(three, zh, "zh-CN")).toBe(
      "3 个数字未能计算：6.55、4.2和7.1。写入时没有可核对的算式。",
    );
  });

  test("a figure with no number written before it keeps the count, never a raw marker", () => {
    const nameless = figuresOf([
      call({
        uncalculated: 2,
        uncalculatedFigures: [
          { marker: 3, written: "6.55" },
          { marker: 7, written: null },
        ],
      }),
    ]);
    expect(uncalculatedWords(nameless, en, "en")).toBe("2 figures couldn’t be calculated");
    expect(uncalculatedWords(nameless, zh, "zh-CN")).toBe("2 个数字未能计算");
  });

  test("an Answer written before the names keeps its count alone", () => {
    const older = figuresOf([call({ uncalculated: 2 })]);
    expect(older.missing).toEqual([]);
    expect(uncalculatedWords(older, en, "en")).toBe("2 figures couldn’t be calculated");
    expect(uncalculatedWords(older, zh, "zh-CN")).toBe("2 个数字未能计算");
    expect(uncalculatedWords(figuresOf([call({})]), en, "en")).toBe(
      "0 figures couldn’t be calculated",
    );
  });
});
