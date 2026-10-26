/**
 * Charts in a Mind (#436): what a chart Block holds, and how one is made from
 * a table or from cited figures. A chart keeps the values it draws, each with
 * where it came from (its table cell, or its line of text) and the Citation
 * that was there, so every point can be traced to its source after the table
 * changes or goes. Charts from calculated figures (#439, #440) and from an
 * Analysis (#449) add their own kinds of origin beside these.
 *
 * Pure, with no Node or DOM imports: the editor, the core's one reader
 * (exports, Question context) and the tests share it.
 */
import {
  CITATION_NODE,
  type CitationAttributes,
  type CitationCheck,
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../core/api";
import type { NodeJSON } from "./blockJson";
import { type Figure, type FigureUnit, figureContextOf, readFigures } from "./figures";
import type { MessageKey, MessageParams } from "./i18n";
import { holdsPeriods, isPeriod } from "./periods";
import { readProposalAttribute } from "./proposals";

export const CHART_KINDS = ["bar", "line", "pie", "scatter"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** At most this many values in a chart: a longer table is cut, and the chart says so. */
export const MAX_CHART_VALUES = 500;

/** Past this many series, a chart's colours repeat (`ChartInk`). */
export const CATEGORY_COUNT = 9;

export type ChartValueOrigin =
  /** A cell of a table in the Mind: its row and column on the table's grid, from 0, the heading row included. */
  | { kind: "cell"; row: number; column: number }
  /** A cited figure in a line of text: the line's place among those the chart was made from, from 0. */
  | { kind: "text"; line: number };

export interface ChartValue {
  /** As written where it came from: "1.5亿", "$377.9 million", "41.2%". */
  shown: string;
  /** The number read from `shown` (./figures); null when it holds none, or none that reads one way: not drawn. */
  value: number | null;
  unit: FigureUnit | null;
  /** What its scale word multiplies by: 1e6 for "million", 1 with none; null in a chart made before charts kept it. */
  scale: number | null;
  /** The Citation that was with it, as its node held it; null: it had none. */
  citation: CitationAttributes | null;
  from: ChartValueOrigin;
}

export interface ChartRow {
  /** What the row is: the first column's text ("Q3"), or a line's words before its figure. */
  label: string;
  /** One per series, in order; null where the row has nothing in that column. */
  values: (ChartValue | null)[];
}

export interface ChartData {
  /** The first column's heading ("Quarter"); "" when the source has none. */
  labelHeading: string;
  /** Each column that holds a number, by its heading ("2025"); "" when it has none. */
  series: string[];
  rows: ChartRow[];
  /** How many rows the source had when only the first ones fit (`MAX_CHART_VALUES`); null: all are here. */
  cutFrom: number | null;
  /**
   * The source's rows after `rows`, when it was cut: never drawn, but listed in
   * Show as table with their Citations, so none is out of reach (#503).
   */
  cutRows: ChartRow[];
}

export type ChartSource =
  /** `switched`: the chart's rows are its table's columns. */
  { kind: "table"; blockId: string | null; switched?: boolean } | { kind: "figures" };

export interface ChartAttributes {
  kind: ChartKind;
  title: string;
  /** The series drawn, by their place in `data.series`; null: all of them. */
  drawn: number[] | null;
  data: ChartData;
  source: ChartSource;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const isKind = (value: unknown): value is ChartKind =>
  typeof value === "string" && (CHART_KINDS as readonly string[]).includes(value);

function readOrigin(value: unknown): ChartValueOrigin | null {
  if (!isRecord(value)) return null;
  const index = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null);
  if (value.kind === "cell") {
    const row = index(value.row);
    const column = index(value.column);
    return row === null || column === null ? null : { kind: "cell", row, column };
  }
  if (value.kind === "text") {
    const line = index(value.line);
    return line === null ? null : { kind: "text", line };
  }
  return null;
}

function readValue(value: unknown): ChartValue | null {
  if (!isRecord(value)) return null;
  const from = readOrigin(value.from);
  if (!from) return null;
  const number =
    typeof value.value === "number" && Number.isFinite(value.value) ? value.value : null;
  return {
    shown: text(value.shown),
    value: number,
    unit:
      isRecord(value.unit) && typeof value.unit.kind === "string"
        ? (value.unit as FigureUnit)
        : null,
    scale:
      typeof value.scale === "number" && Number.isFinite(value.scale) && value.scale > 0
        ? value.scale
        : null,
    citation: isRecord(value.citation) ? (value.citation as unknown as CitationAttributes) : null,
    from,
  };
}

/** Anything malformed (from another version, or a sync) is left out rather than guessed. */
export function readChartData(value: unknown): ChartData {
  if (!isRecord(value)) {
    return { labelHeading: "", series: [], rows: [], cutFrom: null, cutRows: [] };
  }
  const series = Array.isArray(value.series) ? value.series.map(text) : [];
  const readRows = (list: unknown) =>
    (Array.isArray(list) ? list : []).flatMap((row): ChartRow[] => {
      if (!isRecord(row)) return [];
      const values = Array.isArray(row.values) ? row.values : [];
      return [
        { label: text(row.label), values: series.map((_, index) => readValue(values[index])) },
      ];
    });
  const rows = readRows(value.rows);
  const cutFrom =
    typeof value.cutFrom === "number" &&
    Number.isInteger(value.cutFrom) &&
    value.cutFrom > rows.length
      ? value.cutFrom
      : null;
  const cutRows = cutFrom === null ? [] : readRows(value.cutRows);
  return { labelHeading: text(value.labelHeading), series, rows, cutFrom, cutRows };
}

/** Every row, as Show as table lists them: those drawn, then those cut from the drawing. */
export const listedRows = (data: ChartData): ChartRow[] => [...data.rows, ...data.cutRows];

function readSource(value: unknown): ChartSource {
  if (isRecord(value) && value.kind === "figures") return { kind: "figures" };
  const blockId = isRecord(value) && typeof value.blockId === "string" ? value.blockId : null;
  return {
    kind: "table",
    blockId,
    ...(isRecord(value) && value.switched === true ? { switched: true } : {}),
  };
}

export function readChart(attributes: Readonly<Record<string, unknown>>): ChartAttributes {
  const data = readChartData(attributes.data);
  const drawn = Array.isArray(attributes.drawn)
    ? [
        ...new Set(
          attributes.drawn.filter(
            (index): index is number =>
              typeof index === "number" &&
              Number.isInteger(index) &&
              index >= 0 &&
              index < data.series.length,
          ),
        ),
      ]
    : null;
  return {
    kind: isKind(attributes.kind) ? attributes.kind : "bar",
    title: text(attributes.title),
    drawn,
    data,
    source: readSource(attributes.source),
  };
}

/**
 * The series drawn, by their place in the data: those chosen (all, by default),
 * in order. A pie draws one, the last chosen ("this year"); a scatter chart
 * the first two, one across and one up.
 */
export function drawnSeries(chart: Pick<ChartAttributes, "kind" | "drawn" | "data">): number[] {
  const chosen = chosenSeries(chart);
  if (chart.kind === "pie") return chosen.slice(-1);
  if (chart.kind === "scatter") return chosen.slice(0, 2);
  return chosen;
}

/**
 * The columns chosen. The foot, Show as table and exports count and list
 * their cells: bar, line and scatter every one chosen, whatever they draw of
 * them; a pie the one it draws, the last chosen (#503).
 */
export function chosenSeries(chart: Pick<ChartAttributes, "kind" | "drawn" | "data">): number[] {
  const chosen = chart.drawn ?? chart.data.series.map((_, index) => index);
  return chart.kind === "pie" ? chosen.slice(-1) : chosen;
}

export interface ChartCell {
  row: number;
  series: number;
  value: ChartValue;
}

/** Row by row, as a table reads. */
export function chartCells(chart: Pick<ChartAttributes, "kind" | "drawn" | "data">): ChartCell[] {
  const series = chosenSeries(chart);
  return chart.data.rows.flatMap((row, index) =>
    series.flatMap((each) => {
      const value = row.values[each];
      return value ? [{ row: index, series: each, value }] : [];
    }),
  );
}

/**
 * A series' name: its heading, or, with none, "Column 3" (the column of the
 * table it came from, or its "Row 3" when the chart switched them) or "Value"
 * for figures from text, in the words of `say`.
 */
export function seriesName(
  chart: Pick<ChartAttributes, "data" | "source">,
  index: number,
  say: (key: MessageKey, params?: MessageParams) => string,
): string {
  const name = chart.data.series[index];
  if (name) return name;
  if (chart.source.kind === "figures") return say("chart.series.value");
  const from = chart.data.rows
    .map((row) => row.values[index]?.from)
    .find((each) => each?.kind === "cell");
  if (chart.source.switched) {
    return say("chart.series.unnamedRow", {
      number: from?.kind === "cell" ? from.row + 1 : index + 1,
    });
  }
  return say("chart.series.unnamed", {
    number: from?.kind === "cell" ? from.column + 1 : index + 2,
  });
}

/** Whether a kind can be drawn from this data: a scatter chart needs two series. */
export const kindFits = (kind: ChartKind, data: ChartData) =>
  kind !== "scatter" || data.series.length >= 2;

export interface ChartPoint {
  row: number;
  series: number;
  value: ChartValue & { value: number };
}

/**
 * The points drawn, series by series, each in row order; a scatter chart's
 * are its rows with a number in both series, as the one series up.
 */
export function chartPoints(chart: Pick<ChartAttributes, "kind" | "drawn" | "data">): ChartPoint[] {
  const drawn = drawnSeries(chart);
  const { rows } = chart.data;
  const points: ChartPoint[] = [];
  const unitless = new Map(drawn.map((series) => [series, unitlessRows(chart.data, series)]));
  const drawable = (value: ChartValue | null | undefined, row: number, series: number) =>
    value?.value != null && !unitless.get(series)?.has(row);
  if (chart.kind === "scatter") {
    const [across, up] = drawn;
    if (across === undefined || up === undefined) return [];
    rows.forEach((row, index) => {
      const x = row.values[across];
      const y = row.values[up];
      if (drawable(x, index, across) && drawable(y, index, up)) {
        points.push({ row: index, series: up, value: y as ChartPoint["value"] });
      }
    });
    return points;
  }
  for (const series of drawn) {
    rows.forEach((row, index) => {
      const value = row.values[series];
      // A pie has no room for a share below nothing.
      if (!drawable(value, index, series) || (chart.kind === "pie" && (value?.value ?? 0) <= 0))
        return;
      points.push({ row: index, series, value: value as ChartPoint["value"] });
    });
  }
  return points;
}

type Measured = Pick<ChartValue, "unit" | "scale">;

/** Whether a value says what it counts: a unit ("$", "%", "吨") or a scale ("million", "亿"). */
function saysUnit(value: Measured): boolean {
  return (value.unit !== null && value.unit.kind !== "plain") || (value.scale ?? 1) !== 1;
}

/** One key per unit a column's numbers can share: "$" whatever its scale, "%", or a scale alone. */
function unitKey(value: Measured): string {
  const { unit } = value;
  if (!unit || unit.kind === "plain") return "scale";
  if (unit.kind === "currency") return `currency:${unit.code}`;
  if (unit.kind === "other") return `other:${unit.word}`;
  return unit.kind;
}

/** "one" also when only half of them say it: the bare others aren't drawn (`unitlessRows`). */
function unitsOf(values: readonly Measured[]): "none" | "one" | "mixed" {
  const withUnit = values.filter(saysUnit);
  const units = new Set(withUnit.map(unitKey)).size;
  if (units === 0) return "none";
  return units === 1 && withUnit.length * 2 >= values.length ? "one" : "mixed";
}

/**
 * The rows of a column whose number has no unit or scale ("120.0") while the
 * column's other numbers share one, at least as many of them ("$331.2
 * million"; #579). Drawn, the bare number would be read on another scale, and
 * the chart never guesses its unit, so it isn't drawn. A column with no unit
 * anywhere, or with different ones, is drawn as it is.
 */
export function unitlessRows(data: ChartData, series: number): Set<number> {
  const numbered = data.rows.flatMap((row, index) => {
    const value = row.values[series];
    return value?.value != null ? [{ index, value }] : [];
  });
  return unitsOf(numbered.map((each) => each.value)) === "one"
    ? new Set(numbered.filter((each) => !saysUnit(each.value)).map((each) => each.index))
    : new Set();
}

export interface ChartUnitGroup {
  /** The drawn series in this chart, by their place in `data.series`. */
  series: number[];
  /**
   * What its values measure, for its label; null when none states one, and
   * for a pie or scatter chart, whose series are read together.
   */
  unit: FigureUnit | null;
}

function seriesUnit(data: ChartData, series: number): { key: string; unit: FigureUnit | null } {
  const unitless = unitlessRows(data, series);
  const units = new Map<string, FigureUnit>();
  data.rows.forEach((row, index) => {
    const value = row.values[series];
    if (!value || value.value === null || unitless.has(index) || !saysUnit(value)) return;
    const key = unitKey(value);
    if (!units.has(key)) units.set(key, value.unit ?? { kind: "plain" });
  });
  const entries = [...units.entries()];
  const only = entries[0];
  if (entries.length === 1 && only) {
    return { key: only[0], unit: only[1].kind === "plain" ? null : only[1] };
  }
  const keys = entries.map(([key]) => key).sort();
  return { key: keys.length === 0 ? "none" : `mixed:${keys.join(",")}`, unit: null };
}

/**
 * A chart's drawn series grouped by what they measure (#1392): series of one
 * unit share a chart, and each other unit gets its own, so none is drawn on
 * another's scale. A pie draws one column, and a scatter chart's two are read
 * together: either is one chart however its units differ.
 */
export function unitGroups(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
): ChartUnitGroup[] {
  const drawn = drawnSeries(chart);
  if (chart.kind === "pie" || chart.kind === "scatter") return [{ series: drawn, unit: null }];
  const groups = new Map<string, ChartUnitGroup>();
  for (const series of drawn) {
    const { key, unit } = seriesUnit(chart.data, series);
    const group = groups.get(key);
    if (group) group.series.push(series);
    else groups.set(key, { series: [series], unit });
  }
  return [...groups.values()];
}

export interface ChartSourcePlace {
  /**
   * The first of its Citations whose quote wasn't found, if any, else the
   * first: what an export's footnote for the place says.
   */
  citation: CitationAttributes;
  count: number;
}

export interface ChartSources {
  values: number;
  uncited: number;
  /** Those values with no Citation, row by row: what the foot's "1 with no Citation" finds. */
  uncitedCells: { row: number; series: number }[];
  /** Cells of the columns chosen that hold words but no number, so aren't drawn. */
  notDrawn: number;
  /** Cells whose number has no unit where their column's others have one, so aren't drawn (`unitlessRows`). */
  noUnit: number;
  places: ChartSourcePlace[];
  documents: number;
}

function placeKey(citation: CitationAttributes): string {
  const document = citation.documentId ?? citation.documentName ?? "";
  const where = citation.location
    ? JSON.stringify(citation.location)
    : `${citation.pageFrom ?? ""}-${citation.pageTo ?? ""}`;
  return `${document}\u0000${where}`;
}

const isFound = (check: CitationCheck | undefined) => check === "found";

export function chartSources(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
): ChartSources {
  const places = new Map<string, ChartSourcePlace>();
  const documents = new Set<string>();
  let values = 0;
  const uncitedCells: ChartSources["uncitedCells"] = [];
  let notDrawn = 0;
  let noUnit = 0;
  const unitless = new Map(
    chosenSeries(chart).map((series) => [series, unitlessRows(chart.data, series)]),
  );
  for (const { row, series, value } of chartCells(chart)) {
    if (value.value === null) {
      if (value.shown.trim() !== "") notDrawn++;
      continue;
    }
    if (unitless.get(series)?.has(row)) {
      noUnit++;
      continue;
    }
    values++;
    const { citation } = value;
    if (!citation) {
      uncitedCells.push({ row, series });
      continue;
    }
    documents.add(citation.documentId ?? citation.documentName ?? "");
    const key = placeKey(citation);
    const place = places.get(key);
    if (!place) places.set(key, { citation, count: 1 });
    else {
      place.count++;
      if (isFound(place.citation.check) && !isFound(citation.check)) place.citation = citation;
    }
  }
  return {
    values,
    uncited: uncitedCells.length,
    uncitedCells,
    notDrawn,
    noUnit,
    places: [...places.values()],
    documents: documents.size,
  };
}

/** What a figure doesn't settle that changes its value: drawn, it would be a guess. */
const UNSETTLED = new Set(["separator", "sign"]);

function figureIn(figures: readonly Figure[]): { figure: Figure; value: number | null } | null {
  const [figure] = figures;
  if (!figure) return null;
  const unsettled = figure.ambiguous.some((each) => UNSETTLED.has(each.kind));
  return { figure, value: unsettled || !Number.isFinite(figure.value) ? null : figure.value };
}

export interface SourceCell {
  /** Its text, without its Citations' markers or its footnotes' text. */
  text: string;
  citation: CitationAttributes | null;
  header: boolean;
  /** It spans down or across from another slot: its value is that slot's, its words read again. */
  continued?: boolean;
}

/** A table laid out on its grid, row by row: a cell in each slot, or null where none is. */
export type SourceGrid = readonly (readonly (SourceCell | null)[])[];

export interface FromTableOptions {
  /** The table Block's id, so the chart can tell when it changes. */
  blockId: string | null;
  title: string;
  /** The Mind's language, a BCP 47 tag: how its numbers are written when its text doesn't say. */
  language: string;
  /** True: the first row is the labels. Left out, the table's periods decide (`chartFromTable`). */
  switched?: boolean;
}

const BLANK_MARK = /^(?:[-–—−]+|n\/?a|n\.a\.|nm|无|暂无)$/i;

interface TableReading {
  first: readonly (SourceCell | null)[];
  headingRow: boolean;
  firstDataRow: number;
  dataRows: SourceGrid;
  columns: number;
  /** Each text is read once: `numericSeries` and the chart read the table twice. */
  figuresOf(text: string): readonly Figure[];
  /** A cell of a body column: `figuresOf`, but a bare year-like number in a quantity column is one. */
  figuresIn(text: string, column: number): readonly Figure[];
}

/** A whole number from 1900 to 2099 and nothing else: `readFigures` leaves it out, as a year. */
const BARE_YEAR = /^(?:19|20)\d{2}$/;

const QUANTITY_HEADER =
  /\b(?:units?|sold|sales|revenues?|income|profit|cost|price|amount|quantity|qty|count|total|orders?|users?|customers?|visitors?|volume|headcount|employees)\b|销量|销售|收入|营收|数量|金额|价格|成本|利润|总计|人数|订单|用户|客户|员工/iu;

const YEAR_HEADER =
  /\b(?:years?|dates?|periods?|fy|founded|established|since|born|launched|released|published|opened)\b|年份|年度|日期|成立|创立|创办|始于|出生|发布|上市|^年$/iu;

/**
 * Whether a body column is a year or date axis, whose bare years are labels, not values: its
 * header names none of a quantity or a period, and says "year" or holds nothing but years. Any
 * other column holds quantities, so 2000 under "Units sold" is a value (#1131).
 */
function yearAxis(header: string, cells: readonly string[]): boolean {
  if (QUANTITY_HEADER.test(header) || isPeriod(header)) return false;
  return YEAR_HEADER.test(header) || (cells.length > 0 && cells.every((c) => BARE_YEAR.test(c)));
}

function readTable(grid: SourceGrid, language: string): TableReading {
  const first = grid[0] ?? [];
  const context = figureContextOf(
    grid.flatMap((row) => row.map((cell) => cell?.text ?? "")).join("\n"),
    language,
  );
  const read = new Map<string, readonly Figure[]>();
  const figuresOf = (text: string) => {
    const trimmed = text.trim();
    let figures = read.get(trimmed);
    if (!figures) {
      figures = readFigures(trimmed, context);
      read.set(trimmed, figures);
    }
    return figures;
  };
  const headingRow =
    first.length > 0 &&
    (first.every((cell) => cell === null || cell.header) ||
      first.slice(1).every((cell) => !cell || figureIn(figuresOf(cell.text)) === null));
  const dataRows = headingRow ? grid.slice(1) : grid;
  const axes = new Map<number, boolean>();
  const isYearAxis = (column: number) => {
    let axis = axes.get(column);
    if (axis === undefined) {
      const cells = dataRows.flatMap((row) => {
        const cell = row[column];
        const text = cell?.text.trim() ?? "";
        return !cell || cell.continued || text === "" || BLANK_MARK.test(text) ? [] : [text];
      });
      axis = yearAxis(headingRow ? (first[column]?.text.trim() ?? "") : "", cells);
      axes.set(column, axis);
    }
    return axis;
  };
  const asQuantities = new Map<string, readonly Figure[]>();
  const figuresIn = (text: string, column: number) => {
    const trimmed = text.trim();
    if (!BARE_YEAR.test(trimmed) || isYearAxis(column)) return figuresOf(trimmed);
    let figures = asQuantities.get(trimmed);
    if (!figures) {
      figures = readFigures(trimmed, { ...context, dates: true });
      asQuantities.set(trimmed, figures);
    }
    return figures;
  };
  return {
    first,
    headingRow,
    firstDataRow: headingRow ? 1 : 0,
    dataRows,
    columns: Math.max(0, ...grid.map((row) => row.length)),
    figuresOf,
    figuresIn,
  };
}

/** The word that makes a figure approximate ("约", "about") isn't part of its span. */
const MAX_APPROXIMATE_WORD = "approximately".length;

type CellKind = "number" | "calculation" | "words";

/** A figure among other things (a formula, several figures, a sentence) is a calculation. */
function readCell(
  text: string,
  figures: readonly Figure[],
): { kind: CellKind; figure: Figure | null } {
  const [figure] = figures;
  if (!figure) return { kind: "words", figure: null };
  const rest = `${text.slice(0, figure.start)}${text.slice(figure.end)}`.trim();
  const alone = rest === "" || (figure.approximate && rest.length <= MAX_APPROXIMATE_WORD);
  return figures.length === 1 && alone
    ? { kind: "number", figure }
    : { kind: "calculation", figure: null };
}

/**
 * In the table's body (not its first column or heading row; dashes and "n/a" left out), numbers
 * (one figure alone in a cell) are at least as many as cells of words and more than
 * calculations, and they share one unit down each column, or along each row when two columns
 * or more hold them. A calculation's working table, with formulas, steps in words or a column
 * of dollars and percent, is not a numeric series.
 */
export const isNumericSeries = (grid: SourceGrid, language: string): boolean =>
  numericSeries(readTable(grid, language));

function numericSeries({ dataRows, columns, figuresIn }: TableReading): boolean {
  const counts: Record<CellKind, number> = { number: 0, calculation: 0, words: 0 };
  const down: Figure[][] = Array.from({ length: columns }, () => []);
  const across: Figure[][] = [];
  for (const row of dataRows) {
    const line: Figure[] = [];
    for (let column = 1; column < columns; column++) {
      const cell = row[column];
      const text = cell?.text.trim() ?? "";
      if (!cell || cell.continued || text === "" || BLANK_MARK.test(text)) continue;
      const { kind, figure } = readCell(text, figuresIn(text, column));
      counts[kind]++;
      if (figure) {
        line.push(figure);
        down[column]?.push(figure);
      }
    }
    across.push(line);
  }
  const numberColumns = down.filter((column) => column.length > 0).length;
  const oneThing = (line: readonly Figure[]) => unitsOf(line) !== "mixed";
  return (
    counts.number > 0 &&
    counts.number >= counts.words &&
    counts.number > counts.calculation &&
    (down.every(oneThing) || (numberColumns > 1 && across.every(oneThing)))
  );
}

type UncutData = Pick<ChartData, "labelHeading" | "series" | "rows">;

function cut(matrix: UncutData): ChartData {
  const fit = Math.max(1, Math.floor(MAX_CHART_VALUES / Math.max(1, matrix.series.length)));
  return {
    labelHeading: matrix.labelHeading,
    series: matrix.series,
    rows: matrix.rows.slice(0, fit),
    cutFrom: matrix.rows.length > fit ? matrix.rows.length : null,
    cutRows: matrix.rows.slice(fit),
  };
}

/**
 * A row with no number isn't a series, as a column with none isn't. The labels lose their
 * heading: the table's corner cell names the labels that become the series.
 */
function transposed(matrix: UncutData): UncutData {
  const kept = matrix.rows.filter((row) => row.values.some((value) => value?.value != null));
  return {
    labelHeading: "",
    series: kept.map((row) => row.label),
    rows: matrix.series.map((name, series) => ({
      label: name,
      values: kept.map((row) => row.values[series] ?? null),
    })),
  };
}

/** Null for a chart cut at `MAX_CHART_VALUES`: it doesn't hold the rows a switch needs. */
export function switchedData(data: ChartData): ChartData | null {
  if (data.cutFrom !== null) return null;
  const matrix = transposed(data);
  return matrix.series.length === 0 ? null : cut(matrix);
}

const switchableData = (chart: Pick<ChartAttributes, "data" | "source">): boolean =>
  chart.source.kind === "table" &&
  chart.data.cutFrom === null &&
  chart.data.rows.length * chart.data.series.length > 1;

/**
 * A bare number is its own unit: `unitlessRows` would hide it beside a
 * column's unit, or draw it on that unit's axis, so a Switch that makes such
 * a series loses or misreads it (#1392).
 */
function mixesUnits(data: ChartData, series: number): boolean {
  const keys = new Set<string>();
  for (const row of data.rows) {
    const value = row.values[series];
    if (!value || value.value === null) continue;
    keys.add(saysUnit(value) ? unitKey(value) : "none");
  }
  return keys.size > 1;
}

/**
 * Whether the Switch would turn a row whose numbers don't share one unit
 * into one series — different units, or a bare number beside a unit: their
 * values would share one scale, and one would hide the other (#1392).
 */
export function switchMixesUnits(chart: Pick<ChartAttributes, "data" | "source">): boolean {
  if (!switchableData(chart)) return false;
  const next = switchedData(chart.data);
  if (next === null) return false;
  return next.series.some((_, series) => mixesUnits(next, series));
}

export const canSwitch = (chart: Pick<ChartAttributes, "data" | "source">): boolean =>
  switchableData(chart) && !switchMixesUnits(chart);

/**
 * `fromTable`: the table read the other way round, used in place of the chart's own data.
 * Every series is drawn again, and a kind that can't draw the new data becomes a bar chart.
 */
export function switchedChart(
  chart: ChartAttributes,
  fromTable: ChartData | null = null,
): Pick<ChartAttributes, "kind" | "drawn" | "data" | "source"> | null {
  const data = canSwitch(chart) ? (fromTable ?? switchedData(chart.data)) : null;
  if (!data || chart.source.kind !== "table") return null;
  const { switched, ...source } = chart.source;
  return {
    kind: kindFits(chart.kind, data) ? chart.kind : "bar",
    drawn: null,
    data,
    source: switched ? source : { ...source, switched: true },
  };
}

/**
 * A bar chart of a table (#436): the first column is the labels, and each
 * other column that holds a number is a series. The heading row names them:
 * the first row when it is one, or when its other cells hold no number. Each
 * value keeps its cell and the Citation in it. Only the first rows that fit
 * `MAX_CHART_VALUES` are drawn, and the chart says how many there were; the
 * rest are kept to list.
 *
 * Periods go on the x axis: when the first row holds periods ("2023",
 * "Q1 2025", "2024年") and the first column doesn't, the rows are the series
 * and the columns the labels, which is `source.switched`; unless the rows
 * are more series than the key tells apart (`CATEGORY_COUNT`). Null when
 * the table isn't a series of numbers (`isNumericSeries`), or no column
 * holds one.
 */
export function chartFromTable(
  grid: SourceGrid,
  options: FromTableOptions,
): ChartAttributes | null {
  const table = readTable(grid, options.language);
  const { first, headingRow, firstDataRow, dataRows, columns, figuresIn } = table;
  if (!numericSeries(table)) return null;

  const valueAt = (cell: SourceCell | null, row: number, column: number): ChartValue | null => {
    if (!cell || cell.continued || cell.text.trim() === "") return null;
    const read = figureIn(figuresIn(cell.text, column));
    return {
      shown: cell.text.trim(),
      value: read?.value ?? null,
      unit: read ? read.figure.unit : null,
      scale: read ? read.figure.scale : null,
      citation: cell.citation,
      from: { kind: "cell", row, column },
    };
  };

  const seriesColumns: number[] = [];
  for (let column = 1; column < columns; column++) {
    const holdsNumber = dataRows.some(
      (row, index) => valueAt(row[column] ?? null, firstDataRow + index, column)?.value != null,
    );
    if (holdsNumber) seriesColumns.push(column);
  }
  if (seriesColumns.length === 0) return null;

  const labelled: UncutData = {
    labelHeading: headingRow ? (first[0]?.text.trim() ?? "") : "",
    series: seriesColumns.map((column) => (headingRow ? (first[column]?.text.trim() ?? "") : "")),
    rows: dataRows.map((row, index) => ({
      label: row[0]?.text.trim() ?? "",
      values: seriesColumns.map((column) =>
        valueAt(row[column] ?? null, firstDataRow + index, column),
      ),
    })),
  };
  const periodsAcross = headingRow && holdsPeriods(first.slice(1).map((cell) => cell?.text ?? ""));
  const periodsDown = holdsPeriods(dataRows.map((row) => row[0]?.text ?? ""));
  const fewRows =
    labelled.rows.filter((row) => row.values.some((value) => value?.value != null)).length <=
    CATEGORY_COUNT;
  const switched = options.switched ?? (periodsAcross && !periodsDown && fewRows);
  const matrix = switched ? transposed(labelled) : labelled;
  if (matrix.series.length === 0) return null;
  return {
    kind: "bar",
    title: options.title.trim(),
    drawn: null,
    data: cut(matrix),
    source: {
      kind: "table",
      blockId: options.blockId,
      ...(switched ? { switched: true } : {}),
    },
  };
}

/** A line of text (a paragraph, a list item, a table row's text), as a chart reads it. */
export interface SourceLine {
  text: string;
  citation: CitationAttributes | null;
}

const CITATION_KEYS: readonly (keyof CitationAttributes)[] = [
  "passageId",
  "documentId",
  "documentName",
  "contentHash",
  "pageFrom",
  "pageTo",
  "location",
  "quote",
  "check",
  "checkReason",
  "verdict",
  "quotedWords",
];

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
]);

