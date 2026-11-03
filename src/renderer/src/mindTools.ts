import { create } from "zustand";

/**
 * Which Mind shows its outline, or its find bar. Commands set them; the Mind's
 * editor draws them. `findRequests` counts the ⌘F and ⌥⌘F presses, so a press
 * on an open bar puts the cursor back in its field; `findReplace` says whether
 * the bar shows Replace too.
 */
interface MindTools {
  outlineMindId: string | null;
  findMindId: string | null;
  findRequests: number;
  findReplace: boolean;
  showOutline(mindId: string): void;
  hideOutline(): void;
  showFind(mindId: string, options?: { replace?: boolean }): void;
  hideFind(): void;
}

export const useMindTools = create<MindTools>((set) => ({
  outlineMindId: null,
  findMindId: null,
  findRequests: 0,
  findReplace: false,
  showOutline: (mindId) => set({ outlineMindId: mindId }),
  hideOutline: () => set({ outlineMindId: null }),
  showFind: (mindId, options) =>
    set((state) => ({
      findMindId: mindId,
      findRequests: state.findRequests + 1,
      findReplace: options?.replace === true,
    })),
  hideFind: () => set({ findMindId: null }),
}));
