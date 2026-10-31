import {
  currencyNamed,
  type Figure,
  type FigureContext,
  readFigures,
  readingsOf,
  readStatedUnits,
} from "../../../shared/figures";
import type { Citation, InputNumber } from "../../api";
import { writtenNumbers } from "../../transcription/spokenNumbers";
import { documentFigureContext } from "../calculations";
import { figuresInClaim, statedFigure } from "./calculated";
import type { ReadVerdict } from "./prompt";
import { unitNotStated } from "./units";

const spaced = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();

/** The word a figure of `text` is counted in, written after it: "trips" in "4,005 trips". */
const wordAfter = (text: string, figure: Pick<Figure, "end">) =>
  /^\s*([\p{L}]+)/u.exec(text.slice(figure.end))?.[1]?.toLowerCase() ?? null;

/** Whether a column's heading names what `word` counts: "Trips" names trips, "户数" 户. */
const headingNames = (heading: string, word: string) => {
  const named = heading.toLowerCase();
  return named.includes(word) || (word.length > 3 && named.includes(word.replace(/e?s$/u, "")));
};

/**
 * Whether a quoted sheet row states `figure` (#2311): a cell holds its value, and the cell's
 * column heading names its unit, which a row's cells leave to the heading ("12" under "Docks").
 * A sheet's Units are its rows, a line each with tab-separated cells, the heading row first.
 */
function rowStates(
  claim: string,
  figure: Figure,
  quote: string,
  units: readonly { text: string }[],
  context: FigureContext,
): boolean {
  const word = figure.unit.kind === "other" ? figure.unit.word : wordAfter(claim, figure);
  if (!word || (figure.unit.kind !== "other" && figure.unit.kind !== "plain")) return false;
  const quoted = spaced(quote);
  return units.some((unit) => {
    const [heading, ...rows] = unit.text.split("\n");
    if (!heading?.includes("\t")) return false;
    const headings = heading.split("\t");
    return rows.some((row) => {
      const cells = row.split("\t");
      if (!spaced(cells.join(" ")).includes(quoted)) return false;
      return cells.some((cell, column) => {
        const [read, ...more] = readFigures(cell, { ...context, header: null });
        return (
          read !== undefined &&
          more.length === 0 &&
          read.value === figure.value &&
          read.unit.kind === "plain" &&
          headingNames(headings[column] ?? "", word)
        );
      });
    });
  });
}

/**
 * Whether a quote states `figure` in words (#2311): "forty-two thousand pounds" states £42,000,
 * "twelve new posts" 12. Chinese numerals are figures already.
 */
function wordsState(figure: Figure, quote: string, context: FigureContext): boolean {
  const written = writtenNumbers(quote);
  if (written === quote) return false;
  return figuresInClaim(written, context).some((read) => {
    if (read.value !== figure.value || read.unit.kind !== "plain") return false;
    if (figure.unit.kind === "plain") return true;
    const named = wordAfter(written, read);
    return (
      figure.unit.kind === "currency" && named !== null && currencyNamed(named) === figure.unit.code
    );
  });
}

export async function needsCalculation({
  claim,
  verdict,
  attempted,
  computed,
  citations,
  inputs,
  confirm,
}: {
  claim: string;
  verdict: ReadVerdict;
  attempted: boolean;
  computed: readonly Figure[];
  citations: readonly { citation: Citation; units: readonly { text: string }[] }[];
  inputs: readonly InputNumber[];
  confirm(figure: Figure, citations: readonly Citation[]): Promise<boolean>;
}): Promise<boolean> {
  const context = documentFigureContext(citations.flatMap((citation) => citation.units));
  const own = documentFigureContext([{ text: claim }]);
  const claimFigures = figuresInClaim(claim, own.language ? own : { ...context, header: null });
  if (claimFigures.length === 0 && !attempted && !verdict.calculations?.length) return false;
  if (attempted && computed.length === 0) return true;
  if (
    verdict.verdict === "unsupported" &&
    verdict.topic === "not found" &&
    !attempted &&
    !verdict.calculations?.length
  )
    return false;
  const sameUnit = (a: Figure["unit"], b: InputNumber["unit"]) =>
    a.kind === b.kind &&
    (a.kind !== "currency" || (b.kind === "currency" && a.code === b.code)) &&
    (a.kind !== "other" || (b.kind === "other" && a.word === b.word));
  const matches = (a: Pick<Figure, "value" | "unit">, b: Pick<InputNumber, "value" | "unit">) =>
    a.value === b.value && sameUnit(a.unit, b.unit);
  const remaining = [...computed];
  if (
    verdict.calculations?.some((named) => {
      const wanted = statedFigure(claim, named, context);
      const at = wanted ? remaining.findIndex((number) => matches(wanted, number)) : -1;
      if (at < 0) return true;
      remaining.splice(at, 1);
      return false;
    })
  )
    return true;
  const unique = [
    ...new Map(
      citations.map((each) => [
        JSON.stringify([
          each.citation.documentId,
          each.citation.contentHash,
          each.citation.passageId,
          each.citation.quote,
        ]),
        each,
      ]),
    ).values(),
  ];
  const sources = unique.map(({ citation, units }) => {
    const context = documentFigureContext(units);
    const statements = readStatedUnits(units.map((unit) => unit.text).join("\n"), context);
    const header = statements.length === 1 ? statements[0]?.chars : undefined;
    const figures = figuresInClaim(citation.quote, context);
    const alternatives = header ? figuresInClaim(citation.quote, { ...context, header }) : [];
    return {
      citation,
      figures: figures.map((figure) => [
        figure,
        ...alternatives
          .filter((each) => each.start === figure.start && each.end === figure.end)
          .flatMap(readingsOf),
      ]),
    };
  });
  const available = [...sources.flatMap(({ figures }) => figures.flat()), ...inputs];
  const quoted = citations.map(({ citation, units }) => ({
    cited: () => citation.quote,
    document: () => units.map((unit) => unit.text).join("\n"),
  }));
  const unused = [...computed];
  for (const figure of claimFigures) {
    const at = unused.findIndex((number) => matches(figure, number));
    if (at >= 0) {
      unused.splice(at, 1);
      continue;
    }
    if (unitNotStated(figure.chars, quoted) !== null) continue;
    if (
      citations.some(
        ({ citation, units }) =>
          rowStates(claim, figure, citation.quote, units, context) ||
          wordsState(figure, citation.quote, context),
      )
    )
      continue;
    if (!available.some((source) => matches(figure, source))) {
      if (verdict.verdict === "supported" || (attempted && computed.length === 0)) return true;
      continue;
    }
    if (verdict.verdict !== "supported") continue;
    const inUnit = sources.flatMap((source) =>
      source.figures.filter((readings) =>
        readings.some((each) => sameUnit(figure.unit, each.unit)),
      ),
    );
    if (
      inUnit.length > 1 &&
      inUnit.some((readings) => readings.some((each) => matches(figure, each)))
    ) {
      if (
        !(await confirm(
          figure,
          sources.map(({ citation }) => citation),
        ))
      )
        return true;
    }
  }
  return false;
}
