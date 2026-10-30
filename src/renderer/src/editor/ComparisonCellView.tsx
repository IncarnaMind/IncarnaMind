import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { COMPARISON_TABLE_NODE } from "../../../core/api";
import { cellProblemMessage, comparisonCellOf } from "../../../shared/comparisons";
import {
  type ComparisonCellHandle,
  comparisonCellHandles,
  comparisonCellKey,
  comparisonCellRef,
} from "../comparisonCellHandle";
import { useComparisonCells } from "../comparisonCellState";
import {
  comparisonCellLocation,
  comparisonCellsSelected,
  comparisonCellText,
  copyComparisonCells,
  editComparisonCell,
  invalidateComparisonCellEdit,
  startComparisonCellEdit,
} from "../comparisonCells";
import { staleAnswerKey, useComparisonColumns } from "../comparisonColumnState";
import {
  comparisonCellAt,
  comparisonCellFilters,
  comparisonCellFirst,
  comparisonCellNext,
  comparisonCellsSelectable,
} from "../comparisonSelection";
import { useComparisons } from "../comparisons";
import { type RowProblem, useComparisonTables } from "../comparisonTableState";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useLanguage, useT } from "../i18n";
import { ComparisonCellCard } from "./ComparisonCellCard";
import { ComparisonRefillEstimate } from "./ComparisonRefillEstimate";
import { useMindId } from "./mindContext";
import { signOffWords } from "./SignOff";
import { useComparisonCellSignOff } from "./signOffActions";

let openCardTimer: number | undefined;
const EMPTY_PROBLEMS: ReadonlySet<RowProblem> = new Set();

