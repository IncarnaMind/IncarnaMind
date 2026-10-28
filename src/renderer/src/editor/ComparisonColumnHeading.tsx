import type { Editor } from "@tiptap/core";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import type { ComparisonQuestion } from "../../../core/api";
import {
  comparisonLabelOf,
  MAX_COMPARISON_COLUMN_WIDTH,
  MAX_COMPARISON_LABEL,
  MAX_COMPARISON_TEXT,
  MIN_COMPARISON_COLUMN_WIDTH,
} from "../../../shared/comparisons";
import {
  type ComparisonColumnHandle,
  comparisonColumnHandles,
  useComparisonColumns,
} from "../comparisonColumnState";
import {
  closeColumnField,
  removeColumn,
  saveColumnEdit,
  saveColumnInsert,
  startColumnEdit,
  stepColumn,
} from "../comparisonColumns";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useT } from "../i18n";

/** Where a heading dropped, among the columns the table shows: before that one, or after the last. */
export type ColumnDrop = "before" | "after" | null;

const MOVE_DRAG_PX = 4;
const WIDTH_STEP_PX = 16;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const clampedWidth = (width: number) =>
  Math.min(MAX_COMPARISON_COLUMN_WIDTH, Math.max(MIN_COMPARISON_COLUMN_WIDTH, Math.round(width)));

/**
 * A comparison table's heading (DESIGN.md, Comparison table; #1833): the
 * column's label, its menu, the edge that resizes it, and the field that
 * edits the label and Question or asks for a column being inserted. F2 edits
 * it, Delete removes it, ⌥⇧← and ⌥⇧→ move it, and dragging it moves it
 * where it is dropped. Enter and Esc end a field, also while a Chinese input
 * method composes.
 */
