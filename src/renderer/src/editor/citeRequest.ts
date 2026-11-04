import type { Editor } from "@tiptap/core";

/** Where Cite… is: the "/" and what was typed after it, which the Citation replaces. */
export interface CitePlace {
  editor: Editor;
  from: number;
  to: number;
}

/** The views that can open Cite… for their editor, so ⌘K reaches it as the "/" menu does. */
const openers = new WeakMap<Editor, (place: CitePlace) => void>();

export function offerCite(editor: Editor, open: (place: CitePlace) => void): () => void {
  openers.set(editor, open);
  return () => openers.delete(editor);
}

/** Opens Cite… at the caret. False where no Note is open to search from. */
export function requestCite(editor: Editor): boolean {
  const open = openers.get(editor);
  if (!open) return false;
  const at = editor.state.selection.from;
  open({ editor, from: at, to: at });
  return true;
}
