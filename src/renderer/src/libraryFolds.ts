import { useEffect, useRef } from "react";
import { create } from "zustand";
import { RECENTLY_DELETED } from "./libraryPage";
import { TO_REVIEW } from "./toReview";

const KEY = "incarnamind.library.folded";

function read(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    return Array.isArray(value)
      ? new Set(value.filter((key): key is string => typeof key === "string"))
      : new Set([RECENTLY_DELETED]);
  } catch {
    return new Set([RECENTLY_DELETED]);
  }
}

function save(folded: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...folded]));
  } catch {
    // Not remembered, then: every section starts open next time, Recently deleted folded.
  }
}

interface LibraryFolds {
  /** The sections folded, by key (a Folder's id, Not in a Folder's, Recently deleted's). */
  folded: ReadonlySet<string>;
  /** The sections listing all their Documents past the first few. Forgotten at a restart. */
  showingAll: ReadonlySet<string>;
  /** Forgotten at a restart. */
  reviewOpen: boolean;
  setReviewOpen(open: boolean): void;
  showReview(): void;
  /** To review's head is on the page now: Accept all, by key or from ⌘K, acts only on what is in view. */
  reviewShown: boolean;
  setReviewShown(shown: boolean): void;
  /** The section the page was asked to show (a Folder opened from the sidebar), until it has. */
  revealing: string | null;
  /** Opens a section, and asks the page to bring it into view. */
  reveal(key: string): void;
  /** The section is in view. */
  revealed(): void;
  toggle(key: string): void;
  setOpen(key: string, open: boolean): void;
  /** Folds or opens all these at once. */
  setAll(keys: readonly string[], open: boolean): void;
  showAll(key: string): void;
}

/** Which of the Library page's sections are folded, remembered on this computer. */
export const useLibraryFolds = create<LibraryFolds>()((set, get) => {
  const fold = (folded: Set<string>) => {
    set({ folded });
    save(folded);
  };
  return {
    folded: read(),
    showingAll: new Set(),
    reviewOpen: false,
    setReviewOpen: (reviewOpen) => set({ reviewOpen }),
    showReview: () => set({ reviewOpen: true, revealing: TO_REVIEW }),
    reviewShown: false,
    setReviewShown: (reviewShown) => set({ reviewShown }),
    revealing: null,
    reveal(key) {
      get().setOpen(key, true);
      set({ revealing: key });
    },
    revealed() {
      set({ revealing: null });
    },
    toggle(key) {
      const folded = new Set(get().folded);
      if (!folded.delete(key)) folded.add(key);
      fold(folded);
    },
    setOpen(key, open) {
      if (get().folded.has(key) !== open) return;
      const folded = new Set(get().folded);
      if (open) folded.delete(key);
      else folded.add(key);
      fold(folded);
    },
    setAll(keys, open) {
      const folded = new Set(get().folded);
      for (const key of keys) {
        if (open) folded.delete(key);
        else folded.add(key);
      }
      fold(folded);
    },
    showAll(key) {
      set({ showingAll: new Set([...get().showingAll, key]) });
    },
  };
});

/**
 * For a section's element: brings it into view, with the focus on its name,
 * once the page was asked to show it and it is drawn (`ready`).
 */
export function useRevealed<E extends HTMLElement>(key: string, ready = true) {
  const element = useRef<E>(null);
  const revealing = useLibraryFolds((state) => state.revealing === key);
  useEffect(() => {
    if (!revealing || !ready || !element.current) return;
    element.current.scrollIntoView({ block: "start" });
    element.current.querySelector<HTMLElement>("[data-tree-row]")?.focus({ preventScroll: true });
    useLibraryFolds.getState().revealed();
  }, [revealing, ready]);
  return element;
}
