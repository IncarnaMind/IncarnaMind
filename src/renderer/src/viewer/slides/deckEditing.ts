/**
 * The viewer's side of editing a deck by hand (#149): each gesture the slide editor hands over is
 * written by the core (`editDeck`), drawn at once from the bytes it wrote, and put on the shared
 * undo stack as one step, whose line says what was done and where it was saved. A file that can't
 * be written keeps the edit waiting, with one action: save a copy beside it. The deck's states
 * kept before each sitting are offered in its menu, to put it back as it was.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type {
  DeckEdit,
  DeckSaved,
  DeckUnwritable,
  Document,
  KeptDeckState,
} from "../../../../core/api";
import type { EditedParagraph, ShapeEdit } from "../../../../core/exports/pptxPatch/shapeEdit";
import type { Language } from "../../../../core/language";
import { formatDateTime } from "../../../../shared/dates";
import { core } from "../../core";
import { languageNow, useLanguage } from "../../i18n";
import type { Words, WordsInLine } from "../../lineNames";
import { useAppStore } from "../../store";
import { makeInTurn, UndoRefused, useUndo } from "../../undo";
import {
  adopt,
  beginWrite,
  forget,
  steadyVersion,
  useHandVersions,
  useSteadyVersion,
} from "./handVersions";

/** The deck's kept states, by Document, as its menu offers them. */
export const useKeptDecks = create<{ byDocument: Readonly<Record<string, KeptDeckState[]>> }>(
  () => ({ byDocument: {} }),
);

/** Reads again a Document's kept states, for its menu. */
export async function refreshKept(documentId: string): Promise<void> {
  const kept = await core.keptDeckStates(documentId);
  useKeptDecks.setState((state) => ({ byDocument: { ...state.byDocument, [documentId]: kept } }));
}

/** What a shape's text box that runs past it would fit at, to say so where it is. */
export interface Overflow {
  slide: number;
  shapeId: string;
  paragraphs: EditedParagraph[];
  fontScale: number;
  lineReduction: number;
}

/** What a gesture did, for its line. */
export type DeckGesture = "moved" | "resized" | "text" | "cell" | "fitted";

const doneWords =
  (what: DeckGesture, slide: number): Words =>
  (t) =>
    t(`viewer.deck.edit.${what}`, { slide });

/** Where the deck was saved, said after what was done. */
function savedWords(saved: DeckSaved, language: Language): WordsInLine {
  return (t, cut) => {
    const where =
      saved.kind !== "version"
        ? t("viewer.deck.saved.file", { name: cut(saved.name) })
        : saved.number === null
          ? t("viewer.deck.saved.kept")
          : t("viewer.deck.saved.version", { number: saved.number });
    const letGo =
      saved.kind === "file" && saved.letGo.length > 0
        ? t("viewer.deck.saved.letGo", {
            date: formatDateTime(saved.letGo[0] ?? "", language),
          })
        : "";
    return letGo ? `${where} ${letGo}` : where;
  };
}

const joined =
  (first: Words, then: WordsInLine): WordsInLine =>
  (t, cut) =>
    `${first(t)} · ${then(t, cut)}`;

export interface DeckEditing {
  /** Hands a gesture's edits over to be written. */
  edit(edits: ShapeEdit[], what: DeckGesture): void;
  /** The deck as the last edit wrote it, drawn while its version is one this window wrote. */
  written: Uint8Array | null;
  /** What names the deck's version: the same while this window's hand edits wrote it. */
  steady: string;
  /** The file that couldn't take the last edit, while it waits to be saved as a copy. */
  waiting: DeckUnwritable | null;
  saveCopy(): void;
  /** A text box that runs past its shape after typing, while the line about it shows. */
  overflow: Overflow | null;
  setOverflow(overflow: Overflow | null): void;
  /** Lets the text of the box that ran past it shrink to fit, as PowerPoint's would. */
  shrinkToFit(): void;
  /** A hand edit was written into the User's own file while this deck was open. */
  wroteFile: boolean;
}

/** Sittings handed from a deck's viewer to its copy's, which takes it up once it opens. */
const handedOn = new Map<string, string>();

