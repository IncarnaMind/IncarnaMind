/**
 * Where a Document is, shown beside its name where the name alone doesn't say (#1507): among
 * Documents that share a shown name, the folders that tell each apart (`whereShown`); in a
 * Linked folder, every Document's folder inside it, until Source locations show its folders as
 * on disk (#1250). Worked out once per change of the Documents or Linked folders, for every row,
 * the Library, ⌘K, findings and Citation cards. A Meeting's Transcript never takes the folder
 * IncarnaMind keeps it in ("Transcripts (2)"), which says nothing of which call
 * it was: a Citation of it shows its call's start instead (#3005, `transcriptsNamedAlike`).
 */
import type { Document, LinkedFolder } from "../../core/api";
import type { Language } from "../../core/language";
import { whereShown } from "../../shared/documentNames";
import { languageNow, translateNow } from "./i18n";
import { useAppStore } from "./store";

let cached: {
  documents: readonly Document[];
  linkedFolders: readonly LinkedFolder[];
  language: Language;
  places: ReadonlyMap<string, string>;
  transcripts: ReadonlySet<string>;
} | null = null;

function foldersWithin(root: string, path: string): string | null {
  const base = root.replace(/[\\/]+$/, "");
  if (!path.startsWith(base)) return null;
  const after = path.slice(base.length);
  // A sibling whose name starts with the root's ("/a/bc" for "/a/b") isn't inside it.
  if (after !== "" && !/^[\\/]/.test(after)) return null;
  const inside = after.split(/[\\/]/).filter(Boolean).slice(0, -1);
  return inside.length > 0 ? inside.join(" / ") : null;
}

function worked(documents: readonly Document[], linkedFolders: readonly LinkedFolder[]) {
  const language = languageNow();
  if (
    cached?.documents === documents &&
    cached.linkedFolders === linkedFolders &&
    cached.language === language
  ) {
    return cached;
  }
  const places = whereShown(documents, (place, count) =>
    translateNow("documents.place.twin", { place, count }),
  );
  const transcripts = new Set<string>();
  for (const document of documents) {
    if ((document.meetingMindId ?? null) === null || !places.has(document.id)) continue;
    places.delete(document.id);
    transcripts.add(document.id);
  }
  const roots = new Map(linkedFolders.map((each) => [each.id, each.path]));
  for (const document of documents) {
    const root = document.linkedFolderId ? roots.get(document.linkedFolderId) : undefined;
    if (!root || places.has(document.id)) continue;
    const folders = foldersWithin(root, document.path);
    if (folders) places.set(document.id, folders);
  }
  cached = { documents, linkedFolders, language, places, transcripts };
  return cached;
}

export const placesOf = (
  documents: readonly Document[],
  linkedFolders: readonly LinkedFolder[],
): ReadonlyMap<string, string> => worked(documents, linkedFolders).places;

/** The Meetings' Transcripts whose shown name another Document shares, by id. */
export const transcriptsNamedAlike = (
  documents: readonly Document[],
  linkedFolders: readonly LinkedFolder[],
): ReadonlySet<string> => worked(documents, linkedFolders).transcripts;

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
