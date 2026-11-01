import type {
  AnalysisRangeInput,
  CalculatedFigure,
  Citation,
  FigureFinding,
  FigureInput,
  FigureSchedule,
  FigureScheduleChange,
  FigureScheduleRow,
} from "../core/api";
import type { Language } from "../core/language";
import { formatDateTime } from "./dates";
import type { Figure, FigureUnit, Reading } from "./figures";
import { formulaText } from "./formula";
import { type MessageKey, translate } from "./i18n";
import { checkedByMe } from "./signOffs";

export type FigureFilter = "all" | "look" | "supported" | "not-checked" | "not-mine";
export interface ScheduleLine {
  id: string;
  parent: FigureScheduleRow;
  input?: FigureInput;
  /** A sheet range an Analysis behind the figure read. */
  range?: AnalysisRangeInput;
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
): Exclude<FigureFilter, "all" | "not-mine"> | "checking" | "kept" {
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
      return "claim.why.notFound";
    case "quote-not-found":
      return "claim.why.quoteNotFound";
    case "doesnt-add-up":
      return "claim.why.doesntAddUp";
    default:
      return `claim.why.${row.reason}`;
  }
}

export function sourceOf(line: ScheduleLine): Citation | null {
  if (line.input) return line.input.citation;
  if (line.range) return line.range.citation;
  const row = line.component ?? line.parent;
  return row.sourceInput?.citation ?? row.source ?? null;
}

/** What a calculated figure is worked out from: its formula's inputs, or what its Analysis read. */
function inputsOf(
  row: FigureScheduleRow,
  analyses: FigureSchedule["analyses"],
): Pick<ScheduleLine, "input" | "range">[] {
  const calculated = row.calculated;
  if (!calculated) return [];
  if (!calculated.figure.analysis) return calculated.figure.inputs.map((input) => ({ input }));
  const run = analyses.find((each) => each.id === calculated.analysisId);
  return (run?.inputs ?? []).map((each) =>
    each.kind === "figure" ? { input: each.input } : { range: each },
  );
}

export function childrenOf(
  row: FigureScheduleRow,
  { rows, analyses }: Pick<FigureSchedule, "rows" | "analyses">,
): ScheduleLine[] {
  const children: ScheduleLine[] = [];
  for (const [index, input] of inputsOf(row, analyses).entries())
    children.push({ id: `${row.id}:input:${index}`, parent: row, ...input });
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
  const parents = schedule.rows.filter((row) =>
    filter === "all"
      ? true
      : filter === "not-mine"
        ? !checkedByMe(row.signOff)
        : figureGroup(row) === filter,
  );
  if (statusSort)
    parents.sort((a, b) => ranks[figureGroup(a)] - ranks[figureGroup(b)] || a.number - b.number);
  return parents.flatMap((parent) => [
    { id: parent.id, parent },
    ...(expanded.has(parent.id) ? childrenOf(parent, schedule) : []),
  ]);
}

/** Whether two structured-clone-safe values hold the same, but for the keys left out. */
function sameValue(a: unknown, b: unknown, leftOut?: ReadonlySet<string>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (leftOut?.has(key)) continue;
    if (!Object.hasOwn(b, key) || !sameValue(Reflect.get(a, key), Reflect.get(b, key)))
      return false;
  }
  return true;
}

const ROW_LEFT_OUT: ReadonlySet<string> = new Set(["number", "place"]);
const PLACE_LEFT_OUT: ReadonlySet<string> = new Set(["paragraph"]);

/**
 * Whether a row says what a row held says, but for its number and for its paragraph's, `shift`
 * paragraphs on: Enter or a new figure above moves every row below it along.
 */
function sameRow(held: FigureScheduleRow, row: FigureScheduleRow, shift: number): boolean {
  return (
    row.place.paragraph === held.place.paragraph + shift &&
    sameValue(held.place, row.place, PLACE_LEFT_OUT) &&
    sameValue(held, row, ROW_LEFT_OUT)
  );
}

/** `schedule` as a change to the one held, which `token` will name; whole when none is held. */
export function figureScheduleChange(
  schedule: FigureSchedule,
  token: string,
  held: { token: string; rows: readonly FigureScheduleRow[] } | null,
): FigureScheduleChange {
  const { rows, ...rest } = schedule;
  if (!held) return { ...rest, token, since: null, from: 0, to: 0, shift: 0, rows };
  const most = Math.min(held.rows.length, rows.length);
  let from = 0;
  while (from < most) {
    const before = held.rows[from];
    const now = rows[from];
    if (!before || !now || !sameRow(before, now, 0)) break;
    from++;
  }
  const lastHeld = held.rows.at(-1);
  const last = rows.at(-1);
  const shift = lastHeld && last ? last.place.paragraph - lastHeld.place.paragraph : 0;
  let same = 0;
  while (same < most - from) {
    const before = held.rows[held.rows.length - 1 - same];
    const now = rows[rows.length - 1 - same];
    if (!before || !now || !sameRow(before, now, shift)) break;
    same++;
  }
  return {
    ...rest,
    token,
    since: held.token,
    from,
    to: held.rows.length - same,
    shift,
    rows: rows.slice(from, rows.length - same),
  };
}

