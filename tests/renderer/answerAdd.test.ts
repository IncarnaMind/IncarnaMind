import { describe, expect, test } from "vitest";
import { addNamesItsMind, LONG_ANSWER_SENTENCES } from "../../src/renderer/src/answerAdd";

const CITED = [{}];
const sentences = (count: number, mark = "[^1]") =>
  Array.from(
    { length: count },
    (_, at) => `Claim number ${at + 1} holds${at === 0 ? mark : ""}.`,
  ).join(" ");

describe("Add to note naming its Mind", () => {
  test("in an empty Mind it does for any Answer, cited or not", () => {
    expect(addNamesItsMind({ text: "Yes.", citations: [] }, true)).toBe(true);
    expect(addNamesItsMind({ text: sentences(1), citations: CITED }, true)).toBe(true);
  });

  test("in a Mind with text it does for a cited Answer past the threshold, not at it", () => {
    expect(
      addNamesItsMind({ text: sentences(LONG_ANSWER_SENTENCES + 1), citations: CITED }, false),
    ).toBe(true);
    expect(
      addNamesItsMind({ text: sentences(LONG_ANSWER_SENTENCES), citations: CITED }, false),
    ).toBe(false);
  });

  test("a long Answer with no Citations does not", () => {
    expect(addNamesItsMind({ text: sentences(8), citations: [] }, false)).toBe(false);
  });

  test("a list item, a Chinese sentence and a sentence with a marker each count once; code and headings do not", () => {
    const list = ["# Heading", "", "- One.", "- Two.", "- Three.", "", "```", "a. b. c. d.", "```"];
    expect(addNamesItsMind({ text: list.join("\n"), citations: CITED }, false)).toBe(false);
    expect(
      addNamesItsMind({ text: `${list.join("\n")}\n- Four[^1].`, citations: CITED }, false),
    ).toBe(true);
    expect(
      addNamesItsMind({ text: "第一句[^1]。第二句。第三句。第四句。", citations: CITED }, false),
    ).toBe(true);
    expect(addNamesItsMind({ text: "第一句[^1]。第二句。第三句。", citations: CITED }, false)).toBe(
      false,
    );
  });
});
