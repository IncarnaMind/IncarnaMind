import type { Editor } from "@tiptap/core";
import { create } from "zustand";

/** Where a column is: the Mind and editor that hold it, and its table. */
export interface ComparisonColumnHandle {
  editor: Editor;
  mindId: string;
  tableId: string;
}

/** The heads with an editor showing them, by Question id: what a menu or ⌘K acts on. */
export const comparisonColumnHandles = new Map<string, ComparisonColumnHandle>();

/** The field open in a table's heading: a column being edited, or one being inserted beside it. */
export interface ComparisonColumnField {
  mode: "edit" | "insert";
  tableId: string;
  questionId: string;
  /** An insert's new column goes left or right of `questionId`. */
  side: "left" | "right";
}

interface ComparisonColumnState {
  field: ComparisonColumnField | null;
  /**
   * The Answers a reworded column showed before it, as text, until its new
   * Answer arrives. By `staleAnswerKey`.
   */
  stale: Readonly<Record<string, string>>;
  /** The column whose head takes the focus once it is drawn. */
  focus: { tableId: string; questionId: string } | null;
  openField(field: ComparisonColumnField): void;
  closeField(): void;
  focusColumn(tableId: string, questionId: string | null): void;
  clearFocus(tableId: string, questionId: string): void;
  rememberStale(key: string, words: string): void;
  forgetStale(key: string): void;
}

export const staleAnswerKey = (tableId: string, documentId: string, questionId: string) =>
  `${tableId}\n${documentId}\n${questionId}`;

export const useComparisonColumns = create<ComparisonColumnState>()((set) => ({
  field: null,
  stale: {},
  focus: null,
  openField: (field) => set({ field }),
  closeField: () => set({ field: null }),
  focusColumn: (tableId, questionId) => set({ focus: questionId ? { tableId, questionId } : null }),
  clearFocus: (tableId, questionId) =>
    set((state) =>
      state.focus?.tableId === tableId && state.focus.questionId === questionId
        ? { focus: null }
        : {},
    ),
  rememberStale: (key, words) => set((state) => ({ stale: { ...state.stale, [key]: words } })),
  forgetStale: (key) =>
    set((state) => {
      if (!(key in state.stale)) return {};
      const { [key]: _gone, ...rest } = state.stale;
      return { stale: rest };
    }),
}));
