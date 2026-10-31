/**
 * The changes the undo stack takes back, each with the core call that undoes
 * it and the one that does it again (docs/designs/interaction-system.md, C.6):
 * a rename by the other name, a delete by `restore`, Tags by putting their
 * links back as they were. Each says what happened in the words of the undo
 * line, and what it was, for the Edit menu.
 */
import type { RestoreRef, TagLinkState } from "../../core/api";
import { core } from "./core";
import { languageNow } from "./i18n";
import type { Words } from "./lineNames";
import { formatCount } from "./linkedFolders";
import type { Translate } from "./objects";
import type { Undoable } from "./undo";

/** A name the User gave, or the words for what it is called when it has none. */
type Shown = string | Words;

const shownIn = (t: Translate, shown: Shown) => (typeof shown === "string" ? shown : shown(t));

/** Renamed: undone by the old name, done again by the new one. */
export function renamed(
  shown: Shown,
  rename: (name: string) => Promise<unknown>,
  { before, after }: { before: string; after: string },
): Undoable {
  return {
    said: (t) => t("object.renamed", { name: shownIn(t, shown) }),
    name: (t) => t("undo.name.rename"),
    undo: async () => {
      await rename(before);
    },
    redo: async () => {
      await rename(after);
    },
  };
}

/**
 * Sent to Recently deleted: undone by restoring it, done again by deleting it again.
 * Several are Documents, and are said by their count; one by its name.
 */
export function deleted(
  shown: Shown,
  refs: RestoreRef[],
  remove: () => Promise<unknown>,
  here?: { putBack(): void; takeOut(): void },
): Undoable {
  const count = refs.length;
  const counted = () => formatCount(count, languageNow());
  /** Whether the last Undo brought a Meeting back without its audio (#1253). */
  let audioLost = false;
  // Undo puts the User back where they were, so a Mind's tabs come back; a restore from
  // Recently deleted leaves the window as it is.
  const restore = async () => {
    audioLost = (await core.restore(refs, { reopen: true })).audioLost.length > 0;
  };
  return {
    said: (t) =>
      count > 1
        ? t("object.deleted.documents", { count: counted() })
        : t("object.deleted", { name: shownIn(t, shown) }),
    name: (t) =>
      count > 1
        ? t("undo.name.delete.documents", { count: counted() })
        : t("undo.name.delete", { name: shownIn(t, shown) }),
    undo: async () => {
      if (!here) return restore();
      // Back on the page at once, as they went: the core follows, and a refusal takes them out again.
      here.putBack();
      try {
        await restore();
      } catch (error) {
        here.takeOut();
        throw error;
      }
    },
    undoneNote: () =>
      audioLost ? (t) => t("meetings.audio.notRestored", { name: shownIn(t, shown) }) : null,
    redo: async () => {
      await remove();
    },
  };
}

/**
 * Documents added: undone by moving to Recently deleted those of the ones this add brought in that
 * are still its own, done again by bringing back exactly those. `take` says which it took.
 */
export function documentsAdded(count: number, take: () => Promise<RestoreRef[]>): Undoable {
  let taken: RestoreRef[] = [];
  return {
    said: (t) =>
      t(count === 1 ? "undo.documentAdded.one" : "undo.documentsAdded", {
        count: formatCount(count, languageNow()),
      }),
    name: (t) => t("undo.name.addDocuments"),
    undo: async () => {
      taken = await take();
    },
    redo: async () => {
      if (taken.length > 0) await core.restore(taken);
    },
  };
}

/** A folder linked: undone by unlinking it, which touches nothing on disk, done again by linking it again. */
export function folderLinked(
  shown: () => string,
  unlink: () => Promise<unknown>,
  link: () => Promise<unknown>,
): Undoable {
  return {
    said: (t) => t("undo.folderLinked", { name: shown() }),
    name: (t) => t("undo.name.linkFolder", { name: shown() }),
    undo: async () => {
      await unlink();
    },
    redo: async () => {
      await link();
    },
  };
}

/** A Linked folder paused or resumed: undone and done again by setting it as it was and as it is. */
export function linkedFolderPaused(
  shown: string,
  paused: boolean,
  setPaused: (paused: boolean) => Promise<unknown>,
): Undoable {
  return {
    said: (t) =>
      t(paused ? "undo.linkedFolderPaused" : "undo.linkedFolderResumed", { name: shown }),
    name: (t) => t(paused ? "linkedFolders.pause" : "linkedFolders.resume"),
    undo: async () => {
      await setPaused(!paused);
    },
    redo: async () => {
      await setPaused(paused);
    },
  };
}

/**
 * A Tag added to or taken off Documents: undone by putting each link back as it
 * was, with who chose it and no removal recorded, so automatic tagging carries on
 * as before; done again as the User did it.
 */
export function retagged(
  change: { added: boolean; tag: string; names: readonly string[] },
  before: TagLinkState[],
  again: () => Promise<unknown>,
): Undoable {
  const { added, tag, names } = change;
  const [only] = names;
  const count = names.length;
  return {
    said: (t) =>
      only !== undefined && count === 1
        ? t(added ? "undo.tagAdded.one" : "undo.tagRemoved.one", { name: only, tag })
        : t(added ? "undo.tagAdded" : "undo.tagRemoved", {
            count: formatCount(count, languageNow()),
            tag,
          }),
    name: (t) => t(added ? "undo.name.tagAdded" : "undo.name.tagRemoved"),
    undo: async () => {
      await core.revertDocumentTags(before);
    },
    redo: async () => {
      await again();
    },
  };
}
