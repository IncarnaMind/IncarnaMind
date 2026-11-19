import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hypothesisSegment, readHypothesis } from "../../eval/meetings/hypotheses";

import { afterCallLines, transcriptCues } from "../../eval/speakers/lines";

describe("Reading a transcriber's results", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "incarnamind-hypotheses-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("a case with no file is left out, not failed", async () => {
    await expect(readHypothesis(folder, "en-online-X")).resolves.toBeNull();
  });

  test("a file that is no JSON fails, naming the file", async () => {
    await writeFile(join(folder, "en-online-X.json"), '{"case": "en-online-X", "segments": [');
    await expect(readHypothesis(folder, "en-online-X")).rejects.toThrow(
      /en-online-X\.json isn't JSON/,
    );
  });

  test("a file for another case, or with no segments, fails", async () => {
    await writeFile(join(folder, "a.json"), JSON.stringify({ case: "b", segments: [] }));
    await expect(readHypothesis(folder, "a")).rejects.toThrow(/isn't a hypothesis for a/);
    await writeFile(join(folder, "c.json"), JSON.stringify({ case: "c" }));
    await expect(readHypothesis(folder, "c")).rejects.toThrow(/isn't a hypothesis for c/);
  });

  test("a hypothesis comes back as it was written", async () => {
    const written = { case: "d", transcriber: "t", segments: [{ start: 1, end: 2, text: "hi" }] };
    await writeFile(join(folder, "d.json"), JSON.stringify(written));
    await expect(readHypothesis(folder, "d")).resolves.toEqual(written);
  });
  test("a saved word time gives each part of a shared transcript line to its speaker", async () => {
    const text = "This one. Another word.";
    const segment = hypothesisSegment(
      {
        stream: "system",
        id: 1,
        startMs: 100,
        endMs: 3000,
        final: true,
        decodeMs: 0,
        text,
        words: [
          { text: "This", ms: 800 },
          { text: "one", ms: 1150 },
          { text: "Another", ms: 1650 },
          { text: "word", ms: 1850 },
        ],
      },
      "Them",
    );
    await writeFile(
      join(folder, "call.json"),
      JSON.stringify({ case: "call", transcriber: "t", segments: [segment] }),
    );
    const saved = await readHypothesis(folder, "call");
    if (!saved) throw new Error("Missing saved hypothesis.");
    const turns = [
      { startMs: 100, endMs: 1400, voice: 0 },
      { startMs: 1550, endMs: 3000, voice: 1 },
    ];
    const cues = transcriptCues(saved, true, Number.POSITIVE_INFINITY);
    expect(afterCallLines(cues, turns, true)).toEqual([
      { startMs: 100, endMs: 1650, text: "This one.", speaker: "Speaker 1" },
      { startMs: 1650, endMs: 3000, text: "Another word.", speaker: "Speaker 2" },
    ]);
    expect(transcriptCues(saved, true, 1.5)[0]).toMatchObject({
      endMs: 1500,
      text: "This one.",
      words: [
        { at: 0, ms: 800 },
        { at: 5, ms: 1150 },
      ],
    });
    const older = { ...saved, segments: [{ start: 0.1, end: 3, text, speaker: "Them" }] };
    expect(afterCallLines(transcriptCues(older, true, 4), turns, true)).toEqual([
      { startMs: 100, endMs: 3000, text, speaker: "Them" },
    ]);
  });

  test("a timed cutoff omits text that has not started and keeps a complete cue at the cutoff", () => {
    const segments = [
      { start: 6.846, end: 8.556, text: "好", words: [{ at: 0, ms: 7220 }] },
      { start: 5, end: 7, text: "hi", words: [{ at: 0, ms: 7000 }] },
      { start: 3, end: 4, text: "" },
    ];
    const cues = transcriptCues({ case: "room", transcriber: "t", segments }, false, 7);
    expect(cues.map((cue) => cue.text)).toEqual(["hi", ""]);
  });

  test("the unlabelled remote and its only identified voice both stay Them if separation fails", () => {
    const segments = [
      { start: 0, end: 1, text: "one", speaker: "system:7" },
      { start: 1, end: 2, text: "two", speaker: "Them" },
      { start: 2, end: 3, text: "me", speaker: "Me" },
      { start: 3, end: 4, text: "three", speaker: "system:2" },
    ];
    const saved = { case: "call", transcriber: "t", segments };
    const labels = (until: number) =>
      afterCallLines(transcriptCues(saved, true, until), [], true).map((line) => line.speaker);
    expect(labels(3)).toEqual(["Them", "Them", "Me"]);
    expect(labels(4)).toEqual(["Speaker 1", "Them", "Me", "Speaker 2"]);
  });
});
