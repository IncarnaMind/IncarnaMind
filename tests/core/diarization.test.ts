import { describe, expect, test } from "vitest";
import {
  joinedVoices,
  refineTurnsWithSpans,
  segmentsByWindow,
  soloIntervalsOf,
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

describe("Solo intervals exclude overlapping speech (#138)", () => {
  // protects=a voiceprint is built from stretches where only that voice speaks, so simultaneous speech in a room does not pull two speakers' voiceprints together; fails_when=overlapped parts remain in the solo stretches, or slivers under 0.3 s are kept; no_claim=how CAM++ embeds those stretches.
  test("subtracts other speakers' intervals and drops slivers under 0.3 s", () => {
    const segments = [
      { start: 0, end: 5, speaker: 0 },
      { start: 1, end: 2.5, speaker: 1 },
      { start: 4.8, end: 6, speaker: 2 },
      { start: 6, end: 6.2, speaker: 0 },
      { start: 7, end: 9, speaker: 0 },
    ];
    expect(soloIntervalsOf(segments, 0)).toEqual([
      { start: 0, end: 1 },
      { start: 2.5, end: 4.8 },
      { start: 7, end: 9 },
    ]);
  });
});

describe("Voices joined by voiceprint after the engine's clustering (#138)", () => {
  // protects=a person the engine split into two voices is one again when their voiceprints are alike enough, and a voice with a stray stretch or two joins the voice most like it; fails_when=unlike voices join, alike ones stay apart, or a stray voice is left on its own; no_claim=the threshold's best value, which eval/speakers measures.
  test("alike voices become one, unlike ones stay apart", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0, 0), seconds: 100, soloSeconds: 80 }],
        [1, { print: print(0.95, 0.1, 0), seconds: 60, soloSeconds: 50 }],
        [2, { print: print(0, 1, 0), seconds: 80, soloSeconds: 70 }],
      ]),
      0.9,
    );
    expect(joined.get(1)).toBe(joined.get(0));
    expect(joined.get(2)).not.toBe(joined.get(0));
  });

  test("a voice with almost none of the speech joins the voice most like it", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0, 0), seconds: 100, soloSeconds: 80 }],
        [1, { print: print(0, 1, 0), seconds: 100, soloSeconds: 80 }],
        [2, { print: print(0.1, 0.25, 0.96), seconds: 1, soloSeconds: 1 }],
      ]),
    );
    expect(joined.get(2)).toBe(joined.get(1));
    expect(new Set(joined.values()).size).toBe(2);
  });

  // protects=solid speakers are joined only when their voiceprints meet samePerson, rough fragments (< 5 s solo) attach to the nearest solid without pulling solid prints together or bridging distinct speakers, a speaker with plenty of solo speech stays distinct even if its individual turns are short, and a zero-solo overlap artifact is absorbed as stray even in a short recording (#138); fails_when=rough fragments bridge two solid speakers, a speaker with >= 5 s solo speech merges below samePerson, a short rough fragment stays apart from its speaker, or a zero-solo overlap fragment stays its own speaker; no_claim=the likeness threshold's best value, which eval/speakers measures.
  test("solid speakers resist bridging by rough fragments, rough fragments attach, and zero-solo artifacts absorb", () => {
    const joined = joinedVoices(
      new Map([
        [0, { print: print(1, 0, 0, 0), seconds: 60, soloSeconds: 40 }],
        [1, { print: print(0.5, 0.866, 0, 0), seconds: 50, soloSeconds: 30 }],
        // Halfway between speakers 0 and 1 (cosine ~0.866 to both), must attach without bridging 0 and 1.
        [2, { print: print(0.866, 0.5, 0, 0), seconds: 3, soloSeconds: 2 }],
        // Distinct speaker with enough total solo speech (>= 5 s) stays apart at cosine 0.45.
        [3, { print: print(0.45, 0, 0.893, 0), seconds: 25, soloSeconds: 12 }],
        // Short rough fragment of speaker 0 attaches at cosine 0.45.
        [4, { print: print(0.45, 0, 0, 0.893), seconds: 2, soloSeconds: 1.5 }],
        // Zero-solo overlap artifact (> 2% of a short recording if alone) is absorbed.
        [5, { print: print(0.2, 0.1, 0, 0.975), seconds: 5, soloSeconds: 0 }],
      ]),
    );
    expect(joined.get(1)).not.toBe(joined.get(0));
    expect(joined.get(3)).not.toBe(joined.get(0));
    expect(joined.get(4)).toBe(joined.get(0));
    expect(joined.get(5)).toBe(joined.get(0));
    expect(new Set(joined.values()).size).toBe(3);
  });
});

