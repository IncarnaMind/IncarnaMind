import type { Citation, FigureInput, FigureSchedule, FigureScheduleRow } from "../core/api";
import type { Language } from "../core/language";
import type { FigureUnit } from "./figures";
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
      return "figures.quoteNotFound";
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
