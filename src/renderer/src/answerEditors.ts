/**
 * The Answers shown in the assistant (#201), each drawn by a read-only editor
 * of its own, by Answer id: what is selected in one, for Add to note, and
 * Copy, which copies the Answer (or what is selected in it) as the editor
 * does, so it pastes back as Notes with their Citations.
 */
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { type ConversationAnswer, NOTE_BLOCK_TYPES } from "../../core/api";
import { answerBlocks } from "../../shared/answerBlocks";
import type { NodeJSON } from "../../shared/blockJson";
import { withoutFraming } from "../../shared/noteBlocks";
import { tablesOf } from "./editor/answerTables";
import { withoutCitationGlue } from "./editor/citationGlue";
import { useAppStore } from "./store";

const editors = new Map<string, Editor>();

/** Lends an Answer's editor for as long as it is shown; returns how to take it back. */
export function lendAnswerEditor(answerId: string, editor: Editor): () => void {
  editors.set(answerId, editor);
  return () => {
    if (editors.get(answerId) === editor) editors.delete(answerId);
  };
}

/** The part of the Answer the User selected in it, as the editor's positions; null for none. */
function selectedRange(editor: Editor): { from: number; to: number } | null {
  const { view } = editor;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!view.dom.contains(range.commonAncestorContainer)) return null;
  try {
    const from = view.posAtDOM(range.startContainer, range.startOffset);
    const to = view.posAtDOM(range.endContainer, range.endOffset);
    return from < to ? { from, to } : null;
  } catch {
    // A selection ProseMirror can't place (inside a formula's rendering, say): the whole Answer.
    return null;
  }
}

export function answerTables(answerId: string): NodeJSON[] {
  const editor = editors.get(answerId);
  return editor && !editor.isDestroyed ? tablesOf(editor.state.doc) : [];
}

export function tableHolding(answerId: string, active: Element | null): number | null {
  const editor = editors.get(answerId);
  if (!editor || editor.isDestroyed) return null;
  const anchor = active?.ownerDocument.getSelection()?.anchorNode ?? null;
  const frames = [active, anchor instanceof Element ? anchor : anchor?.parentElement]
    .map((element) => element?.closest(".tableWrapper") ?? null)
    .filter((frame) => frame !== null && editor.view.dom.contains(frame));
  const frame = frames[0];
  if (!frame) return null;
  const { doc } = editor.state;
  const top = doc.resolve(editor.view.posAtDOM(frame, 0)).index(0);
  if (doc.child(top).type.name !== "table") return null;
  let before = 0;
  for (let at = 0; at < top; at++) if (doc.child(at).type.name === "table") before++;
  return before;
}

/** The slice's Notes: its top-level Blocks with something in them (a rule or a formula counts). */
function notesOf(slice: Slice): NodeJSON[] {
  const nodes: ProseMirrorNode[] = [];
  slice.content.forEach((node) => {
    if ((NOTE_BLOCK_TYPES as readonly string[]).includes(node.type.name)) nodes.push(node);
  });
  return withoutCitationGlue(
    nodes
      .filter((node) => node.isLeaf || node.content.size > 0)
      .map((node) => node.toJSON() as NodeJSON),
  );
}

/**
 * The Notes selected in an Answer (from the top, so the paragraph or list
 * around a selection inside it comes too), or null when nothing in it is
 * selected: then the whole Answer is meant.
 */
export function selectedNotes(answerId: string): NodeJSON[] | null {
  const editor = editors.get(answerId);
  if (!editor || editor.isDestroyed) return null;
  const range = selectedRange(editor);
  if (!range) return null;
  const notes = notesOf(editor.state.doc.slice(range.from, range.to, true));
  return notes.length > 0 ? notes : null;
}

/**
 * Copies an Answer, or what is selected in it: HTML that pastes back as Notes
 * with their Citations and into Word as footnotes, and plain text with numbered
 * markers and a list of Sources (see `CopyCitations`). Resolves to whether it was copied.
 */
export async function copyAnswer(answerId: string): Promise<boolean> {
  const editor = editors.get(answerId);
  if (!editor || editor.isDestroyed) return false;
  const { doc } = editor.state;
  const range = selectedRange(editor) ?? { from: 0, to: doc.content.size };
  // The editor's own copy: its Citations as footnotes, and the text with markers and Sources.
  const { dom, text } = editor.view.serializeForClipboard(doc.slice(range.from, range.to));
  // The run's mark is how the Answer is drawn, not part of it.
  for (const run of dom.querySelectorAll(".citation-glue")) run.replaceWith(...run.childNodes);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([dom.innerHTML], { type: "text/html" }),
        "text/plain": new Blob([text.trim()], { type: "text/plain" }),
      }),
    ]);
    return true;
  } catch (error) {
    useAppStore.getState().reportError(error);
    return false;
  }
}

/**
 * What Add to note puts in from an Answer: what is selected in it, as it is,
 * or all of it without the model's lead-in and closing note.
 */
export const notesToAdd = (answer: ConversationAnswer): NodeJSON[] =>
  selectedNotes(answer.id) ?? withoutFraming(answerBlocks({ ...answer, status: "done" }));
