import { describe, expect, test } from "vitest";
import { hasImmediateRecordCitePrevious } from "../../src/core/recordCites/previous";
import type { RecordCiteChoice, RecordCiteSentence } from "../../src/shared/recordCiteChoices";

const sentence = (blockId: string, text: string): RecordCiteSentence => ({
  place: { blockId, from: 0 },
  text,
});

const previousFor = (blockId: string, claim: string, raw: string): RecordCiteChoice => ({
  documentId: "document",
  location: { kind: "page", from: 3, to: 3 },
  raw,
  claim,
  place: { blockId, from: 0, citeFrom: claim.indexOf(raw) },
});

const current = { blockId: "next", from: 0 };

describe("the immediately preceding record item", () => {
  test("must be the last cite within its own sentence", () => {
    const text = "ECF No. 41 at 3 and Ex. 7 at 3 state the record.";
    const sentences = [sentence("before", text), sentence("next", "Id. at 4 states more.")];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("before", text, "ECF No. 41 at 3"),
        current,
      ),
    ).toBe(false);
    expect(
      hasImmediateRecordCitePrevious(sentences, previousFor("before", text, "Ex. 7 at 3"), current),
    ).toBe(true);
  });

  test("a replacement at the same offset cannot impersonate the saved cite", () => {
    const before = "Ex. 7 at 3 states the deadline.";
    const sentences = [
      sentence("before", "Dkt. 41 at 2 states the deadline."),
      sentence("next", "Id. at 4 states more."),
    ];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("before", before, "Ex. 7 at 3"),
        current,
      ),
    ).toBe(false);
  });

  test("a cite appended after the saved item invalidates it without a recheck", () => {
    const before = "Ex. 7 at 3 states it.";
    const sentences = [
      sentence("before", "Ex. 7 at 3 states it, and Dkt. 41 at 2 adds more."),
      sentence("next", "Id. at 4 states more."),
    ];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("before", before, "Ex. 7 at 3"),
        current,
      ),
    ).toBe(false);
  });

  test("a proposed write supplies reading order, and an intervening cite clears it", () => {
    const source = "ECF No. 41 at 3 states the deadline.";
    const first = sentence("new-a", source);
    const second = sentence("new-b", "Id. at 2 states another deadline.");
    const previous = previousFor("new-a", source, "ECF No. 41 at 3");
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

  test("a newly assigned proposed Block id falls back to the exact current claim", () => {
    const source = "ECF No. 41 at 3 states the deadline.";
    const nextText = "Id. at 2 states another deadline.";
    const sentences = [sentence("assigned-a", source), sentence("assigned-b", nextText)];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("assigned-a", source, "ECF No. 41 at 3"),
        { blockId: "proposed-container", from: 0 },
        nextText,
      ),
    ).toBe(true);
  });

  test("duplicate proposed claims never borrow an occurrence's position", () => {
    const source = "ECF No. 41 at 3 states the deadline.";
    const repeated = "Id. at 2 states another deadline.";
    const first = sentence("source", source);
    const second = sentence("repeat-a", repeated);
    const third = sentence("repeat-b", repeated);
    const sentences = [first, second, third];
    const proposed = { blockId: "proposed-container", from: 0 };
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("source", source, "ECF No. 41 at 3"),
        proposed,
        repeated,
      ),
    ).toBe(false);
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("repeat-a", repeated, "Id. at 2"),
        proposed,
        repeated,
      ),
    ).toBe(false);
  });

  test("an item cannot refer to itself or a later source", () => {
    const source = "Ex. 7 at 3 states it.";
    const sentences = [sentence("first", "Id. at 2 has no source."), sentence("next", source)];
    expect(
      hasImmediateRecordCitePrevious(
        sentences,
        previousFor("first", "Id. at 2 has no source.", "Id. at 2"),
        { blockId: "first", from: 0 },
      ),
    ).toBe(false);
    expect(
      hasImmediateRecordCitePrevious(sentences, previousFor("next", source, "Ex. 7 at 3"), {
        blockId: "first",
        from: 0,
      }),
    ).toBe(false);
  });
});
