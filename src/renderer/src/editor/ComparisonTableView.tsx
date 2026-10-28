import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComparisonQuestion, RunStop } from "../../../core/api";
import {
  cellStop,
  cellToFill,
  comparisonCellOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_QUESTIONS,
  visibleComparisonQuestions,
} from "../../../shared/comparisons";
import { mindName } from "../../../shared/naming";
import { readProposalAttribute } from "../../../shared/proposals";
import { moveColumn, resizeColumn, showColumn } from "../comparisonColumns";
import { fittedColumnWidth } from "../comparisonColumnWidth";
import {
  expandComparisonTable,
  fillComparisonTable,
  loadFillingComparisons,
  stopComparisonTable,
  useComparisons,
} from "../comparisons";
import { ExportLineIcon, PlusLineIcon } from "../components/lineIcons";
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
import { ComparisonHiddenColumnsMenu } from "./ComparisonHiddenColumnsMenu";
import { addComparisonColumn } from "./comparisonCommands";
import { CollapseIcon, ExpandIcon, TableIcon } from "./icons";
import { useMindId } from "./mindContext";

/**
 * How the table places its cells: every heading and cell has its column from
 * the Question it belongs to and every row its line, so a moved column is
 * drawn where the Questions put it without touching a cell. A hidden column's
 * cells stay in the document, unshown, and the last column shown keeps the
 * grid's outer edge.
 */
function comparisonGridCss(
  tableId: string,
  columns: readonly ComparisonQuestion[],
  rows: number,
  adding: boolean,
): string {
  const table = `.comparison-table[data-comparison-table="${CSS.escape(tableId)}"]`;
  const rules = [`${table} .comparison-head-row > .comparison-corner{grid-row:1;grid-column:1}`];
  const selectorOf = (question: (typeof columns)[number]) =>
    `[data-question-id="${CSS.escape(question.id)}"]`;
  let shown = 0;
  for (const column of columns) {
    if (column.hidden === true) {
      rules.push(
        `${table} .comparison-row-cells > .comparison-cell${selectorOf(column)}{display:none}`,
      );
      continue;
    }
    shown++;
    rules.push(
      `${table} .comparison-head-row > .comparison-question${selectorOf(column)}{grid-row:1;grid-column:${shown + 1}}`,
      `${table} .comparison-row-cells > .comparison-cell${selectorOf(column)}{grid-column:${shown + 1}}`,
    );
  }
  for (let row = 1; row <= rows; row++) {
    rules.push(
      `${table} .comparison-row:nth-child(${row}) > .comparison-document{grid-row:${row + 1};grid-column:1}`,
      `${table} .comparison-row:nth-child(${row}) > .comparison-row-cells > .comparison-cell{grid-row:${row + 1}}`,
    );
  }
  if (adding) {
    rules.push(
      `${table} .comparison-head-row > .comparison-question--new{grid-row:1;grid-column:${shown + 2}}`,
    );
  }
  const lastShown = columns.reduce((last, column, at) => (column.hidden ? last : at), -1);
  const lastColumn = lastShown >= 0 ? columns[lastShown] : undefined;
  if (lastColumn) {
    rules.push(
      `${table} .comparison-head-row > .comparison-question${selectorOf(lastColumn)}{border-right:0}`,
      `${table} .comparison-row-cells > .comparison-cell${selectorOf(lastColumn)}{border-right:0}`,
    );
  } else {
    rules.push(
      `${table} .comparison-head-row > .comparison-corner{border-right:0}`,
      `${table} .comparison-document{border-right:0}`,
    );
  }
  return rules.join("\n");
}

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
  const mindTitle = useAppStore((state) => {
    const mind = state.minds.find((each) => each.id === mindId);
    return mind ? mindName(mind) : "";
  });
  const wrapper = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [resizing, setResizing] = useState<{ questionId: string; width: number } | null>(null);
  const [drag, setDrag] = useState<{ questionId: string; slot: number | null } | null>(null);
  const hiddenIds = new Set(hidden.map((column) => column.id));
  const { total, settled, toFill, stop } = cellCounts(node, hiddenIds);
  const language = useLanguage();
  const openSettings = useAppStore((state) => state.openSettings);
  const editable = editor.isEditable;
  const ref = { mindId, tableId };
  const handle = { editor, mindId, tableId };

  useExpandInPlace(wrapper, expanded, () => expandComparisonTable(null));
  useEffect(loadFillingComparisons, []);

  const title = [
    t("comparison.title"),
    `${t(node.childCount === 1 ? "comparison.documents.one" : "comparison.documents.other", { count: node.childCount })} × ${t(questions.length === 1 ? "comparison.questions.one" : "comparison.questions.other", { count: questions.length })}`,
  ].join(" · ");

  const resolve = (outcome: "accept" | "reject") => {
    if (proposal) resolveProposalsIn(editor, mindId, [proposal.id], outcome);
  };

  const addQuestion = (text: string) => {
    setAdding(false);
    const id = addComparisonColumn(editor, tableId, text);
    if (id) void fillComparisonTable({ ...ref, questionIds: [id] });
  };

  const moveTo = (questionId: string, slot: number) => {
    const landing = questions[slot];
    const to = landing
      ? columns.findIndex((column) => column.id === landing.id)
      : columns.length - 1;
    if (to >= 0) moveColumn(handle, questionId, to);
  };

  const fit = (questionId: string) => {
    const table = wrapper.current;
    const width = table ? fittedColumnWidth(table, questionId) : null;
    if (width !== null) resizeColumn(handle, questionId, width);
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
      className="comparison-table"
    >
      <style>{comparisonGridCss(tableId, columns, node.childCount, adding)}</style>
      <div contentEditable={false} data-comparison-ui className="comparison-head">
        {expanded && <TableIcon className="size-4 shrink-0 text-ink-meta" />}
        <span data-testid="comparison-title" className="comparison-title" title={title}>
          {expanded ? (
            <>
              <strong>{t("comparison.title")}</strong>
              {mindTitle ? ` · ${mindTitle}` : ""}
            </>
          ) : (
            title
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
          {editable && hidden.length > 0 && (
            <ComparisonHiddenColumnsMenu
              hidden={hidden}
              onShow={(questionId) => showColumn(handle, questionId)}
            />
          )}
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
          style={
            {
              "--comparison-columns": questions.length + (adding ? 1 : 0),
              gridTemplateColumns,
            } as React.CSSProperties
          }
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
                dragging={drag?.questionId === question.id}
                drop={dropOf(index)}
                onWidthPreview={(questionId, width) =>
                  setResizing(width === null ? null : { questionId, width })
                }
                onWidthCommit={(questionId, width) => resizeColumn(handle, questionId, width)}
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
