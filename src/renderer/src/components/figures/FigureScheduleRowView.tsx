import { type ReactNode, useRef } from "react";
import type { Citation, FigureScheduleRow } from "../../../../core/api";
import {
  figurePlaceText,
  footingNotes,
  type LineStatus,
  lineRef,
  lineShows,
  notCheckedYet,
  rowGlyph,
  type ScheduleGlyph,
  type ScheduleLine,
  sourceValueText,
  toCheckAgain,
  toKeep,
} from "../../../../shared/figureSchedule";
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

const GLYPHS: Record<ScheduleGlyph, string> = {
  supported: "✓",
  look: "!",
  recheck: "↻",
  "not-checked": "",
  kept: "–",
};

function Status({ status }: { status: LineStatus }) {
  const t = useT();
  const { glyph, word, why } = status;
  return (
    <>
      <span className="figure-glyph" data-glyph={glyph} aria-hidden="true">
        {GLYPHS[glyph]}
      </span>
      <span className="figure-status-words">
        <span className="figure-status-word">{t(word)}</span>
        {why && <span className="figure-why-word">{t(why)}</span>}
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
  chosen: readonly FigureScheduleRow[];
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
  const glyph = rowGlyph(parent);
  const unchecked = notCheckedYet(parent);
  const shows = lineShows(line, language);
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
  const looked = parent.shown.state;
  const totals = parent.footing.map((axis) => axis.axis);
  // Each item shows for, counts and acts on the same rows: the chosen ones it applies to.
  const checks = toCheckAgain(chosen).map((row) => row.id);
  const keeps = toKeep(chosen).map((row) => row.id);
  const acts: ReactNode[] = kid
    ? []
    : [
        checks.length > 0 &&
          action(
            checks.length > 1
              ? t("figures.checkCount", { count: checks.length })
              : t("claim.checkAgain"),
            () => props.onCheckAgain(checks),
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
        keeps.length > 0 &&
          action(
            keeps.length > 1
              ? t("figures.keepCount", { count: keeps.length })
              : t("claim.keepAsView"),
            () => props.onKeep(keeps),
          ),
        parent.place.table &&
          action(t(totals.length > 0 ? "figures.notTotal" : "figures.total"), () =>
            props.onTotalRole(parent.id, totals.length > 0 ? totals : ["row"], totals.length === 0),
          ),
      ].filter(Boolean);

  const { name, value, difference } = shows;
  const source =
    shows.formula !== null ? (
      <span className="figure-formula">
        {t("figures.calculated")} · {shows.formula}
      </span>
    ) : (
      sourceLink(shows.citation)
    );
  const status = shows.status && <Status status={shows.status} />;
  const notes = kid || unchecked ? [] : footingNotes(parent);
  return (
    <tr
      {...selected.rowProps}
      {...objectMenu.rowProps}
      data-figure-id={line.id}
      data-kid={kid ? (line.input || line.range ? "input" : "part") : undefined}
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
