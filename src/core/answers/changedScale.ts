/**
 * A comparison table's cell gave GBP 310,000 thousand as "310,000 GBP million", and its Citation
 * read "Quote found" all the same (#1798): the Citation check finds the words, not what an amount
 * is worth. So a program compares each amount a cell writes with the amounts its Citations quote,
 * each worth what its Document says once its scale is applied: its own, its row's unit cell, or
 * the unit its line or page states. An amount equal to none of them but 10ⁿ times one is a
 * changed scale. An amount none of them gives at any scale (worked out, or another figure) is
 * left alone, as are percents, multiples and plain counts.
 */

import { FIGURE_MARKER } from "../../shared/figureMarkers";
import {
  type Figure,
  type FigureContext,
  type Reading,
  readFigures,
  readStatedUnits,
  statesScale,
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

function givenAmounts(quoted: QuotedText, documentText: () => string): Given[] {
  const context = documentFigureContext(quoted.units);
  const { quote } = quoted.citation;
  const lines = quotedLines(quoted);
  let elsewhere: boolean | null = null;
  return readFigures(quote, context).flatMap((figure): Given[] => {
    if (!isAmount(figure)) return [];
    if (figure.scale !== 1) {
      return ownReadings(figure).map((reading) => ({
        value: reading.value,
        given: shown(figure.chars),
        scaled: true,
      }));
    }
    const row = readOnItsLine(lines, figure, context);
    if (row) return [{ value: row.value, given: shown(row.chars), scaled: true }];
    for (const where of [lines, joinUnits(quoted.units).text]) {
      const stated = statedIn(where, quote, figure.start, context);
      if (stated.length > 0) return stated;
    }
    // A scale stated elsewhere in the Document may or may not be this number's: it isn't settled.
    elsewhere ??= statesScale(documentText(), context);
    if (elsewhere) return [];
    return ownReadings(figure).map((reading) => ({
      value: reading.value,
      given: shown(figure.chars),
      scaled: false,
    }));
  });
}

const close = (written: Reading, value: number) =>
  Math.abs(written.value - value) <=
  Math.max(0.5 * 10 ** -written.decimals * written.scale, 1e-9 * Math.abs(value));

/**
 * The first amount `text` writes that its Citations (`cited`) give at another scale; null when
 * there is none. `documentText` is the whole text of a Citation's Document version; `language`
 * is the one the text is written in.
 */
export function changedScale<T extends QuotedText>(
  text: string,
  cited: readonly T[],
  documentText: (quoted: T) => string,
  language: Language,
): ChangedScale | null {
  if (cited.length === 0) return null;
  const words = text.replace(/\[\^\d{1,4}\]/g, " ").replace(FIGURE_MARKER, " ");
  // A cell is too short to tell its language by, and "95,000" must not read as 95.
  const own = documentFigureContext([{ text: words }]);
  const written = readFigures(words, own.language ? own : { ...own, language }).flatMap(
    (figure) => {
      const worth = writtenWorth(figure);
      return worth ? [{ figure, worth }] : [];
    },
  );
  if (written.length === 0) return null;
  const given = cited.flatMap((quoted) => givenAmounts(quoted, () => documentText(quoted)));
  for (const { figure, worth } of written) {
    if (worth.some((reading) => given.some((each) => close(reading, each.value)))) continue;
    for (const reading of worth) {
      for (const each of given) {
        if (reading.value === 0 || each.value === 0) continue;
        if (Math.sign(reading.value) !== Math.sign(each.value)) continue;
        // Neither scale stated: "£1,000" beside a quoted "£100" is likelier worked out than rescaled.
        if (!each.scaled && reading.scale === 1) continue;
        const power = Math.round(Math.log10(reading.value / each.value));
        if (power !== 0 && close(reading, each.value * 10 ** power)) {
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
