import type { Editor } from "@tiptap/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ComparisonQuestion } from "../../../core/api";
import {
  comparisonLabelOf,
  MAX_COMPARISON_LABEL,
  MAX_COMPARISON_TEXT,
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
} from "../comparisonColumns";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { useT } from "../i18n";

/**
 * A comparison table's heading (DESIGN.md, Comparison table; #1833): the
 * column's label, its menu, and the field that edits the label and Question
 * or asks for a column being inserted. F2 edits it, Delete removes it, and
 * Enter and Esc end a field, also while a Chinese input method composes.
 */
export function ComparisonColumnHeading({
  editor,
  mindId,
  tableId,
  question,
  count,
  editable,
}: {
  editor: Editor;
  mindId: string;
  tableId: string;
  question: ComparisonQuestion;
  count: number;
  editable: boolean;
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editable || event.defaultPrevented) return;
    menu.rowProps.onKeyDown(event);
    // F2 and Delete belong to the heading itself, not to a field or the menu inside it.
    if (event.defaultPrevented || event.target !== heading.current) return;
    if (event.key === "F2") {
      event.preventDefault();
      startColumnEdit(handle, question.id);
      return;
    }
    if (event.key === "Delete" && count > 1) {
      event.preventDefault();
      removeColumn(handle, question.id);
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
      title={question.text}
      {...(showMenu && menu.rowProps)}
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