describe("Cue-span refinement fills missed speech and clarifies short cues (#138)", () => {
  const prints = new Map([
    [0, print(1, 0)],
    [1, print(0, 1)],
  ]);

  // protects=when the engine missed a stretch of speech inside a Transcript line, CAM++ classifies the uncovered gap (splitting long gaps) against the kept voiceprints, and clarifies short non-handoff cues without masking speakerPass's 50% coverage guard or breaking clean consecutive voice handoffs for word-aligned splits; fails_when=uncovered gaps stay empty, a clean consecutive two-voice handoff is overwritten, or a broken <50% separation gets fabricated coverage; no_claim=real CAM++ accuracy, which eval/speakers measures.
  test("fills uncovered cue gaps, overrides ambiguous short cues, and preserves clean consecutive handoffs", () => {
    const base = [
      { startMs: 0, endMs: 2000, voice: 0 },
      // Clean consecutive handoff inside the 4000..7000 cue (must be preserved for word-aligned splits).
      { startMs: 4000, endMs: 5400, voice: 0 },
      { startMs: 5500, endMs: 7000, voice: 1 },
      // Simultaneous overlap on a short cue (10000..12000): should be re-scored as a single voice.
      { startMs: 10_000, endMs: 12_000, voice: 0 },
      { startMs: 10_200, endMs: 11_800, voice: 1 },
      // Long cue 15000..25000: covered 15000..20000, uncovered 20000..25000 (5 s -> split into 2 sub-chunks).
      { startMs: 15_000, endMs: 20_000, voice: 0 },
    ];
    const spans = [
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 7000 },
      { startMs: 10_000, endMs: 12_000 },
      { startMs: 15_000, endMs: 25_000 },
    ];
    const embedded: [number, number][] = [];
    const refined = refineTurnsWithSpans(base, prints, spans, (startMs, endMs) => {
      embedded.push([startMs, endMs]);
      if (startMs >= 10_000 && endMs <= 12_000) return print(0, 1);
      if (startMs >= 20_000 && endMs <= 22_500) return print(0, 1);
      if (startMs >= 22_500) return print(1, 0);
      return print(1, 0);
    });
    // Clean consecutive handoff inside 4000..7000 must stay intact as two distinct turns.
    expect(refined).toContainEqual({ startMs: 4000, endMs: 5400, voice: 0 });
    expect(refined).toContainEqual({ startMs: 5500, endMs: 7000, voice: 1 });
    // Ambiguous short cue 10000..12000 replaced cleanly with voice 1 (no leftover voice 0 inside it).
    expect(refined.filter((t) => t.startMs < 12_000 && t.endMs > 10_000)).toEqual([
      { startMs: 10_000, endMs: 12_000, voice: 1 },
    ]);
    // 5 s uncovered gap 20000..25000 split into two 2.5 s turns classified as voice 1 then voice 0.
    expect(refined).toContainEqual({ startMs: 20_000, endMs: 22_500, voice: 1 });
    expect(refined).toContainEqual({ startMs: 22_500, endMs: 25_000, voice: 0 });
    // Handoff cue 4000..7000 was NOT embedded as a whole override.
    expect(embedded).not.toContainEqual([4000, 7000]);
  });

  test("does not fill gaps when base turns cover less than half of the spans", () => {
    const base = [{ startMs: 0, endMs: 1000, voice: 0 }];
    const spans = [
      { startMs: 0, endMs: 2000 },
      { startMs: 2000, endMs: 6000 },
    ];
    let calls = 0;
    const refined = refineTurnsWithSpans(base, prints, spans, () => {
      calls++;
      return print(0, 1);
    });
    expect(refined).toEqual(base);
    expect(calls).toBe(0);
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
