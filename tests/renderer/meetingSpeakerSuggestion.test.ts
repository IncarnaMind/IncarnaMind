import { describe, expect, test } from "vitest";
import type { MeetingSpeakerSuggestion, TranscriptSpeakers } from "../../src/core/api";
import type { Cue } from "../../src/core/documents/formats/vtt";
import {
  reviewSpeakersMatch,
  suggestionLine,
  suggestionLines,
} from "../../src/renderer/src/viewer/speakerSuggestion";
import { lineKey } from "../../src/shared/speakers";

const systemCue: Cue = {
  startMs: 1000,
  endMs: 4800,
  text: "First draft. Final copy.",
  speaker: "Them",
};
const suggestion: MeetingSpeakerSuggestion = {
  startMs: 1000,
  endMs: 4800,
  text: systemCue.text,
  fileLabel: "Them",
  currentLabel: "Them",
  suggestedLabel: "Speaker 1",
};
const document = { contentHash: "the-transcript", speakers: null };
const resolve = (change: Partial<MeetingSpeakerSuggestion>) =>
  suggestionLine(document, suggestionLines([systemCue], null), "the-transcript", {
    ...suggestion,
    ...change,
  });

describe("Verifying a meeting speaker suggestion before saving", () => {
  test("the current file label, timing, text and speaker must all match", () => {
    expect(resolve({})).toEqual({ startMs: 1000, label: "Them" });
    for (const mismatch of [
      { startMs: 1001 },
      { endMs: 4801 },
      { text: "The final copy." },
      { currentLabel: "Speaker 3" },
      { fileLabel: "Speaker 3" },
      { suggestedLabel: "Me" },
    ])
      expect(resolve(mismatch)).toBeNull();
    expect(
      suggestionLine(document, suggestionLines([systemCue], null), "an-old-version", suggestion),
    ).toBeNull();
    expect(
      suggestionLine(
        document,
        suggestionLines([systemCue, systemCue], null),
        "the-transcript",
        suggestion,
      ),
    ).toBeNull();
  });

  test("a suggestion for a split is applied only to that exact part", () => {
    const speakers: TranscriptSpeakers = {
      labels: { "Speaker 3": "Dana" },
      lines: { [lineKey(3200, "Them")]: "Speaker 3" },
      splits: {
        [lineKey(1000, "Them")]: { text: systemCue.text, parts: [{ at: 13, ms: 3200 }] },
      },
    };
    const split = { ...document, speakers };
    const part = { ...suggestion, startMs: 3200, text: "Final copy.", currentLabel: "Speaker 3" };
    expect(
      suggestionLine(split, suggestionLines([systemCue], speakers), "the-transcript", part),
    ).toEqual({
      startMs: 3200,
      label: "Them",
    });
    expect(
      suggestionLine(split, suggestionLines([systemCue], speakers), "the-transcript", suggestion),
    ).toBeNull();
    expect(
      suggestionLine(split, suggestionLines([systemCue], speakers), "the-transcript", {
        ...part,
        currentLabel: "Them",
      }),
    ).toBeNull();
  });

  test("a line from the microphone cannot be reassigned by the review", () => {
    expect(
      suggestionLine(
        document,
        suggestionLines([{ ...systemCue, speaker: "Me" }], null),
        "the-transcript",
        {
          ...suggestion,
          fileLabel: "Me",
          currentLabel: "Me",
        },
      ),
    ).toBeNull();
  });
});

test("a room review can assign an unknown microphone voice and a manual edit invalidates a proposed new identity", () => {
  const room = { ...systemCue, speaker: "Speaker ?" };
  const proposed = { ...suggestion, fileLabel: room.speaker, currentLabel: room.speaker };
  expect(
    suggestionLine(document, suggestionLines([room], null), document.contentHash, proposed),
  ).toEqual({ startMs: room.startMs, label: room.speaker });
  expect(reviewSpeakersMatch(null, { labels: { "Speaker 1": "Dana" }, lines: {} })).toBe(false);
  expect(reviewSpeakersMatch(null, null)).toBe(true);
});
