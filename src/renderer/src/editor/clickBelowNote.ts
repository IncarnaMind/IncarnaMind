import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { type RefObject, useEffect } from "react";
import { asOneStep } from "./editorUndo";
import { shownEnd } from "./noteTabs";

/** What a click can land on in the Mind's page without hitting any content. */
const EMPTY_SPACE = ".mind-scroller, .mind-column, .mind-measure, .mind-editor-frame";

/**
 * The cursor goes to the end of the Mind, or of the tab shown (#3414): in its last paragraph, or,
 * when it ends in another Block (a table, a Question, an Answer), on a new empty paragraph under
 * it that is one step of Undo.
 */
export function cursorAtEndOfMind(editor: Editor): void {
  const { view } = editor;
  const { doc } = view.state;
  const end = shownEnd(view.state);
  if (doc.resolve(end).nodeBefore?.type.name === "paragraph") {
    const last = Selection.findFrom(doc.resolve(end), -1, true);
    if (last) view.dispatch(view.state.tr.setSelection(last));
  } else {
    const paragraph = view.state.schema.nodes.paragraph?.createAndFill();
    if (!paragraph) return;
    asOneStep(editor, () => {
      const tr = view.state.tr.insert(end, paragraph);
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)));
    });
  }
  view.focus();
  view.dispatch(view.state.tr.scrollIntoView());
}

function inEmptySpaceBelowNote(editor: Editor, scroller: HTMLElement, event: MouseEvent) {
  const { target } = event;
  if (!(target instanceof Element)) return false;
  if (target !== editor.view.dom && !target.matches(EMPTY_SPACE)) return false;
  // A press on the scroller's own scrollbar is for scrolling.
  const area = scroller.getBoundingClientRect();
  if (event.clientX >= area.left + scroller.clientWidth) return false;
  if (event.clientY >= area.top + scroller.clientHeight) return false;
  const { doc } = editor.state;
  const end = shownEnd(editor.state);
  const last = doc.resolve(end).nodeBefore;
  if (!last) return false;
  const lastBlock = editor.view.nodeDOM(end - last.nodeSize);
  return lastBlock instanceof Element && event.clientY > lastBlock.getBoundingClientRect().bottom;
}

/**
 * A click in the page's empty space below the Mind's last Block puts the
 * cursor at the end of the Mind, as in Word, Notion and Apple Notes. The
 * press is taken in the capture phase and prevented, so ProseMirror, which
 * ignores a prevented event, doesn't put the cursor somewhere else on release.
 * `frame` is any element inside the Mind's scroller.
 */
export function useClickBelowNote(editor: Editor, frame: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scroller = frame.current?.closest<HTMLElement>(".mind-scroller");
    if (!scroller) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (editor.isDestroyed || !editor.isEditable) return;
      if (!inEmptySpaceBelowNote(editor, scroller, event)) return;
      event.preventDefault();
      cursorAtEndOfMind(editor);
    };
    scroller.addEventListener("mousedown", onMouseDown, true);
    return () => scroller.removeEventListener("mousedown", onMouseDown, true);
  }, [editor, frame]);
}
