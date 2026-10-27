import type React from "react";
import { useEffect, useRef, useState } from "react";
import type { Citation, FigureSchedule, FigureScheduleRow } from "../../../../core/api";
import { formatDateTime } from "../../../../shared/dates";
import {
  childrenOf,
  type FigureFilter,
  lineRef,
  type ScheduleLine,
  scheduleLines,
  selectedFigures,
  shownNumber,
  sourceOf,
  statusKey,
} from "../../../../shared/figureSchedule";
import { sourceText } from "../../../../shared/sources";
import { copyText } from "../../copied";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { extendThroughRows, useSelectedOn, useSelection, useSelectionOrder } from "../../selection";
import { useAppStore } from "../../store";
import { moveThroughRows } from "../../treeKeys";
import { buttonStyle } from "../ui";
import { FigureScheduleRowView } from "./FigureScheduleRowView";
import "./figureSchedule.css";

export interface FigureScheduleViewProps {
  schedule: FigureSchedule | null;
  onFocusFigure(row: FigureScheduleRow | null): void;
  onOpenSource(citation: Citation): void;
  onExport(): void;
  onStop?(): void;
  onKeep(ids: string[]): void;
  onCheckAgain(ids: string[]): void;
  onChangeToSource(ids: string[]): void;
  onAddCitation(id: string): void;
  onChooseCitation(id: string): void;
  onTotalRole(id: string, axis: "row" | "column", total: boolean): void;
}

