import type { Editor } from "@tiptap/core";
import type { ReactNode, Ref } from "react";
import { addFoundCitations } from "../checks";
import { useLanguage, useT } from "../i18n";
import { offerEditorUndo } from "./editorUndo";
import { NotYetCitedIcon } from "./icons";

/**
 * The check card's row of sentences Supported, not yet cited (#3019), with its action on it: Add
 * all, or Add for one, makes each Passage its part's Citation, as one Undo, and Next moves to the
 * next such sentence as the other rows do. Add changes the Note's text and nothing else: no viewer
 * opens, and the caret and the scroll stay where they are.
 */
export function NotYetCitedRow({
  editor,
  count,
  label,
  testId,
  rowRef,
  onNext,
  children,
}: {
  editor: Editor;
  count: number;
  /** What Next says to a screen reader. */
  label: string;
  testId: string;
  rowRef?: Ref<HTMLDivElement>;
  onNext(): void;
  /** The row's words. */
  children: ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  // A button can't hold another: Next lies under the whole row and Add sits over it.
  return (
    <div
      ref={rowRef}
      data-testid={testId}
      data-count={count}
      data-part="notYetCited"
      className="check-row check-row--action"
    >
      <button
        type="button"
        className="check-row-go"
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onNext}
      />
      <span className="check-row-mark">
        <NotYetCitedIcon className="mind-health-icon" />
      </span>
      <span className="check-row-text">{children}</span>
      <button
        type="button"
        data-testid="found-passages-add"
        className="check-row-action citation-card-action"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const added = addFoundCitations(editor);
          if (added === 0) return;
          const many = new Intl.NumberFormat(language).format(added);
          offerEditorUndo(editor, (say) =>
            say(added === 1 ? "found.added.one" : "found.added", { count: many }),
          );
        }}
      >
        {t(count === 1 ? "found.add" : "found.addAll")}
      </button>
      <span className="check-row-next" aria-hidden="true">
        {t("badge.next")}
      </span>
    </div>
  );
}
