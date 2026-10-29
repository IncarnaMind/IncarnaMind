import { create } from "zustand";
import type { ComparisonCellRef } from "../../core/api";
import {
  type ComparisonCellHandle,
  comparisonCellHandles,
  comparisonCellKey,
  comparisonCellRef,
} from "./comparisonCellHandle";
import { comparisonCellRange, comparisonCellsSelectable } from "./comparisonSelection";

interface CellRef extends ComparisonCellRef {
  tableId: string;
}

export interface ComparisonCheckProblem {
  message: string;
  retry(): Promise<void> | void;
}

interface ComparisonCellState {
  current: CellRef | null;
  selected: Readonly<Record<string, { anchor: ComparisonCellRef; cells: ComparisonCellRef[] }>>;
  card: (CellRef & { replace?: boolean }) | null;
  editing: (CellRef & { first?: string }) | null;
  checkProblems: Readonly<Record<string, ComparisonCheckProblem>>;
  checking: Readonly<Record<string, boolean>>;
  select(handle: ComparisonCellHandle, mode?: "single" | "range" | "toggle"): void;
  selectAll(handle: ComparisonCellHandle): void;
  openCard(ref: CellRef, replace?: boolean): void;
  closeCard(): void;
  startEdit(ref: CellRef, first?: string): void;
  finishEdit(): void;
  clearSelection(tableId: string): void;
  setCheckProblem(ref: CellRef, problem: ComparisonCheckProblem | null): void;
  setChecking(ref: CellRef, checking: boolean): void;
}

const keyOf = (ref: CellRef) => comparisonCellKey(ref.tableId, ref.documentId, ref.questionId);

function focus(ref: CellRef | null): void {
  if (!ref) return;
  requestAnimationFrame(() => comparisonCellHandles.get(keyOf(ref))?.anchor.focus());
}

export const useComparisonCells = create<ComparisonCellState>()((set, get) => ({
  current: null,
  selected: {},
  card: null,
  editing: null,
  checkProblems: {},
  checking: {},
  select(handle, mode = "single") {
    const current = {
      tableId: handle.tableId,
      documentId: handle.documentId,
      questionId: handle.questionId,
    };
    const previous = get().current;
    const before = get().selected[handle.tableId];
    const anchor =
      mode === "range" && previous?.tableId === handle.tableId
        ? (before?.anchor ?? previous)
        : current;
    const range = comparisonCellRange(handle, anchor, current);
    const key = comparisonCellKey(handle.tableId, handle.documentId, handle.questionId);
    const cells =
      mode === "toggle"
        ? before?.cells.some(
            (cell) => comparisonCellKey(handle.tableId, cell.documentId, cell.questionId) === key,
          )
          ? before.cells.filter(
              (cell) => comparisonCellKey(handle.tableId, cell.documentId, cell.questionId) !== key,
            )
          : [...(before?.cells ?? []), current]
        : range;
    set((state) => ({
      current,
      card: null,
      selected: { ...state.selected, [handle.tableId]: { anchor, cells } },
    }));
    focus(current);
  },
  selectAll(handle) {
    const cells = comparisonCellsSelectable(handle);
    const first = cells[0];
    if (!first) return;
    const current = comparisonCellRef(handle);
    set((state) => ({
      current,
      card: null,
      selected: {
        ...state.selected,
        [handle.tableId]: { anchor: { ...current, ...first }, cells },
      },
    }));
  },
  openCard(ref, replace = false) {
    set((state) => ({
      current: ref,
      card: { ...ref, replace },
      selected: { ...state.selected, [ref.tableId]: { anchor: ref, cells: [ref] } },
    }));
  },
  closeCard() {
    const current = get().current;
    set({ card: null });
    focus(current);
  },
  startEdit(ref, first) {
    set((state) => ({
      current: ref,
      card: null,
      editing: { ...ref, ...(first !== undefined && { first }) },
      selected: { ...state.selected, [ref.tableId]: { anchor: ref, cells: [ref] } },
    }));
  },
  finishEdit() {
    set({ editing: null });
  },
  clearSelection(tableId) {
    set((state) => {
      const { [tableId]: _gone, ...selected } = state.selected;
      return { selected };
    });
  },
  setCheckProblem(ref, problem) {
    set((state) => {
      const key = keyOf(ref);
      const { [key]: _old, ...rest } = state.checkProblems;
      return { checkProblems: problem ? { ...rest, [key]: problem } : rest };
    });
  },
  setChecking(ref, checking) {
    set((state) => {
      const key = keyOf(ref);
      const { [key]: _old, ...rest } = state.checking;
      return { checking: checking ? { ...rest, [key]: true } : rest };
    });
  },
}));
