import { describe, expect, test } from "vitest";
import {
  joinedVoices,
  segmentsByWindow,
  toMeetingTime,
} from "../../src/core/transcription/diarization";

const SECOND_SAMPLES = 16_000;

describe("The speaker engine's times, in the Meeting's (#138)", () => {
  // protects=the engine reads a Meeting's parts joined end to end, so a turn is put back where its audio was recorded, cut where the recording paused, with voices numbered as first heard; fails_when=a turn after a pause is early, spans the pause, or keeps the engine's numbers; no_claim=the engine's turns themselves.
  test("turns go back to where their audio was recorded, cut at a pause, voices numbered as first heard", () => {
    const spans = [
      { at: 0, length: 10 * SECOND_SAMPLES, offsetMs: 0 },
      { at: 10 * SECOND_SAMPLES, length: 10 * SECOND_SAMPLES, offsetMs: 60_000 },
    ];
    expect(
      toMeetingTime(
        [
          { start: 2, end: 4, speaker: 7 },
          { start: 8, end: 12, speaker: 3 },
          { start: 15, end: 16, speaker: 7 },
        ],
        spans,
      ),
    ).toEqual([
      { startMs: 2000, endMs: 4000, voice: 0 },
      { startMs: 8000, endMs: 10_000, voice: 1 },
      { startMs: 60_000, endMs: 62_000, voice: 1 },
      { startMs: 65_000, endMs: 66_000, voice: 0 },
    ]);
  });

  test("a turn across two parts recorded one after the other stays one", () => {
    const spans = [
      { at: 0, length: 10 * SECOND_SAMPLES, offsetMs: 0 },
      { at: 10 * SECOND_SAMPLES, length: 10 * SECOND_SAMPLES, offsetMs: 10_000 },
    ];
    expect(toMeetingTime([{ start: 8, end: 12, speaker: 0 }], spans)).toEqual([
      { startMs: 8000, endMs: 12_000, voice: 0 },
    ]);
  });
});

const print = (...values: number[]) => Float32Array.from(values);

describe("Voices joined by voiceprint after the engine's clustering (#138)", () => {
  // protects=a person the engine split into two voices is one again when their voiceprints are alike enough, and a voice with a stray stretch or two joins the voice most like it; fails_when=unlike voices join, alike ones stay apart, or a stray voice is left on its own; no_claim=the threshold's best value, which eval/speakers measures.
  test("alike voices become one, unlike ones stay apart", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0, 0), seconds: 100, longest: 12 }],
        [1, { print: print(0.95, 0.1, 0), seconds: 60, longest: 12 }],
        [2, { print: print(0, 1, 0), seconds: 80, longest: 12 }],
      ]),
      0.9,
    );
    expect(joined.get(1)).toBe(joined.get(0));
    expect(joined.get(2)).not.toBe(joined.get(0));
  });

  test("a voice with almost none of the speech joins the voice most like it", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0, 0), seconds: 100, longest: 12 }],
        [1, { print: print(0, 1, 0), seconds: 100, longest: 12 }],
        [2, { print: print(0.1, 0.25, 0.96), seconds: 1, longest: 1 }],
      ]),
    );
    expect(joined.get(2)).toBe(joined.get(1));
    expect(new Set(joined.values()).size).toBe(2);
  });

  // protects=a voice whose voiceprint is rough, because it has only short stretches however many, is one person with a voice it is under half alike, so a person the engine split is not shown as several speakers (#138), while a voice that is clearly different stays its own speaker however little it says and two voices with a long stretch each still need the full likeness; fails_when=a voice of short stretches under half alike its person stays apart, whether it has seconds of speech or half a minute, a short and clearly different voice is joined to another, or two voices with long stretches half alike are joined; no_claim=the likenesses' and the stretch's best values, which eval/speakers measures.
  test("a voice of short stretches joins a voice under half alike, and a clearly different one stays apart", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0, 0, 0, 0), seconds: 40, longest: 12 }],
        [1, { print: print(0.5, 0.866, 0, 0, 0), seconds: 4, longest: 2 }],
        [2, { print: print(0.2, 0, 0.98, 0, 0), seconds: 7, longest: 3 }],
        [3, { print: print(0.5, 0, 0, 0.866, 0), seconds: 30, longest: 12 }],
        [4, { print: print(0.4, 0, 0, 0, 0.917), seconds: 25, longest: 1.5 }],
      ]),
    );
    expect(joined.get(1)).toBe(joined.get(0));
    expect(joined.get(4)).toBe(joined.get(0));
    expect(joined.get(2)).not.toBe(joined.get(0));
    expect(joined.get(3)).not.toBe(joined.get(0));
    expect(new Set(joined.values()).size).toBe(3);
  });
});

describe("A long recording is clustered a window at a time (#138)", () => {
  // protects=the engine's clustering, whose memory grows with the square of the audio's length, sees at most one window: a long recording is cut into even windows, each window's segments are put back at its place, and each window's voices stay its own for the voiceprint join; fails_when=a window is longer than asked, the last one is a sliver, a segment keeps its window's time, or two windows share a voice number; no_claim=whether the join then finds the same person across windows, which eval/speakers measures.
  test("in even windows, each segment at its place, each window's voices its own", () => {
    const samples = new Float32Array(2.5 * SECOND_SAMPLES);
    const windows: number[] = [];
    const segments = segmentsByWindow(samples, 1, (window) => {
      windows.push(window.length);
      return [
        { start: 0.1, end: 0.3, speaker: 1 },
        { start: 0.4, end: 0.6, speaker: 0 },
      ];
    });
    expect(windows).toEqual([13_334, 13_334, 13_332]);
    expect(segments.map((segment) => segment.speaker)).toEqual([1, 0, 3, 2, 5, 4]);
    expect(segments[2]?.start).toBeCloseTo(13_334 / SECOND_SAMPLES + 0.1);
    expect(segments[4]?.end).toBeCloseTo((2 * 13_334) / SECOND_SAMPLES + 0.3);
  });

  // protects=a recording no longer than a window is clustered whole, as the evaluation measured it; fails_when=it is cut; no_claim=the engine's turns.
  test("a recording no longer than a window is clustered whole", () => {
    const windows: number[] = [];
    segmentsByWindow(new Float32Array(SECOND_SAMPLES), 1, (window) => {
      windows.push(window.length);
      return [];
    });
    expect(windows).toEqual([SECOND_SAMPLES]);
  });
});