function CellEditor({ handle, first }: { handle: ComparisonCellHandle; first?: string }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const location = comparisonCellLocation(handle);
  const initial = first ?? (location ? comparisonCellText(location.cell) : "");
  const [value, setValue] = useState(initial);
  useEffect(() => {
    input.current?.focus();
    if (first === undefined) input.current?.select();
    else input.current?.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [first]);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) void editComparisonCell(handle, value);
    else {
      invalidateComparisonCellEdit(handle);
      useComparisonCells.getState().finishEdit();
      requestAnimationFrame(() => handle.anchor.focus());
    }
  };
  return (
    <input
      ref={input}
      className="comparison-cell-input"
      data-testid="comparison-cell-input"
      data-comparison-ui=""
      aria-label={t("comparison.cell.edit")}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={(event) => {
        const field = event.currentTarget;
        if (event.relatedTarget === field.parentElement) {
          requestAnimationFrame(() => field.focus());
        } else {
          finish(true);
        }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

function ComparisonCell({ node, editor, getPos }: ReactNodeViewProps) {
  const t = useT();
  const language = useLanguage();
  const mindId = useMindId();
  const anchor = useRef<HTMLDivElement>(null);
  const pos = getPos();
  let tableId = "";
  let documentId = "";
  if (typeof pos === "number") {
    const at = editor.state.doc.resolve(pos);
    for (let depth = at.depth; depth > 0; depth--) {
      const ancestor = at.node(depth);
      if (!documentId && ancestor.type.name === "comparisonRow") {
        documentId = String(ancestor.attrs.documentId ?? "");
      }
      if (!tableId && ancestor.type.name === COMPARISON_TABLE_NODE) {
        tableId = String(ancestor.attrs.id ?? "");
      }
    }
  }
  const questionId = String(node.attrs.questionId ?? "");
  const key = comparisonCellKey(tableId, documentId, questionId);
  const target = { kind: "comparisonCell", id: key } as const;
  const menu = useObjectMenu(target);
  const signOff = useComparisonCellSignOff(tableId, documentId, questionId, node);
  const cell = { ...comparisonCellOf(node.attrs), reviewed: signOff?.state === "checked" };
  const filling = useComparisons((state) => state.filling.has(tableId));
  const problemFilters = useComparisonTables(
    (state) => state.filters.get(tableId) ?? EMPTY_PROBLEMS,
  );
  const filters = comparisonCellFilters(problemFilters);
  const current = useComparisonCells(
    (state) =>
      state.current?.tableId === tableId &&
      state.current.documentId === documentId &&
      state.current.questionId === questionId,
  );
  const selected = useComparisonCells(
    (state) =>
      state.selected[tableId]?.cells.some(
        (each) => each.documentId === documentId && each.questionId === questionId,
      ) === true,
  );
  const card = useComparisonCells((state) => state.card);
  const editing = useComparisonCells((state) => state.editing);
  const checking = useComparisonCells((state) => state.checking[key] === true);
  const checkProblem = useComparisonCells((state) => state.checkProblems[key]);
  const stale = useComparisonColumns(
    (state) => state.stale[staleAnswerKey(tableId, documentId, questionId)],
  );
  const isCard =
    card?.tableId === tableId && card.documentId === documentId && card.questionId === questionId;
  const isEditing =
    editing?.tableId === tableId &&
    editing.documentId === documentId &&
    editing.questionId === questionId;
  const handle: ComparisonCellHandle = {
    editor,
    mindId,
    tableId,
    documentId,
    questionId,
    get anchor() {
      const element = anchor.current;
      if (!element) throw new Error("The comparison cell isn't mounted.");
      return element;
    },
  };
  const currentRef = useComparisonCells((state) => state.current);
  const hasVisibleCurrent =
    currentRef?.tableId === tableId &&
    comparisonCellsSelectable(handle, filters).some(
      (cell) =>
        cell.documentId === currentRef.documentId && cell.questionId === currentRef.questionId,
    );
  const first = hasVisibleCurrent ? null : comparisonCellFirst(handle, filters);
  const isEntry =
    first !== null && first.documentId === documentId && first.questionId === questionId;

  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const entry = { editor, mindId, tableId, documentId, questionId, anchor: element };
    comparisonCellHandles.set(key, entry);
    return () => {
      if (comparisonCellHandles.get(key) === entry) comparisonCellHandles.delete(key);
      window.clearTimeout(openCardTimer);
    };
  }, [editor, mindId, tableId, documentId, questionId, key]);

  const withHandle = (run: (handle: ComparisonCellHandle) => void) => run(handle);
  const select = (mode: "single" | "range" | "toggle") =>
    withHandle((here) => {
      useComparisonCells.getState().select(here, mode);
    });
  const openCard = () => {
    window.clearTimeout(openCardTimer);
    withHandle((here) => useComparisonCells.getState().openCard(comparisonCellRef(here)));
  };
  const moveTo = (next: { documentId: string; questionId: string } | null, range: boolean) => {
    if (!next) return;
    const element = comparisonCellHandles.get(
      comparisonCellKey(tableId, next.documentId, next.questionId),
    );
    if (element) useComparisonCells.getState().select(element, range ? "range" : "single");
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isEditing || (event.target as Element).closest("button, a, input, textarea")) return;
    if (event.shiftKey) return;
    const mode = event.metaKey || event.ctrlKey ? "toggle" : "single";
    window.clearTimeout(openCardTimer);
    select(mode);
    if (mode !== "single" || event.detail !== 1) return;
    openCardTimer = window.setTimeout(() => {
      if (anchor.current) openCard();
    }, 160);
  };
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!event.shiftKey || event.button !== 0) return;
    if ((event.target as Element).closest("button, a, input, textarea")) return;
    // Select in capture before ProseMirror can turn Shift-click into a text selection.
    event.preventDefault();
    window.clearTimeout(openCardTimer);
    select("range");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    menu.rowProps.onKeyDown(event);
    if (
      event.defaultPrevented ||
      event.target !== anchor.current ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    const here = handle;
    if (event.key === "Shift") {
      window.clearTimeout(openCardTimer);
      return;
    }
    const done = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "a") {
      done();
      useComparisonCells.getState().selectAll(here);
      return;
    }
    if (mod && event.key.toLowerCase() === "c") {
      done();
      void copyComparisonCells(here, false);
      return;
    }
    if (event.key === "Enter") {
      done();
      openCard();
      return;
    }
    if (event.key === "F2") {
      done();
      startComparisonCellEdit(here);
      return;
    }
    if (event.key === "Escape") {
      window.clearTimeout(openCardTimer);
      if (isCard || selected) {
        done();
        if (isCard) useComparisonCells.getState().closeCard();
        else useComparisonCells.getState().clearSelection(tableId);
      }
      return;
    }
    if (event.key === "Tab") {
      const next = comparisonCellNext(here, event.shiftKey);
      if (next) {
        done();
        moveTo(next, false);
      }
      return;
    }
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
      !mod &&
      !event.altKey
    ) {
      done();
      const direction =
        event.key === "ArrowLeft"
          ? "left"
          : event.key === "ArrowRight"
            ? "right"
            : event.key === "ArrowUp"
              ? "up"
              : "down";
      moveTo(comparisonCellAt(here, direction), event.shiftKey);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      const cells = comparisonCellsSelectable(here, filters);
      const questions = new Set(cells.map((each) => each.questionId));
      const columns = questions.size;
      const at = cells.findIndex(
        (each) => each.documentId === documentId && each.questionId === questionId,
      );
      if (at >= 0 && columns > 0) {
        done();
        const row = Math.floor(at / columns);
        const next = mod
          ? event.key === "Home"
            ? cells[0]
            : cells.at(-1)
          : cells[row * columns + (event.key === "Home" ? 0 : columns - 1)];
        moveTo(next ?? null, event.shiftKey);
      }
      return;
    }
    if (!isEditing && event.key.length === 1 && !mod && !event.altKey && editor.isEditable) {
      done();
      startComparisonCellEdit(here, event.key);
    }
  };

  const hasWords = node.content.size > 2;
  const showStale =
    !isEditing &&
    stale !== undefined &&
    !hasWords &&
    (cell.status === "waiting" || cell.status === "writing");
  const problem = cell.problem ? cellProblemMessage(cell.problem, cell.message) : null;
  return (
    <NodeViewWrapper
      ref={anchor}
      className="comparison-cell"
      role="cell"
      contentEditable={false}
      tabIndex={current || isEntry ? 0 : -1}
      data-testid="comparison-cell"
      data-comparison-ui=""
      data-status={cell.status}
      data-question-id={cell.questionId}
      data-problem={cell.problem ?? undefined}
      data-selected={selected || undefined}
      data-stale={showStale || undefined}
      data-streaming={(cell.status === "writing" && hasWords) || undefined}
      aria-selected={selected}
      aria-busy={cell.status === "writing" || undefined}
      {...menu.rowProps}
      onMouseDownCapture={onMouseDown}
      onClick={onClick}
      onDoubleClick={(event: MouseEvent<HTMLDivElement>) => {
        if (isEditing || (event.target as Element).closest("button, input, textarea")) return;
        window.clearTimeout(openCardTimer);
        withHandle((here) => startComparisonCellEdit(here));
      }}
      onKeyDown={onKeyDown}
    >
      <NodeViewContent
        className="comparison-cell-content"
        contentEditable={false}
        hidden={isEditing}
      />
      {isEditing && <CellEditor handle={handle} first={editing.first} />}
      {showStale && (
        <div className="comparison-cell-stale" contentEditable={false}>
          {stale}
        </div>
      )}
      {!isEditing && cell.status === "waiting" && (
        <span
          className={filling ? "comparison-cell-running" : "comparison-cell-stopped"}
          contentEditable={false}
        >
          {filling ? t("comparison.cell.waitingText") : t("comparison.cell.stopped")}
        </span>
      )}
      {cell.status === "writing" && !hasWords && (
        <span className="comparison-cell-reading" contentEditable={false}>
          {t("comparison.cell.readingText")}
        </span>
      )}
      {!isEditing && cell.status === "failed" && (
        <span
          className="comparison-cell-problem"
          data-testid="comparison-cell-problem"
          title={cell.message ?? ""}
          contentEditable={false}
        >
          <span className="comparison-cell-mark" aria-hidden="true">
            !
          </span>
          <span>{problem ? t(problem.key, problem.params) : t("comparison.cell.failed")}</span>
        </span>
      )}
      {checking && (
        <span className="comparison-cell-checking" contentEditable={false}>
          {t("comparison.cell.checking")}
        </span>
      )}
      {checkProblem && (
        <button
          type="button"
          className="comparison-cell-check-warning"
          title={checkProblem.message}
          onClick={openCard}
        >
          !
        </button>
      )}
      {!isEditing && cell.status === "done" && (cell.edited || cell.reviewed) && (
        <span className="comparison-cell-flags" contentEditable={false}>
          {cell.edited && (
            <span
              role="img"
              title={t("comparison.cell.edited")}
              aria-label={t("comparison.cell.edited")}
            >
              ✎
            </span>
          )}
          {cell.reviewed && signOff && (
            <span
              role="img"
              title={signOffWords(signOff, t, language)}
              aria-label={signOffWords(signOff, t, language)}
            >
              ✓
            </span>
          )}
        </span>
      )}
      {editor.isEditable && (
        <ObjectMenu
          target={target}
          label={t("comparison.cell.more")}
          tabIndex={-1}
          className="comparison-cell-menu"
          foot={
            <ComparisonRefillEstimate
              handle={handle}
              mode="refill"
              requested={comparisonCellsSelected(handle)}
            />
          }
        />
      )}
      {isCard && <ComparisonCellCard handle={handle} replace={card.replace === true} />}
    </NodeViewWrapper>
  );
}

export const comparisonCellView = ReactNodeViewRenderer(ComparisonCell);
