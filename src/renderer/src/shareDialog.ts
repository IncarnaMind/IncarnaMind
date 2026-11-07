import { create } from "zustand";

/** The Mind whose Share sheet is open (#1258), from Export › More formats or ⌘K. */
export const useShareDialog = create<{
  mindId: string | null;
  open(mindId: string): void;
  close(): void;
}>()((set) => ({
  mindId: null,
  open: (mindId) => set({ mindId }),
  close: () => set({ mindId: null }),
}));
