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
  KeptDeckStates,
} from "../../../../core/api";
import type { EditedParagraph, ShapeEdit } from "../../../../core/exports/pptxPatch/shapeEdit";
import type { Language } from "../../../../core/language";
import { formatDateTime } from "../../../../shared/dates";
import { core } from "../../core";
import { describeError } from "../../errors";
import { languageNow, useLanguage } from "../../i18n";
import type { Words, WordsInLine } from "../../lineNames";
import { chooseOutputLocation } from "../../outputFiles";
import { useAppStore } from "../../store";
import { makeInTurn, sayWhileSlow, UndoRefused, undoSettled, useUndo } from "../../undo";
import {
  adopt,
  beginWrite,
  forget,
  steadyVersion,
  useHandVersions,
  useSteadyVersion,
} from "./handVersions";

/** What each deck can be put back to, by Document, as its menu offers it. */
export const useKeptDecks = create<{ byDocument: Readonly<Record<string, KeptDeckStates>> }>(
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

/**
 * This window's name for itself as it gives the core a gesture, new with each load: the core lets
 * a gesture join its sitting on the version it began from only when it is the same viewer's.
 */
const VIEWER = crypto.randomUUID();

/** Deck writes held back by a smoke test, to see the window while a write takes long. */
let heldWrites: Promise<void> = Promise.resolve();
let releaseWrites: (() => void) | null = null;

/** Holds every hand edit of a deck before it reaches the core, or lets the held ones go (tests). */
export function holdDeckWrites(hold: boolean): void {
  if (hold && !releaseWrites) {
    heldWrites = new Promise((done) => {
      releaseWrites = done;
    });
  } else if (!hold && releaseWrites) {
    releaseWrites();
    releaseWrites = null;
    heldWrites = Promise.resolve();
  }
}

/** The name of the folder a file's path is in, whichever separator the system uses. */
const folderName = (path: string) => path.split(/[\\/]/).slice(-2, -1)[0] ?? "";

/** Where the deck was saved, said after what was done. */
function savedWords(saved: DeckSaved, language: Language): WordsInLine {
  return (t, cut) => {
    const where =
      saved.kind === "copy" && !saved.beside
        ? t("viewer.deck.saved.elsewhere", {
            name: cut(saved.name),
            folder: cut(folderName(saved.path)),
          })
        : saved.kind !== "version"
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
  /**
   * Hands a gesture's edits over to be written; false once it was refused, nothing written.
   * `leaving`: the window is going, so it goes to the core at once, not behind the window's queue.
   */
  edit(edits: ShapeEdit[], what: DeckGesture, leaving?: boolean): Promise<boolean>;
  /**
   * The deck as the sitting has it: as its last write left it, or with the change that waits. It
   * is what is drawn while the deck's version is one this window wrote; null: the file is drawn.
   */
  written: Uint8Array | null;
  /** What names the deck's version: the same while this window's hand edits wrote it. */
  steady: string;
  /** The content hash of the file as the viewer read it, when it draws that: set by the viewer. */
  read: { current: string | null };
  /** The bytes the viewer read, used only when a sitting's first edit finds the file unreadable. */
  loadedBytes: { current: Uint8Array | null };
  /** The file that couldn't take the last edit, while it waits to be saved as a copy. */
  waiting: DeckUnwritable | null;
  saveCopy(): void;
  chooseFolder(): void;
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
  /** The SHA-256 of `bytes`. */
  hash: string;
  waiting: DeckUnwritable | null;
}

/** The version the deck is at as this window last had it: what a Put back is made from. */
export const versionHere = (document: Document): string =>
  useHere.getState().byDocument[document.id]?.hash ??
  useAppStore.getState().documents.find((each) => each.id === document.id)?.contentHash ??
  document.contentHash;

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
// ends after the viewer has gone and handed over the words its open text box held, and their write,
// which may be the gesture that began the sitting.
useAppStore.subscribe((state, before) => {
  if (state.layout === before.layout) return;
  const now = shownIn(state.layout);
  const gone = [...shownIn(before.layout)].filter((documentId) => !now.has(documentId));
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
  const loadedBytes = useRef<Uint8Array | null>(null);
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

  // The line about text past its box names words of the version it was said of.
  // biome-ignore lint/correctness/useExhaustiveDependencies: what names the deck changed
  useEffect(() => setOverflow(null), [steady]);

  useEffect(() => {
    void refreshKept(document.id).catch((error: unknown) =>
      console.error("The deck's kept states couldn't be read.", error),
    );
  }, [document.id]);

  // A change that waits outlives its viewer: the deck opened again, after a closed tab, a reload
  // or in another window, takes it up from the core, which keeps it until it is saved.
  const takeUpWaiting = useCallback(
    (live: () => boolean = () => true) =>
      core
        .deckChangeWaiting(document.id)
        .then((waiting) => {
          if (!live() || !waiting || useHere.getState().byDocument[document.id]?.waiting) return;
          setHere(document.id, {
            sittingId: waiting.sittingId,
            key: steadyVersion(useHandVersions.getState(), document.id, latest.current),
            bytes: waiting.bytes,
            hash: waiting.contentHash,
            waiting,
          });
        })
        .catch((error: unknown) => {
          // Not taken up, the change can't be saved from here, and every gesture is refused for it.
          console.error("The deck's change that waits couldn't be read.", error);
          if (live()) useAppStore.getState().reportError(error);
        }),
    [document.id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again as the deck's version changes
  useEffect(() => {
    if (stored) return;
    let live = true;
    void takeUpWaiting(() => live);
    return () => {
      live = false;
    };
  }, [stored, steady, takeUpWaiting]);

  // The file back at a version this window wrote earlier (another program wrote it back): what the
  // window wrote last isn't what the file holds, so the file is read again.
  const seenAt = useRef<string | null>(null);
  useEffect(() => {
    if (!stored || stored.waiting) return;
    if (document.contentHash === stored.hash) {
      seenAt.current = stored.hash;
      return;
    }
    const writing = useHandVersions.getState().byDocument[document.id]?.writing ?? 0;
    if (seenAt.current === stored.hash && writing === 0) {
      seenAt.current = null;
      endHere(document.id);
      forget(document.id);
    }
  }, [document.contentHash, stored, document.id]);

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
          hash: result.contentHash,
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
          hash: result.contentHash,
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
        hash: result.contentHash,
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
      // Refused for a change that waits which this window hasn't taken up: it takes it up, so its
      // line and Save a copy show.
      if (describeError(error).wording?.key === "error.deck.waiting") void takeUpWaiting();
      if (!changedUnder(error)) return;
      endHere(document.id);
      forget(document.id);
    },
    [document.id, takeUpWaiting],
  );

  /** Runs one write of the deck, telling the versions this window wrote what it wrote. */
  const writing = useCallback(
    async (run: () => Promise<DeckEdit>): Promise<DeckEdit> => {
      const done = beginWrite(document.id, latest.current);
      try {
        await heldWrites;
        // A write that takes long (a slow or stalled share) says so where Undo's line is.
        const result = await sayWhileSlow(
          (t) => t("viewer.deck.saving", { name: document.name }),
          run,
        );
        done(
          result.kind === "saved" && result.documentId === document.id ? result.contentHash : null,
        );
        return result;
      } catch (error) {
        done(null);
        throw error;
      }
    },
    [document.id, document.name],
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
          const waits = describeError(error).wording?.key === "error.deck.waiting";
          throw new UndoRefused(
            (t) => t(waits ? "viewer.deck.waiting.undo" : "viewer.deck.undoRefused"),
            null,
          );
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
    (edits: ShapeEdit[], what: DeckGesture, leaving = false) => {
      const slide = edits[0]?.slide ?? 1;
      // Text past its box is said of the deck as the last gesture left it.
      setOverflow(null);
      const drawn = read.current;
      const make = async () => {
        const going = useHere.getState().byDocument[document.id];
        const on = going?.key === keyOf(latest.current) ? going : undefined;
        const shown = drawn ?? latest.current;
        const send = (shownBytes?: Uint8Array) =>
          writing(() =>
            core.editDeck({
              documentId: document.id,
              sittingId: on?.sittingId ?? null,
              // What is drawn: a new sitting begins only on the file as the viewer read it.
              shown,
              edits,
              viewer: VIEWER,
              ...(shownBytes && { shownBytes }),
            }),
          );
        try {
          let edited: DeckEdit;
          try {
            edited = await send();
          } catch (firstError) {
            const key = describeError(firstError).wording?.key;
            const retryWithShown =
              !on &&
              loadedBytes.current !== null &&
              (key === "error.deck.unwritable.cloud" ||
                key === "error.document.fileMissing" ||
                key === "error.document.fileUnavailable" ||
                describeError(firstError).reason !== null);
            if (!retryWithShown || !loadedBytes.current) throw firstError;
            edited = await send(loadedBytes.current);
          }
          const result = took(edited);
          if (result) step(result, doneWords(what, slide));
          return true;
        } catch (error) {
          refused(error);
          useAppStore.getState().reportError(error);
          return false;
        }
      };
      // As the window goes, the core takes it in the order it comes: the sitting keeps the order of
      // its own writes, and quitting waits for a write under way.
      return leaving ? make() : makeInTurn(make);
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
          // Cancelling the Output location picker leaves the change waiting without an error toast.
          if (describeError(error).wording?.key !== "error.files.notChosen") {
            useAppStore.getState().reportError(error);
          }
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
  const chooseFolder = useCallback(() => {
    void chooseOutputLocation().then((picked) => {
      if (picked) saveCopy();
    }, useAppStore.getState().reportError);
  }, [saveCopy]);
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
    loadedBytes,
    waiting,
    saveCopy,
    chooseFolder,
    tryAgain,
    overflow,
    setOverflow,
    shrinkToFit,
    wroteFile,
  };
}

/**
 * Puts the deck back as it was before its latest sitting (`sitting`), or as it was before
 * IncarnaMind first changed it (`first`), as one step to undo and redo. The version it is made
 * from is read as its turn comes, after any gesture still being written.
 */
export function putBack(document: Document, which: keyof KeptDeckStates): void {
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
    const kept = useKeptDecks.getState().byDocument[document.id]?.[which];
    if (!kept) return;
    try {
      let now = await restore(kept.id, versionHere(document));
      useUndo.getState().push({
        said: (t, cut) => {
          const restored =
            which === "first"
              ? t("viewer.deck.restoredFirst", { name: cut(document.name) })
              : t("viewer.deck.restored", {
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
