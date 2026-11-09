import { describe, expect, test } from "vitest";
import type { TranscriptSpeakers } from "../../src/core/api";
import type { Cue } from "../../src/core/documents/formats/vtt";

import {
  fileLineOf,
  lineId,
  type PartRow,
  turnLinesOf,
  turnRowsOf,
} from "../../src/renderer/src/viewer/transcriptTurnRows";
import {
  nameOf,
  partsOf,
  speakerOf,
  type TranscriptLine,
  withLineSplit,
  withSpeakerChosen,
} from "../../src/shared/speakers";

/** One Speaker's monologue, a line a sentence, as a cloud route gives it. */
const CUES: Cue[] = [
  { startMs: 0, endMs: 3000, text: "We sign on Friday then.", speaker: "Speaker 1" },
  { startMs: 3200, endMs: 6000, text: "The board reads it next.", speaker: "Speaker 1" },
  { startMs: 6200, endMs: 9000, text: "Press waits for the date.", speaker: "Speaker 1" },
];
const LINES: TranscriptLine[] = CUES.map((cue) => ({
  startMs: cue.startMs,
  label: cue.speaker as string,
}));

/** The lines as the view draws them, each part of a split line one of its own. */
const rowsOf = (speakers: TranscriptSpeakers | null): PartRow[] =>
  CUES.flatMap((cue) =>
    partsOf(speakers, fileLineOf(cue)).map((part) => ({
      id: lineId(part.startMs, part.endMs, cue.speaker),
      part,
      cue,
      pieces: [],
    })),
  );

const shownSpeakers = (speakers: TranscriptSpeakers | null) =>
  rowsOf(speakers).map((row) => {
    const label = speakerOf(speakers, row.part.startMs, row.part.label);
    return [row.part.text, nameOf(speakers, label) ?? label];
  });

describe("Who speaks a split's rest", () => {
  // protects=while the menu asks who speaks the rest of a line split inside a turn, the rest is a turn of its own, so naming someone names the rest alone and no later line of the turn; fails_when=the rest's turn takes in the lines after it and the choice renames them too; no_claim=the menu itself, which the window spec drives.
  test("naming a split's rest renames no later line of the turn", () => {
    const at = "We sign on Friday ".length;
    const split = withLineSplit(null, fileLineOf(CUES[0] as Cue), at, 1800, LINES);
    const rows = rowsOf(split);
    const rest = rows.find((row) => row.part.text.startsWith("then"));
    if (!rest) throw new Error("No rest.");

    const turns = turnRowsOf(rows, split, [], rest.id);
    const asked = turns.find((turn) => turn.id === rest.id);
    if (!asked) throw new Error("The rest isn't a turn.");
    expect(turnLinesOf(asked)).toEqual([{ startMs: rest.part.startMs, label: "Speaker 1" }]);
    expect(turns).toHaveLength(3);

    const named = withSpeakerChosen(split, LINES, turnLinesOf(asked), { name: "Sam" }, false);
    expect(shownSpeakers(named)).toEqual([
      ["We sign on Friday", "Speaker 1"],
      ["then.", "Sam"],
      ["The board reads it next.", "Speaker 1"],
      ["Press waits for the date.", "Speaker 1"],
    ]);
    // Answered, the turns are drawn as said: the rest by Sam, then the first Speaker going on.
    expect(
      turnRowsOf(rowsOf(named), named, [], null).map((turn) => turn.paragraphs.flat().length),
    ).toEqual([1, 1, 2]);
  });
});