/**
 * The schedule a change makes of the one held, its rows the same array when none changed; null
 * when it changes a schedule other than the one held.
 */
export function applyFigureScheduleChange(
  held: { token: string; schedule: FigureSchedule } | null,
  change: FigureScheduleChange,
): FigureSchedule | null {
  const { token: _token, since, from, to, shift, rows, ...rest } = change;
  if (since === null) return { ...rest, rows };
  if (held?.token !== since) return null;
  const before = held.schedule.rows;
  if (from === to && rows.length === 0 && shift === 0) return { ...rest, rows: before };
  const moved = from + rows.length - to;
  const after = before.slice(to);
  return {
    ...rest,
    rows: [
      ...before.slice(0, from),
      ...rows,
      ...(moved === 0 && shift === 0
        ? after
        : after.map((row) => ({
            ...row,
            number: row.number + moved,
            place: { ...row.place, paragraph: row.place.paragraph + shift },
          }))),
    ],
  };
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
  // The value keeps its own sign, written as the note writes a negative: brackets or a minus.
  const signed = (text: string) =>
    value >= 0
      ? text
      : /^[(（]/.test(like.chars) && like.value < 0
        ? `(${text})`
        : `${/^[-−]/.exec(like.chars)?.[0] ?? "−"}${text}`;
  if (!digits) return signed(number);
  const around = like.chars.replace(/^[(\-−+]|[)]$/g, "");
  return signed(around.replace(DIGITS, number));
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

/** The number a figure's quoted source gives, written as the note writes the figure. */
export function quotedSourceText(figure: FigureFinding): string | null {
  const { sourceInput } = figure;
  if (!sourceInput) return null;
  return writtenLike(
    figure.reading,
    sourceInput.number.value,
    decimalsAt(figure.reading, sourceInput.number),
  );
}

/** A row's source value in the note's terms, or null when there is none. */
export function sourceValueText(row: FigureScheduleRow): string | null {
  // A what-if is no Document's number (#2347), whatever an older row kept as its source value.
  if (row.sourceValue === null || row.calculated?.figure.workbook?.change) return null;
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
  return `${sign}${writtenLike(row.reading, Math.abs(row.difference), decimals)}`;
}

export type ScheduleGlyph = "supported" | "look" | "recheck" | "not-checked" | "kept";

/** A line's status: its glyph, its word and, when it needs a look, why. */
export interface LineStatus {
  glyph: ScheduleGlyph;
  word: MessageKey;
  why: MessageKey | null;
}

/**
 * What a schedule line shows in each column, the one reading the schedule, Copy and the
 * workpaper all write: the figure or its input's name, the source value, where it comes from
 * (a Citation, or for a calculated figure its formula, read by the view), the Difference and
 * the status. Null where the column is empty.
 */
export interface LineShows {
  name: string;
  value: string | null;
  citation: Citation | null;
  /** A calculated figure's formula, in its inputs' names. */
  formula: string | null;
  difference: string | null;
  status: LineStatus | null;
}

const citationStatus = (citation: Citation): LineStatus =>
  citation.check === "found"
    ? { glyph: "supported", word: "claim.state.supported", why: null }
    : citation.check === "not-found"
      ? { glyph: "look", word: "figures.filter.look", why: "claim.why.quoteNotFound" }
      : { glyph: "not-checked", word: "claim.state.not-checked", why: null };

export function rowGlyph(row: FigureScheduleRow): ScheduleGlyph {
  const group = figureGroup(row);
  if (row.shown.state === "needs-recheck") return "recheck";
  if (group === "checking") return "not-checked";
  return group;
}

/** Of the chosen rows, those Check again checks: not checked, needing a re-check or kept. */
export const toCheckAgain = (rows: readonly FigureScheduleRow[]): FigureScheduleRow[] =>
  rows.filter(
    (row) =>
      row.shown.state === "not-checked" ||
      row.shown.state === "needs-recheck" ||
      row.shown.state === "kept",
  );

/** Of the chosen rows, those Keep as my view keeps: every one not kept already. */
export const toKeep = (rows: readonly FigureScheduleRow[]): FigureScheduleRow[] =>
  rows.filter((row) => row.shown.state !== "kept");

/**
 * What "Checked by me" does to the chosen rows: marks those the User hasn't checked as they are
 * now, or, when they have checked every one, takes their marks off (`off`).
 */
export function toSignOff(rows: readonly FigureScheduleRow[]): {
  rows: FigureScheduleRow[];
  off: boolean;
} {
  const unmarked = rows.filter((row) => !checkedByMe(row.signOff));
  return unmarked.length > 0 ? { rows: unmarked, off: false } : { rows: [...rows], off: true };
}

/** Who checked the figure themselves and when (#1933), for the schedule's Checked by column. */
export function checkedByText(row: Pick<FigureScheduleRow, "signOff">, language: Language): string {
  const mark = row.signOff;
  if (!mark) return "";
  const name = mark.name ?? "";
  if (mark.state === "changed")
    return mark.mine
      ? translate(language, "figures.checkedBy.changed")
      : translate(language, "figures.checkedBy.changedTheirs", { name });
  const time = formatDateTime(mark.at, language);
  return mark.mine
    ? translate(language, "figures.checkedBy.mine", { time })
    : translate(language, "figures.checkedBy.theirs", { name, time });
}

/** A row that isn't checked yet shows no source, value or Difference. */
export const notCheckedYet = (row: FigureScheduleRow): boolean =>
  row.shown.state === "not-checked" || row.shown.state === "checking";

/**
 * A workbook figure's formula (#2347), naming a what-if's change so it never reads as the
 * workbook's own figure: "What-if: DCF!E5 = E4*Margin, with Revenue growth at 3.0% (5.0% in the
 * workbook)". Null for any other figure.
 */
export function workbookFormulaText(figure: CalculatedFigure, language: Language): string | null {
  const book = figure.workbook;
  if (!book) return null;
  const cell = `${book.cell.sheet}!${book.cell.ref}`;
  const changed = book.change
    ? figure.inputs.find((input) => input.name === book.change?.input)
    : undefined;
  if (!book.change || !changed) return `${cell} = ${book.cell.formula}`;
  return translate(language, "figures.workbook.whatIfFormula", {
    cell,
    formula: book.cell.formula,
    input: changed.label,
    from: changed.number.chars,
    to: book.change.shown,
  });
}

export function lineShows(line: ScheduleLine, language: Language): LineShows {
  const { parent } = line;
  const change = parent.calculated?.figure.workbook?.change;
  if (line.input && change?.input === line.input.name) {
    // A what-if's changed input: the value it was given, never the cell's as if it were found.
    return {
      name: line.input.label,
      value: change.shown,
      citation: line.input.citation,
      formula: null,
      difference: null,
      status: { glyph: "not-checked", word: "figures.workbook.whatIfInput", why: null },
    };
  }
  if (line.input) {
    return {
      name: line.input.label,
      value: line.omitted
        ? writtenLike(parent.reading, line.input.number.value, parent.reading.decimals)
        : line.input.number.chars,
      citation: line.omitted ? null : line.input.citation,
      formula: null,
      difference: null,
      status: line.omitted
        ? { glyph: "look", word: "figures.notInTable", why: null }
        : citationStatus(line.input.citation),
    };
  }
  if (line.range) {
    return {
      name: line.range.name,
      value: translate(language, "figures.range", {
        range: line.range.range,
        count: new Intl.NumberFormat(language).format(line.range.rows),
      }),
      citation: line.range.citation,
      formula: null,
      difference: null,
      status: citationStatus(line.range.citation),
    };
  }
  if (line.component) {
    const place = line.component.place.table;
    return {
      name:
        (line.axis === "column" ? place?.columnLabel : place?.rowLabel) ||
        line.component.reading.chars,
      value: line.component.reading.chars,
      citation: null,
      formula: null,
      difference: null,
      status: null,
    };
  }
  const unchecked = notCheckedYet(parent);
  const glyph = rowGlyph(parent);
  return {
    name: parent.reading.chars,
    value: unchecked ? null : sourceValueText(parent),
    citation:
      unchecked || parent.calculated
        ? null
        : (parent.sourceInput?.citation ?? parent.source ?? null),
    formula: parent.calculated?.figure.workbook
      ? workbookFormulaText(parent.calculated.figure, language)
      : parent.calculated
        ? formulaText(
            parent.calculated.figure.formula,
            (name) =>
              parent.calculated?.figure.inputs.find(
                (each) => each.name.toLowerCase() === name.toLowerCase(),
              )?.label ?? null,
          )
        : null,
    difference: unchecked ? null : differenceText(parent, language),
    status: {
      glyph,
      word: glyph === "look" || glyph === "recheck" ? "figures.filter.look" : statusKey(parent),
      why: reasonKey(parent),
    },
  };
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
      ? translate(language, "figures.tableCell", {
          label: table.rowLabel,
          column: table.columnLabel,
        })
      : translate(language, "figures.tableRow", { label: table.rowLabel })
    : chart
      ? translate(language, "figures.chartPoint", {
          row: chart.rowLabel,
          series: chart.seriesLabel,
        })
      : translate(language, "figures.paragraph", { number: paragraph });
  return heading ? translate(language, "figures.place", { heading, place }) : place;
}
