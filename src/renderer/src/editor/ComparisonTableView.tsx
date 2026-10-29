import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComparisonQuestion, RunStop } from "../../../core/api";
import {
  cellStop,
  cellToFill,
  comparisonCellOf,
  comparisonQuestionsOf,
  comparisonTitleOf,
  MAX_COMPARISON_QUESTIONS,
  MAX_COMPARISON_TITLE,
  visibleComparisonQuestions,
} from "../../../shared/comparisons";
import { readProposalAttribute } from "../../../shared/proposals";
import { addColumn, moveColumn, resizeColumn } from "../comparisonColumns";
import { fittedColumnWidth } from "../comparisonColumnWidth";
import {
  expandComparisonTable,
  fillComparisonTable,
  loadFillingComparisons,
  stopComparisonTable,
  useComparisons,
} from "../comparisons";
import { changeComparisonTitle, endTableRename, startTableRename } from "../comparisonTableName";
import {
  comparisonTableHandles,
  type RowProblem,
  useComparisonTables,
} from "../comparisonTableState";
import { ComparisonAddDocuments } from "../components/ComparisonAddDocuments";
import { ExportLineIcon, PlusLineIcon } from "../components/lineIcons";
import { useObjectMenu } from "../components/ObjectMenu";
import { ProblemLine } from "../components/ProblemLine";
import { ReadinessLine } from "../components/providers/ChatReadinessNotice";
import { runStopParts } from "../cost";
import { resolveProposalsIn } from "../editWithAi";
import { dialogOrMenuOpen } from "../escapeDismiss";
import { exportComparison } from "../exports";
import { useLanguage, useT } from "../i18n";
import { useAppStore } from "../store";
import { tableTask, useTasks } from "../tasks";
import { typesText } from "../undo";
import {
  type ColumnDrop,
  ColumnQuestionField,
  ComparisonColumnHeading,
} from "./ComparisonColumnHeading";
import { ComparisonTableMenu } from "./ComparisonTableMenu";
import { problemCounts, shownRowCount } from "./comparisonRowCounts";
import { CollapseIcon, ExpandIcon, TableIcon } from "./icons";
import { useMindId } from "./mindContext";

/**
 * The table's cells: how many, how many have their outcome, how many filling
 * again would write, and the monthly cap or plan's limit that stopped a fill.
 */
function cellCounts(node: ReactNodeViewProps["node"], hidden: ReadonlySet<string>) {
  let total = 0;
  let settled = 0;
  let toFill = 0;
  let stop: RunStop | null = null;
  node.forEach((row) => {
    row.forEach((cell) => {
      // A hidden column is out of the work, as the core's fill leaves it: not counted or stopped on.
      if (hidden.has(String(cell.attrs.questionId ?? ""))) return;
      const state = comparisonCellOf(cell.attrs);
      total++;
      if (state.status === "done" || state.status === "failed") settled++;
      if (cellToFill(state)) toFill++;
      stop ??= cellStop(state);
    });
  });
  return { total, settled, toFill, stop: stop as RunStop | null };
}

const typingFocused = (): boolean => {
  const active = document.activeElement;
  if (!typesText(active)) return false;
  // A field inside the note takes Escape; the note's own editor is what the table collapses over.
  return !(active instanceof HTMLElement && active.matches('[data-testid="mind-editor"]'));
};

const NO_PROBLEMS: ReadonlySet<RowProblem> = new Set();

/** The table's name, typed in place: Enter or leaving it saves, Esc keeps the old name. */
function TableNameField({ name, onDone }: { name: string; onDone(next: string | null): void }) {
  const t = useT();
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const end = (save: boolean) => {
    if (ended.current) return;
    ended.current = true;
    onDone(save ? value : null);
  };
  return (
    <input
      ref={field}
      data-testid="comparison-name-field"
      className="comparison-name-field"
      aria-label={t("comparison.table.nameField")}
      placeholder={t("comparison.title")}
      maxLength={MAX_COMPARISON_TITLE}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          end(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          end(false);
        }
      }}
      onBlur={() => end(true)}
    />
  );
}

/**
 * Expand (DESIGN.md, Comparison table): the table fills the Mind's card
 * where it is, the note held still behind it, until Back to note or Esc. It
 * grows in place rather than over the window, so its cells stay the editor's
 * own, Citations and their cards included.
 */
