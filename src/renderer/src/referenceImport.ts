/**
 * Importing references (#287) in the window: choose a file, import it, show
 * what came of it in the Library, and offer Undo. The Library's "More" menu,
 * the command palette and a file dropped on the Library all start it here.
 */
import { create } from "zustand";
import type { ReferenceImportResult, ReferenceRecord } from "../../core/api";
import { core, files } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import { useAppStore } from "./store";
import { type Undoable, useUndo } from "./undo";

export type Imported = Extract<ReferenceImportResult, { outcome: "imported" }>;
export type ImportFailure = Extract<ReferenceImportResult, { outcome: "failed" }>["reason"];

/** A file the Library takes as references when dropped: the extensions the picker offers, except .txt. */
export const isReferenceFile = (name: string) => /\.(?:json|bib|bibtex|ris)$/i.test(name);

interface ReferenceImportState {
  /** What the panel in the Library shows: nothing, how far it is, or what came of it. */
  phase: "idle" | "running" | "done" | "failed";
  progress: { done: number; total: number } | null;
  /** The file's name, for the panel and the Undo line. */
  fileName: string;
  result: Imported | null;
  failure: ImportFailure | null;
  /** The references with no Document yet. */
  unmatched: ReferenceRecord[];
  addingFiles: boolean;
  /** A problem the User can act on, in words. */
  error: string | null;
  /** Asks for a file, then imports it. Resolves to how to take it back. */
  start(): Promise<Undoable | undefined>;
  /** Imports a file given by path (dropped on the Library). */
  importPath(path: string): Promise<Undoable | undefined>;
  addFiles(): Promise<void>;
  /** "Add the PDF…" for one unmatched reference. */
  addFileFor(recordId: string): Promise<void>;
  dismiss(): void;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export const useReferenceImport = create<ReferenceImportState>()((set, get) => {
  const refreshUnmatched = async () => {
    set({ unmatched: await core.listUnmatchedReferences() });
  };

  const importPath = async (path: string): Promise<Undoable | undefined> => {
    if (get().phase === "running") return undefined;
    set({
      phase: "running",
      progress: null,
      fileName: baseName(path),
      result: null,
      failure: null,
      error: null,
    });
    // The Library is where the result shows.
    useAppStore.getState().openLibrary();
    const off = core.on("references.importProgress", (progress) => set({ progress }));
    try {
      const result = await core.importReferences(path);
      if (result.outcome === "failed") {
        set({ phase: "failed", failure: result.reason, progress: null });
        return undefined;
      }
      set({ phase: "done", result, progress: null });
      await refreshUnmatched();
      if (result.changed === 0) return undefined;
      const { fileName } = get();
      const { total, importId } = result;
      return {
        said: (t) => t("references.import.undo", { count: total, name: fileName }),
        undo: async () => {
          await core.undoReferenceImport(importId);
          set({ phase: "idle", result: null });
          await refreshUnmatched();
        },
      };
    } catch (error) {
      set({ phase: "idle", progress: null, error: errorMessage(error, translateNow) });
      return undefined;
    } finally {
      off();
    }
  };

  return {
    phase: "idle",
    progress: null,
    fileName: "",
    result: null,
    failure: null,
    unmatched: [],
    addingFiles: false,
    error: null,

    async start() {
      if (get().phase === "running") return undefined;
      const path = await files.pickReferenceFile();
      return path ? importPath(path) : undefined;
    },

    importPath,

    async addFiles() {
      const { result } = get();
      if (!result || get().addingFiles) return;
      set({ addingFiles: true, error: null });
      try {
        await core.addImportedReferenceFiles(result.importId);
        // Dismissed, undone or replaced by another import meanwhile: the panel shows that (#2302).
        set((state) =>
          state.result?.importId === result.importId
            ? { result: { ...state.result, files: 0 } }
            : {},
        );
        await refreshUnmatched();
      } catch (error) {
        set({ error: errorMessage(error, translateNow) });
      } finally {
        set({ addingFiles: false });
      }
    },

    async addFileFor(recordId) {
      set({ error: null });
      try {
        const [path] = await files.pickDocuments();
        if (!path) return;
        await core.addReferenceFile(recordId, path);
        await refreshUnmatched();
      } catch (error) {
        set({ error: errorMessage(error, translateNow) });
      }
    },

    dismiss: () => set({ phase: "idle", result: null, failure: null, error: null }),
  };
});

/** Starts an import, and offers Undo for it once it is done. */
export async function importReferences(): Promise<Undoable | undefined> {
  const undoable = await useReferenceImport.getState().start();
  if (undoable) useUndo.getState().push(undoable);
  return undoable;
}

export async function importReferenceFile(path: string): Promise<void> {
  const undoable = await useReferenceImport.getState().importPath(path);
  if (undoable) useUndo.getState().push(undoable);
}