/** Hand editing of the deck the viewer shows, `shown` being the content hash of what it read. */
export function useDeckEditing(
  document: Document,
  shown: string,
  tabId: string | null,
): DeckEditing {
  const language = useLanguage();
  const sitting = useRef<string | null>(null);
  const latest = useRef(shown);
  latest.current = shown;
  const steady = useSteadyVersion(document.id, shown);
  const [written, setWritten] = useState<{ key: string; bytes: Uint8Array } | null>(null);
  const [waiting, setWaiting] = useState<DeckUnwritable | null>(null);
  const [overflow, setOverflow] = useState<Overflow | null>(null);
  const [wroteFile, setWroteFile] = useState(false);

  // Another version than this viewer's hand edits wrote (another program's, an agent's, one put
  // back) is read again, and the next gesture begins a sitting on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: what names the deck changed
  useEffect(() => {
    setWritten(null);
    setWaiting(null);
    if (!handedOn.has(document.id)) sitting.current = null;
  }, [steady]);

  useEffect(() => {
    sitting.current = handedOn.get(document.id) ?? null;
    handedOn.delete(document.id);
    void refreshKept(document.id).catch((error: unknown) =>
      console.error("The deck's kept states couldn't be read.", error),
    );
    return () => {
      const id = sitting.current;
      sitting.current = null;
      if (id) {
        void core
          .closeDeckSitting(id)
          .catch((error: unknown) => console.error("The deck's sitting couldn't close.", error));
      }
    };
  }, [document.id]);

  /** Takes what the core did: draws it, or keeps the edit waiting. Null when it waits. */
  const took = useCallback(
    (result: DeckEdit): Extract<DeckEdit, { kind: "saved" }> | null => {
      if (result.kind === "unwritable") {
        sitting.current = result.sittingId;
        setWaiting(result);
        return null;
      }
      setWaiting(null);
      if (result.documentId !== document.id) {
        // The sitting goes on in the copy beside the deck, in a tab of its own beside this one.
        sitting.current = null;
        handedOn.set(result.documentId, result.sittingId);
        adopt(result.documentId, result.contentHash);
        const { layout, openDocument } = useAppStore.getState();
        const group = layout?.groups.find((each) => each.tabs.some((tab) => tab.id === tabId));
        void openDocument(
          { documentId: result.documentId },
          { as: "here", ...(group && { from: group.id }) },
        );
        return result;
      }
      sitting.current = result.sittingId;
      setWritten({
        key: steadyVersion(useHandVersions.getState(), document.id, result.contentHash),
        bytes: result.bytes,
      });
      if (result.saved.kind === "file") {
        setWroteFile(true);
        if (result.saved.keptId) void refreshKept(document.id);
      }
      return result;
    },
    [document.id, tabId],
  );

  /** Runs one write of the deck, telling the versions this window wrote what it wrote. */
  const writing = useCallback(
    async (run: () => Promise<DeckEdit>): Promise<DeckEdit> => {
      const done = beginWrite(document.id, latest.current);
      try {
        const result = await run();
        done(
          result.kind === "saved" && result.documentId === document.id ? result.contentHash : null,
        );
        return result;
      } catch (error) {
        done(null);
        throw error;
      }
    },
    [document.id],
  );

  const step = useCallback(
    (result: Extract<DeckEdit, { kind: "saved" }>, said: Words) => {
      const { sittingId, stepId } = result;
      const again = async (run: () => Promise<DeckEdit>) => {
        setOverflow(null);
        let done: DeckEdit;
        try {
          done = await writing(run);
        } catch {
          sitting.current = null;
          setWritten(null);
          throw new UndoRefused((t) => t("viewer.deck.undoRefused"), null);
        }
        if (!took(done)) throw new UndoRefused((t) => t("viewer.deck.waiting.undo"), null);
      };
      useUndo.getState().push({
        said: joined(said, savedWords(result.saved, language)),
        undo: () => again(() => core.undoDeckEdit(sittingId, stepId)),
        redo: () => again(() => core.redoDeckEdit(sittingId, stepId)),
      });
    },
    [took, writing, language],
  );

  const edit = useCallback(
    (edits: ShapeEdit[], what: DeckGesture) => {
      const slide = edits[0]?.slide ?? 1;
      // Text past its box is said of the deck as the last gesture left it.
      setOverflow(null);
      void makeInTurn(async () => {
        try {
          const result = took(
            await writing(() =>
              core.editDeck({
                documentId: document.id,
                sittingId: sitting.current,
                shown: latest.current,
                edits,
              }),
            ),
          );
          if (result) step(result, doneWords(what, slide));
        } catch (error) {
          sitting.current = null;
          setWritten(null);
          useAppStore.getState().reportError(error);
        }
      });
    },
    [document.id, took, writing, step],
  );

  const saveCopy = useCallback(() => {
    const id = waiting?.sittingId;
    if (!id) return;
    void makeInTurn(async () => {
      try {
        const result = took(await core.saveDeckCopy(id));
        if (result) step(result, (t) => t("viewer.deck.edit.copied"));
      } catch (error) {
        useAppStore.getState().reportError(error);
      }
    });
  }, [waiting, took, step]);

  const shrinkToFit = useCallback(() => {
    if (!overflow) return;
    setOverflow(null);
    edit(
      [
        {
          kind: "text",
          slide: overflow.slide,
          shape: overflow.shapeId,
          paragraphs: overflow.paragraphs,
          fit: {
            kind: "shrink",
            fontScale: overflow.fontScale,
            lineReduction: overflow.lineReduction,
          },
        },
      ],
      "fitted",
    );
  }, [overflow, edit]);

  return {
    edit,
    written: written?.key === steady ? written.bytes : null,
    steady,
    waiting,
    saveCopy,
    overflow,
    setOverflow,
    shrinkToFit,
    wroteFile,
  };
}

/** Puts the deck back as it stood when `kept` was kept, as one step to undo and redo. */
export function putBack(document: Document, kept: KeptDeckState, shown: string): void {
  const language = languageNow();
  /** Writes a kept state over the deck at `from`; what it put back, to go the other way from. */
  const restore = async (keptId: string, from: string) => {
    const restored = await core.restoreKeptDeck({ documentId: document.id, keptId, shown: from });
    forget(document.id);
    await refreshKept(document.id);
    return restored;
  };
  const refused = () => new UndoRefused((t) => t("viewer.deck.undoRefused"), null);
  void makeInTurn(async () => {
    try {
      let now = await restore(kept.id, shown);
      useUndo.getState().push({
        said: (t, cut) =>
          t("viewer.deck.restored", {
            name: cut(document.name),
            time: formatDateTime(kept.keptAt, language),
          }),
        undo: async () => {
          const before = now.before;
          if (!before) throw refused();
          now = await restore(before, now.contentHash).catch(() => {
            throw refused();
          });
        },
        redo: async () => {
          now = await restore(kept.id, now.contentHash).catch(() => {
            throw refused();
          });
        },
      });
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  });
}
