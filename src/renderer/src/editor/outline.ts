import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

export interface OutlineEntry {
  /** Where the heading starts in the document. */
  pos: number;
  level: number;
  text: string;
}

/** The Mind's headings in order, Answers' included; an empty one has nothing to jump to. */
export function outlineOf(editor: Editor): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    if (text !== "") entries.push({ pos, level: Number(node.attrs.level) || 1, text });
  });
  return entries;
}

/** Moves the cursor to the start of a heading and scrolls it into view. */
export function jumpTo(editor: Editor, pos: number): void {
  editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      if (dispatch) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
      return true;
    })
    .scrollIntoView()
    .run();
}
