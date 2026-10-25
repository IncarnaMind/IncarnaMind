import type { Editor } from "@tiptap/core";
import type { FocusEvent, KeyboardEvent, RefObject } from "react";
import { ChatLineIcon } from "../components/lineIcons";
import { ProblemLine } from "../components/ProblemLine";
import { stopEdit, useEdits } from "../editWithAi";
import { useT } from "../i18n";
import { isComposing } from "./composing";
import { EditProblemLine } from "./EditStatus";
import { holdSelection } from "./heldSelection";
import type { EditWithAiField, useEditField } from "./useEditField";

type Field = ReturnType<typeof useEditField>;

const CARET_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export function EditField({
  editor,
  edit,
  field,
  keys,
  onLeave,
  onHandOff,
}: {
  editor: Editor;
  edit: EditWithAiField;
  field: Field;
  keys: string;
  onLeave(event: FocusEvent<HTMLInputElement>): void;
  onHandOff(): void;
}) {
  const t = useT();
  const problem = useEdits((state) => state.problems[edit.mindId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    if (CARET_KEYS.has(event.key)) {
      // These move the caret here; the menu would move to another row.
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      field.send();
    }
  };

  return (
    <div className="selection-edit-foot">
      <div className="selection-edit">
        <input
          ref={field.input}
          type="text"
          data-menu-field=""
          data-testid="selection-edit-field"
          aria-label={t("editor.ai.edit")}
          placeholder={t("editor.ai.edit")}
          value={field.text}
          spellCheck={false}
          onChange={(event) => field.setText(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => holdSelection(editor, true, "edit-field")}
          onBlur={(event) => {
            holdSelection(editor, false, "edit-field");
            onLeave(event);
          }}
          className="selection-edit-input"
        />
        {field.text === "" && (
          <span aria-hidden="true" className="editor-menu-shortcut">
            {keys}
          </span>
        )}
        {edit.handOff && (
          <button
            type="button"
            role="menuitem"
            data-testid="selection-edit-handoff"
            aria-label={t("editor.edit.handOff")}
            title={t("editor.edit.handOff.tip")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onHandOff}
            className="selection-edit-handoff"
          >
            <ChatLineIcon className="size-4" />
          </button>
        )}
      </div>
      {field.phase === "settled" && problem && (
        <EditProblemLine
          mindId={edit.mindId}
          problem={problem}
          className="selection-problem"
          onRetry={field.asked}
        />
      )}
    </div>
  );
}

export function EditWorking({
  mindId,
  pill,
  onLeave,
}: {
  mindId: string;
  pill: RefObject<HTMLDivElement | null>;
  onLeave(event: FocusEvent<HTMLElement>): void;
}) {
  const t = useT();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") stopEdit(mindId);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it holds the cursor while the AI works, so Enter does nothing and Esc stops it.
    <div
      ref={pill}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onLeave}
      onMouseDown={(event) => event.preventDefault()}
      className="editor-menu selection-working"
    >
      <ProblemLine
        role="status"
        testId="selection-edit-working"
        action={{
          label: t("edit.stop"),
          testId: "selection-edit-stop",
          onClick: () => stopEdit(mindId),
        }}
      >
        <span className="edit-pending-dot" aria-hidden="true" />
        {t("edit.pending.instruction")}
      </ProblemLine>
    </div>
  );
}
