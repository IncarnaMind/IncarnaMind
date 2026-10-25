/**
 * Calculated figures where an Answer writes them (ADR-0021): a marker such as
 * "[=1]" where the number goes, beside Citation markers ("[^1]"). Each reader
 * of an Answer puts the figure's shown text there, and a marker with no figure
 * is left out, with the space before it. A model often writes the number too,
 * right before its marker ("25% [=1]"): when it reads as the same figure it is
 * left out, so the text shows it once; when it doesn't, it stays, and the
 * figure keeps what the Answer wrote (`CalculatedFigure.written`). Words the
 * shown text already has around its number ("about", "$", "percentage
 * points", "万元") aren't shown twice when the model writes them beside the
 * marker too. Nor is a scale: one written after the marker is left out, and
 * kept as what the Answer wrote when it isn't the figure's ("12.03万元 亿元",
 * #577). Code keeps its markers. Pure: the core and the window share it.
 */
import type { CalculatedFigure } from "../core/api";
import {
  type MarkerReplacement,
  type NodeJSON,
  replaceMarkers,
  withoutSpaceBeforeRemoved,
} from "./blockJson";
import { type Figure, type FigureUnit, readFigures } from "./figures";

/** A figure marker as the model writes it: "[=1]". */
export const FIGURE_MARKER = /\[=(\d{1,4})\]/g;

/** What placing a figure needs of it. */
export type PlacedFigure = Pick<CalculatedFigure, "value" | "shown" | "show">;

/** A number written right before a figure's marker: where it starts in the text read, and whether it is that figure. */
export interface NumberBefore {
  start: number;
  chars: string;
  same: boolean;
}

/** The number `before` ends with (spaces aside), as it bears on `figure`; null when it ends with none. */
export function numberBefore(before: string, figure: PlacedFigure): NumberBefore | null {
  const trimmed = before.replace(/\s+$/u, "");
  if (!trimmed) return null;
  const last = readFigures(trimmed, { language: figure.show.language }).at(-1);
  if (!last || last.end !== trimmed.length) return null;
  return { start: last.start, chars: last.chars, same: sameFigure(last, figure) };
}

/**
 * Whether what a model wrote reads as the figure: the same unit (a number
 * with none matches an amount), and the figure's value rounded to as many
 * decimals as the model wrote, in the scale it wrote.
 */
function sameFigure(written: Figure, figure: PlacedFigure): boolean {
  if (typeof figure.value !== "number" || written.ambiguous.length > 0) return false;
  const shown = readFigures(figure.shown, { language: figure.show.language })[0];
  if (!shown || !sameUnit(written.unit, shown.unit)) return false;
  const percent = written.unit.kind === "percent" || written.unit.kind === "points" ? 100 : 1;
  const wrote = (written.value / written.scale) * percent;
  const worked = (figure.value / written.scale) * percent;
  return Math.abs(wrote - worked) <= 0.5 * 10 ** -written.decimals + 1e-9 * Math.abs(worked);
}

function sameUnit(written: FigureUnit, shown: FigureUnit): boolean {
  if (written.kind === "plain") return ["plain", "currency", "other"].includes(shown.kind);
  if (written.kind === "currency") return shown.kind === "currency" && shown.code === written.code;
  if (written.kind === "other")
    return shown.kind === "other" && shown.word.toLowerCase() === written.word.toLowerCase();
  return written.kind === shown.kind;
}

/** A word that ends with a letter, cut from a longer word: "about" in "roundabout". */
const partOfWord = (text: string, at: number, word: string) =>
  /^[\p{L}]/u.test(word) && /[\p{L}]$/u.test(text.slice(0, at)) && /[A-Za-z]/.test(word);

/** What the shown text has before its number ("about", "$", "约") and after it ("%", "percentage points", "万元"). */
function wordsAround(shown: string): { lead: string; unit: string } | null {
  const number = /\d[\d.,]*/.exec(shown);
  if (!number) return null;
  return {
    lead: shown.slice(0, number.index).trim(),
    unit: shown.slice(number.index + number[0].length).trim(),
  };
}

const AMOUNT: ReadonlySet<FigureUnit["kind"]> = new Set(["plain", "currency", "other"]);

const unitKey = (unit: FigureUnit) => JSON.stringify(unit);

/**
 * A scale or unit written right after an amount's marker ("[=1] 亿元"), which
 * its shown text has its own of: how much of `after` to leave out, and the
 * words when they say another scale or currency than the figure's. A unit
 * that is the text's own ("people" after a count) stays, and so do words
 * after the unit ("以上", "左右").
 */
