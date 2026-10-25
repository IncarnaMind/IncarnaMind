import { create } from "zustand";
import type { ObjectRef } from "./objects";

/**
 * The Document, Folder or Linked folder whose info panel is open (Get info, ⌘I),
 * wherever it was asked for, and what had the focus, so closing it gives the
 * focus back. `InfoPanel` (mounted once) shows it.
 */
export const useInfo = create<{
  target: ObjectRef | null;
  from: HTMLElement | null;
  open(target: ObjectRef, from: HTMLElement | null): void;
  close(): void;
}>()((set) => ({
  target: null,
  from: null,
  open: (target, from) => set({ target, from }),
  close: () => set({ target: null, from: null }),
}));
