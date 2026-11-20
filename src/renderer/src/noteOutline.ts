import { create } from "zustand";
import { heldByMind } from "./heldByMind";

/*
 * Which Notes show their outline (#3414), remembered on this computer. Not in the Note's own
 * settings: every change there is an edit to the Note, so opening the outline would move its
 * Modified time and its place in Recent, and a read-only Note couldn't keep it.
 */

const KEY = "incarnamind.noteOutline.open";

function read(): ReadonlySet<string> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function save(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...open]));
  } catch {
    // Not remembered, then: each Note opens with its outline closed next time.
  }
}

interface NoteOutlines {
  open: ReadonlySet<string>;
  /** A Note whose outline should take the focus once it shows: it was opened from a key or ⌘K. */
  focusAsked: { mindId: string; at: number } | null;
  setOpen(mindId: string, open: boolean, options?: { focus?: boolean }): void;
  focusTaken(): void;
}

export const useNoteOutlines = create<NoteOutlines>()((set, get) => ({
  open: read(),
  focusAsked: null,
  setOpen(mindId, open, { focus = false } = {}) {
    if (focus && open) set({ focusAsked: { mindId, at: (get().focusAsked?.at ?? 0) + 1 } });
    if (get().open.has(mindId) === open) return;
    const next = new Set(get().open);
    if (open) next.add(mindId);
    else next.delete(mindId);
    set({ open: next });
    save(next);
  },
  focusTaken() {
    set({ focusAsked: null });
  },
}));

export const useNoteOutlineOpen = (mindId: string): boolean =>
  useNoteOutlines((state) => state.open.has(mindId));

/** The Notes shown, for ⌘K and the menus: whether each has enough headings, and the way to show or hide it. */
const outlines = heldByMind<{ has(): boolean; toggle(): void }>();
export const useHeldOutlines = outlines.use;
export const holdOutline = outlines.hold;
