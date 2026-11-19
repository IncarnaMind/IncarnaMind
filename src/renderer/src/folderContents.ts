import { useMemo } from "react";
import type { Document, LibraryGroup } from "../../core/api";
import { useCanvases } from "./canvases";
import { useLanguage } from "./i18n";
import { isListedDocument } from "./meetingTranscript";
import { sorted } from "./sort";
import { sortOf, useSort } from "./sortChoices";
import { folderFields } from "./sortFields";
import { exampleMindIds, useAppStore } from "./store";

const NO_GROUPS: readonly LibraryGroup[] = [];

/** Each Folder's items, those in none under null. */
function byFolder<T extends { folderId: string | null }>(
  items: readonly T[],
  groups: readonly LibraryGroup[],
): Map<string | null, T[]> {
  const live = new Set(groups.map((group) => group.id));
  const grouped = new Map<string | null, T[]>();
  for (const item of items) {
    // One whose Folder this window doesn't know (yet) shows outside any.
    const key = item.folderId !== null && live.has(item.folderId) ? item.folderId : null;
    const list = grouped.get(key);
    if (list) list.push(item);
    else grouped.set(key, [item]);
  }
  return grouped;
}

/**
 * The Folders in the sidebar's order, and each Folder's Minds, Canvases and `documents` (those in
 * none under null), worked out in one pass and again only when they change: the sidebar's tree and
 * Home's cards both show them. `hideExamples` leaves the example Minds out, once the examples
 * are folded to one row (#1944).
 */
export function useFolderContents(documents: readonly Document[], { hideExamples = false } = {}) {
  const groups = useAppStore((state) => state.library?.groups) ?? NO_GROUPS;
  const assignments = useAppStore((state) => state.library?.assignments);
  const minds = useAppStore((state) => state.minds);
  const canvases = useCanvases((state) => state.canvases);
  const exampleIds = useAppStore((state) => exampleMindIds(state).join(" "));
  const language = useLanguage();
  const sidebarSort = useSort(sortOf("sidebar"));

  const documentsByFolder = useMemo(() => {
    const folderOf = new Map(assignments?.map((item) => [item.documentId, item.groupId]));
    const grouped = new Map<string | null, Document[]>();
    for (const doc of documents) {
      if (!isListedDocument(doc)) continue;
      const key = folderOf.get(doc.id) ?? null;
      const list = grouped.get(key);
      if (list) list.push(doc);
      else grouped.set(key, [doc]);
    }
    return grouped;
  }, [documents, assignments]);

  const mindsByFolder = useMemo(() => {
    const examples = hideExamples ? new Set(exampleIds.split(" ").filter(Boolean)) : null;
    return byFolder(examples ? minds.filter((mind) => !examples.has(mind.id)) : minds, groups);
  }, [minds, groups, hideExamples, exampleIds]);

  const canvasesByFolder = useMemo(() => byFolder(canvases, groups), [canvases, groups]);

  const orderedGroups = useMemo(
    () => sorted(groups, sidebarSort, folderFields, language),
    [groups, sidebarSort, language],
  );

  return { orderedGroups, documentsByFolder, mindsByFolder, canvasesByFolder };
}