// Text still waiting to be accepted isn't the User's yet.
const proposed = (node: NodeJSON) =>
  readProposalAttribute(node.attrs?.[PROPOSAL_ATTRIBUTE])?.kind === "insert" ||
  (node.marks ?? []).some((mark) => mark.type === PROPOSAL_INSERT_MARK);

/**
 * A line of text as a chart reads it, from a node as ProseMirror writes it in JSON (`toJSON()`,
 * or the core's Blocks): its words, without Citations, footnotes or text still waiting, and its
 * first Citation.
 */
export function sourceLineOf(node: NodeJSON): SourceLine {
  let text = "";
  let citation: CitationAttributes | null = null;
  const visit = (child: NodeJSON) => {
    if (proposed(child)) return;
    if (child.type === CITATION_NODE) {
      if (!citation) {
        const copy: Record<string, unknown> = {};
        for (const key of CITATION_KEYS) {
          const value = child.attrs?.[key];
          if (value !== undefined) copy[key] = value;
        }
        citation = copy as unknown as CitationAttributes;
      }
      return;
    }
    if (child.type === FOOTNOTE_NODE) return;
    if (child.type === "text") text += child.text ?? "";
    else if (child.type === "hardBreak" || (BLOCK_TYPES.has(child.type) && text !== "")) {
      text += " ";
    }
    for (const each of child.content ?? []) visit(each);
  };
  for (const child of node.content ?? []) visit(child);
  return { text: text.replace(/\s+/g, " ").trim(), citation };
}

