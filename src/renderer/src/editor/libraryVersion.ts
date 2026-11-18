/**
 * The version of the Library's own lists as this Note's check counts them (#2525), for a Note
 * that holds a check resting on them. It is asked of the core again whenever what the lists are
 * made of changes, so that check reads needs re-check once the Library differs.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import { LIBRARY_FACTS } from "../../../shared/libraryFacts";
import { core } from "../core";
import { useAppStore } from "../store";
import { claimSpans } from "./claimChecks";

const countsLibrary = (editor: Editor): boolean =>
  !editor.isDestroyed &&
  claimSpans(editor.state.doc).some(({ check }) =>
    check.versions?.some((version) => version.documentId === LIBRARY_FACTS),
  );

export function useLibraryListsVersion(editor: Editor, mindId: string): string | null {
  const [counted, setCounted] = useState(() => countsLibrary(editor));
  useEffect(() => {
    const read = () => setCounted(countsLibrary(editor));
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  const documents = useAppStore((state) => state.documents);
  const minds = useAppStore((state) => state.minds);
  const tags = useAppStore((state) => state.tags);
  const library = useAppStore((state) => state.library);
  const [read, setRead] = useState<{ mindId: string; version: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the lists are made of the Documents, notes, Tags and Folders.
  useEffect(() => {
    if (!counted) return;
    let active = true;
    core
      .libraryListsVersion(mindId)
      .then((version) => {
        if (active) setRead({ mindId, version });
      })
      .catch((error: unknown) => {
        if (active) useAppStore.getState().reportError(error);
      });
    return () => {
      active = false;
    };
  }, [counted, mindId, documents, minds, tags, library]);
  return counted && read?.mindId === mindId ? read.version : null;
}
