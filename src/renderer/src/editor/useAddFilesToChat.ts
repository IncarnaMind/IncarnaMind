import { useCallback, useRef, useState } from "react";
import { displayName } from "../../../shared/documentNames";
import { core } from "../core";
import { folderChain } from "../folders";
import { type SkippedFileInfo, useAppStore } from "../store";

const keyOf = (file: SkippedFileInfo) => file.path ?? file.name;

/** Picked files the Question doesn't search: Documents already, and outside the Folder it is kept to. */
export interface NotSearched {
  names: string[];
  folder: string;
}

/**
 * "Add files…" in the composer (#2924): the system's picker, the files made Documents as Library ›
 * Add makes them, then each joins the Search scope as a Document dragged in does (`join`).
 *
 * A Question kept to one Folder (`insideFolderId`: a Folder wall, or the walled Folder the Library
 * shows) can't take a chip for a Document outside it, so new files are filed in that Folder
 * instead. One that is a Document already stays where the User filed it: `notSearched` names it,
 * for as long as the box is where it was added (`place`: the note, the conversation and the
 * Folder the Question is kept to).
 *
 * `skipped` is what this add couldn't take: said here as well as in the sidebar's footer, which
 * the User may have hidden.
 */
export function useAddFilesToChat({
  insideFolderId,
  place,
  join,
}: {
  insideFolderId: string | null;
  place: string;
  join(documentIds: readonly string[]): void;
}) {
  const latest = useRef({ insideFolderId, join });
  latest.current = { insideFolderId, join };
  const skippedFiles = useAppStore((state) => state.skippedFiles);
  const [mine, setMine] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<{ place: string; value: NotSearched } | null>(null);
  const placeNow = useRef(place);
  placeNow.current = place;

  const addFiles = useCallback(async () => {
    const before = useAppStore.getState().skippedFiles;
    const inside = latest.current.insideFolderId;
    const at = placeNow.current;
    setSaid(null);
    const ids = await useAppStore.getState().pickDocumentsForChat(inside);
    const after = useAppStore.getState().skippedFiles;
    // The store's list is a new one after every add, and the same after a closed dialog.
    if (after !== before) setMine(new Set(after.map(keyOf)));
    if (inside === null) {
      if (ids.length > 0) latest.current.join(ids);
      return;
    }
    if (ids.length > 0) {
      try {
        const value = await outsideOf(ids, inside);
        if (value) setSaid({ place: at, value });
      } catch (error) {
        useAppStore.getState().reportError(error);
      }
    }
  }, []);

  return {
    addFiles,
    skipped: skippedFiles.filter((file) => mine.has(keyOf(file))),
    notSearched: said !== null && said.place === place ? said.value : null,
    dismissNotSearched: () => setSaid(null),
  };
}

/** The Documents among `ids` that are filed neither in the Folder nor in one inside it, or null when none. */
async function outsideOf(ids: readonly string[], folderId: string): Promise<NotSearched | null> {
  const library = await core.getLibrary();
  const filed = new Map(library.assignments.map((each) => [each.documentId, each.groupId]));
  const within = (documentId: string) => {
    const groupId = filed.get(documentId) ?? null;
    return (
      groupId !== null && folderChain(library.groups, groupId).some((each) => each.id === folderId)
    );
  };
  const documents = useAppStore.getState().documents;
  const names = ids
    .filter((id) => !within(id))
    .flatMap((id) => {
      const document = documents.find((each) => each.id === id);
      return document ? [displayName(document)] : [];
    });
  const folder = library.groups.find((each) => each.id === folderId)?.name;
  return names.length > 0 && folder !== undefined ? { names, folder } : null;
}
