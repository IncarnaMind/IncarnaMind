/**
 * Importing a Word file as a Mind (#104), from "Import a Word file…" (the +
 * menu, ⌘K) or a .docx dropped on an open Mind: the import screen reads the
 * file first, says why it can't be imported, or asks whose document it is
 * (someone else's when it carries tracked changes or comments), then imports
 * it and opens the new Mind in a tab. The original is also added as a
 * Document unless the User unticks it (#720), as a new version of an earlier
 * draft's when they keep both.
 */
import { create } from "zustand";
import type { WordFileCheck, WordOrigin, WordRefusalReason } from "../../core/api";
import type { MessageKey } from "../../shared/i18n";
import { core, files } from "./core";
import { useAppStore } from "./store";

interface WordImportState {
  /** The file the import screen is about; null while it is closed. */
  path: string | null;
  /** It is a .docx copy IncarnaMind converted from the User's .doc (#104): its temporary copy goes when the screen does. */
  converted: boolean;
  /** It was dropped on a Mind, so the screen also offers to add it as a Document, as other drops do. */
  dropped: boolean;
  /** What reading the file found; null while it is being read. */
  check: WordFileCheck | null;
  origin: WordOrigin;
  /** Also add the original to the Library, so Answers can cite it. */
  addOriginal: boolean;
  /** Make it a new version of the earlier draft's Document (`check.earlierDraft`), if there is one. */
  newVersion: boolean;
  importing: boolean;
  /** Why importing refused it, when the file changed after it was read. */
  refusal: WordRefusalReason | null;
  /** LibreOffice is converting a .doc to a .docx copy: the import waits. */
  converting: boolean;
  /** Why the conversion failed, in the file's plain next step; null otherwise. */
  conversionFailed: boolean;
  /** The Minds whose original the Library couldn't take at import, each with its file, to try again. */
  notAdded: Record<string, string>;
  /** The Mind whose original is being added again. */
  retrying: string | null;
  /** "Import a Word file…": the system's open dialog, then the import screen. */
  pick(): Promise<void>;
  /** Opens the import screen on a file; `converted`: a copy this core made for it. */
  open(path: string, dropped: boolean, converted?: boolean): Promise<void>;
  setOrigin(origin: WordOrigin): void;
  setAddOriginal(addOriginal: boolean): void;
  setNewVersion(newVersion: boolean): void;
  confirm(): Promise<void>;
  /** For a dropped file: adds it as a Document, as a drop elsewhere would, instead. */
  addAsDocument(): Promise<void>;
  /** A .doc the LibreOffice here can convert: makes a .docx copy and reads that (#104). */
  convert(): Promise<void>;
  /** Adds a Mind's original to the Library again, after it couldn't be added at import. */
  retryOriginal(mindId: string): Promise<void>;
  close(): void;
}

export const refusalKey = (reason: WordRefusalReason): MessageKey => `wordImport.refusal.${reason}`;

const reportError = (error: unknown) => useAppStore.getState().reportError(error);

export const useWordImport = create<WordImportState>()((set, get) => ({
  path: null,
  converted: false,
  dropped: false,
  check: null,
  origin: "own",
  addOriginal: true,
  newVersion: true,
  importing: false,
  refusal: null,
  converting: false,
  conversionFailed: false,
  notAdded: {},
  retrying: null,

  async pick() {
    const path = await files.pickWordFile();
    if (path) await get().open(path, false);
  },

  async open(path, dropped, converted = false) {
    const before = get();
    if (before.converted && before.path !== null && before.path !== path) {
      void core.discardWordFile(before.path).catch(reportError);
    }
    set({
      path,
      converted,
      dropped,
      check: null,
      origin: "own",
      addOriginal: !converted,
      newVersion: true,
      importing: false,
      refusal: null,
      converting: false,
      conversionFailed: false,
    });
    try {
      const check = await core.checkWordFile(path);
      if (get().path !== path) return;
      set({ check, origin: check.origin });
    } catch (error) {
      set({ path: null });
      reportError(error);
    }
  },

  setOrigin: (origin) => set({ origin }),
  setAddOriginal: (addOriginal) => set({ addOriginal }),
  setNewVersion: (newVersion) => set({ newVersion }),

  async confirm() {
    const { path, origin, importing, addOriginal, newVersion, check } = get();
    if (!path || importing) return;
    set({ importing: true });
    const earlier = addOriginal && newVersion ? (check?.earlierDraft?.documentId ?? null) : null;
    try {
      const result = await core.importWordFile({
        path,
        origin,
        addOriginal,
        newVersionOf: earlier,
      });
      if (!result.ok) {
        set({ importing: false, refusal: result.refusal });
        return;
      }
      get().close();
      if (result.originalAdded === false) {
        set((state) => ({ notAdded: { ...state.notAdded, [result.mind.id]: path } }));
      }
      await useAppStore.getState().showNewMind(result.mind);
    } catch (error) {
      set({ importing: false });
      reportError(error);
    }
  },

  async addAsDocument() {
    const { path, converted } = get();
    if (converted) return;
    get().close();
    if (path) await useAppStore.getState().addPaths([path]);
  },

  async convert() {
    const { path, converting } = get();
    if (!path || converting) return;
    set({ converting: true, conversionFailed: false });
    try {
      const result = await core.convertWordFile(path);
      if (result.outcome === "problem") {
        set({ converting: false, conversionFailed: true });
        return;
      }
      await get().open(result.path, false, true);
    } catch (error) {
      set({ converting: false, conversionFailed: true });
      reportError(error);
    }
  },

  async retryOriginal(mindId) {
    const path = get().notAdded[mindId];
    if (path === undefined || get().retrying !== null) return;
    set({ retrying: mindId });
    try {
      const added = await core.addWordOriginal(mindId, path);
      set((state) => {
        if (!added) return { retrying: null };
        const { [mindId]: _added, ...notAdded } = state.notAdded;
        return { retrying: null, notAdded };
      });
    } catch (error) {
      set({ retrying: null });
      reportError(error);
    }
  },

  close() {
    const { path, converted } = get();
    if (converted && path !== null) void core.discardWordFile(path).catch(reportError);
    set({
      path: null,
      converted: false,
      check: null,
      importing: false,
      refusal: null,
      converting: false,
      conversionFailed: false,
    });
  },
}));
