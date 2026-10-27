import type { Citation, FigureInput, FigureSchedule, FigureScheduleRow } from "../core/api";
import type { Language } from "../core/language";
import type { Figure, FigureUnit, Reading } from "./figures";
import { type MessageKey, translate } from "./i18n";

export type FigureFilter = "all" | "look" | "supported" | "not-checked";
export interface ScheduleLine {
  id: string;
  parent: FigureScheduleRow;
  input?: FigureInput;
  component?: FigureScheduleRow;
  omitted?: boolean;
  axis?: "row" | "column";
}

export const lineRef = (mindId: string, line: ScheduleLine) => ({
  kind: "check" as const,
  id: JSON.stringify([mindId, line.id]),
});

export function figureGroup(
  row: FigureScheduleRow,
): Exclude<FigureFilter, "all"> | "checking" | "kept" {
  const state = row.shown.state;
  return state === "supported" ||
    state === "not-checked" ||
    state === "checking" ||
    state === "kept"
    ? state
    : "look";
}

export function statusKey(row: FigureScheduleRow): MessageKey {
  if (row.shown.state === "kept") return "claim.keptAsView";
  return `claim.state.${row.shown.state}`;
}

export function reasonKey(row: FigureScheduleRow): MessageKey | null {
  if (row.shown.state === "kept" || row.reason === null) return null;
  switch (row.reason) {
    case "not-found":
      return "claim.state.notFound";
    case "quote-not-found":
      return "claim.state.quoteNotFound";
    case "doesnt-add-up":
      return "claim.state.doesntAddUp";
    default:
      return `claim.state.${row.reason}`;
  }
}

export function sourceOf(line: ScheduleLine): Citation | null {
  if (line.input) return line.input.citation;
  const row = line.component ?? line.parent;
  return row.sourceInput?.citation ?? row.source ?? null;
}

export function childrenOf(
  row: FigureScheduleRow,
  rows: readonly FigureScheduleRow[],
): ScheduleLine[] {
  const children: ScheduleLine[] = [];
  for (const [index, input] of (row.calculated?.figure.inputs ?? []).entries())
    children.push({ id: `${row.id}:input:${index}`, parent: row, input });
  for (const footing of row.footing) {
    for (const id of footing.componentIds) {
      const component = rows.find((candidate) => candidate.id === id);
      if (component)
        children.push({
          id: `${row.id}:${footing.axis}:${id}`,
          parent: row,
          component,
          axis: footing.axis,
        });
    }
    for (const [index, input] of (
      row.sourceFooting?.find((proof) => proof.axis === footing.axis)?.inputs ?? []
    ).entries())
      children.push({
        id: `${row.id}:${footing.axis}:omitted:${index}`,
        parent: row,
        input,
        omitted: true,
        axis: footing.axis,
      });
  }
  return children;
}

export function scheduleLines(
  schedule: FigureSchedule,
  filter: FigureFilter,
  statusSort: boolean,
  expanded: ReadonlySet<string>,
): ScheduleLine[] {
  const ranks = { look: 0, "not-checked": 1, checking: 2, kept: 3, supported: 4 };
  const parents = schedule.rows.filter((row) => filter === "all" || figureGroup(row) === filter);
  if (statusSort)
    parents.sort((a, b) => ranks[figureGroup(a)] - ranks[figureGroup(b)] || a.number - b.number);
  return parents.flatMap((parent) => [
    { id: parent.id, parent },
    ...(expanded.has(parent.id) ? childrenOf(parent, schedule.rows) : []),
  ]);
}

export function selectedFigures(schedule: FigureSchedule, ids: ReadonlySet<string>): string[] {
  return schedule.rows
    .filter((row) => ids.has(lineRef(schedule.mindId, { id: row.id, parent: row }).id))
    .map((row) => row.id);
}

export function shownNumber(value: number | null, language: Language, unit?: FigureUnit): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const format = new Intl.NumberFormat(language, {
    maximumSignificantDigits: 21,
    ...(unit?.kind === "currency"
      ? { style: "currency", currency: unit.code }
      : unit?.kind === "percent" || unit?.kind === "points"
        ? { style: "percent" }
        : {}),
  });
  if (unit?.kind === "points")
    return translate(language, "figure.points", {
      value: format
        .formatToParts(value)
        .filter((part) => part.type !== "percentSign")
        .map((part) => part.value)
        .join("")
        .trim(),
    });
  const shown = format.format(value);
  if (unit?.kind === "times") return translate(language, "figure.times", { value: shown });
  return unit?.kind === "other" ? `${shown} ${unit.word}` : shown;
}

