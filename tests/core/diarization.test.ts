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
        [0, { print: print(1, 0, 0), seconds: 100 }],
        [1, { print: print(0.95, 0.1, 0), seconds: 60 }],
        [2, { print: print(0, 1, 0), seconds: 80 }],
      ]),
      0.9,
    );
    expect(joined.get(1)).toBe(joined.get(0));
    expect(joined.get(2)).not.toBe(joined.get(0));
  });

  test("a voice with almost none of the speech joins the voice most like it", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0), seconds: 100 }],
        [1, { print: print(0, 1), seconds: 100 }],
        [2, { print: print(0.2, 0.8), seconds: 1 }],
      ]),
      0.99,
    );
    expect(joined.get(2)).toBe(joined.get(1));
    expect(new Set(joined.values()).size).toBe(2);
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
