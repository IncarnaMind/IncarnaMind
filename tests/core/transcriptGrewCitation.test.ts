/**
 * A Citation of a meeting's Transcript, checked again once the Transcript has a newer version
 * (#3762): a Transcript that only grew, lines added after the ones it had, stands as cited
 * (`grew`), so the card says nothing changed; any other change to its lines is a change.
 */
import { expect, test } from "vitest";
import { recheckCitation } from "../../src/core/answers/citations";
import { type Cue, transcriptUnits } from "../../src/core/documents/formats/vtt";

const cues: Cue[] = [
  { startMs: 0, endMs: 2000, text: "The launch is on Monday.", speaker: "Them" },
  { startMs: 2000, endMs: 4000, text: "The budget holds at one point two million.", speaker: "Me" },
];
const later: Cue = {
  startMs: 4000,
  endMs: 6000,
  text: "Press waits for the date.",
  speaker: "Them",
};

/** A Transcript's versions by their content hash, the one named `current` its version now. */
function transcript(versions: Record<string, Cue[]>, current: string) {
  const units = new Map(
    Object.entries(versions).map(([hash, each]) => [
      hash,
      transcriptUnits({ cues: each, gaps: [] }),
    ]),
  );
  return {
    currentVersion: () => current,
    documentName: () => "Transcript · Launch",
    pageTexts: (_documentId: string, version: string, from: number | null, to: number | null) =>
      (units.get(version) ?? []).filter(
        (unit) =>
          from === null ||
          to === null ||
          (unit.page !== null && unit.page >= from && unit.page <= to),
      ),
    passagesCovering: () => [
      { id: "passage", text: (units.get(current) ?? []).map((unit) => unit.text).join("\n") },
    ],
  };
}

const cited = {
  documentId: "transcript",
  contentHash: "cited",
  pageFrom: 1,
  pageTo: 1,
  quote: "The launch is on Monday.",
  location: { kind: "time" as const, from: 0, to: 2000, speaker: "Them" },
};

// protects=a Citation of a live Transcript stays as cited while the meeting only adds lines after it; fails_when=each new line of a recording makes every earlier Citation say its Document changed
test("a Transcript that only grew after its line was cited stands as cited", () => {
  const grown = transcript({ cited: cues, grown: [...cues, later] }, "grown");
  expect(recheckCitation(grown, cited)).toMatchObject({
    check: "found",
    contentHash: "grown",
    grew: true,
  });
  // Its own version, unchanged, says nothing of growing.
  expect(recheckCitation(transcript({ cited: cues }, "cited"), cited)).not.toHaveProperty("grew");
});

// protects=a real change to a Transcript's lines still counts as a change for its Citations; fails_when=an edited, split, relabelled or reordered Transcript passes for one that only grew
test.each([
  ["its line edited", [{ ...cues[0], text: "The launch is on Tuesday." } as Cue, cues[1] as Cue]],
  ["another line edited", [cues[0] as Cue, { ...cues[1], text: "The budget was cut." } as Cue]],
  [
    "its line split",
    [
      { startMs: 0, endMs: 1000, text: "The launch is", speaker: "Them" },
      { startMs: 1000, endMs: 2000, text: "on Monday.", speaker: "Them" },
      cues[1] as Cue,
    ],
  ],
  ["a speaker renamed in the file", [cues[0] as Cue, { ...cues[1], speaker: "Speaker 2" } as Cue]],
  ["a line dropped", [cues[0] as Cue, later]],
  [
    "a line put in before the last",
    [cues[0] as Cue, { ...later, startMs: 1500, endMs: 1900 }, cues[1] as Cue],
  ],
])("a Transcript with %s has changed", (_what, now) => {
  const result = recheckCitation(transcript({ cited: cues, now }, "now"), cited);
  expect(result.contentHash).toBe("now");
  expect(result).not.toHaveProperty("grew");
});
