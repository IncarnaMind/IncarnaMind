/**
 * A Document's highlights and notes in the window (#327): each document's list
 * for its page and its Annotations list, and how many each Document has, for
 * the Library's rows. The core pushes "annotations.changed" for every change,
 * from this window or another, and the lists follow.
 */
import { create } from "zustand";
import type { Annotation, AnnotationColour } from "../../core/api";
import { ANNOTATION_COLOURS } from "../../core/api";
import { core } from "./core";

const COLOUR_KEY = "incarnamind.annotationColour";

const isColour = (value: unknown): value is AnnotationColour =>
  typeof value === "string" && (ANNOTATION_COLOURS as readonly string[]).includes(value);

function rememberedColour(): AnnotationColour {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLOUR_KEY) ?? "null");
    if (isColour(value)) return value;
  } catch {
    // A choice not remembered yet, or one this version can't read.
  }
  return "yellow";
}

export interface AnnotationExport {
  documentId: string;
  name: string;
  folder: string;
  inDefaultFolder: boolean;
  path: string;
}

interface AnnotationsState {
  byDocument: Record<string, Annotation[]>;
  counts: Record<string, number>;
  /** The last export of a Document's highlights and comments, for its result line. */
  exported: AnnotationExport | null;
  showExport(exported: AnnotationExport | null): void;
  /** The colour the last highlight was made in: the next one starts in it. */
  colour: AnnotationColour;
  /** Each viewer's list is open, by Document: two viewers never share one. */
  panelOpen: Record<string, boolean>;
  /** Each viewer whose list takes the page's place, by Document. */
  listInPlace: Record<string, boolean>;
  setListInPlace(documentId: string, listInPlace: boolean): void;
  /** Each Document's viewer is wide enough for its list: by Document, as two viewers may differ. */
  room: Record<string, boolean>;
  setRoom(documentId: string, room: boolean): void;
  togglePanel(open: boolean, documentId: string): void;
  /** Reads a Document's annotations, unless they are being read now. */
  load(documentId: string): Promise<void>;
  /** Reads how many annotations each Document has. */
  loadCounts(): Promise<void>;
  chooseColour(colour: AnnotationColour): void;
}

const loading = new Set<string>();
const loadingAgain = new Set<string>();

export const useAnnotations = create<AnnotationsState>()((set) => ({
  byDocument: {},
  counts: {},
  exported: null,
  showExport: (exported) => set({ exported }),
  colour: rememberedColour(),
  panelOpen: {},
  listInPlace: {},
  setListInPlace: (documentId, listInPlace) =>
    set((state) => ({ listInPlace: { ...state.listInPlace, [documentId]: listInPlace } })),
  room: {},
  setRoom: (documentId, room) => set((state) => ({ room: { ...state.room, [documentId]: room } })),
  togglePanel: (open, documentId) =>
    set((state) => ({
      panelOpen: {
        ...state.panelOpen,
        [documentId]: open && state.room[documentId] !== false,
      },
    })),
  load: async (documentId) => {
    if (documentId === "") return;
    if (loading.has(documentId)) {
      // A change while a read runs is read again once, so the last one is never lost.
      loadingAgain.add(documentId);
      return;
    }
    loading.add(documentId);
    try {
      const list = await core.listAnnotations(documentId);
      set((state) => ({ byDocument: { ...state.byDocument, [documentId]: list } }));
    } catch (error) {
      console.error(`The highlights of Document ${documentId} couldn't be read.`, error);
    } finally {
      loading.delete(documentId);
      if (loadingAgain.delete(documentId)) void useAnnotations.getState().load(documentId);
    }
  },
  loadCounts: async () => {
    try {
      set({ counts: await core.annotationCounts() });
    } catch (error) {
      console.error("How many highlights each Document has couldn't be read.", error);
    }
  },
  chooseColour: (colour) => {
    set({ colour });
    try {
      localStorage.setItem(COLOUR_KEY, JSON.stringify(colour));
    } catch {
      // Not remembered, then: the next highlight starts in yellow.
    }
  },
}));

core.on("annotations.changed", ({ documentId }) => {
  void useAnnotations.getState().load(documentId);
  void useAnnotations.getState().loadCounts();
});

// The Library's rows read how many each Document has as they draw.
void useAnnotations.getState().loadCounts();

/** A Document's annotations, as last read; `null` until they are. */
export const useDocumentAnnotations = (documentId: string): Annotation[] | undefined =>
  useAnnotations((state) => state.byDocument[documentId]);

/** How many annotations a Document has, for the Library's row. */
export const useAnnotationCount = (documentId: string): number =>
  useAnnotations((state) => state.counts[documentId] ?? 0);

/**
 * The highlights on a Document that its page can mark: a sticky note from a file has no
 * words, and one the current version no longer holds is in the list alone, not on the page.
 */
export const highlightsOf = (annotations: readonly Annotation[] | undefined): Annotation[] =>
  (annotations ?? []).filter((annotation) => !annotation.missing && annotation.quote.trim() !== "");