const DIGITS = /\d(?:[\d,.\u00a0\u202f' ]*\d)?/;

/**
 * `value` written the way `like` is written: its currency, scale word and unit
 * around the number, at `decimals` places, so a source's value and a
 * difference read in the note's own terms ("£4,979.6m" beside "£4,980m").
 */
export function writtenLike(like: Figure, value: number, decimals: number): string {
  const shares = like.unit.kind === "percent" || like.unit.kind === "points";
  const amount = Math.abs(value) * (shares ? 100 : 1 / like.scale);
  const digits = DIGITS.exec(like.chars);
  const comma = digits !== null && /\d,\d{1,2}$/.test(digits[0]) && like.decimals > 0;
  const number = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
    .format(amount)
    .replace(/[,.]/g, (mark) => (comma ? (mark === "," ? "." : ",") : mark));
  if (!digits) return number;
  const around = like.chars.replace(/^[(\-−+]|[)]$/g, "");
  return around.replace(DIGITS, number);
}

/** How many decimals `read` carries once written at the scale of `like`. */
function decimalsAt(like: Figure, read: Pick<Reading, "decimals" | "scale">): number {
  if (like.unit.kind === "percent" || like.unit.kind === "points") return read.decimals;
  return Math.max(0, read.decimals + Math.round(Math.log10(like.scale / read.scale)));
}

/** The decimals a row's source carries in the note's terms; a calculation keeps the figure's own. */
function sourceDecimals(row: FigureScheduleRow): number {
  return row.sourceInput ? decimalsAt(row.reading, row.sourceInput.number) : row.reading.decimals;
}

/** A row's source value in the note's terms, or null when there is none. */
export function sourceValueText(row: FigureScheduleRow): string | null {
  if (row.sourceValue === null) return null;
  if (!row.sourceInput) return row.sourceShown;
  return writtenLike(row.reading, row.sourceValue, sourceDecimals(row));
}

/** What the Difference column says: "Rounded from …", a signed amount, or null for "—". */
export function differenceText(row: FigureScheduleRow, language: Language): string | null {
  if (row.calculated || row.difference === null || row.difference === 0) return null;
  // A worked-out value is always rounded to be shown: only a quoted source's digits say "Rounded from".
  if (!row.sourceInput && row.roundedFrom !== null) return null;
  if (row.roundedFrom !== null)
    return translate(language, "figures.roundedFrom", {
      value: writtenLike(row.reading, row.roundedFrom, sourceDecimals(row)),
    });
  const sign = row.difference > 0 ? "+" : "−";
  const decimals = Math.max(row.reading.decimals, sourceDecimals(row));
  if (row.reading.unit.kind === "percent" || row.reading.unit.kind === "points")
    return translate(language, "figure.points", {
      value: `${sign}${new Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(Math.abs(row.difference) * 100)}`,
    });
  return `${sign}${writtenLike(row.reading, row.difference, decimals)}`;
}

/** A total's footing, as its row explains it under the figure. */
export interface FootingNote {
  axis: "row" | "column";
  /** The total agrees with its source, which the row says beside the sum. */
  agrees: boolean;
  sum: string;
  /** Source rows the note's table leaves out, as "Other £130m". */
  omitted: string[];
  /** The source's own rows add to the same sum, so the gap is in the source. */
  sourceSum: string | null;
}

export function footingNotes(row: FigureScheduleRow): FootingNote[] {
  return row.footing.flatMap((axis): FootingNote[] => {
    if (axis.agrees !== false || axis.sum === null) return [];
    const proof = row.sourceFooting?.find((each) => each.axis === axis.axis);
    return [
      {
        axis: axis.axis,
        agrees:
          row.sourceInput !== null &&
          row.shown.state !== "contradicted" &&
          (row.difference === 0 || row.roundedFrom !== null),
        sum: writtenLike(row.reading, axis.sum, row.reading.decimals),
        omitted: (proof?.inputs ?? []).map(
          (input) =>
            `${input.label} ${writtenLike(row.reading, input.number.value, decimalsAt(row.reading, input.number))}`,
        ),
        sourceSum:
          proof && proof.inputs.length === 0 && proof.sum !== null && proof.agrees === false
            ? writtenLike(row.reading, proof.sum, row.reading.decimals)
            : null,
      },
    ];
  });
}

/** Where a figure sits in the note: "Results › paragraph 2", "Segments › table, Total row". */
export function figurePlaceText(row: FigureScheduleRow, language: Language): string {
  const { table, chart, heading, paragraph } = row.place;
  const place = table
    ? table.columnLabel
      ? translate(language, "figures.tableCell", { row: table.rowLabel, column: table.columnLabel })
      : translate(language, "figures.tableRow", { row: table.rowLabel })
    : chart
      ? translate(language, "figures.chartPoint", {
          row: chart.rowLabel,
          series: chart.seriesLabel,
        })
      : translate(language, "figures.paragraph", { number: paragraph });
  return heading ? translate(language, "figures.place", { heading, place }) : place;
}
