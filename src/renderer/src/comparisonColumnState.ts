import type { Editor } from "@tiptap/core";
import { create } from "zustand";

/** Where a table or one of its parts is: the Mind and editor that hold it, and its table. */
export interface ComparisonHandle {
  editor: Editor;
  mindId: string;
  tableId: string;
}

export type ComparisonColumnHandle = ComparisonHandle;

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
  /** The structure changes being written, by table and request: a note takes no edits to a held table. */
  holds: ReadonlyMap<string, ReadonlySet<string>>;
  openField(field: ComparisonColumnField): void;
  closeField(): void;
  focusColumn(tableId: string, questionId: string | null): void;
  clearFocus(tableId: string, questionId: string): void;
  hold(tableId: string, requestId: string): void;
  release(tableId: string, requestId: string): void;
  rememberStale(key: string, words: string): void;
  forgetStale(key: string): void;
}

export const staleAnswerKey = (tableId: string, documentId: string, questionId: string) =>
  `${tableId}\n${documentId}\n${questionId}`;

export const useComparisonColumns = create<ComparisonColumnState>()((set) => ({
  field: null,
  stale: {},
  focus: null,
  holds: new Map(),
  openField: (field) => set({ field }),
  closeField: () => set({ field: null }),
  focusColumn: (tableId, questionId) => set({ focus: questionId ? { tableId, questionId } : null }),
  clearFocus: (tableId, questionId) =>
    set((state) =>
      state.focus?.tableId === tableId && state.focus.questionId === questionId
        ? { focus: null }
        : {},
    ),
  hold: (tableId, requestId) =>
    set((state) => {
      const requests = new Set(state.holds.get(tableId) ?? []);
      if (requests.has(requestId)) return {};
      requests.add(requestId);
      return { holds: new Map(state.holds).set(tableId, requests) };
    }),
  release: (tableId, requestId) =>
    set((state) => {
      const requests = state.holds.get(tableId);
      if (!requests?.has(requestId)) return {};
      const next = new Set(requests);
      next.delete(requestId);
      const holds = new Map(state.holds);
      if (next.size === 0) holds.delete(tableId);
      else holds.set(tableId, next);
      return { holds };
    }),
  rememberStale: (key, words) => set((state) => ({ stale: { ...state.stale, [key]: words } })),
  forgetStale: (key) =>
    set((state) => {
      if (!(key in state.stale)) return {};
      const { [key]: _gone, ...rest } = state.stale;
      return { stale: rest };
    }),
}));
