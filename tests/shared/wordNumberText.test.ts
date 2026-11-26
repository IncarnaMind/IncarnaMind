import { describe, expect, test } from "vitest";
import { wordNumberText } from "../../src/shared/numbering";

describe("a number as Word writes it in a list's format", () => {
  // protects=each number format a cross-reference's result is rewritten in writes the number as Word does, and one whose writing isn't certain gives nothing, so the export leaves the file's result; fails_when=a format writes another number, or guesses past what is certain (Chinese counting from 10, letters past z); no_claim=how the Note draws its own lists' markers.
  test.each([
    ["decimal", 12, "12"],
    ["decimalZero", 7, "07"],
    ["decimalFullWidth", 12, "１２"],
    ["decimalEnclosedCircle", 3, "③"],
    ["lowerRoman", 14, "xiv"],
    ["upperRoman", 14, "XIV"],
    ["lowerLetter", 3, "c"],
    ["upperLetter", 26, "Z"],
    ["chineseCounting", 3, "三"],
    ["chineseCountingThousand", 9, "九"],
    ["japaneseCounting", 11, "十一"],
    ["taiwaneseCounting", 20, "二十"],
    ["chineseLegalSimplified", 5, "伍"],
    ["ideographTraditional", 3, "丙"],
    ["chineseCounting", 10, null],
    ["chineseCountingThousand", 10, null],
    ["lowerLetter", 27, null],
    ["decimalEnclosedCircle", 21, null],
    ["ordinal", 2, null],
    ["decimal", 0, null],
  ] as const)("%s %i is %s", (format, n, written) => {
    expect(wordNumberText(format, n)).toBe(written);
  });
});
