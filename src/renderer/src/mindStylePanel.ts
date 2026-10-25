import { create } from "zustand";

interface Asked {
  mindId: string;
  anchor: HTMLButtonElement | null;
}

/**
 * The Mind whose Style is open, and the one whose Other fonts… list or custom line spacing
 * is, wherever each was asked for. `MindStyleHost` (mounted once) shows them.
 */
export const useMindStylePanel = create<{
  open: Asked | null;
  fonts: (Asked & { anchor: HTMLButtonElement }) | null;
  spacing: (Asked & { anchor: HTMLButtonElement }) | null;
  show(mindId: string, anchor: HTMLButtonElement | null): void;
  close(): void;
  pickFont(mindId: string, anchor: HTMLButtonElement): void;
  closeFonts(): void;
  typeSpacing(mindId: string, anchor: HTMLButtonElement): void;
  closeSpacing(): void;
}>()((set) => ({
  open: null,
  fonts: null,
  spacing: null,
  show: (mindId, anchor) => set({ open: { mindId, anchor } }),
  close: () => set({ open: null }),
  pickFont: (mindId, anchor) => set({ fonts: { mindId, anchor } }),
  closeFonts: () => set({ fonts: null }),
  typeSpacing: (mindId, anchor) => set({ spacing: { mindId, anchor } }),
  closeSpacing: () => set({ spacing: null }),
}));
