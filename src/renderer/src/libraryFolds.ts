import { useEffect, useRef } from "react";
import { create } from "zustand";
import { RECENTLY_DELETED } from "./libraryPage";
import { TO_REVIEW } from "./toReview";

const KEY = "incarnamind.library.folded";

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
}

function read(): { folded: Set<string>; subOpen: Set<string> } {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    // Saved before Folders held Folders: the array is the sections folded.
    if (Array.isArray(value)) return { folded: new Set(names(value)), subOpen: new Set() };
    const saved = (value ?? {}) as { folded?: unknown; subOpen?: unknown };
    return {
      folded: new Set(Array.isArray(saved.folded) ? names(saved.folded) : [RECENTLY_DELETED]),
      subOpen: new Set(names(saved.subOpen)),
    };
  } catch {
    return { folded: new Set([RECENTLY_DELETED]), subOpen: new Set() };
  }
}

function save(folded: ReadonlySet<string>, subOpen: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ folded: [...folded], subOpen: [...subOpen] }));
  } catch {
    // Not remembered, then: every section starts open next time, Recently deleted folded.
  }
}

interface LibraryFolds {
  /** The sections folded, by key (a Folder's id, Not in a Folder's, Recently deleted's). */
  folded: ReadonlySet<string>;
  /** The sub-Folders showing what is inside them; the rest are closed. */
  subOpen: ReadonlySet<string>;
  /** The sections listing all their Documents past the first few. Forgotten at a restart. */
  showingAll: ReadonlySet<string>;
  /** Forgotten at a restart. */
  reviewOpen: boolean;
  setReviewOpen(open: boolean): void;
  showReview(): void;
  /** To review's head is on the page now: Accept all, by key or from ⌘K, acts only on what is in view. */
  reviewShown: boolean;
  setReviewShown(shown: boolean): void;
  /** The section or sub-Folder the page was asked to show (a Folder opened from the sidebar), until it has. */
  revealing: string | null;
  /** Opens a section, and asks the page to bring it into view. */
  reveal(key: string): void;
  /** Opens the top section and every sub-Folder around this Folder, and asks the page to show its row. */
  revealFolder(id: string, parentOf: (folderId: string) => string | null): void;
  /** The section is in view. */
  revealed(): void;
  toggle(key: string): void;
  setOpen(key: string, open: boolean): void;
  /** Folds or opens all these at once. */
  setAll(keys: readonly string[], open: boolean): void;
  toggleSub(id: string): void;
  setSubOpen(id: string, open: boolean): void;
  showAll(key: string): void;
}

/** Which of the Library page's sections and sub-Folders are open, remembered on this computer. */
export const useLibraryFolds = create<LibraryFolds>()((set, get) => {
  const initial = read();
  const change = (next: Partial<Pick<LibraryFolds, "folded" | "subOpen">>) => {
    const state = { ...get(), ...next };
    set(next);
    save(state.folded, state.subOpen);
  };
  return {
    folded: initial.folded,
    subOpen: initial.subOpen,
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
    revealFolder(id, parentOf) {
      const ancestors: string[] = [];
      const seen = new Set<string>([id]);
      let parent = parentOf(id);
      while (parent !== null && !seen.has(parent)) {
        seen.add(parent);
        ancestors.unshift(parent);
        parent = parentOf(parent);
      }
      if (ancestors.length === 0) {
        get().reveal(id);
        return;
      }
      const [top] = ancestors as [string];
      const subOpen = new Set(get().subOpen);
      // The Folder's own row shows once what it is in is open; whether it is open is the User's.
      for (const ancestor of ancestors.slice(1)) subOpen.add(ancestor);
      change({ folded: new Set([...get().folded].filter((key) => key !== top)), subOpen });
      set({ revealing: id });
    },
    revealed() {
      set({ revealing: null });
    },
    toggle(key) {
      const folded = new Set(get().folded);
      if (!folded.delete(key)) folded.add(key);
      change({ folded });
    },
    setOpen(key, open) {
      if (get().folded.has(key) !== open) return;
      const folded = new Set(get().folded);
      if (open) folded.delete(key);
      else folded.add(key);
      change({ folded });
    },
    setAll(keys, open) {
      const folded = new Set(get().folded);
      for (const key of keys) {
        if (open) folded.delete(key);
        else folded.add(key);
      }
      change({ folded });
    },
    toggleSub(id) {
      const subOpen = new Set(get().subOpen);
      if (!subOpen.delete(id)) subOpen.add(id);
      change({ subOpen });
    },
    setSubOpen(id, open) {
      if (get().subOpen.has(id) === open) return;
      const subOpen = new Set(get().subOpen);
      if (open) subOpen.add(id);
      else subOpen.delete(id);
      change({ subOpen });
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