export function FigureScheduleView(props: FigureScheduleViewProps) {
  const { schedule } = props;
  const t = useT();
  const language = useLanguage();
  const modelNames = useModelNames();
  const documents = useAppStore((state) => state.documents);
  const [filter, setFilter] = useState<FigureFilter>("all");
  const [statusSort, setStatusSort] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const selected = useSelectedOn("figures");
  const root = useRef<HTMLElement>(null);
  const focus = useRef(props.onFocusFigure);
  focus.current = props.onFocusFigure;
  const lines = schedule ? scheduleLines(schedule, filter, statusSort, expanded) : [];
  const allLines = schedule
    ? scheduleLines(schedule, "all", false, new Set(schedule.rows.map((row) => row.id)))
    : [];
  const refs = lines.map((line) => lineRef(schedule?.mindId ?? "", line));
  useSelectionOrder("figures", () => refs);
  const selectedIds = new Set(selected.map((ref) => ref.id));
  const parentIds = schedule ? selectedFigures(schedule, selectedIds) : [];
  useEffect(() => {
    const available = schedule
      ? scheduleLines(schedule, "all", false, new Set(schedule.rows.map((row) => row.id)))
      : [];
    const line =
      selected.length === 1
        ? available.find((line) => lineRef(schedule?.mindId ?? "", line).id === selected[0]?.id)
        : null;
    focus.current(line?.parent ?? null);
    if (schedule) {
      const valid = new Set(available.map((line) => lineRef(schedule.mindId, line).id));
      const prefix = `${JSON.stringify([schedule.mindId]).slice(0, -1)},`;
      useSelection
        .getState()
        .keepOnly((ref) => ref.kind !== "check" || !ref.id.startsWith(prefix) || valid.has(ref.id));
    }
  }, [selected, schedule]);
  const mindId = schedule?.mindId;
  useEffect(() => {
    if (!mindId) return;
    setExpanded(new Set());
    setCurrent(null);
    setFilter("all");
    useSelection.getState().clear("figures");
    return () => {
      useSelection.getState().clear("figures");
      focus.current(null);
    };
  }, [mindId]);

  const sourceLabel = (line: ScheduleLine) => {
    const citation = sourceOf(line);
    return citation ? sourceText(citation, { language, documents }).text : "—";
  };
  const lineName = (line: ScheduleLine) =>
    line.input?.label ?? line.component?.reading.chars ?? line.parent.reading.chars;
  const copy = (fallback?: ScheduleLine) => {
    const chosen = allLines.filter((line) =>
      selectedIds.has(lineRef(schedule?.mindId ?? "", line).id),
    );
    const copied = chosen.length
      ? chosen
      : fallback
        ? [fallback]
        : lines.filter((line) => line.id === current);
    void copyText(
      copied
        .map((line) =>
          [
            line.input || line.component ? "" : line.parent.number,
            lineName(line),
            line.input?.number.chars ?? (line.component ?? line.parent).sourceShown ?? "",
            sourceLabel(line),
            line.input || line.component
              ? ""
              : shownNumber(
                  line.parent.difference,
                  language,
                  line.parent.reading.unit.kind === "percent"
                    ? { kind: "points" }
                    : line.parent.reading.unit,
                ),
            line.input || line.component ? t("figures.retainedInput") : t(statusKey(line.parent)),
          ].join("\t"),
        )
        .join("\n"),
    ).catch(useAppStore.getState().reportError);
  };
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
      if (lines.find((line) => line.id === current)?.parent.id === id) {
        setCurrent(id);
        root.current
          ?.querySelector<HTMLElement>(`[data-figure-id="${CSS.escape(id)}"] [data-tree-row]`)
          ?.focus();
      }
    } else next.add(id);
    setExpanded(next);
  };
  const open = (line: ScheduleLine) => {
    if (line.id === line.parent.id && line.parent.calculated) {
      toggle(line.parent.id);
      return;
    }
    const citation = sourceOf(line);
    if (citation) props.onOpenSource(citation);
  };
  const keys = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || (event.target as Element).closest('[role="menu"]')) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      useSelection.getState().clear("figures");
      focus.current(null);
      if (current)
        root.current
          ?.querySelector<HTMLElement>(`[data-figure-id="${CSS.escape(current)}"] [data-tree-row]`)
          ?.focus();
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === "a") {
        event.preventDefault();
        useSelection.getState().all("figures");
      }
      if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        copy();
      }
      return;
    }
    if (extendThroughRows(event, "figures")) return;
    if (moveThroughRows(event)) {
      const id = document.activeElement?.closest<HTMLElement>("[data-figure-id]")?.dataset.figureId;
      const line = lines.find((line) => line.id === id);
      if (line && schedule)
        useSelection.getState().choose("figures", lineRef(schedule.mindId, line));
      return;
    }
    if (!(event.target as Element).matches("[data-tree-row]")) return;
    const line = lines.find((line) => line.id === current);
    if (!line) return;
    if (event.key === "Enter") {
      event.preventDefault();
      open(line);
    }
    if (event.key === " ") {
      event.preventDefault();
      props.onFocusFigure(line.parent);
    }
    if (
      event.key === "ArrowRight" &&
      childrenOf(line.parent, schedule?.rows ?? []).length &&
      !expanded.has(line.parent.id)
    ) {
      event.preventDefault();
      toggle(line.parent.id);
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (line.id !== line.parent.id || expanded.has(line.id)) toggle(line.parent.id);
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
  const unchecked = schedule.rows
    .filter((row) => row.shown.state === "not-checked" || row.shown.state === "needs-recheck")
    .map((row) => row.id);
  const model = schedule.model
    ? modelNames(schedule.model.modelId, schedule.model.providerId)
    : null;
  return (
    <section
      ref={root}
      className="figure-schedule"
      aria-label={t("figures.title")}
      data-surface="figures"
      onKeyDown={keys}
    >
      <header className="figure-heading">
        <div className="figure-heading-top">
          <div className="min-w-0">
            <h2>{schedule.name}</h2>
            <div className="figure-meta">
              {schedule.checkedAt ? (
                <time dateTime={schedule.checkedAt}>
                  {formatDateTime(schedule.checkedAt, language)}
                </time>
              ) : (
                t("figures.noCheck")
              )}
              {model && <span title={model.id}> · {model.name}</span>}
            </div>
          </div>
          <button
            type="button"
            className={buttonStyle("secondary", "sm")}
            disabled={schedule.progress !== null}
            onClick={() => props.onExport()}
          >
            {t("figures.export")}
          </button>
        </div>
        <div className="figure-counts" role="status" aria-live="polite">
          {t("figures.counts", schedule.counts)}
          {schedule.counts.kept > 0 && (
            <> · {t("figures.keptCount", { count: schedule.counts.kept })}</>
          )}
          {schedule.progress ? (
            <span>
              {" "}
              · {t("figures.progress", schedule.progress)}
              {props.onStop && (
                <>
                  {" "}
                  ·{" "}
                  <button type="button" onClick={() => props.onStop?.()}>
                    {t("figures.stop")}
                  </button>
                </>
              )}
            </span>
          ) : (
            unchecked.length > 0 && (
              <span>
                {" "}
                ·{" "}
                <button type="button" onClick={() => props.onCheckAgain(unchecked)}>
                  {t("figures.checkRemaining")}
                </button>
              </span>
            )
          )}
        </div>
        <fieldset className="figure-filters" aria-label={t("figures.filter")}>
          {(["all", "look", "supported", "not-checked"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(`figures.filter.${key}`)}
            </button>
          ))}
        </fieldset>
        {parentIds.length > 0 && (
          <fieldset
            className="figure-bulk"
            aria-label={t("figures.selection", { count: parentIds.length })}
          >
            <span>{t("figures.selection", { count: parentIds.length })}</span>
            <button type="button" onClick={() => props.onKeep(parentIds)}>
              {t("figures.keepCount", { count: parentIds.length })}
            </button>
            <button type="button" onClick={() => props.onCheckAgain(parentIds)}>
              {t("figures.checkCount", { count: parentIds.length })}
            </button>
          </fieldset>
        )}
      </header>
      {schedule.rows.length === 0 ? (
        <p className="figure-empty">{t("figures.empty")}</p>
      ) : (
        <div className="figure-scroll">
          <table className="figure-table" aria-label={t("figures.title")}>
            <thead>
              <tr className="figure-grid figure-columns">
                <th scope="col">#</th>
                <th scope="col">{t("figures.figure")}</th>
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
                    aria-pressed={statusSort}
                    title={t(statusSort ? "figures.sortNote" : "figures.sortStatus")}
                    onClick={() => setStatusSort(!statusSort)}
                  >
                    {t("figures.status")}
                    {statusSort ? " ↓" : ""}
                  </button>
                </th>
                <th scope="col">
                  <span className="sr-only">{t("figures.rowActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={7} className="figure-empty">
                    {t("figures.noMatches")}
                  </td>
                </tr>
              )}
              {lines.map((line) => (
                <FigureScheduleRowView
                  key={line.id}
                  line={line}
                  rows={schedule.rows}
                  mindId={schedule.mindId}
                  current={
                    lines.some((each) => each.id === current) ? current : (lines[0]?.id ?? null)
                  }
                  expanded={expanded.has(line.parent.id)}
                  parentIds={parentIds}
                  props={props}
                  onCurrent={setCurrent}
                  onToggle={() => toggle(line.parent.id)}
                  onOpen={() => open(line)}
                  onCopy={() => copy(line)}
                  sourceLabel={sourceLabel(line)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
