import React, { useRef } from "react";
import type { FigureScheduleRow } from "../../../../core/api";
import { formatDateTime } from "../../../../shared/dates";
import {
  childrenOf,
  figureGroup,
  lineRef,
  reasonKey,
  type ScheduleLine,
  shownNumber,
  sourceOf,
  statusKey,
} from "../../../../shared/figureSchedule";
import { useLanguage, useT } from "../../i18n";
import { useModelNames } from "../../modelNames";
import { useSelectable, useSelection } from "../../selection";
import { TREE_ROW } from "../../treeKeys";
import { ChevronDownLineIcon, ChevronRightLineIcon, MoreLineIcon } from "../lineIcons";
import { useObjectMenu } from "../ObjectMenu";
import { iconButtonClass, menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import type { FigureScheduleViewProps } from "./FigureScheduleView";

export function FigureScheduleRowView({
  line,
  rows,
  mindId,
  current,
  expanded,
  parentIds,
  props,
  onCurrent,
  onToggle,
  onOpen,
  onCopy,
  sourceLabel,
}: {
  line: ScheduleLine;
  rows: FigureScheduleRow[];
  mindId: string;
  current: string | null;
  expanded: boolean;
  parentIds: string[];
  props: FigureScheduleViewProps;
  onCurrent(id: string): void;
  onToggle(): void;
  onOpen(): void;
  onCopy(): void;
  sourceLabel: string;
}) {
  const t = useT();
  const language = useLanguage();
  const { parent } = line;
  const modelNames = useModelNames();
  const checked = [
    parent.checkedAt ? formatDateTime(parent.checkedAt, language) : null,
    parent.model ? modelNames(parent.model.modelId, parent.model.providerId).name : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const child = line.id !== parent.id;
  const selected = useSelectable(lineRef(mindId, line), "figures", () => {});
  const menu = usePopoverMenu({ focus: "first", align: "end" });
  const objectMenu = useObjectMenu(null, (row) =>
    row.querySelector<HTMLButtonElement>("[data-figure-more]"),
  );
  const ids = selected.selected && parentIds.length ? parentIds : [parent.id];
  const expandable = !child && childrenOf(parent, rows).length > 0;
  const source = sourceOf(line);
  const reason = reasonKey(parent);
  const state = figureGroup(parent);
  const context =
    child && (parent.shown.state === "not-checked" || parent.shown.state === "needs-recheck");
  const action = (label: string, run: () => void) => (
    <button
      type="button"
      role="menuitem"
      className={menuItemClass}
      onClick={() => {
        menu.close();
        run();
      }}
    >
      {label}
    </button>
  );
  const main = useRef<HTMLButtonElement>(null);
  return (
    <>
      <tr
        tabIndex={-1}
        {...selected.rowProps}
        {...objectMenu.rowProps}
        data-figure-id={line.id}
        data-input={child || undefined}
        className={`figure-grid figure-row ${selected.selected ? "is-selected" : ""} ${line.omitted ? "is-omitted" : ""}`}
        onContextMenu={(event) => {
          if (!selected.selected) useSelection.getState().choose("figures", lineRef(mindId, line));
          objectMenu.rowProps.onContextMenu(event);
        }}
        onClick={(event) => {
          if ((event.target as Element).closest("button,[role=menu]")) return;
          main.current?.focus();
          selected.onClick(event);
        }}
      >
        <td className="figure-number">{child ? "" : parent.number}</td>
        <td className="figure-main">
          {expandable && (
            <button
              type="button"
              className="figure-expand"
              aria-label={t(expanded ? "figures.collapse" : "figures.expand")}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
            >
              {expanded ? <ChevronDownLineIcon /> : <ChevronRightLineIcon />}
            </button>
          )}
          <button
            ref={main}
            {...TREE_ROW}
            type="button"
            tabIndex={current === line.id ? 0 : -1}
            className="figure-main-button"
            onFocus={() => onCurrent(line.id)}
            onClick={selected.onClick}
          >
            {line.input?.label ?? line.component?.reading.chars ?? parent.reading.chars}
            {!child && parent.calculated && (
              <span className="figure-calc" title={t("figures.calculated")}>
                {" "}
                =
              </span>
            )}
          </button>
          <div className="figure-meta">
            {child ? (
              <>
                {line.axis && `${t(`figures.axis.${line.axis}`)} · `}
                {line.omitted ? t("figures.omitted") : t("figures.retainedInput")}
              </>
            ) : parent.place.table ? (
              `${parent.place.table.rowLabel} · ${parent.place.table.columnLabel}`
            ) : parent.place.chart ? (
              `${parent.place.chart.rowLabel} · ${parent.place.chart.seriesLabel}`
            ) : (
              parent.place.heading || t("figures.paragraph", { number: parent.place.paragraph })
            )}
          </div>
        </td>
        <td className="figure-value" data-label={t("figures.sourceValue")}>
          {line.input?.number.chars ?? (line.component ?? parent).sourceShown ?? "—"}
        </td>
        <td className="figure-source" data-label={t("figures.source")}>
          {!child && parent.calculated ? (
            <button type="button" onClick={onToggle} title={parent.calculated.figure.formula}>
              {t("figures.calculated")} · <code>{parent.calculated.figure.formula}</code>
            </button>
          ) : source ? (
            <button
              type="button"
              title={sourceLabel}
              onClick={() => {
                useSelection.getState().choose("figures", lineRef(mindId, line));
                onOpen();
              }}
            >
              {sourceLabel}
            </button>
          ) : (
            "—"
          )}
          {line.input?.cell && (
            <div className="figure-meta">
              {line.input.cell.sheet ? `${line.input.cell.sheet}!` : ""}
              {line.input.cell.ref}
              {line.input.cell.stored !== null && (
                <>
                  {" "}
                  · {t("figures.stored", { value: shownNumber(line.input.cell.stored, language) })}
                </>
              )}
            </div>
          )}
          {line.input && (
            <details className="figure-quote">
              <summary>{t("figures.quote")}</summary>
              <blockquote>{line.input.citation.quote}</blockquote>
              {line.input.unitStatement && (
                <>
                  <span>{t("figures.unitQuote")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (line.input?.unitStatement)
                        props.onOpenSource(line.input.unitStatement.citation);
                    }}
                  >
                    {line.input.unitStatement.citation.quote}
                  </button>
                </>
              )}
            </details>
          )}
        </td>
        <td className="figure-difference" data-label={t("figures.difference")}>
          {child
            ? ""
            : parent.roundedFrom !== null
              ? t("figures.roundedFrom", {
                  value: shownNumber(parent.roundedFrom, language, parent.reading.unit),
                })
              : shownNumber(
                  parent.difference,
                  language,
                  parent.reading.unit.kind === "percent" ? { kind: "points" } : parent.reading.unit,
                )}
        </td>
        <td
          className="figure-status"
          data-state={child ? "input" : state}
          title={checked || undefined}
        >
          {child ? (
            context ? (
              <span>
                {t(statusKey(parent))}
                <span className="figure-meta">{t("figures.parentContext")}</span>
              </span>
            ) : (
              <span className="figure-meta">{t("figures.retainedInput")}</span>
            )
          ) : (
            <>
              <span>
                <span aria-hidden="true" className="figure-status-icon">
                  {state === "supported"
                    ? "✓"
                    : state === "look"
                      ? "!"
                      : state === "checking" || parent.shown.state === "needs-recheck"
                        ? "↻"
                        : "—"}
                </span>
                {state === "look" ? t("figures.filter.look") : t(statusKey(parent))}
              </span>
              {reason && <span className="figure-meta">{t(reason)}</span>}
            </>
          )}
        </td>
        <td className="figure-actions">
          <button
            {...menu.buttonProps}
            type="button"
            data-figure-more=""
            className={iconButtonClass}
            aria-label={t("figures.actions", { figure: line.input?.label ?? parent.reading.chars })}
            onClick={(event) => {
              event.stopPropagation();
              onCurrent(line.id);
              if (!selected.selected)
                useSelection.getState().choose("figures", lineRef(mindId, line));
            }}
          >
            <MoreLineIcon className="size-4" />
          </button>
          <div
            {...menu.menuProps}
            className={menuClass}
            role="menu"
            aria-label={t("figures.rowActions")}
            onKeyDown={(event) => {
              menu.menuProps.onKeyDown(event);
              if (event.key === "Escape") event.stopPropagation();
            }}
          >
            {(source || (!child && parent.calculated)) && action(t("figures.openSource"), onOpen)}
            {action(t("figures.showInNote"), () => props.onFocusFigure(parent))}
            {!child && (
              <>
                <div className={menuRuleClass} />
                {action(t("figures.checkCount", { count: ids.length }), () =>
                  props.onCheckAgain(ids),
                )}
                {parent.shown.state === "contradicted" &&
                  parent.sourceInput &&
                  action(t("figures.changeToSource"), () => props.onChangeToSource(ids))}
                {parent.shown.state === "supported" &&
                  parent.sourceInput &&
                  action(t("claim.addAsCitation"), () => props.onAddCitation(parent.id))}
                {!parent.calculated &&
                  action(t("figures.chooseCitation"), () => props.onChooseCitation(parent.id))}
                {parent.shown.state !== "kept" &&
                  action(
                    ids.length > 1
                      ? t("figures.keepCount", { count: ids.length })
                      : t("claim.keepAsView"),
                    () => props.onKeep(ids),
                  )}
                {parent.place.table &&
                  (["row", "column"] as const).map((axis) => (
                    <React.Fragment key={axis}>
                      {action(
                        t(
                          parent.footing.some((fact) => fact.axis === axis)
                            ? `figures.notTotal.${axis}`
                            : `figures.total.${axis}`,
                        ),
                        () =>
                          props.onTotalRole(
                            parent.id,
                            axis,
                            !parent.footing.some((fact) => fact.axis === axis),
                          ),
                      )}
                    </React.Fragment>
                  ))}
              </>
            )}
            <div className={menuRuleClass} />
            {action(t("menu.copy"), onCopy)}
          </div>
        </td>
      </tr>
      {!child &&
        (parent.footing.length > 0 ||
          (expanded && parent.calculated && parent.calculated.figure.literals.length > 0)) && (
          <tr className={`figure-explanation-row ${selected.selected ? "is-selected" : ""}`}>
            <td colSpan={7} className="figure-explanation">
              {parent.footing.map((fact) => (
                <div
                  key={fact.axis}
                  className={`figure-footing ${fact.agrees === false ? "has-problem" : ""}`}
                >
                  <span>
                    {t(`figures.sum.${fact.axis}`, {
                      value: shownNumber(fact.sum, language, parent.reading.unit),
                    })}
                  </span>
                  {fact.agrees === false && <span> · {t("claim.state.doesntAddUp")}</span>}
                  {parent.sourceFooting
                    ?.filter((proof) => proof.axis === fact.axis)
                    .map((proof) => (
                      <div key={proof.axis}>
                        <span>
                          {t("figures.sourceSum", {
                            value: shownNumber(proof.sum, language, parent.reading.unit),
                          })}
                          {proof.agrees === true
                            ? ` · ${t("figures.sourceAddsUp")}`
                            : proof.agrees === false
                              ? ` · ${t("claim.state.doesntAddUp")}`
                              : ""}
                        </span>
                        {proof.inputs.map((input) => (
                          <div
                            key={JSON.stringify([
                              input.name,
                              input.citation.passageId,
                              input.number.at,
                              input.cell?.ref,
                            ])}
                            className="figure-omitted-proof"
                          >
                            <span>{t("figures.omitted")}: </span>
                            <button
                              type="button"
                              onClick={() => props.onOpenSource(input.citation)}
                            >
                              {input.label} · {input.number.chars}
                            </button>
                          </div>
                        ))}
                      </div>
                    ))}
                </div>
              ))}
              {expanded && parent.calculated && parent.calculated.figure.literals.length > 0 && (
                <div className="figure-meta">
                  {t("figures.literals")}:{" "}
                  {parent.calculated.figure.literals.map((literal) => literal.text).join(", ")}
                </div>
              )}
            </td>
          </tr>
        )}
    </>
  );
}
