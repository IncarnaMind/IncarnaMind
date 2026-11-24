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
import { describeError } from "../../errors";
import { languageNow, useLanguage } from "../../i18n";
import type { Words, WordsInLine } from "../../lineNames";
import { useAppStore } from "../../store";
import { makeInTurn, UndoRefused, undoSettled, useUndo } from "../../undo";
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
  /** Hands a gesture's edits over to be written; false once it was refused, nothing written. */
  edit(edits: ShapeEdit[], what: DeckGesture): Promise<boolean>;
  /**
   * The deck as the sitting has it: as its last write left it, or with the change that waits. It
   * is what is drawn while the deck's version is one this window wrote; null: the file is drawn.
   */
  written: Uint8Array | null;
  /** What names the deck's version: the same while this window's hand edits wrote it. */
  steady: string;
  /** The content hash of the file as the viewer read it, when it draws that: set by the viewer. */
  read: { current: string | null };
  /** The file that couldn't take the last edit, while it waits to be saved as a copy. */
  waiting: DeckUnwritable | null;
  saveCopy(): void;
  /** Writes the change that waits again, as the file may take it now. */
  tryAgain(): void;
  /** A text box that runs past its shape after typing, while the line about it shows. */
  overflow: Overflow | null;
  setOverflow(overflow: Overflow | null): void;
  /** Lets the text of the box that ran past it shrink to fit, as PowerPoint's would. */
  shrinkToFit(): void;
  /** A hand edit was written into the User's own file while this deck was open. */
  wroteFile: boolean;
}

/**
 * A sitting this window's hand edits go on with, by Document. It is kept while a tab of the window
 * shows the deck, as a look at another tab unmounts the viewer, and ends when the last tab showing
 * the deck closes, the deck changes elsewhere or is put back, or the window closes.
 */
interface Here {
  sittingId: string;
  /** What names the deck while the sitting's writes are what it holds (`steadyVersion`). */
  key: string;
  /** What the sitting's next gesture is made on: as last written, or with the change that waits. */
  bytes: Uint8Array;
  waiting: DeckUnwritable | null;
}

const useHere = create<{ byDocument: Readonly<Record<string, Here>> }>(() => ({ byDocument: {} }));

const setHere = (documentId: string, here: Here | null) =>
  useHere.setState((state) => {
    const { [documentId]: _, ...others } = state.byDocument;
    return { byDocument: here ? { ...others, [documentId]: here } : others };
  });

/** The sitting on this Document ends here: the next gesture begins another, from the file. */
function endHere(documentId: string): void {
  const here = useHere.getState().byDocument[documentId];
  if (!here) return;
  setHere(documentId, null);
  void core
    .closeDeckSitting(here.sittingId)
    .catch((error: unknown) => console.error("The deck's sitting couldn't close.", error));
}

const shownIn = (layout: ReturnType<typeof useAppStore.getState>["layout"]) =>
  new Set(
    (layout?.groups ?? []).flatMap((group) =>
      group.tabs.flatMap((tab) => (tab.item.kind === "document" ? [tab.item.documentId] : [])),
    ),
  );

// A deck's sitting ends once no tab shows the deck: one that was shown and isn't any more. It
// ends after the viewer has gone and handed over the words its open text box held, and their write.
useAppStore.subscribe((state, before) => {
  if (state.layout === before.layout) return;
  const now = shownIn(state.layout);
  const was = shownIn(before.layout);
  const gone = Object.keys(useHere.getState().byDocument).filter(
    (documentId) => was.has(documentId) && !now.has(documentId),
  );
  if (gone.length === 0) return;
  setTimeout(() => {
    void undoSettled().then(() => {
      const shown = shownIn(useAppStore.getState().layout);
      for (const documentId of gone) if (!shown.has(documentId)) endHere(documentId);
    });
  }, 0);
});

/** Whether the core refused because the deck changed under the sitting: it is read again. */
const changedUnder = (error: unknown) => describeError(error).wording?.key === "error.deck.changed";

