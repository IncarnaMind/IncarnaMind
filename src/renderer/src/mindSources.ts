/**
 * A Mind used as a source (#335): its snapshot Document on screen, and the
 * three changes — use it as a source, update the snapshot, remove it — each
 * with Undo. The core holds the snapshot and its versions; these only say
 * what the User asked for and put it back.
 */
import type { Document, Mind, MindSourceUpdate } from "../../core/api";
import { translate } from "../../shared/i18n";
import { mindName } from "../../shared/naming";
import { core } from "./core";
import type { Undoable } from "./objects";
import { useAppStore } from "./store";

/** The live Document that is this Mind's snapshot, if it has one. */
export const mindSourceOf = (
  documents: readonly Document[],
  mindId: string,
): Document | undefined => documents.find((document) => document.yourNote?.mindId === mindId);

/** The same, for a component. */
export function useMindSource(mindId: string | null): Document | undefined {
  return useAppStore((state) =>
    mindId === null ? undefined : mindSourceOf(state.documents, mindId),
  );
}

/** What the User calls a Mind in the lines about its snapshot. */
const nameOf = (mind: Pick<Mind, "title" | "autoTitle">): string => {
  const name = mindName(mind);
  if (name !== "") return name;
  return translate(useAppStore.getState().settings?.language ?? "en", "mind.untitled");
};

/** Saves each Mind's snapshot as a source, with one Undo: its Document goes again. */
export async function saveAsSources(minds: readonly Mind[]): Promise<Undoable> {
  const documents: Document[] = [];
  for (const mind of minds) documents.push(await core.saveMindAsSource(mind.id));
  const [only] = minds;
  return {
    said: (t) =>
      minds.length === 1 && only
        ? t("mind.source.saved", { name: nameOf(only) })
        : t("mind.source.savedMany", { count: minds.length }),
    undo: async () => {
      for (const document of documents) await core.deleteDocument(document.id);
    },
    redo: async () => {
      // The same Documents come back, so Citations that named them read as they did.
      await core.restore(documents.map((document) => ({ kind: "document", id: document.id })));
    },
  };
}

/** Takes a new snapshot over each Document's file, with one Undo: the version before it comes back. */
export async function updateSnapshots(minds: readonly Mind[]): Promise<Undoable> {
  const updates: MindSourceUpdate[] = [];
  for (const mind of minds) updates.push(await core.updateMindSourceSnapshot(mind.id));
  const [only] = minds;
  return {
    said: (t) =>
      minds.length === 1 && only
        ? t("mind.source.updated", { name: nameOf(only) })
        : t("mind.source.updatedMany", { count: minds.length }),
    undo: async () => {
      for (const update of updates) {
        await core.restoreMindSourceSnapshot(update.document.id, {
          text: update.previousText,
          snapshotAt: update.previousSnapshotAt,
        });
      }
    },
    redo: async () => {
      for (const update of updates) {
        await core.restoreMindSourceSnapshot(update.document.id, {
          text: update.snapshotText,
          snapshotAt: update.snapshotAt,
        });
      }
    },
  };
}

/** Removes each Mind's snapshot: it waits in Recently deleted, and Undo brings it back as a source. */
export async function removeAsSources(minds: readonly Mind[]): Promise<Undoable> {
  const live = useAppStore.getState().documents;
  const documents = minds.flatMap((mind) => {
    const document = mindSourceOf(live, mind.id);
    return document ? [document] : [];
  });
  for (const mind of minds) await core.removeMindSource(mind.id);
  const [only] = minds;
  return {
    said: (t) =>
      minds.length === 1 && only
        ? t("mind.source.removed", { name: nameOf(only) })
        : t("mind.source.removedMany", { count: minds.length }),
    undo: async () => {
      await core.restore(documents.map((document) => ({ kind: "document", id: document.id })));
    },
    redo: async () => {
      for (const mind of minds) await core.removeMindSource(mind.id);
    },
  };
}