function useExpandInPlace(
  wrapper: React.RefObject<HTMLElement | null>,
  expanded: boolean,
  collapse: () => void,
) {
  useLayoutEffect(() => {
    const element = wrapper.current;
    const scroller = element?.closest<HTMLElement>(".mind-scroller");
    if (!expanded || !element || !scroller) return;
    const before = { overflow: scroller.style.overflow, scrollTop: scroller.scrollTop };
    const fitCard = () => {
      element.style.marginLeft = "0px";
      const box = scroller.getBoundingClientRect();
      const from = element.getBoundingClientRect().left;
      element.style.width = `${scroller.clientWidth}px`;
      element.style.height = `${scroller.clientHeight}px`;
      element.style.marginLeft = `${box.left - from}px`;
    };
    scroller.style.overflow = "hidden";
    fitCard();
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const observer = new ResizeObserver(fitCard);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
      element.style.width = "";
      element.style.height = "";
      element.style.marginLeft = "";
      scroller.style.overflow = before.overflow;
      element.scrollIntoView({ block: "nearest" });
    };
  }, [wrapper, expanded]);

  useEffect(() => {
    if (!expanded) return;
    // Esc closes what is open in front of the page: a dialog or a menu, or a field the key
    // is typed in. With none of those open, the expanded table is what Esc closes, even
    // though the note's editor marks every Esc as handled.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (dialogOrMenuOpen() || typingFocused()) return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [expanded, collapse]);
}

/**
 * A comparison table (#98; DESIGN.md, Comparison table; the canvas boards
 * Final-07-Compare and Final-07-Compare-Expanded): "Comparison table · N
 * Documents × M Questions", what it is doing (filling, with Stop; cells to
 * fill, with Fill), Accept all · Reject all while it waits as a change, and
 * Expand. Then the table: the Document column sticky as it scrolls
 * sideways, a heading row of its Questions, "+ Question" beside it.
 */
export function ComparisonTableView({ node, editor }: ReactNodeViewProps) {
  const t = useT();
  const mindId = useMindId();
  const tableId = String(node.attrs.id ?? "");
  const columns = comparisonQuestionsOf(node.attrs);
  const questions = visibleComparisonQuestions(columns);
  const hidden = columns.filter((column) => column.hidden === true);
  const proposal = readProposalAttribute(node.attrs.proposal);
  const filling = useComparisons((state) => state.filling.has(tableId));
  // Paused, its Task still holds its cells: they wait rather than stopped.
  const waiting = useTasks((state) => tableTask(state, tableId) !== null);
  const expanded = useComparisons((state) => state.expanded === tableId);
  const problem = useComparisons((state) => state.problems[tableId]);
  const addingDocuments = useComparisonTables((state) => state.adding === tableId);
  const renaming = useComparisonTables((state) => state.renaming === tableId);
  const filters = useComparisonTables((state) => state.filters.get(tableId) ?? NO_PROBLEMS);
  const tableMenu = useObjectMenu({ kind: "comparisonTable", id: tableId });
  const rowDocuments = (() => {
    const ids: string[] = [];
    node.forEach((row) => {
      ids.push(String(row.attrs.documentId ?? ""));
    });
    return ids;
  })();
  const tableModel =
    typeof node.attrs.providerId === "string" && typeof node.attrs.modelId === "string"
      ? { providerId: node.attrs.providerId, modelId: node.attrs.modelId }
      : null;
  const wrapper = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [resizing, setResizing] = useState<{ questionId: string; width: number } | null>(null);
  const [drag, setDrag] = useState<{ questionId: string; slot: number | null } | null>(null);
  const hiddenIds = new Set(hidden.map((column) => column.id));
  const { total, settled, toFill, stop } = cellCounts(node, hiddenIds);
  const counts = problemCounts(node, hiddenIds);
  const hasProblems = counts.nothing > 0 || counts.failed > 0;
  const shown = shownRowCount(node, hiddenIds, filters);
  const name = comparisonTitleOf(node.attrs) || t("comparison.title");
  const meta = `${t(node.childCount === 1 ? "comparison.documents.one" : "comparison.documents.other", { count: node.childCount })} × ${t(questions.length === 1 ? "comparison.questions.one" : "comparison.questions.other", { count: questions.length })}`;
  const title = `${name} · ${meta}`;
  const hiddenKey = hidden.map((column) => column.id).join("\n");
  const lastShown = questions.at(-1)?.id ?? null;
  // The cells are drawn in the document's order, which is the Questions': a hidden column's
  // cells are hidden, and the last column shown keeps the grid's outer edge. Read by
  // `questionId`, so a move, a hide or a show keeps this right however the rows arrive.
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const hiddenNow = new Set(hiddenKey === "" ? [] : hiddenKey.split("\n"));
    let applied = "";
    const apply = () => {
      const cells = element.querySelectorAll<HTMLElement>(
        ".comparison-row-cells > .comparison-cell[data-question-id]",
      );
      // A keystroke elsewhere in the note changes no cell's column: one signature keeps this off it.
      const signature = `${hiddenKey}\n${lastShown ?? ""}\n${cells.length}`;
      if (signature === applied) return;
      applied = signature;
      for (const cell of cells) {
        const questionId = cell.dataset.questionId ?? "";
        cell.hidden = hiddenNow.has(questionId);
        if (questionId === lastShown) cell.dataset.lastShown = "true";
        else delete cell.dataset.lastShown;
      }
    };
    apply();
    editor.on("transaction", apply);
    return () => {
      editor.off("transaction", apply);
    };
  }, [editor, hiddenKey, lastShown]);
  // A row hides itself from the counts the User clicked: it needs the columns its table hides.
  useEffect(() => {
    useComparisonTables
      .getState()
      .setHiddenColumns(tableId, hiddenKey === "" ? [] : hiddenKey.split("\n"));
  }, [tableId, hiddenKey]);
  // A filter left on with nothing to show would hide every row and leave no count to
  // press to bring them back, so it clears once no problem cell is left and no fill runs.
  useEffect(() => {
    if (filling || hasProblems || filters.size === 0) return;
    useComparisonTables.getState().clearFilter(tableId);
  }, [tableId, filling, hasProblems, filters.size]);
  const language = useLanguage();
  const openSettings = useAppStore((state) => state.openSettings);
  const editable = editor.isEditable;
  const ref = { mindId, tableId };
  const handle = { editor, mindId, tableId };

  useEffect(() => {
    const entry = { editor, mindId, tableId };
    comparisonTableHandles.set(tableId, entry);
    return () => {
      if (comparisonTableHandles.get(tableId) === entry) comparisonTableHandles.delete(tableId);
    };
  }, [tableId, editor, mindId]);

  useExpandInPlace(wrapper, expanded, () => expandComparisonTable(null));
  useEffect(loadFillingComparisons, []);

  const resolve = (outcome: "accept" | "reject") => {
    if (proposal) resolveProposalsIn(editor, mindId, [proposal.id], outcome);
  };

  const addQuestion = (text: string) => {
    setAdding(false);
    void addColumn(handle, text);
  };

  const moveTo = (questionId: string, slot: number) => {
    const landing = questions[slot];
    const to = landing
      ? columns.findIndex((column) => column.id === landing.id)
      : columns.length - 1;
    if (to >= 0) void moveColumn(handle, questionId, to);
  };

  const fit = (questionId: string) => {
    const table = wrapper.current;
    const width = table ? fittedColumnWidth(table, questionId) : null;
    if (width !== null) void resizeColumn(handle, questionId, width);
  };

  const dropOf = (index: number): ColumnDrop => {
    if (!drag || drag.slot === null) return null;
    if (drag.slot === index) return "before";
    return drag.slot === questions.length && index === questions.length - 1 ? "after" : null;
  };

  const widthOf = (question: ComparisonQuestion) =>
    resizing?.questionId === question.id ? resizing.width : question.width;
  const gridTemplateColumns = [
    "minmax(132px, 168px)",
    ...questions.map((question) => {
      const width = widthOf(question);
      return width ? `${Math.round(width)}px` : "minmax(156px, 1fr)";
    }),
    ...(adding ? ["minmax(156px, 1fr)"] : []),
  ].join(" ");

  const canAdd = editable && columns.length < MAX_COMPARISON_QUESTIONS;
  /** "+ Question", in the title line or beside the heading row: styles.css shows the one that fits. */
  const addButton = (place: "head" | "side") =>
    canAdd &&
    !adding && (
      <button
        type="button"
        data-testid="comparison-add-question"
        data-comparison-ui
        className={`comparison-add-question comparison-add-question--${place}`}
        onClick={() => setAdding(true)}
      >
        <PlusLineIcon className="size-3.5" />
        {t("comparison.addQuestion")}
      </button>
    );

  return (
    <NodeViewWrapper
      ref={wrapper}
      data-testid="comparison-table"
      data-comparison-table={tableId}
      data-filling={filling || undefined}
      data-waiting={(!filling && waiting) || undefined}
      data-expanded={expanded || undefined}
      data-pending={proposal ? "true" : undefined}
      data-no-columns={questions.length === 0 ? "true" : undefined}
      className="comparison-table"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the table's title line takes F2, which renames it; the name field inside takes the keys while it is open. */}
      <div
        ref={head}
        contentEditable={false}
        data-comparison-ui
        data-testid="comparison-head"
        tabIndex={editable ? 0 : undefined}
        {...(editable ? tableMenu.rowProps : {})}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (!editable) return;
          tableMenu.rowProps.onKeyDown(event);
          if (event.defaultPrevented || renaming) return;
          if (event.key === "F2") {
            event.preventDefault();
            startTableRename(tableId);
          }
        }}
        className="comparison-head"
      >
        {expanded && <TableIcon className="size-4 shrink-0 text-ink-meta" />}
        <span data-testid="comparison-title" className="comparison-title" title={title}>
          {renaming ? (
            <TableNameField
              name={comparisonTitleOf(node.attrs)}
              onDone={(next) => {
                endTableRename();
                if (next !== null) changeComparisonTitle(editor, tableId, next);
              }}
            />
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: a double-click renames it, as F2 on the title line does.
            <span
              className="comparison-name"
              data-testid="comparison-name"
              title={t("comparison.table.renameTip")}
              onDoubleClick={() => editable && useComparisonTables.getState().startRename(tableId)}
            >
              {name}
            </span>
          )}
          {` · ${meta}`}
        </span>
        <span className="comparison-status">
          {(hasProblems || filters.size > 0) && (
            <span aria-hidden="true" className="comparison-sep">
              ·
            </span>
          )}
          {counts.nothing > 0 && (
            <button
              type="button"
              data-testid="comparison-count-nothing"
              className="comparison-count"
              aria-pressed={filters.has("nothing")}
              title={t("comparison.status.nothingTip")}
              onClick={() => useComparisonTables.getState().toggleFilter(tableId, "nothing")}
            >
              {t("comparison.status.nothing", { count: counts.nothing })}
            </button>
          )}
          {counts.nothing > 0 && counts.failed > 0 && (
            <span aria-hidden="true" className="comparison-sep">
              ·
            </span>
          )}
          {counts.failed > 0 && (
            <button
              type="button"
              data-testid="comparison-count-failed"
              className="comparison-count"
              aria-pressed={filters.has("failed")}
              title={t("comparison.status.failedTip")}
              onClick={() => useComparisonTables.getState().toggleFilter(tableId, "failed")}
            >
              {t("comparison.status.failed", { count: counts.failed })}
            </button>
          )}
          {filters.size > 0 && (
            <>
              <span aria-hidden="true" className="comparison-sep">
                ·
              </span>
              <span data-testid="comparison-showing" className="comparison-showing">
                {t("comparison.status.showing", { shown, total: node.childCount })}
              </span>
              <button
                type="button"
                data-testid="comparison-clear-filter"
                className="comparison-action"
                onClick={() => useComparisonTables.getState().clearFilter(tableId)}
              >
                {t("comparison.status.clearFilter")}
              </button>
            </>
          )}
        </span>
        {filling ? (
          <span className="comparison-progress" role="status" data-testid="comparison-progress">
            {t("comparison.filling", { done: settled, total })}
            {editable && (
              <button
                type="button"
                data-testid="comparison-stop"
                className="comparison-action"
                onClick={() => stopComparisonTable(ref)}
              >
                {t("comparison.stop")}
              </button>
            )}
          </span>
        ) : (
          editable &&
          toFill > 0 && (
            <button
              type="button"
              data-testid="comparison-fill"
              className="comparison-action"
              onClick={() => void fillComparisonTable(ref)}
            >
              {t(toFill === 1 ? "comparison.fill.one" : "comparison.fill.other", { count: toFill })}
            </button>
          )
        )}
        {editable && proposal && (
          <span className="comparison-proposal">
            <button
              type="button"
              data-testid="comparison-accept-all"
              className="comparison-action comparison-action--accept"
              onClick={() => resolve("accept")}
            >
              {t("proposal.acceptAll")}
            </button>
            <button
              type="button"
              data-testid="comparison-reject-all"
              className="comparison-action"
              onClick={() => resolve("reject")}
            >
              {t("proposal.rejectAll")}
            </button>
          </span>
        )}
        <span className="comparison-head-end">
          {editable && <ComparisonTableMenu handle={handle} hidden={hidden} />}
          {addButton("head")}
          {expanded && (
            <button
              type="button"
              data-testid="comparison-export-excel"
              className="comparison-export"
              onClick={() => void exportComparison(mindId, tableId)}
            >
              <ExportLineIcon className="size-3.5" />
              {t("export.excel.button")}
            </button>
          )}
          {expanded ? (
            <button
              type="button"
              data-testid="comparison-back"
              className="comparison-back"
              onClick={() => expandComparisonTable(null)}
            >
              <CollapseIcon className="size-3.5" />
              {t("comparison.back")}
              <kbd>Esc</kbd>
            </button>
          ) : (
            <button
              type="button"
              data-testid="comparison-expand"
              className="comparison-expand"
              aria-label={t("comparison.expand")}
              title={t("comparison.expand")}
              onClick={() => expandComparisonTable(tableId)}
            >
              <ExpandIcon className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      {editable && addingDocuments && (
        <ComparisonAddDocuments
          handle={handle}
          anchor={head.current ?? wrapper.current ?? document.body}
          documentIds={rowDocuments}
          questions={questions.length}
          model={tableModel}
          onClose={() => useComparisonTables.getState().closeAddDocuments()}
        />
      )}{" "}
      {problem && (
        <div contentEditable={false} data-comparison-ui className="comparison-problem">
          {problem.reason === "not-ready" ? (
            <ReadinessLine
              readiness={problem.readiness}
              testId="comparison-not-ready"
              setUpLabel={t("question.setUp")}
            />
          ) : (
            <ProblemLine testId="comparison-not-sent">
              {t("answer.error.consent-declined")}
            </ProblemLine>
          )}
        </div>
      )}
      {!problem && !filling && stop && (
        <div contentEditable={false} data-comparison-ui className="comparison-problem">
          <ProblemLine
            testId="comparison-stopped"
            details={runStopParts(stop, t, language).slice(1)}
            action={
              stop.reason === "cost-cap"
                ? { label: t("answer.error.changeCap"), onClick: () => openSettings("general") }
                : undefined
            }
          >
            {runStopParts(stop, t, language)[0]}
          </ProblemLine>
        </div>
      )}
      <div className="comparison-frame">
        {/* biome-ignore lint/a11y/useSemanticElements: a grid whose rows step aside (display: contents), so its first column can stick; the editor draws its rows. */}
        <div
          className="comparison-scroll"
          role="table"
          aria-label={title}
          style={{ gridTemplateColumns } as React.CSSProperties}
        >
          {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: the table's heading row, as its grid needs it; nothing in it takes the focus but "+ Question"'s field. */}
          <div
            className="comparison-head-row"
            role="row"
            contentEditable={false}
            data-comparison-ui
          >
            {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a heading cell of the grid above, read with it. */}
            <div className="comparison-corner" role="columnheader">
              {t("comparison.document")}
            </div>
            {questions.map((question, index) => (
              <ComparisonColumnHeading
                key={question.id}
                editor={editor}
                mindId={mindId}
                tableId={tableId}
                question={question}
                count={columns.length}
                editable={editable}
                width={widthOf(question)}
                lastShown={question.id === lastShown}
                dragging={drag?.questionId === question.id}
                drop={dropOf(index)}
                onWidthPreview={(questionId, width) =>
                  setResizing(width === null ? null : { questionId, width })
                }
                onWidthCommit={(questionId, width) => void resizeColumn(handle, questionId, width)}
                onFit={fit}
                onDragStart={(questionId) => setDrag({ questionId, slot: null })}
                onDragOver={(slot) => setDrag((state) => (state ? { ...state, slot } : state))}
                onDragEnd={() => setDrag(null)}
                onMoveTo={moveTo}
              />
            ))}
            {adding && (
              // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: a heading cell of the table's grid; its field takes the focus.
              <div className="comparison-question comparison-question--new" role="columnheader">
                <ColumnQuestionField
                  testId="comparison-new-question"
                  onDone={addQuestion}
                  onCancel={() => setAdding(false)}
                />
              </div>
            )}
          </div>
          <NodeViewContent className="comparison-rows" />
        </div>
        {!expanded && addButton("side")}
      </div>
    </NodeViewWrapper>
  );
}
