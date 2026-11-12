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
import { joinsUnspaced } from "../../src/shared/transcriptTurns";

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

describe("A long stretch the engine on this computer read in parts (#1031)", () => {
  /** Three parts of one stretch, each cut at a quiet moment inside a sentence. */
  const PARTS = {
    en: [
      "We looked at the three offices on the list and the one near the station has room for forty people and a",
      "kitchen on the second floor, so I think we should take it if the landlord agrees to the",
      "longer lease and the parking. Then we can move in March.",
    ],
    "zh-CN": [
      "我们看了名单上的三个办公室，车站旁边那个能坐四十个人，还有一个",
      "在二楼的厨房，所以我觉得如果房东同意更长的",
      "租期和停车位，我们就租下来。三月份就能搬进去。",
    ],
  };
  const TIMES = [0, 11_850, 23_400, 31_000];

  for (const [language, texts] of Object.entries(PARTS)) {
    // protects=the parts of a long stretch, cut inside a sentence and touching end to end, are drawn as one turn of one paragraph that reads straight on across each cut, with a space between English words and none between Chinese characters; fails_when=a cut starts a new turn or paragraph, repeats the time and Speaker, or joins its words wrongly; no_claim=a cut at a sentence's end after 30 s, where a paragraph may break, which the turn tests cover.
    test(`reads as one paragraph of one turn across cuts that aren't sentence ends, ${language}`, () => {
      const rows: PartRow[] = texts.map((text, at) => {
        const cue: Cue = {
          startMs: TIMES[at] as number,
          endMs: TIMES[at + 1] as number,
          text,
          speaker: "Me",
        };
        return {
          id: lineId(cue.startMs, cue.endMs, cue.speaker),
          part: partsOf(null, fileLineOf(cue))[0] as PartRow["part"],
          cue,
          pieces: [],
        };
      });

      const turns = turnRowsOf(rows, null, [], null);

      expect(turns).toHaveLength(1);
      expect(turns[0]?.paragraphs.map((paragraph) => paragraph.length)).toEqual([3]);
      const paragraph = turns[0]?.paragraphs[0] ?? [];
      const shown = paragraph
        .map((row, at) => {
          const before = paragraph[at - 1];
          return before && !joinsUnspaced(before.part.text, row.part.text)
            ? ` ${row.part.text}`
            : row.part.text;
        })
        .join("");
      expect(shown).toBe(texts.join(language === "en" ? " " : ""));
      expect(shown).toContain(
        language === "en"
          ? "forty people and a kitchen on the second floor"
          : "还有一个在二楼的厨房",
      );
    });
  }
});
