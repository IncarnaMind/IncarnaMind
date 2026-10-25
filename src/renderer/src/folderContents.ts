import { useMemo } from "react";
import type { Document, LibraryGroup, Mind } from "../../core/api";
import { useLanguage } from "./i18n";
import { sorted } from "./sort";
import { sortOf, useSort } from "./sortChoices";
import { folderFields } from "./sortFields";
import { useAppStore } from "./store";

const NO_GROUPS: readonly LibraryGroup[] = [];

/**
 * The Folders in the sidebar's order, and each Folder's Minds and `documents` (those in none
 * under null), worked out in one pass and again only when they change: the sidebar's tree and
 * Home's cards both show them.
 */
export function useFolderContents(documents: readonly Document[]) {
  const groups = useAppStore((state) => state.library?.groups) ?? NO_GROUPS;
  const assignments = useAppStore((state) => state.library?.assignments);
  const minds = useAppStore((state) => state.minds);
  const language = useLanguage();
  const sidebarSort = useSort(sortOf("sidebar"));

  const documentsByFolder = useMemo(() => {
    const folderOf = new Map(assignments?.map((item) => [item.documentId, item.groupId]));
    const grouped = new Map<string | null, Document[]>();
    for (const doc of documents) {
      const key = folderOf.get(doc.id) ?? null;
      const list = grouped.get(key);
      if (list) list.push(doc);
      else grouped.set(key, [doc]);
    }
    return grouped;
  }, [documents, assignments]);

  const mindsByFolder = useMemo(() => {
    const live = new Set(groups.map((group) => group.id));
    const grouped = new Map<string | null, Mind[]>();
    for (const mind of minds) {
      // A Mind whose Folder this window doesn't know (yet) shows outside any.
      const key = mind.folderId !== null && live.has(mind.folderId) ? mind.folderId : null;
      const list = grouped.get(key);
      if (list) list.push(mind);
      else grouped.set(key, [mind]);
    }
    return grouped;
  }, [minds, groups]);

  const orderedGroups = useMemo(
    () => sorted(groups, sidebarSort, folderFields, language),
    [groups, sidebarSort, language],
  );

  return { orderedGroups, documentsByFolder, mindsByFolder };
}