function scaleAfter(
  after: string,
  figure: PlacedFigure,
): { skip: number; written: string | null } | null {
  const space = /^[ \t]*/.exec(after)?.[0].length ?? 0;
  const rest = after.slice(space);
  if (!/^\p{L}/u.test(rest)) return null;
  const { language } = figure.show;
  const read = (text: string) => {
    const found = readFigures(`1${text}`, { language })[0];
    return found?.start === 0 && found.end > 1 ? found : null;
  };
  const shown = readFigures(figure.shown, { language })[0];
  const wrote = read(rest);
  if (!shown || !wrote || (wrote.scaleWord === null && wrote.unit.kind === "plain")) return null;
  if (!AMOUNT.has(shown.unit.kind) || !AMOUNT.has(wrote.unit.kind)) return null;
  let length = 1;
  for (; length < wrote.end - 1; length++) {
    if (/[A-Za-z]/.test(rest[length - 1] ?? "") && /[A-Za-z]/.test(rest[length] ?? "")) continue;
    const part = read(rest.slice(0, length));
    if (part?.scale === wrote.scale && unitKey(part.unit) === unitKey(wrote.unit)) break;
  }
  const words = rest.slice(0, length);
  const currencyDiffers =
    wrote.unit.kind === "currency" &&
    shown.unit.kind === "currency" &&
    !sameUnit(wrote.unit, shown.unit);
  const unitAgrees = wrote.unit.kind === "plain" || sameUnit(wrote.unit, shown.unit);
  const scaleAt = wrote.scaleWord ? words.indexOf(wrote.scaleWord) : -1;
  const scaleEnd = scaleAt < 0 ? 0 : scaleAt + (wrote.scaleWord?.length ?? 0);
  const taken = unitAgrees || currencyDiffers ? words.length : scaleEnd;
  if (taken <= 0) return null;
  const differs = currencyDiffers || (wrote.scaleWord !== null && wrote.scale !== shown.scale);
  return { skip: space + taken, written: differs ? words.slice(0, taken) : null };
}

/**
 * Where a figure's marker, ending at `end` in `text`, ends with the scale or unit written right
 * after it that its shown text has its own of ("[=1] 亿元"), which the figure takes in.
 */
export const figureMarkerEnd = (text: string, end: number, figure: PlacedFigure): number =>
  end + (scaleAfter(text.slice(end), figure)?.skip ?? 0);

/** Where a figure's marker is: what stays before it, what goes in its place, and what the Answer wrote there. */
function place(
  figure: PlacedFigure | null,
  before: string,
  after: string,
): MarkerReplacement & { written: string | null } {
  if (!figure)
    return { before: withoutSpaceBeforeRemoved(before, after), put: null, written: null };
  const found = numberBefore(before, figure);
  let kept = found?.same ? before.slice(0, found.start) : before;
  let skip = 0;
  const around = wordsAround(figure.shown);
  if (around?.lead && !found) {
    const trimmed = kept.trimEnd();
    const at = trimmed.length - around.lead.length;
    if (trimmed.endsWith(around.lead) && !partOfWord(trimmed, at, around.lead))
      kept = trimmed.slice(0, at);
  }
  if (around?.unit) {
    const space = /^[ \t]*/.exec(after)?.[0].length ?? 0;
    const next = after[space + around.unit.length];
    if (
      after.startsWith(around.unit, space) &&
      !(next !== undefined && /[A-Za-z]/.test(next) && /[A-Za-z]$/.test(around.unit))
    )
      skip = space + around.unit.length;
  }
  const scale = skip === 0 ? scaleAfter(after, figure) : null;
  return {
    before: kept,
    put: figure.shown,
    written: found && !found.same ? found.chars : (scale?.written ?? null),
    skip: scale?.skip ?? skip,
  };
}

/**
 * Turns the figure markers in Blocks into their figures: what `show` gives
 * for each (a node, or text with the marks around it), told what the Answer
 * wrote right before it when that isn't the figure. A marker `figureOf` has
 * no figure for is left out.
 */
export function withFigures<F extends PlacedFigure>(
  blocks: readonly NodeJSON[],
  figureOf: (marker: number) => F | null,
  show: (figure: F, marker: number, written: string | null) => NodeJSON | string,
): NodeJSON[] {
  return replaceMarkers(blocks, FIGURE_MARKER, (match, before, after) => {
    const marker = Number(match[1]);
    const figure = figureOf(marker);
    const placed = place(figure, before, after);
    return {
      before: placed.before,
      put: figure ? show(figure, marker, placed.written) : null,
      skip: placed.skip,
    };
  });
}

/** Markdown with each figure marker made its figure's shown text, for what reads an Answer as text. */
export function withFigureText(
  markdown: string,
  figureOf: (marker: number) => PlacedFigure | null,
): string {
  let text = "";
  let last = 0;
  for (const match of markdown.matchAll(FIGURE_MARKER)) {
    const end = match.index + match[0].length;
    const before = markdown.slice(last, match.index);
    const lineStart = before.lastIndexOf("\n") + 1;
    const placed = place(figureOf(Number(match[1])), before.slice(lineStart), markdown.slice(end));
    text +=
      before.slice(0, lineStart) +
      placed.before +
      (typeof placed.put === "string" ? placed.put : "");
    last = end + (placed.skip ?? 0);
  }
  return text + markdown.slice(last);
}