/** Hand editing of the deck the viewer shows. */
export function useDeckEditing(document: Document, tabId: string | null): DeckEditing {
  const language = useLanguage();
  const latest = useRef(document.contentHash);
  latest.current = document.contentHash;
  const read = useRef<string | null>(null);
  const steady = useSteadyVersion(document.id, document.contentHash);
  const stored = useHere((state) => state.byDocument[document.id]);
  const here = stored?.key === steady ? stored : undefined;
  const [overflow, setOverflow] = useState<Overflow | null>(null);
  const [wroteFile, setWroteFile] = useState(false);

  // Another version than this window's hand edits wrote (another program's, an agent's, one put
  // back) is read again, and the next gesture begins a sitting on it.
  useEffect(() => {
    if (stored && stored.key !== steady) endHere(document.id);
  }, [stored, steady, document.id]);

  useEffect(() => {
    void refreshKept(document.id).catch((error: unknown) =>
      console.error("The deck's kept states couldn't be read.", error),
    );
  }, [document.id]);

  const keyOf = useCallback(
    (version: string) => steadyVersion(useHandVersions.getState(), document.id, version),
    [document.id],
  );

  /** Takes what the core did: draws it, or keeps the edit waiting. Null when it waits. */
  const took = useCallback(
    (result: DeckEdit): Extract<DeckEdit, { kind: "saved" }> | null => {
      if (result.kind === "unwritable") {
        setHere(document.id, {
          sittingId: result.sittingId,
          key: keyOf(latest.current),
          bytes: result.bytes,
          waiting: result,
        });
        return null;
      }
      if (result.documentId !== document.id) {
        // The sitting goes on in the copy beside the deck, in a tab of its own beside this one.
        setHere(document.id, null);
        adopt(result.documentId, result.contentHash);
        setHere(result.documentId, {
          sittingId: result.sittingId,
          key: steadyVersion(useHandVersions.getState(), result.documentId, result.contentHash),
          bytes: result.bytes,
          waiting: null,
        });
        const { layout, openDocument } = useAppStore.getState();
        const group = layout?.groups.find((each) => each.tabs.some((tab) => tab.id === tabId));
        void openDocument(
          { documentId: result.documentId },
          { as: "here", ...(group && { from: group.id }) },
        );
        return result;
      }
      setHere(document.id, {
        sittingId: result.sittingId,
        key: keyOf(result.contentHash),
        bytes: result.bytes,
        waiting: null,
      });
      if (result.saved.kind === "file") {
        setWroteFile(true);
        if (result.saved.keptId) {
          void refreshKept(document.id).catch((error: unknown) =>
            console.error("The deck's kept states couldn't be read.", error),
          );
        }
      }
      return result;
    },
    [document.id, tabId, keyOf],
  );

  /** A write the core refused: the deck changed under it, and is read again; else nothing changed. */
  const refused = useCallback(
    (error: unknown) => {
      if (!changedUnder(error)) return;
      endHere(document.id);
      forget(document.id);
    },
    [document.id],
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
        } catch (error) {
          console.error("A hand edit of the deck couldn't be undone or redone.", error);
          refused(error);
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
    [took, writing, refused, language],
  );

  const edit = useCallback(
    (edits: ShapeEdit[], what: DeckGesture) => {
      const slide = edits[0]?.slide ?? 1;
      // Text past its box is said of the deck as the last gesture left it.
      setOverflow(null);
      const drawn = read.current;
      return makeInTurn(async () => {
        const going = useHere.getState().byDocument[document.id];
        const on = going?.key === keyOf(latest.current) ? going : undefined;
        try {
          const result = took(
            await writing(() =>
              core.editDeck({
                documentId: document.id,
                sittingId: on?.sittingId ?? null,
                // What is drawn: a new sitting begins only on the file as the viewer read it.
                shown: drawn ?? latest.current,
                edits,
              }),
            ),
          );
          if (result) step(result, doneWords(what, slide));
          return true;
        } catch (error) {
          refused(error);
          useAppStore.getState().reportError(error);
          return false;
        }
      });
    },
    [document.id, took, writing, step, refused, keyOf],
  );

  const waiting = here?.waiting ?? null;
  const settle = useCallback(
    (run: (sittingId: string) => Promise<DeckEdit>, said: Words) => {
      const id = waiting?.sittingId;
      if (!id) return;
      void makeInTurn(async () => {
        try {
          const result = took(await writing(() => run(id)));
          if (result) step(result, said);
        } catch (error) {
          refused(error);
          useAppStore.getState().reportError(error);
        }
      });
    },
    [waiting, took, writing, step, refused],
  );
  const saveCopy = useCallback(
    () =>
      settle(
        (id) => core.saveDeckCopy(id),
        (t) => t("viewer.deck.edit.copied"),
      ),
    [settle],
  );
  const tryAgain = useCallback(
    () =>
      settle(
        (id) => core.retryDeckEdit(id),
        (t) => t("viewer.deck.edit.tried"),
      ),
    [settle],
  );

  const shrinkToFit = useCallback(() => {
    if (!overflow) return;
    setOverflow(null);
    void edit(
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
    written: here?.bytes ?? null,
    steady,
    read,
    waiting,
    saveCopy,
    tryAgain,
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
    endHere(document.id);
    forget(document.id);
    await refreshKept(document.id);
    return restored;
  };
  const refused = () => new UndoRefused((t) => t("viewer.deck.undoRefused"), null);
  void makeInTurn(async () => {
    try {
      let now = await restore(kept.id, shown);
      useUndo.getState().push({
        said: (t, cut) => {
          const restored = t("viewer.deck.restored", {
            name: cut(document.name),
            time: formatDateTime(kept.keptAt, language),
          });
          const [letGo] = now.letGo;
          return letGo
            ? `${restored} ${t("viewer.deck.saved.letGo", { date: formatDateTime(letGo, language) })}`
            : restored;
        },
        undo: async () => {
          const before = now.before;
          if (!before) throw refused();
          now = await restore(before, now.contentHash).catch((error: unknown) => {
            console.error("Putting the deck back couldn't be undone.", error);
            throw refused();
          });
        },
        redo: async () => {
          now = await restore(kept.id, now.contentHash).catch((error: unknown) => {
            console.error("Putting the deck back couldn't be done again.", error);
            throw refused();
          });
        },
      });
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
  });
}
