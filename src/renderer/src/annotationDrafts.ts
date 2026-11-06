/**
 * The note draft being written for an annotation, kept outside the list row and
 * the note over the page (#327): a resize that swaps the page's tree, a Save the
 * core refuses, or a pointer leaving a hovered note never loses the User's words.
 * One draft per annotation, owned by the surface that opened it.
 */
import { create } from "zustand";

/** Where a draft is being written: the list's row, or the note over the page. */
export type DraftPlace = "row" | "note";

interface AnnotationDrafts {
  drafts: Readonly<Record<string, string>>;
  places: Readonly<Record<string, DraftPlace>>;
  begin(id: string, text: string, place: DraftPlace): void;
  write(id: string, text: string): void;
  end(id: string): void;
}

export const useAnnotationDrafts = create<AnnotationDrafts>()((set) => ({
  drafts: {},
  places: {},
  begin: (id, text, place) =>
    set((state) => ({
      drafts: { ...state.drafts, [id]: text },
      places: { ...state.places, [id]: place },
    })),
  write: (id, text) => set((state) => ({ drafts: { ...state.drafts, [id]: text } })),
  end: (id) =>
    set((state) => {
      const drafts = { ...state.drafts };
      const places = { ...state.places };
      delete drafts[id];
      delete places[id];
      return { drafts, places };
    }),
}));