export function ComparisonColumnHeading({
  editor,
  mindId,
  tableId,
  question,
  count,
  editable,
  width,
  dragging = false,
  drop = null,
  onWidthPreview,
  onWidthCommit,
  onFit,
  onDragStart,
  onDragOver,
  onDragEnd,
  onMoveTo,
}: {
  editor: Editor;
  mindId: string;
  tableId: string;
  question: ComparisonQuestion;
  count: number;
  editable: boolean;
  /** Its width in pixels when the User sized it; absent: the table's own width. */
  width?: number;
  dragging?: boolean;
  drop?: ColumnDrop;
  onWidthPreview?(questionId: string, width: number | null): void;
  onWidthCommit?(questionId: string, width: number): void;
  onFit?(questionId: string): void;
  onDragStart?(questionId: string): void;
  onDragOver?(slot: number | null): void;
  onDragEnd?(): void;
  /** Where the column lands among the columns the table shows, hidden ones passed over. */
  onMoveTo?(questionId: string, slot: number): void;
}) {
  const t = useT();
  const heading = useRef<HTMLDivElement>(null);
  const field = useComparisonColumns((state) => state.field);
  const focus = useComparisonColumns((state) => state.focus);
  const menu = useObjectMenu({ kind: "comparisonColumn", id: question.id });
  const handle: ComparisonColumnHandle = { editor, mindId, tableId };
  const open = editable ? field : null;
  const editing =
    open?.mode === "edit" && open.tableId === tableId && open.questionId === question.id;
  const inserting =
    open?.mode === "insert" && open.tableId === tableId && open.questionId === question.id;
  const label = comparisonLabelOf(question);

  useEffect(() => {
    const entry = { editor, mindId, tableId };
    comparisonColumnHandles.set(question.id, entry);
    return () => {
      if (comparisonColumnHandles.get(question.id) === entry) {
        comparisonColumnHandles.delete(question.id);
      }
    };
  }, [question.id, editor, mindId, tableId]);

  useEffect(() => {
    if (focus?.tableId !== tableId || focus.questionId !== question.id) return;
    heading.current?.focus();
    useComparisonColumns.getState().clearFocus(tableId, question.id);
  }, [focus, tableId, question.id]);

  /** The headings the table shows, in the order it shows them. */
  const headingsShown = (): HTMLElement[] => {
    const table = heading.current?.closest(".comparison-table");
    return Array.from(
      table?.querySelectorAll<HTMLElement>(
        ".comparison-head-row .comparison-question[data-question-id]",
      ) ?? [],
    ).filter((each) => each.getClientRects().length > 0);
  };

  const beginMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!editable || event.button !== 0) return;
    const target = event.target as Element;
    if (
      target.closest(
        "[data-object-menu], input, [data-comparison-field], .comparison-column-resize",
      )
    ) {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let slot: number | null = null;
    const onMove = (move: globalThis.PointerEvent) => {
      if (!active) {
        if (Math.hypot(move.clientX - startX, move.clientY - startY) < MOVE_DRAG_PX) return;
        active = true;
        document.documentElement.dataset.comparisonColumnDrag = "true";
        onDragStart?.(question.id);
      }
      const shown = headingsShown();
      let at = shown.length;
      for (const [index, each] of shown.entries()) {
        const box = each.getBoundingClientRect();
        if (move.clientX < box.left + box.width / 2) {
          at = index;
          break;
        }
      }
      slot = at;
      onDragOver?.(at);
    };
    const remove = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
    };
    const onUp = () => {
      remove();
      if (!active) return;
      delete document.documentElement.dataset.comparisonColumnDrag;
      onDragEnd?.();
      const own = headingsShown().indexOf(heading.current as HTMLElement);
      if (slot === null || own < 0) return;
      const landed = slot > own ? slot - 1 : slot;
      if (landed !== own) onMoveTo?.(question.id, landed);
    };
    const cancel = () => {
      remove();
      if (!active) return;
      delete document.documentElement.dataset.comparisonColumnDrag;
      onDragEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
  };

  const beginResize = (event: PointerEvent<HTMLSpanElement>) => {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    const column = heading.current;
    if (!column) return;
    const startX = event.clientX;
    const startWidth = column.getBoundingClientRect().width;
    let width = startWidth;
    const onMove = (move: globalThis.PointerEvent) => {
      width = clampedWidth(startWidth + move.clientX - startX);
      onWidthPreview?.(question.id, width);
    };
    const remove = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
    };
    const onUp = () => {
      remove();
      delete document.documentElement.dataset.comparisonColumnDrag;
      onWidthPreview?.(question.id, null);
      if (Math.round(width) !== Math.round(startWidth)) onWidthCommit?.(question.id, width);
    };
    const cancel = () => {
      remove();
      delete document.documentElement.dataset.comparisonColumnDrag;
      onWidthPreview?.(question.id, null);
    };
    document.documentElement.dataset.comparisonColumnDrag = "true";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
  };

  const onResizeKeys = (event: KeyboardEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (!editable) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onFit?.(question.id);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current =
      question.width ??
      heading.current?.getBoundingClientRect().width ??
      MIN_COMPARISON_COLUMN_WIDTH;
    const step = event.shiftKey ? WIDTH_STEP_PX * 4 : WIDTH_STEP_PX;
    onWidthCommit?.(
      question.id,
      clampedWidth(current + (event.key === "ArrowRight" ? step : -step)),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editable || event.defaultPrevented) return;
    menu.rowProps.onKeyDown(event);
    // F2, Delete and the move keys belong to the heading itself, not to a field or the menu inside it.
    if (event.defaultPrevented || event.target !== heading.current) return;
    if (event.key === "F2") {
      event.preventDefault();
      startColumnEdit(handle, question.id);
      return;
    }
    if (event.key === "Delete" && count > 1) {
      event.preventDefault();
      removeColumn(handle, question.id);
      return;
    }
    const moving = isMac ? event.altKey : event.ctrlKey;
    if (moving && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      stepColumn(handle, question.id, event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  const showMenu = editable && !editing && !inserting;
  const close = () => {
    closeColumnField();
    useComparisonColumns.getState().focusColumn(tableId, question.id);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a heading cell of the table's grid, focusable for F2 and Delete.
    <div
      ref={heading}
      className="comparison-question"
      role="columnheader"
      tabIndex={editable ? 0 : undefined}
      data-testid="comparison-question"
      data-question-id={question.id}
      data-dragging={dragging || undefined}
      data-drop={drop ?? undefined}
      title={question.text}
      {...(showMenu && menu.rowProps)}
      onPointerDown={beginMove}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => {
        if (!editable || (event.target as Element).closest("[data-object-menu]")) return;
        event.preventDefault();
        startColumnEdit(handle, question.id);
      }}
    >
      {inserting ? (
        <ColumnQuestionField
          testId="comparison-insert-question"
          onDone={(text) => saveColumnInsert(handle, question.id, open.side, text)}
          onCancel={close}
        />
      ) : editing ? (
        <ColumnFields
          question={question}
          onDone={(next) => saveColumnEdit(handle, question.id, next)}
          onCancel={close}
        />
      ) : (
        <>
          <span className="comparison-question-label">{label}</span>
          {showMenu && (
            <ObjectMenu
              target={{ kind: "comparisonColumn", id: question.id }}
              label={t("comparison.column.more", { label })}
              tabIndex={-1}
              className="comparison-question-menu"
            />
          )}
        </>
      )}
      {editable && (
        // biome-ignore lint/a11y/useSemanticElements: a resize grip at the column's edge, focusable for its own keys.
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={t("comparison.column.resize")}
          aria-valuemin={MIN_COMPARISON_COLUMN_WIDTH}
          aria-valuemax={MAX_COMPARISON_COLUMN_WIDTH}
          aria-valuenow={Math.round(width ?? MIN_COMPARISON_COLUMN_WIDTH)}
          title={t("comparison.column.resize")}
          tabIndex={0}
          className="comparison-column-resize"
          data-testid="comparison-column-resize"
          onPointerDown={beginResize}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onFit?.(question.id);
          }}
          onKeyDown={onResizeKeys}
        />
      )}
    </div>
  );
}

