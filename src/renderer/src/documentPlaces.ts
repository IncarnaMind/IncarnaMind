/**
 * Where a Document is, shown beside its name where the name alone doesn't say (#1507): among
 * Documents that share a shown name, the folders that tell each apart (`whereShown`); in a
 * Linked folder, every Document's folder inside it, until Source locations show its folders as
 * on disk (#1250). Worked out once per change of the Documents or Linked folders, for every row,
 * the Library, ⌘K and Citation cards.
 */
import type { Document, LinkedFolder } from "../../core/api";
import { whereShown } from "../../shared/documentNames";
import { useAppStore } from "./store";

let cached: {
  documents: readonly Document[];
  linkedFolders: readonly LinkedFolder[];
  places: ReadonlyMap<string, string>;
} | null = null;

function foldersWithin(root: string, path: string): string | null {
  if (!path.startsWith(root)) return null;
  const after = path.slice(root.length);
  // A sibling whose name starts with the root's ("/a/bc" for "/a/b") isn't inside it.
  if (after !== "" && !/^[\\/]/.test(after)) return null;
  const inside = after.split(/[\\/]/).filter(Boolean).slice(0, -1);
  return inside.length > 0 ? inside.join(" / ") : null;
}

export function placesOf(
  documents: readonly Document[],
  linkedFolders: readonly LinkedFolder[],
): ReadonlyMap<string, string> {
  if (cached?.documents === documents && cached.linkedFolders === linkedFolders) {
    return cached.places;
  }
  const places = whereShown(documents);
  const roots = new Map(linkedFolders.map((each) => [each.id, each.path]));
  for (const document of documents) {
    const root = document.linkedFolderId ? roots.get(document.linkedFolderId) : undefined;
    if (!root || places.has(document.id)) continue;
    const folders = foldersWithin(root, document.path);
    if (folders) places.set(document.id, folders);
  }
  cached = { documents, linkedFolders, places };
  return places;
}

/** Where a Document is, as its row shows it, or null when its name is enough. */
export const useDocumentPlace = (documentId: string | null): string | null =>
  useAppStore((state) =>
    documentId === null
      ? null
      : (placesOf(state.documents, state.linkedFolders).get(documentId) ?? null),
  );

/** A Document's name with where it is, for one line of text: "Annual-Report · 2025". */
export const nameWithPlace = (name: string, place: string | null): string =>
  place ? `${name} · ${place}` : name;
