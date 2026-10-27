import { describe, expect, test } from "vitest";
import { hasImmediateRecordCitePrevious } from "../../src/core/recordCites/previous";
import type { RecordCiteSentence } from "../../src/shared/recordCiteChoices";

const sentence = (blockId: string, text: string): RecordCiteSentence => ({
  place: { blockId, from: 0 },
  text,
});

const current = { blockId: "next", from: 0 };

describe("the immediately preceding record item", () => {
  test("must be the last cite within its own sentence", () => {
    const text = "ECF No. 41 at 3 and Ex. 7 at 3 state the record.";
    const sentences = [sentence("before", text), sentence("next", "Id. at 4 states more.")];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        { blockId: "before", from: 0, citeFrom: 0 },
        current,
      ),
    ).toBe(false);
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        { blockId: "before", from: 0, citeFrom: text.indexOf("Ex. 7") },
        current,
      ),
    ).toBe(true);
  });

  test("a cite appended after the saved item invalidates it without a recheck", () => {
    const sentences = [
      sentence("before", "Ex. 7 at 3 states it, and Dkt. 41 at 2 adds more."),
      sentence("next", "Id. at 4 states more."),
    ];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        { blockId: "before", from: 0, citeFrom: 0 },
        current,
      ),
    ).toBe(false);
  });

  test("a proposed write supplies reading order, and an intervening cite clears it", () => {
    const first = sentence("new-a", "ECF No. 41 at 3 states the deadline.");
    const second = sentence("new-b", "Id. at 2 states another deadline.");
    const previous = { blockId: "new-a", from: 0, citeFrom: 0 };
    const next = { blockId: "new-b", from: 0 };
    expect(hasImmediateRecordCitePrevious([first, second], previous, next)).toBe(true);
    expect(
      hasImmediateRecordCitePrevious(
        [first, sentence("ambiguous", "Dkt. 41 at 2 is ambiguous."), second],
        previous,
        next,
      ),
    ).toBe(false);
  });

  test("an item cannot refer to itself or a later source", () => {
    const sentences = [
      sentence("first", "Id. at 2 has no source."),
      sentence("next", "Ex. 7 at 3 states it."),
    ];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        { blockId: "first", from: 0, citeFrom: 0 },
        { blockId: "first", from: 0 },
      ),
    ).toBe(false);
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        { blockId: "next", from: 0, citeFrom: 0 },
        { blockId: "first", from: 0 },
      ),
    ).toBe(false);
  });
});
