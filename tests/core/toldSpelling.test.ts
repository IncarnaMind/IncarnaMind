import { describe, expect, test } from "vitest";
import { inToldSpelling } from "../../src/core/transcription/spelling";

describe("A name the Meeting was told is written its way in a line (#1031)", () => {
  test("words written as a name that sound the same are written as the told name; a like sound is not", () => {
    const told = ["Catherine Marsh", "Erik", "Nikki"];
    expect(inToldSpelling("We asked Katherine to send the draft to Eric.", told)).toBe(
      "We asked Catherine to send the draft to Erik.",
    );
    expect(inToldSpelling("Then Katherine Marsh and Nicky agreed.", told)).toBe(
      "Then Catherine Marsh and Nikki agreed.",
    );
    // Kathryn and Erica are other names: one sound of theirs differs.
    expect(inToldSpelling("We asked Kathryn and Erica.", told)).toBe("We asked Kathryn and Erica.");
  });

  test("a told name already written keeps its place, whatever its case", () => {
    const told = ["Catherine Marsh", "Erik"];
    expect(inToldSpelling("We asked Catherine and erik.", told)).toBe(
      "We asked Catherine and erik.",
    );
  });

  test("a word that opens a sentence, or isn't written as a name, stays", () => {
    const told = ["Phil", "Guy"];
    expect(inToldSpelling("Fill in the form, said Fill.", told)).toBe(
      "Fill in the form, said Phil.",
    );
    expect(inToldSpelling("Please fill in the form.", told)).toBe("Please fill in the form.");
    expect(inToldSpelling("The new GUI ships with Gui.", told)).toBe("The new GUI ships with Guy.");
  });

  test("when two told names sound the same, neither is written for the other or for a third spelling", () => {
    const line = "We asked Mark and Marc, then Marq.";
    expect(inToldSpelling(line, ["Marc", "Mark Stone"])).toBe(line);
    expect(inToldSpelling(line, ["Marc"])).toBe("We asked Marc and Marc, then Marc.");
  });

  test("a Chinese line that reads the same as a told name stays as the engine wrote it; the English name in it is respelled", () => {
    const told = ["高欣", "王丽", "Catherine Marsh"];
    expect(inToldSpelling("高新说下周交付，往里走。", told)).toBe("高新说下周交付，往里走。");
    expect(inToldSpelling("高新请Katherine确认。", told)).toBe("高新请Catherine确认。");
  });

  test("with no told name, or none that sounds like a word of the line, the line is as it came", () => {
    expect(inToldSpelling("We asked Katherine.", [])).toBe("We asked Katherine.");
    expect(inToldSpelling("We asked Katherine.", ["Harbor Logistics", "星河科技"])).toBe(
      "We asked Katherine.",
    );
  });
});
