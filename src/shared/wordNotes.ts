/**
 * How a Word file's footnotes and endnotes are numbered (#746): the label
 * the n-th note shows, in the number format the file's settings give it.
 * A format this doesn't know is shown in figures, as Word falls back to.
 */
import type { WordNoteNumbering } from "../core/api";

export const DEFAULT_NOTE_NUMBERING: WordNoteNumbering = {
  footnote: { format: "decimal", start: 1 },
  endnote: { format: "lowerRoman", start: 1 },
};

const ROMAN: readonly [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function roman(value: number): string {
  let rest = value;
  let out = "";
  for (const [step, letters] of ROMAN) {
    for (; rest >= step; rest -= step) out += letters;
  }
  return out;
}

/** Word's letters: a to z, then aa, bb… */
const letters = (value: number) =>
  String.fromCharCode(97 + ((value - 1) % 26)).repeat(Math.floor((value - 1) / 26) + 1);

const CHICAGO = ["*", "†", "‡", "§"];

/** Above it, figures: a damaged file's start must not make a label endless. */
const MAX_LABELLED = 9999;

/** The label of the `ordinal`-th note (from 1) in `numbering`. */
export function noteLabel(ordinal: number, numbering: { format: string; start: number }): string {
  const value = numbering.start + ordinal - 1;
  if (value <= 0 || value > MAX_LABELLED) return String(value);
  switch (numbering.format) {
    case "lowerRoman":
      return roman(value);
    case "upperRoman":
      return roman(value).toUpperCase();
    case "lowerLetter":
      return letters(value);
    case "upperLetter":
      return letters(value).toUpperCase();
    case "chicago":
      return (CHICAGO[(value - 1) % 4] as string).repeat(Math.floor((value - 1) / 4) + 1);
    case "decimalEnclosedCircle":
    case "decimalEnclosedCircleChinese":
      return value <= 20 ? String.fromCharCode(0x2460 + value - 1) : String(value);
    default:
      return String(value);
  }
}
