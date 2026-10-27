import { type ReactNode, useRef } from "react";
import type { Citation, FigureScheduleRow } from "../../../../core/api";
import {
  differenceText,
  figureGroup,
  figurePlaceText,
  footingNotes,
  lineRef,
  reasonKey,
  type ScheduleLine,
  sourceValueText,
  statusKey,
  writtenLike,
} from "../../../../shared/figureSchedule";
import { formulaText } from "../../../../shared/formula";
import { sourceParts } from "../../../../shared/sources";
import { useLanguage, useT } from "../../i18n";
import { useSelectable, useSelection } from "../../selection";
import { useAppStore } from "../../store";
import { TREE_ROW } from "../../treeKeys";
import { ChevronRightLineIcon, MoreLineIcon } from "../lineIcons";
import { useObjectMenu } from "../ObjectMenu";
import { iconButtonClass, menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import type { FigureScheduleViewProps } from "./FigureScheduleView";

type Glyph = "supported" | "look" | "recheck" | "not-checked" | "kept";

function glyphOf(row: FigureScheduleRow): Glyph {
  const group = figureGroup(row);
  if (row.shown.state === "needs-recheck") return "recheck";
  if (group === "checking") return "not-checked";
  return group;
}

const GLYPHS: Record<Glyph, string> = {
  supported: "✓",
  look: "!",
  recheck: "↻",
  "not-checked": "",
  kept: "–",
};

function Status({ glyph, word, why }: { glyph: Glyph; word: string; why?: string | null }) {
  return (
    <>
      <span className="figure-glyph" data-glyph={glyph} aria-hidden="true">
        {GLYPHS[glyph]}
      </span>
      <span className="figure-status-words">
        <span className="figure-status-word">{word}</span>
        {why && <span className="figure-why-word">{why}</span>}
      </span>
    </>
  );
}

export function FigureScheduleRowView({
  line,
  mindId,
  current,
  expandable,
  expanded,
  chosen,
  props,
  onCurrent,
  onToggle,
  onOpen,
  onCopy,
}: {
  line: ScheduleLine;
  mindId: string;
  current: string | null;
  expandable: boolean;
  expanded: boolean;
  /** The figures an action on this row acts on: the selection when it holds this row. */
  chosen: readonly string[];
  props: FigureScheduleViewProps;
  onCurrent(id: string): void;
  onToggle(): void;
  onOpen(line: ScheduleLine): void;
  onCopy(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const documents = useAppStore((state) => state.documents);
  const { parent } = line;
  const kid = line.id !== parent.id;
  const selected = useSelectable(lineRef(mindId, line), "figures", () => {
    if (!kid) props.onFocusFigure(parent);
  });
  const menu = usePopoverMenu({ focus: "first", align: "end" });
  const objectMenu = useObjectMenu(null, (row) =>
    row.querySelector<HTMLButtonElement>("[data-figure-more]"),
  );
  const main = useRef<HTMLButtonElement>(null);
  const glyph = glyphOf(parent);
  const unchecked = parent.shown.state === "not-checked" || parent.shown.state === "checking";
  const sourceLink = (citation: Citation | null | undefined) => {
    if (!citation) return null;
    const { name, location } = sourceParts(citation, { language, documents });
    return (
      <button
        type="button"
        className="figure-link"
        title={location ? `${name} · ${location}` : name}
        onClick={(event) => {
          event.stopPropagation();
          useSelection.getState().choose("figures", lineRef(mindId, line));
          onCurrent(line.id);
          onOpen(line);
        }}
      >
        <span className="figure-link-name">{name}</span>
        {location && <span className="figure-link-place">· {location}</span>}
      </button>
    );
  };
  const dash = <span className="figure-dash">—</span>;

  const action = (label: string, run: () => void, keys?: string) => (
    <button
      type="button"
      role="menuitem"
      className={menuItemClass}
      onClick={() => {
        menu.close();
        run();
      }}
    >
      <span className="flex-1">{label}</span>
      {keys && <span className="text-ink-meta">{keys}</span>}
    </button>
  );
  const several = chosen.length > 1;
  const looked = parent.shown.state;
  const totals = parent.footing.map((axis) => axis.axis);
  const acts: ReactNode[] = kid
    ? []
    : [
        (looked === "not-checked" || looked === "needs-recheck" || looked === "kept") &&
          action(
            several ? t("figures.checkCount", { count: chosen.length }) : t("claim.checkAgain"),
            () => props.onCheckAgain([...chosen]),
          ),
        looked === "contradicted" &&
          parent.sourceInput &&
          totals.length === 0 &&
          action(t("figures.changeToSource", { value: sourceValueText(parent) ?? "" }), () =>
            props.onChangeToSource([parent.id]),
          ),
        looked === "supported" &&
          parent.sourceInput &&
          !parent.cited &&
          action(t("claim.addAsCitation"), () => props.onAddCitation(parent.id)),
        !parent.calculated &&
          action(t("figures.chooseCitation"), () => props.onChooseCitation(parent.id)),
        looked !== "kept" &&
          action(
            several ? t("figures.keepCount", { count: chosen.length }) : t("claim.keepAsView"),
            () => props.onKeep([...chosen]),
          ),
        parent.place.table &&
          action(t(totals.length > 0 ? "figures.notTotal" : "figures.total"), () =>
            props.onTotalRole(parent.id, totals.length > 0 ? totals : ["row"], totals.length === 0),
          ),
      ].filter(Boolean);

  const name = line.input
    ? line.input.label
    : line.component
      ? (line.axis === "column"
          ? line.component.place.table?.columnLabel
          : line.component.place.table?.rowLabel) || line.component.reading.chars
      : parent.reading.chars;
  const value = line.input
    ? line.omitted
      ? writtenLike(parent.reading, line.input.number.value, parent.reading.decimals)
      : line.input.number.chars
    : line.component
      ? line.component.reading.chars
      : unchecked
        ? null
        : sourceValueText(parent);
  const difference = kid || unchecked ? null : differenceText(parent, language);
  const source = kid ? (
    line.input && !line.omitted ? (
      sourceLink(line.input.citation)
    ) : null
  ) : parent.calculated ? (
    <span className="figure-formula">
      {t("figures.calculated")} ·{" "}
      {formulaText(
        parent.calculated.figure.formula,
        (input) =>
          parent.calculated?.figure.inputs.find(
            (each) => each.name.toLowerCase() === input.toLowerCase(),
          )?.label ?? null,
      )}
    </span>
  ) : unchecked ? null : (
    sourceLink(parent.sourceInput?.citation ?? parent.source)
  );
  const reason = reasonKey(parent);
  const status = line.omitted ? (
    <Status glyph="look" word={t("figures.notInTable")} />
  ) : line.input ? (
    line.input.citation.check === "found" ? (
      <Status glyph="supported" word={t("claim.state.supported")} />
    ) : line.input.citation.check === "not-found" ? (
      <Status glyph="look" word={t("figures.filter.look")} why={t("claim.state.quoteNotFound")} />
    ) : (
      <Status glyph="not-checked" word={t("claim.state.not-checked")} />
    )
  ) : kid ? null : (
    <Status
      glyph={glyph}
      word={
        glyph === "look" || glyph === "recheck" ? t("figures.filter.look") : t(statusKey(parent))
      }
      why={reason ? t(reason) : null}
    />
  );
  const notes = kid || unchecked ? [] : footingNotes(parent);
  return (
    <tr
      {...selected.rowProps}
      {...objectMenu.rowProps}
      data-figure-id={line.id}
      data-kid={kid ? (line.input ? "input" : "part") : undefined}
      data-state={kid ? undefined : glyph}
      className={`figure-grid figure-row ${selected.selected ? "is-selected" : ""} ${line.omitted ? "is-omitted" : ""} ${menu.open ? "has-menu" : ""}`}
      onClick={(event) => {
        if ((event.target as Element).closest("button:not([data-tree-row]),[role=menu]")) return;
        main.current?.focus();
        onCurrent(line.id);
        selected.onClick(event);
      }}
    >
      <td className="figure-number">{kid ? "" : parent.number}</td>
      <td className="figure-main">
        <div className="figure-main-line">
          {expandable && (
            <button
              type="button"
              tabIndex={-1}
              className="figure-expand"
              aria-label={t(expanded ? "figures.collapse" : "figures.expand")}
              title={t(expanded ? "figures.collapse" : "figures.expand")}
              aria-expanded={expanded}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
            >
              <ChevronRightLineIcon />
            </button>
          )}
          {!kid && parent.calculated && (
            <span className="figure-equals" title={t("figures.calculated")}>
              =
            </span>
          )}
          <button
            ref={main}
            {...TREE_ROW}
            type="button"
            tabIndex={current === line.id ? 0 : -1}
            className="figure-main-button"
            aria-expanded={expandable ? expanded : undefined}
            onFocus={() => onCurrent(line.id)}
          >
            {name}
          </button>
        </div>
        {!kid && <div className="figure-place">{figurePlaceText(parent, language)}</div>}
      </td>
      <td className="figure-value" data-label={t("figures.sourceValue")}>
        {value ?? dash}
      </td>
      <td className={`figure-source ${source ? "" : "is-empty"}`} data-label={t("figures.source")}>
        {source ?? (kid ? null : dash)}
      </td>
      <td className="figure-difference" data-label={t("figures.difference")}>
        {kid ? null : difference ? (
          <span className={parent.roundedFrom === null ? "figure-delta" : ""}>{difference}</span>
        ) : (
          dash
        )}
      </td>
      <td className="figure-status">{status}</td>
      <td className="figure-actions">
        {!kid && (
          <>
            <button
              {...menu.buttonProps}
              type="button"
              tabIndex={-1}
              data-figure-more=""
              className={`${iconButtonClass} figure-more`}
              aria-label={t("figures.actions", { figure: parent.reading.chars })}
              title={t("figures.actions", { figure: parent.reading.chars })}
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
              {action(t("figures.openSource"), () => onOpen(line), "↵")}
              {action(t("figures.showInNote"), () => props.onShowFigure(parent), "Space")}
              {acts.length > 0 && <div className={menuRuleClass} />}
              {acts}
              <div className={menuRuleClass} />
              {action(t("menu.copy"), onCopy, "⌘C")}
            </div>
          </>
        )}
      </td>
      {notes.length > 0 && (
        <td className="figure-why">
          {notes.map((note) => (
            <div key={note.axis} className="figure-why-axis">
              {note.agrees && (
                <div className="figure-why-line">
                  <span className="figure-glyph" data-glyph="supported" aria-hidden="true">
                    ✓
                  </span>
                  <span>{t("figures.foot.agrees")}</span>
                </div>
              )}
              <div className="figure-why-line">
                <span className="figure-glyph" data-glyph="look" aria-hidden="true">
                  !
                </span>
                <span>
                  {t(note.axis === "row" ? "figures.foot.rows" : "figures.foot.columns", {
                    value: note.sum,
                  })}
                </span>
              </div>
              {note.omitted.length > 0 ? (
                <div className="figure-why-more">
                  {t(
                    note.omitted.length > 1 ? "figures.foot.omitted.many" : "figures.foot.omitted",
                    {
                      rows: note.omitted.join(t("figures.foot.join")),
                    },
                  )}
                </div>
              ) : (
                note.sourceSum && (
                  <div className="figure-why-more">
                    {t("figures.foot.source", { value: note.sourceSum })}
                  </div>
                )
              )}
            </div>
          ))}
        </td>
      )}
    </tr>
  );
}
