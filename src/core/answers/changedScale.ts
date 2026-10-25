/**
 * A comparison table's cell gave GBP 310,000 thousand as "310,000 GBP million", and its Citation
 * read "Quote found" all the same (#1798): the Citation check finds the words, not what an amount
 * is worth. So a program compares each amount a cell writes with the amounts its Citations quote,
 * each worth what its Document says once its scale is applied: its own, its row's unit cell, or
 * the unit its line or page states. Only the same digits at another power of ten count as a
 * changed scale, and only against an amount whose scale the Document states in words the reader
 * knows. Anything less certain is left alone: an amount none of them gives (worked out, a total
 * or a difference of them, or another figure), an approximate one, a scale stated in a form the
 * reader doesn't know ("£000", "TEUR"), and percents, multiples and plain counts. A check that
 * flags a right amount teaches the model to write a wrong one.
 */

import { FIGURE_MARKER } from "../../shared/figureMarkers";
import {
  type Figure,
  type FigureContext,
  type Reading,
  readFigures,
  readStatedUnits,
} from "../../shared/figures";
import { joinUnits } from "../../shared/locations";
import type { Language } from "../language";
import { documentFigureContext, type QuotedText, quotedLines, readOnItsLine } from "./calculations";

export interface ChangedScale {
  /** The amount as the cell writes it: "310,000 GBP million". */
  written: string;
  /** The amount as its Document gives it, with the unit it states: "310000 GBP thousands". */
  given: string;
  /** How many times the given amount the written one is: 1000, or 0.001. */
  times: number;
}

interface Given {
  value: number;
  given: string;
  /** Its Document states its scale, not only its digits. */
  scaled: boolean;
}

const isAmount = (figure: Figure) =>
  (figure.unit.kind === "plain" || figure.unit.kind === "currency") && figure.rangeTo === null;

const shown = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/(\d) (?=\p{Script=Han})/gu, "$1")
    .trim();

const statedReadings = (figure: Figure): Reading[] =>
  figure.ambiguous
    .filter((each) => each.kind === "scale")
    .flatMap((each) => each.readings)
    .filter((each) => each.scale !== 1);

const ownReadings = (figure: Figure): Reading[] => [
  figure,
  ...figure.ambiguous
    .filter((each) => each.kind === "separator" || each.kind === "sign")
    .flatMap((each) => each.readings),
];

function writtenWorth(figure: Figure): Reading[] | null {
  if (!isAmount(figure)) return null;
  if (figure.scale !== 1) return ownReadings(figure);
  const stated = statedReadings(figure);
  if (stated.length > 0) return stated;
  return figure.unit.kind === "currency" ? ownReadings(figure) : null;
}

function statedIn(where: string, quote: string, start: number, context: FigureContext): Given[] {
  const statements = readStatedUnits(where, context).filter((each) => each.scale !== 1);
  if (statements.length === 0) return [];
  const read = readFigures(quote, {
    ...context,
    header: statements.map((each) => each.chars).join("\n"),
  }).find((each) => each.start === start);
  return (read ? statedReadings(read) : []).map((reading) => ({
    value: reading.value,
    given: shown(
      `${read?.chars ?? ""} ${statements.find((each) => each.scale === reading.scale)?.chars ?? ""}`,
    ),
    scaled: true,
  }));
}

function givenAmounts(quoted: QuotedText): Given[] {
  const context = documentFigureContext(quoted.units);
  const { quote } = quoted.citation;
  const lines = quotedLines(quoted);
  return readFigures(quote, context).flatMap((figure): Given[] => {
    if (!isAmount(figure)) return [];
    const own = (scaled: boolean) =>
      ownReadings(figure).map((reading) => ({
        value: reading.value,
        given: shown(figure.chars),
        scaled,
      }));
    if (figure.scale !== 1) return own(true);
    const row = readOnItsLine(lines, figure, context);
    if (row) return [{ value: row.value, given: shown(row.chars), scaled: true }];
    for (const where of [lines, joinUnits(quoted.units).text]) {
      const stated = statedIn(where, quote, figure.start, context);
      // "$2.15" under "(in millions, except per share data)" may be either: both stand.
      if (stated.length > 0) return figure.currency ? [...stated, ...own(false)] : stated;
    }
    return own(false);
  });
}

// To the precision the amount is written in: "£310 million" is 310,412 thousand.
const close = (written: Reading, value: number) =>
  Math.abs(written.value - value) <=
  Math.max(0.5 * 10 ** -written.decimals * written.scale, 1e-9 * Math.abs(value));

const exactly = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), 1);

function workedOut(values: readonly number[]): number[] {
  const out = [values.reduce((sum, each) => sum + each, 0)];
  values.forEach((a, at) => {
    for (const b of values.slice(at + 1)) out.push(a + b, a - b, b - a);
  });
  return out;
}

/**
 * The first amount `text` writes that its Citations (`cited`) give at another scale; null when
 * there is none. `language` is the one the text is written in.
 */
export function changedScale(
  text: string,
  cited: readonly QuotedText[],
  language: Language,
): ChangedScale | null {
  if (cited.length === 0) return null;
  const words = text.replace(/\[\^\d{1,4}\]/g, " ").replace(FIGURE_MARKER, " ");
  // A cell is too short to tell its language by, and "95,000" must not read as 95.
  const context = documentFigureContext([{ text: words }]);
  const written = readFigures(words, context.language ? context : { ...context, language });
  const given = cited.flatMap(givenAmounts);
  const sums = workedOut([...new Set(given.map((each) => each.value))]);
  for (const figure of written) {
    const worth = writtenWorth(figure);
    if (!worth || figure.approximate) continue;
    const matches = (value: number) => worth.some((reading) => close(reading, value));
    if (given.some((each) => matches(each.value)) || sums.some(matches)) continue;
    for (const reading of worth) {
      for (const each of given) {
        if (!each.scaled || reading.value === 0 || each.value === 0) continue;
        if (Math.sign(reading.value) !== Math.sign(each.value)) continue;
        const power = Math.round(Math.log10(reading.value / each.value));
        if (power !== 0 && exactly(reading.value, each.value * 10 ** power)) {
          const stated = reading.scale !== figure.scale ? (reading.scaleWord ?? "") : "";
          return {
            written: shown(`${figure.chars} ${stated}`),
            given: each.given,
            times: 10 ** power,
          };
        }
      }
    }
  }
  return null;
}

/** What the model is told of a changed scale, to write its cell again once. */
export function changedScaleNote(found: ChangedScale, calculates: boolean): string {
  const times =
    found.times >= 1
      ? `${found.times.toLocaleString("en")} times`
      : `1/${Math.round(1 / found.times).toLocaleString("en")} of`;
  return `Your cell writes ${found.written}, which is ${times} the amount its Citation gives: the Document gives ${found.given}. Write the cell again with the amount at the scale the Document gives it${calculates ? ", or call calculate to show it in another scale" : ""}; never change an amount's scale yourself.`;
}
