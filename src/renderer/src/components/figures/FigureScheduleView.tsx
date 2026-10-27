import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { Citation, FigureSchedule, FigureScheduleRow } from "../../../../core/api";
import { formatDateTime } from "../../../../shared/dates";
import {
  childrenOf,
  differenceText,
  type FigureFilter,
  lineRef,
  reasonKey,
  type ScheduleLine,
  scheduleLines,
  selectedFigures,
  sourceOf,
  sourceValueText,
  statusKey,
  writtenLike,
} from "../../../../shared/figureSchedule";
import { sourceText } from "../../../../shared/sources";
import { useLanguage, useT } from "../../i18n";
import { useNotices } from "../../notices";
import { extendThroughRows, useSelectedOn, useSelection, useSelectionOrder } from "../../selection";
import { useAppStore } from "../../store";
import { moveThroughRows } from "../../treeKeys";
import { SortLineIcon } from "../lineIcons";
import { buttonStyle } from "../ui";
import { FigureScheduleRowView } from "./FigureScheduleRowView";
import "./figureSchedule.css";

export interface FigureScheduleViewProps {
  schedule: FigureSchedule | null;
  onFocusFigure(row: FigureScheduleRow | null): void;
  /** Show in the note: outlines the figure and brings the note into view, when the schedule hides it. */
  onShowFigure(row: FigureScheduleRow): void;
  onOpenSource(citation: Citation): void;
  onExport(): void;
  onStop?(): void;
  onKeep(ids: string[]): void;
  onCheckAgain(ids: string[]): void;
  onChangeToSource(ids: string[]): void;
  onAddCitation(id: string): void;
  onChooseCitation(id: string): void;
  onTotalRole(id: string, axes: ("row" | "column")[], total: boolean): void;
}

const FILTERS = ["all", "look", "supported", "not-checked"] as const;

/** The figures whose rows show an outcome the last Check gave them. */
const settled = (row: FigureScheduleRow) =>
  row.shown.state !== "not-checked" &&
  row.shown.state !== "checking" &&
  row.shown.state !== "needs-recheck";

