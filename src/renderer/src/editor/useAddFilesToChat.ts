import { useCallback, useRef, useState } from "react";
import { type SkippedFileInfo, useAppStore } from "../store";

const keyOf = (file: SkippedFileInfo) => file.path ?? file.name;

/**
 * "Add files…" in the composer (#2924): the system's picker, the files made Documents as Library ›
 * Add makes them, then each joins the Search scope as a Document dragged in does (`join`). Behind a
 * Folder wall (`wallFolderId`) they are filed in that Folder instead, which the Question already
 * searches, since the wall would refuse a chip for a Document outside it.
 *
 * `skipped` is what this add couldn't take: said here as well as in the sidebar's footer, which
 * the User may have hidden.
 */
export function useAddFilesToChat({
  wallFolderId,
  join,
}: {
  wallFolderId: string | null;
  join(documentIds: readonly string[]): void;
}) {
  const latest = useRef({ wallFolderId, join });
  latest.current = { wallFolderId, join };
  const skippedFiles = useAppStore((state) => state.skippedFiles);
  const [mine, setMine] = useState<ReadonlySet<string>>(new Set());

  const addFiles = useCallback(async () => {
    const before = useAppStore.getState().skippedFiles;
    const ids = await useAppStore.getState().pickDocumentsForChat(latest.current.wallFolderId);
    const after = useAppStore.getState().skippedFiles;
    // The store's list is a new one after every add, and the same after a closed dialog.
    if (after !== before) setMine(new Set(after.map(keyOf)));
    if (latest.current.wallFolderId === null && ids.length > 0) latest.current.join(ids);
  }, []);

  return { addFiles, skipped: skippedFiles.filter((file) => mine.has(keyOf(file))) };
}
