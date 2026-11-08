import type { TranscriptSpeakers } from "../../../core/api";
import type { Cue } from "../../../core/documents/formats/vtt";
import {
  type FileLine,
  type LinePart,
  speakerOf,
  type TranscriptLine,
} from "../../../shared/speakers";
import { turnsOf } from "../../../shared/transcriptTurns";
import type { WordPiece } from "./transcriptWords";

/** A line as the Transcript shows it: a file's line, or a part of one the User split (#138). */
export interface PartRow {
  /** Names it: two lines can start together, so its start alone doesn't. */
  id: string;
  part: LinePart;
  /** Its file's line. */
  cue: Cue;
  pieces: WordPiece[];
}

/** A turn as the Transcript shows it: one Speaker's lines, in paragraphs (../../../shared/transcriptTurns). */
export interface TurnRow {
  /** Names it while it grows: its first line's id. */
  id: string;
  startMs: number;
  /** Its Speaker, as its lines have it now; null for lines that name no one. */
  speaker: string | null;
  paragraphs: PartRow[][];
}

/** Names a line: two can start together, so its start alone doesn't. */
export const lineId = (startMs: number, endMs: number, speaker: string | null) =>
  `${startMs}-${endMs}-${speaker ?? ""}`;

export const fileLineOf = (cue: Cue): FileLine => ({
  startMs: cue.startMs,
  endMs: cue.endMs,
  text: cue.text,
  label: cue.speaker ?? "",
});

/**
 * A Transcript's lines in turns, as the view shows them (../../../shared/transcriptTurns): a turn
 * breaks at a gap in the Transcript (`breaks`), and around the line whose Speaker the User is
 * asked for (`asking`), so the answer is that line's alone.
 */
export function turnRowsOf(
  parts: readonly PartRow[],
  speakers: TranscriptSpeakers | null,
  breaks: readonly number[],
  asking: string | null,
): TurnRow[] {
  return turnsOf(
    parts.map((row, index) => {
      const before = parts[index - 1];
      return {
        row,
        startMs: row.part.startMs,
        endMs: row.part.endMs,
        text: row.part.text,
        speaker:
          row.cue.speaker === null ? null : speakerOf(speakers, row.part.startMs, row.part.label),
        startsTurn:
          (asking !== null && (asking === row.id || asking === before?.id)) ||
          (before !== undefined &&
            breaks.some((at) => before.part.startMs < at && at <= row.part.startMs)),
      };
    }),
  ).map((turn) => {
    const paragraphs = turn.paragraphs.map((paragraph) => paragraph.map((line) => line.row));
    return {
      id: paragraphs[0]?.[0]?.id ?? "",
      startMs: turn.startMs,
      speaker: turn.speaker,
      paragraphs,
    };
  });
}

/** The lines a turn's Speaker menu says who speaks: all of the turn's that have a Speaker. */
export const turnLinesOf = (turn: TurnRow): TranscriptLine[] =>
  turn.paragraphs
    .flat()
    .flatMap((row) =>
      row.cue.speaker === null ? [] : [{ startMs: row.part.startMs, label: row.part.label }],
    );