export function FigureScheduleView(props: FigureScheduleViewProps) {
  const { schedule } = props;
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) => state.documents);
  const [filter, setFilter] = useState<FigureFilter>("all");
  const [statusSort, setStatusSort] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const selected = useSelectedOn("figures");
  const root = useRef<HTMLElement>(null);
  const focus = useRef(props.onFocusFigure);
  focus.current = props.onFocusFigure;
  const mindId = schedule?.mindId ?? "";
  const shownExpanded = new Set(
    [...expanded].filter((id) => {
      const row = schedule?.rows.find((each) => each.id === id);
      return row !== undefined && hasKids(row, schedule?.rows ?? []);
    }),
  );
  const lines = schedule ? scheduleLines(schedule, filter, statusSort, shownExpanded) : [];
  const allLines = schedule
    ? scheduleLines(schedule, "all", false, new Set(schedule.rows.map((row) => row.id)))
    : [];
  useSelectionOrder("figures", () => lines.map((line) => lineRef(mindId, line)));
  const selectedIds = new Set(selected.map((ref) => ref.id));
  const parentIds = schedule ? selectedFigures(schedule, selectedIds) : [];
  const shownCurrent = lines.some((line) => line.id === current) ? current : (lines[0]?.id ?? null);

  // One figure selected is outlined in the note; any other selection outlines none.
  useEffect(() => {
    if (!schedule) return;
    const line =
      selected.length === 1
        ? allLines.find((line) => lineRef(schedule.mindId, line).id === selected[0]?.id)
        : null;
    focus.current(line && line.id === line.parent.id ? line.parent : null);
    const valid = new Set(allLines.map((line) => lineRef(schedule.mindId, line).id));
    const prefix = `${JSON.stringify([schedule.mindId]).slice(0, -1)},`;
    useSelection
      .getState()
      .keepOnly((ref) => ref.kind !== "check" || !ref.id.startsWith(prefix) || valid.has(ref.id));
  }, [selected, schedule, allLines]);
  useEffect(() => {
    if (!mindId) return;
    setExpanded(new Set());
    setCurrent(null);
    setFilter("all");
    useSelection.getState().clear("figures");
    // The outline outlives the schedule while Show in the note took the User there: its tab
    // says when the schedule is gone (`focusFigure`).
    return () => useSelection.getState().clear("figures");
  }, [mindId]);

  const sourceLabel = (line: ScheduleLine) => {
    const citation = sourceOf(line);
    return citation ? sourceText(citation, { language, documents }).text : "";
  };
  const statusLabel = (line: ScheduleLine) => {
    if (line.omitted) return t("figures.notInTable");
    if (line.input)
      return t(
        line.input.citation.check === "found" ? "claim.state.supported" : "claim.state.not-checked",
      );
    if (line.component) return "";
    const reason = reasonKey(line.parent);
    const word =
      line.parent.shown.state === "supported" ||
      line.parent.shown.state === "kept" ||
      line.parent.shown.state === "not-checked" ||
      line.parent.shown.state === "checking"
        ? t(statusKey(line.parent))
        : t("figures.filter.look");
    return reason ? `${word}: ${t(reason)}` : word;
  };
  const copy = (fallback?: ScheduleLine) => {
    const chosen = allLines.filter((line) => selectedIds.has(lineRef(mindId, line).id));
    const copied = chosen.length
      ? chosen
      : fallback
        ? [fallback]
        : lines.filter((line) => line.id === shownCurrent);
    if (copied.length === 0) return;
    const head = [
      "#",
      t("figures.figure"),
      t("figures.sourceValue"),
      t("figures.source"),
      t("figures.difference"),
      t("figures.status"),
    ];
    const body = copied.map((line) => {
      const kid = line.id !== line.parent.id;
      const unchecked =
        !kid && !settled(line.parent) && line.parent.shown.state !== "needs-recheck";
      return [
        kid ? "" : String(line.parent.number),
        line.input?.label ??
          (line.component
            ? (line.component.place.table?.rowLabel ?? "")
            : line.parent.reading.chars),
        line.input
          ? line.omitted
            ? writtenLike(
                line.parent.reading,
                line.input.number.value,
                line.parent.reading.decimals,
              )
            : line.input.number.chars
          : line.component
            ? line.component.reading.chars
            : unchecked
              ? ""
              : (sourceValueText(line.parent) ?? ""),
        unchecked || line.component || line.omitted ? "" : sourceLabel(line),
        kid || unchecked ? "" : (differenceText(line.parent, language) ?? ""),
        statusLabel(line),
      ];
    });
    const escaped = (text: string) =>
      text.replace(
        /[&<>"]/g,
        (mark) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[mark]};`,
      );
    const text = [head, ...body].map((cells) => cells.join("\t")).join("\n");
    const html = `<table><tr>${head.map((cell) => `<th>${escaped(cell)}</th>`).join("")}</tr>${body
      .map((cells) => `<tr>${cells.map((cell) => `<td>${escaped(cell)}</td>`).join("")}</tr>`)
      .join("")}</table>`;
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ])
      .then(() => useNotices.getState().confirm("info.copied"))
      .catch(useAppStore.getState().reportError);
  };
  const focusLine = (id: string) =>
    root.current
      ?.querySelector<HTMLElement>(`[data-figure-id="${CSS.escape(id)}"] [data-tree-row]`)
      ?.focus();
  const toggle = (id: string, open = !expanded.has(id)) => {
    const next = new Set(expanded);
    if (open) next.add(id);
    else {
      next.delete(id);
      if (lines.find((line) => line.id === shownCurrent)?.parent.id === id) {
        setCurrent(id);
        requestAnimationFrame(() => focusLine(id));
      }
    }
    setExpanded(next);
  };
  const open = (line: ScheduleLine) => {
    if (line.id === line.parent.id) {
      if (line.parent.shown.state === "not-checked") {
        useNotices.getState().confirm("figures.notCheckedNotice");
        return;
      }
      if (line.parent.calculated) {
        toggle(line.parent.id);
        return;
      }
    }
    const citation = sourceOf(line);
    if (citation) props.onOpenSource(citation);
  };
  const keys = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest('[role="menu"]')) return;
    if (event.key === "Escape") {
      if (selected.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      useSelection.getState().clear("figures");
      focus.current(null);
      if (shownCurrent) focusLine(shownCurrent);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === "a" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        useSelection.getState().all("figures");
      }
      if (event.key.toLowerCase() === "c" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        copy();
      }
      return;
    }
    if (extendThroughRows(event, "figures")) return;
    if (moveThroughRows(event)) {
      const id = document.activeElement?.closest<HTMLElement>("[data-figure-id]")?.dataset.figureId;
      const line = lines.find((line) => line.id === id);
      if (line) useSelection.getState().choose("figures", lineRef(mindId, line));
      return;
    }
    if (!(event.target as Element).matches("[data-tree-row]")) return;
    const line = lines.find((line) => line.id === shownCurrent);
    if (!line) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(line);
    }
    if (event.key === " ") {
      event.preventDefault();
      useSelection.getState().choose("figures", lineRef(mindId, line));
      props.onShowFigure(line.parent);
    }
    if (
      event.key === "ArrowRight" &&
      line.id === line.parent.id &&
      hasKids(line.parent, schedule?.rows ?? [])
    ) {
      event.preventDefault();
      if (!expanded.has(line.parent.id)) toggle(line.parent.id, true);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (line.id !== line.parent.id) {
        setCurrent(line.parent.id);
        focusLine(line.parent.id);
        useSelection
          .getState()
          .choose("figures", lineRef(mindId, { id: line.parent.id, parent: line.parent }));
      } else if (expanded.has(line.id)) toggle(line.id, false);
    }
  };
  if (!schedule)
    return (
      <section className="figure-schedule" aria-label={t("figures.title")} aria-busy="true">
        <p className="figure-empty" role="status">
          {t("figures.loading")}
        </p>
      </section>
    );
  const { counts } = schedule;
  const toCheck = schedule.rows
    .filter((row) => row.shown.state === "not-checked" || row.shown.state === "needs-recheck")
    .map((row) => row.id);
  const when = schedule.progress ? (
    <>
      <span className="figure-live" aria-hidden="true" />
      <span>{t("figures.progress", schedule.progress)}</span>
      {props.onStop && (
        <>
          <span className="figure-sep">·</span>
          <button type="button" className="figure-text-button" onClick={() => props.onStop?.()}>
            {t("figures.stop")}
          </button>
        </>
      )}
    </>
  ) : toCheck.length > 0 ? (
    <>
      <span>
        {schedule.checkedAt
          ? t("figures.partial", { done: counts.total - toCheck.length, total: counts.total })
          : t("figures.noCheck")}
      </span>
      <span className="figure-sep">·</span>
      <button
        type="button"
        className="figure-text-button"
        onClick={() => props.onCheckAgain(toCheck)}
      >
        {t("figures.checkRemaining")}
      </button>
    </>
  ) : (
    schedule.checkedAt && (
      <time dateTime={schedule.checkedAt}>
        {t("figures.checked", { time: formatDateTime(schedule.checkedAt, language) })}
      </time>
    )
  );
  const look = counts.needsLook;
  const countLine = [
    counts.total === 1 ? t("figures.count.one") : t("figures.count", { count: counts.total }),
    t("figures.supported", { count: counts.supported }),
    look === 1 ? t("figures.look.one") : t("figures.look", { count: look }),
    t("figures.notChecked", { count: counts.notChecked + counts.checking }),
    ...(counts.kept > 0 ? [t("figures.yourView", { count: counts.kept })] : []),
  ].join(" · ");
  return (
    <section
      ref={root}
      className="figure-schedule"
      aria-label={t("figures.title")}
      data-surface="figures"
      data-testid="figure-schedule"
      onKeyDown={keys}
    >
      <header className="figure-heading">
        <div className="figure-heading-top">
          <h2 className="figure-name" title={schedule.name}>
            {schedule.name}
          </h2>
          <div className="figure-when" data-testid="figure-when">
            {when}
          </div>
          <button
            type="button"
            className={`${buttonStyle("secondary", "sm")} figure-export`}
            disabled={schedule.progress !== null}
            data-testid="figure-export"
            onClick={() => props.onExport()}
          >
            {t("figures.export")}
          </button>
        </div>
        <div className="figure-counts" role="status" aria-live="polite" data-testid="figure-counts">
          {countLine}
        </div>
        <fieldset className="figure-filters" aria-label={t("figures.filter")}>
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className="figure-chip"
              aria-pressed={filter === key}
              data-filter={key}
              onClick={() => setFilter(key)}
            >
              {t(`figures.filter.${key}`)}
            </button>
          ))}
        </fieldset>
      </header>
      {schedule.rows.length === 0 ? (
        <p className="figure-empty">{t("figures.empty")}</p>
      ) : (
        <div className="figure-scroll">
          <table className="figure-table" aria-label={t("figures.title")}>
            <thead>
              <tr className="figure-grid figure-columns">
                <th scope="col" className="figure-number">
                  #
                </th>
                <th scope="col" className="figure-main">
                  {t("figures.figure")}
                </th>
                <th scope="col" className="figure-value">
                  {t("figures.sourceValue")}
                </th>
                <th scope="col" className="figure-source">
                  {t("figures.source")}
                </th>
                <th scope="col" className="figure-difference">
                  {t("figures.difference")}
                </th>
                <th scope="col" className="figure-status">
                  <button
                    type="button"
                    className="figure-sort"
                    aria-pressed={statusSort}
                    aria-label={t("figures.sortStatus")}
                    title={t(statusSort ? "figures.sortNote" : "figures.sortStatus")}
                    onClick={() => setStatusSort(!statusSort)}
                  >
                    {t("figures.status")}
                    <SortLineIcon className="size-3" />
                  </button>
                </th>
                <th scope="col" className="figure-actions">
                  <span className="sr-only">{t("figures.rowActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td className="figure-empty">
                    {t("figures.noMatches")}{" "}
                    <button
                      type="button"
                      className="figure-text-button"
                      onClick={() => setFilter("all")}
                    >
                      {t("figures.showAll")}
                    </button>
                  </td>
                </tr>
              )}
              {lines.map((line) => (
                <FigureScheduleRowView
                  key={line.id}
                  line={line}
                  mindId={mindId}
                  current={shownCurrent}
                  expandable={line.id === line.parent.id && hasKids(line.parent, schedule.rows)}
                  expanded={shownExpanded.has(line.parent.id)}
                  chosen={
                    parentIds.includes(line.parent.id) && parentIds.length > 1
                      ? parentIds
                      : [line.parent.id]
                  }
                  props={props}
                  onCurrent={setCurrent}
                  onToggle={() => toggle(line.parent.id)}
                  onOpen={open}
                  onCopy={() => copy(line)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A figure that unfolds: a calculated one to its inputs, a total to the rows it adds, once checked. */
function hasKids(row: FigureScheduleRow, rows: readonly FigureScheduleRow[]): boolean {
  if (row.shown.state === "not-checked" || row.shown.state === "checking") return false;
  return childrenOf(row, rows).length > 0;
}
