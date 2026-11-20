import { create } from "zustand";

/**
 * Which Mind shows its find bar. Commands set it; the Mind's editor draws it.
 * `findRequests` counts the ⌘F and ⌥⌘F presses, so a press on an open bar
 * puts the cursor back in its field; `findReplace` says whether the bar shows
 * Replace too.
 */
interface MindTools {
  findMindId: string | null;
  findRequests: number;
  findReplace: boolean;
  showFind(mindId: string, options?: { replace?: boolean }): void;
  hideFind(): void;
}

export const useMindTools = create<MindTools>((set) => ({
  findMindId: null,
  findRequests: 0,
  findReplace: false,
  showFind: (mindId, options) =>
    set((state) => ({
      findMindId: mindId,
      findRequests: state.findRequests + 1,
      findReplace: options?.replace === true,
    })),
  hideFind: () => set({ findMindId: null }),
}));
