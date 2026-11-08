import { describe, expect, test } from "vitest";
import { alignWords, atTime, timeAt } from "../../src/shared/wordTimes";

const CUE = { startMs: 10_000, endMs: 14_000, text: "Budget is approved for this year." };

describe("When a Transcript's words were said (#138)", () => {
  // protects=a transcriber's words are placed where the written line has them, a word the line no longer has as it came left out with its time, case and spaces aside; fails_when=a word is placed in another word, before the one it follows, or with a time before the last one; no_claim=each service's own word format, which the cloud tests cover.
  test("a transcriber's words are placed in the line as it was written", () => {
    expect(
      alignWords(CUE.text, [
        { text: "budget", ms: 10_000 },
        { text: " is", ms: 10_900 },
        { text: "twenty", ms: 11_000 },
        { text: " approved", ms: 11_200 },
        { text: "for", ms: 12_400 },
        { text: "this", ms: 12_000 },
        { text: "year", ms: 13_100 },
      ]),
    ).toEqual([
      { at: 0, ms: 10_000 },
      { at: 7, ms: 10_900 },
      { at: 10, ms: 11_200 },
      { at: 19, ms: 12_400 },
      { at: 28, ms: 13_100 },
    ]);
    expect(
      alignWords("预算已经批准了", [
        { text: "预算", ms: 0 },
        { text: "批准", ms: 900 },
      ]),
    ).toEqual([
      { at: 0, ms: 0 },
      { at: 4, ms: 900 },
    ]);
  });

  // protects=with word times a word plays from its own time, and between two the time goes evenly; with none, a character's time is in proportion to where it is in the line; atTime is timeAt's inverse at the stamps; fails_when=a word plays from the line's start, a time falls outside the line, or the estimate isn't proportional; no_claim=how close the estimate is on real speech, which the pull request measures.
  test("a word's time is its own, else an estimate in proportion to where it is", () => {
    const timed = {
      ...CUE,
      words: [
        { at: 10, ms: 11_200 },
        { at: 28, ms: 13_100 },
      ],
    };
    expect(timeAt(timed, 10)).toBe(11_200);
    expect(timeAt(timed, 28)).toBe(13_100);
    expect(timeAt(timed, 5)).toBe(10_600);
    expect(atTime(timed, 11_200)).toBe(10);
    expect(atTime(timed, 13_100)).toBe(28);
    expect(timeAt(CUE, 0)).toBe(10_000);
    expect(timeAt(CUE, CUE.text.length)).toBe(14_000);
    expect(timeAt(CUE, 10)).toBe(Math.ceil(10_000 + (4000 * 10) / CUE.text.length));
    // A word's time reads back as that word, never the one before it.
    for (let at = 0; at < CUE.text.length; at++) expect(atTime(CUE, timeAt(CUE, at))).toBe(at);
    expect(atTime(CUE, 9_000)).toBe(0);
    expect(atTime(CUE, 20_000)).toBe(CUE.text.length);
  });
});
