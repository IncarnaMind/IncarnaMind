/**
 * A figure read two ways, as the card writes its readings (#3088): in English the check's own
 * words; in Chinese the platform's 万 and 亿 with every digit kept, none of a double's noise, and the
 * currency's Chinese name; a reading this build can't write the Chinese way keeps its words.
 */
import { describe, expect, test } from "vitest";
import { readingText, twoReadingsDetail, twoReadingsOf } from "../../src/shared/twoReadings";

const pounds = (value: number, words: string) => ({
  words,
  value,
  unit: { kind: "currency" as const, code: "GBP" },
});

describe("a reading as the card writes it", () => {
  // protects=the Chinese card writes a reading a scale or separator moved, "1.1 billion" and "1.005 million", without the float noise of the arithmetic that moved it (#3088); fails_when=it reads "1.1000000000000001亿" or "100.49999999999999万"; no_claim=how the English card writes it, which keeps the check's own words.
  test("Chinese: 万 and 亿, every digit and no float noise", () => {
    expect(readingText("zh-CN", pounds(1.1 * 1e9, "1.1 billion GBP"))).toBe("11亿英镑");
    expect(readingText("zh-CN", pounds(1.1 * 1e8, "110 million GBP"))).toBe("1.1亿英镑");
    expect(readingText("zh-CN", pounds(1.005 * 1e6, "1.005 million GBP"))).toBe("100.5万英镑");
    expect(readingText("zh-CN", pounds(1_284_000_000, "1,284 million GBP"))).toBe("12.84亿英镑");
    expect(readingText("en", pounds(1.1 * 1e9, "1.1 billion GBP"))).toBe("1.1 billion GBP");
  });

  // protects=a reading whose unit this build doesn't know, or a currency with no code, keeps its words on the Chinese card rather than breaking the line (#3088); fails_when=it throws or writes "undefined"; no_claim=a detail that names no two readings, which reads the fallback line.
  test("a unit it doesn't know, or a currency with no code, keeps its words", () => {
    const detail = JSON.stringify({
      shown: "1,284 widgets",
      readings: [
        { words: "1,284 widgets", value: 1284, unit: { kind: "a-later-kind" } },
        { words: "1.284 widgets", value: 1.284, unit: { kind: "currency" } },
      ],
    });
    const read = twoReadingsOf(detail);
    expect(read?.readings.map((each) => readingText("zh-CN", each))).toEqual([
      "1,284 widgets",
      "1.284 widgets",
    ]);
    expect(twoReadingsOf(twoReadingsDetail({ shown: "x", readings: [] }))).toBeNull();
  });
});
