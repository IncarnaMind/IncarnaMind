/**
 * The note a highlight opens ready to type (#327): "Add a note…" in the
 * viewer's selection menu makes the highlight, then opens its note where it is
 * drawn, on its mark.
 */
import { create } from "zustand";

interface NoteEditorState {
  editing: { annotationId: string; documentId: string } | null;
  open(annotationId: string, documentId: string): void;
  close(): void;
}

export const useNoteEditor = create<NoteEditorState>()((set) => ({
  editing: null,
  open: (annotationId, documentId) => set({ editing: { annotationId, documentId } }),
  close: () => set({ editing: null }),
}));
