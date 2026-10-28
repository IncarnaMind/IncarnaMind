/**
 * "Show Tasks" asks the Tasks popover to open, whether or not the chip in the
 * band shows: it says so once, and `TasksChip` takes it and opens, so Recent
 * (7 days) is in reach while nothing runs.
 */
import { create } from "zustand";

interface TaskMenuState {
  /** "Show Tasks" was chosen and not yet taken. */
  open: boolean;
  ask(): void;
  taken(): void;
}

export const useTaskMenu = create<TaskMenuState>()((set) => ({
  open: false,
  ask: () => set({ open: true }),
  taken: () => set({ open: false }),
}));

export const requestTaskMenu = () => useTaskMenu.getState().ask();
