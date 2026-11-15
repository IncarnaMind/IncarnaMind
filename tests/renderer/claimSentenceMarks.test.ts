/**
 * Where a check card marks a part in its sentence (#2869): only where the part's words are found
 * exactly once, so a mark never lands on the wrong words, and never over the whole sentence, which
 * the verdict already names.
 */
import { describe, expect, test } from "vitest";
import {
  cutPlaces,
  markedPieces,
  placeWords,
  sentenceMarks,
} from "../../src/renderer/src/editor/claimSentenceMarks";

const CASES = [
  {
    language: "en",
    sentence:
      "Underlying EBITDA was £96 million in the third quarter, and the group opened 14 new stores.",
    part: "the group opened 14 new stores",
    twice: "Revenue was £96 million, and costs were £96 million.",
    repeated: "£96 million",
  },
  {
    language: "zh-CN",
    sentence: "第三季度基础 EBITDA 为 9,600 万英镑，公司同期新开了 14 家门店。",
    part: "公司同期新开了 14 家门店",
    twice: "收入为 9,600 万英镑，成本也为 9,600 万英镑。",
    repeated: "9,600 万英镑",
  },
] as const;

describe.each(CASES)("placing a part's words in its sentence ($language)", (example) => {
  // protects=a part found once in its sentence is marked at its words; fails_when=it is marked elsewhere or not at all; no_claim=its colours.
  test("words found once are placed there", () => {
    const place = placeWords(example.sentence, example.part);
    expect(place).not.toBeNull();
    expect(example.sentence.slice(place?.start, place?.end)).toBe(example.part);
  });

  // protects=words found twice, or not at all, get no mark (the ruled rule for #2869); fails_when=a mark is drawn on the first of two places, or on words that aren't there; no_claim=what the card writes instead.
  test("words found twice, or nowhere, are not placed", () => {
    expect(placeWords(example.twice, example.repeated)).toBeNull();
    expect(placeWords(example.sentence, "words that aren't there")).toBeNull();
    expect(placeWords(example.sentence, "  ")).toBeNull();
  });

  // protects=a part's words as its check read them, a Citation left out and its space doubled, are placed in the sentence the card shows; fails_when=a doubled space or a Citation's character keeps them from being found; no_claim=other whitespace.
  test("spaces and Citations are read as the card shows the sentence", () => {
    expect(placeWords(example.sentence, example.part.replace(" ", "￼  "))).not.toBeNull();
    expect(placeWords(example.sentence, `  ${example.part}  `)).not.toBeNull();
  });

  // protects=the sentence is cut into its plain and marked stretches in order, and the whole sentence is never marked; fails_when=a stretch is lost or doubled, or a one-part sentence is washed whole; no_claim=how the card draws them.
  test("marks cut the sentence in order, and never the whole of it", () => {
    const place = placeWords(example.sentence, example.part);
    const marks = sentenceMarks(example.sentence, [
      { key: "part", place, tone: "unsupported" },
      { key: "overlap", place, tone: "found" },
    ]);
    expect(marks).toHaveLength(1);
    const pieces = markedPieces(example.sentence, marks);
    expect(pieces.map((piece) => piece.text).join("")).toBe(example.sentence);
    expect(pieces.filter((piece) => piece.mark).map((piece) => piece.text)).toEqual([example.part]);
    const whole = { start: 0, end: example.sentence.length - 1 };
    expect(sentenceMarks(example.sentence, [{ key: "all", place: whole, tone: "found" }])).toEqual(
      [],
    );
  });

  // protects=the two-line cut may start the sentence only at a word's start before the mark; fails_when=it would start inside a word or after the mark; no_claim=which of them fits two lines, which the card measures.
  test("the cut starts only at a word's start before the mark", () => {
    const place = placeWords(example.sentence, example.part);
    const places = cutPlaces(example.sentence, place?.start ?? 0);
    expect(places.length).toBeGreaterThan(0);
    for (const at of places) {
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThanOrEqual(place?.start ?? 0);
    }
  });
});