const span = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 1 ? value : 1;

/** A table in JSON on its grid, a cell that spans in each slot it covers (`SourceGrid`). */
export function gridOfTable(table: NodeJSON): SourceGrid {
  const grid: (SourceCell | null)[][] = [];
  const rowAt = (at: number) => {
    const slots = grid[at] ?? [];
    grid[at] = slots;
    return slots;
  };
  (table.content ?? []).forEach((row, at) => {
    const slots = rowAt(at);
    let column = 0;
    for (const cell of row.content ?? []) {
      while (slots[column] !== undefined) column++;
      const read: SourceCell = {
        ...sourceLineOf(cell),
        header: cell.type === "tableHeader",
        continued: false,
      };
      const across = span(cell.attrs?.colspan);
      for (let down = 0; down < span(cell.attrs?.rowspan); down++) {
        const spanned = rowAt(at + down);
        for (let step = 0; step < across; step++) {
          spanned[column + step] = down === 0 && step === 0 ? read : { ...read, continued: true };
        }
      }
      column += across;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? null));
}

/** What separates a label from the figure after it: "Q1: 289.4", "Revenue – $1.2bn". */
const LABEL_END = /[\s:：,，;；=\-–—]+$/u;
const LABEL_START = /^[\s:：,，;；=\-–—•·*]+/u;

/**
 * A bar chart of the figures in lines of text, one row each: the first
 * figure in the line, labelled with the words before it (or after it, when
 * it comes first), with the line's Citation. Lines with no figure are left
 * out. Null when none has one.
 */
export function chartFromFigures(
  lines: readonly SourceLine[],
  options: Omit<FromTableOptions, "blockId">,
): ChartAttributes | null {
  const context = figureContextOf(lines.map((line) => line.text).join("\n"), options.language);
  const rows: ChartRow[] = [];
  lines.forEach((line, index) => {
    const read = figureIn(readFigures(line.text, context));
    if (!read) return;
    const { figure } = read;
    const before = line.text.slice(0, figure.start).replace(LABEL_END, "").replace(LABEL_START, "");
    const after = line.text.slice(figure.end).replace(LABEL_START, "").replace(LABEL_END, "");
    rows.push({
      label: (before || after).trim(),
      values: [
        {
          shown: figure.chars,
          value: read.value,
          unit: figure.unit,
          scale: figure.scale,
          citation: line.citation,
          from: { kind: "text", line: index },
        },
      ],
    });
  });
  if (rows.length === 0) return null;
  return {
    kind: "bar",
    title: options.title.trim(),
    drawn: null,
    data: {
      labelHeading: "",
      series: [""],
      rows: rows.slice(0, MAX_CHART_VALUES),
      cutFrom: rows.length > MAX_CHART_VALUES ? rows.length : null,
      cutRows: rows.slice(MAX_CHART_VALUES),
    },
    source: { kind: "figures" },
  };
}

/** Compares what is drawn and where it came from, not how it was stored. */
export function sameChartData(a: ChartData, b: ChartData): boolean {
  // The core writes a Citation without the attributes left null, the editor with them: a chart
  // the assistant drew from a table reads the same as one the User draws from it.
  const asCompared = (data: ChartData) =>
    JSON.stringify(readChartData(data), (_, value: unknown) =>
      value === null ? undefined : value,
    );
  return asCompared(a) === asCompared(b);
}