function ColumnFields({
  question,
  onDone,
  onCancel,
}: {
  question: ComparisonQuestion;
  onDone(change: { text: string; label: string }): void;
  onCancel(): void;
}) {
  const t = useT();
  const [label, setLabel] = useState(() => comparisonLabelOf(question));
  const [text, setText] = useState(question.text);
  const [labelTouched, setLabelTouched] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  const save = () => {
    // A heading that only followed its Question keeps following it.
    const own = question.label !== undefined || labelTouched;
    onDone({ text, label: own ? label : "" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <div className="comparison-question-fields" data-comparison-field="">
      <input
        ref={first}
        data-testid="comparison-edit-label"
        aria-label={t("comparison.column.labelField")}
        placeholder={t("comparison.column.labelPlaceholder")}
        maxLength={MAX_COMPARISON_LABEL}
        value={label}
        onChange={(event) => {
          setLabelTouched(true);
          setLabel(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <input
        data-testid="comparison-edit-question"
        aria-label={t("comparison.column.questionField")}
        placeholder={t("comparison.addQuestion.placeholder")}
        maxLength={MAX_COMPARISON_TEXT}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** The in-place field for a column that doesn't exist yet: Enter adds it, Esc or leaving it empty doesn't. */
export function ColumnQuestionField({
  testId,
  onDone,
  onCancel,
}: {
  testId: string;
  onDone(text: string): void;
  onCancel(): void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  /** Enter, Esc or leaving the field ends it, once. */
  const ended = useRef(false);
  useEffect(() => field.current?.focus(), []);
  const end = (add: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (add && text.trim()) onDone(text);
    else onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      end(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      end(false);
    }
  };
  return (
    <div className="comparison-question-new" data-comparison-field="">
      <input
        ref={field}
        data-testid={testId}
        aria-label={t("comparison.addQuestion.label")}
        placeholder={t("comparison.addQuestion.placeholder")}
        maxLength={MAX_COMPARISON_TEXT}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => end(true)}
      />
    </div>
  );
}
