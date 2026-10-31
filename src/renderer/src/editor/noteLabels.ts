import type { Editor } from "@tiptap/core";
import { wordNoteNumberingOf } from "../../../shared/wordFiles";
import { DEFAULT_NOTE_NUMBERING, noteLabel } from "../../../shared/wordNotes";
import { editorDoc } from "./proposalReview";

/**
 * What a footnote's or an endnote's marker shows for its number: in figures,
 * or as the Word file the Mind was imported from numbers its notes (#746).
 */
export function noteMarker(editor: Editor, number: number, endnote: boolean): string {
  if (number <= 0) return "·";
  const doc = editorDoc(editor);
  const numbering = (doc && wordNoteNumberingOf(doc)) ?? DEFAULT_NOTE_NUMBERING;
  return noteLabel(number, endnote ? numbering.endnote : numbering.footnote);
}
