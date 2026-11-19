import { describe, expect, test } from "vitest";
import type { Cue } from "../../src/core/documents/formats/vtt";
import { reviewSuggestions } from "../../src/core/meetings/reviewSuggestions";
import type { ReviewToken } from "../../src/core/transcription/cloud/sonioxReview";

function line(startMs: number, speaker: string, text: string, length = 1000): Cue {
  return { startMs, endMs: startMs + length, speaker, text };
}

function heard(cue: Cue, speaker: string): ReviewToken {
  return { startMs: cue.startMs, endMs: cue.endMs, text: cue.text, speaker };
}

const first = line(0, "Speaker 1", "Here is the first proposal.", 6000);
const second = line(8000, "Speaker 2", "我们一起看预算。", 6000);
const wrong = line(16_000, "Speaker 1", "预算周五确认。");

describe("post-call speaker suggestions", () => {
  test("maps independent voice numbers to the current speakers and leaves a split, names and the microphone intact", () => {
    const split = line(19_000, "Speaker 1", "First the dates. Then the budget.", 2000);
    const microphone = line(16_000, "Me", wrong.text);
    const labels = {
      labels: { "Speaker 2": "Lian" },
      lines: {},
      splits: {
        "19000 Speaker 1": { text: split.text, parts: [{ at: 17, ms: 20_000 }] },
      },
    };
    const cues = [first, second, wrong, microphone, split];
    const tokens = [
      heard(first, "2"),
      heard(second, "1"),
      heard(wrong, "1"),
      heard(line(19_000, "Speaker 1", "First the dates."), "2"),
      heard(line(20_000, "Speaker 1", "Then the budget."), "1"),
    ];
    expect(reviewSuggestions(cues, labels, tokens)).toEqual([
      {
        startMs: 16000,
        endMs: 17000,
        fileLabel: "Speaker 1",
        currentLabel: "Speaker 1",
        suggestedLabel: "Speaker 2",
        text: wrong.text,
      },
      {
        startMs: 20000,
        endMs: 21000,
        fileLabel: "Speaker 1",
        currentLabel: "Speaker 1",
        suggestedLabel: "Speaker 2",
        text: "Then the budget.",
      },
    ]);
    expect(labels.lines).toEqual({});
  });

  test("overlapping pieces of one voice cannot cover the same time twice", () => {
    const partial = line(16_000, "Speaker 1", "Budget decisions today.");
    expect(
      reviewSuggestions([first, second, partial], null, [
        heard(first, "2"),
        heard(second, "1"),
        { startMs: 16_000, endMs: 16_490, speaker: "1", text: "Budget " },
        { startMs: 16_105, endMs: 16_110, speaker: "2", text: "oh" },
        { startMs: 16_200, endMs: 16_520, speaker: "1", text: "decisions today." },
      ]),
    ).toEqual([]);
  });

  test("abstains for ambiguous identities, different words, short answers, competing voices and duplicate anchors", () => {
    expect(
      reviewSuggestions([line(0, "A", wrong.text), line(1000, "B", wrong.text)], null, [
        { startMs: 0, endMs: 2000, text: wrong.text.repeat(2), speaker: "1" },
      ]),
    ).toEqual([]);
    const short = line(20_000, "Speaker 1", "Yes.");
    const duplicate = line(24_000, "Speaker 1", "Same time twice.");
    const crosstalk = line(27_000, "Speaker 1", "Two people together.");
    const none = reviewSuggestions(
      [first, second, wrong, short, duplicate, duplicate, crosstalk],
      null,
      [
        heard(first, "2"),
        heard(second, "1"),
        { ...heard(wrong, "1"), text: "A completely different sentence." },
        heard(short, "1"),
        heard(duplicate, "1"),
        heard(crosstalk, "1"),
        { ...heard(crosstalk, "2"), startMs: 27_300, endMs: 27_800 },
      ],
    );
    expect(none).toEqual([]);
  });
});
