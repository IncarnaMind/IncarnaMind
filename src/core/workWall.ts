/**
 * The work wall (CONTEXT.md): what a place may read, read again and file into, by the Folders
 * that keep their work inside. Every feature asks here, so none applies the wall its own way.
 */
import {
  folderScope,
  hasSearchScope,
  holdsText,
  mindSearchScope,
  NO_SCOPE,
} from "../shared/searchScope";
import { explicitWalledFolderScope } from "./answers/scopeLine";
import {
  type DeletedItem,
  type Document,
  NOT_IN_A_FOLDER_ID,
  type PassageSearchPlace,
  type SearchScope,
  type TurnPlace,
} from "./api";
import type { DocumentFilter } from "./documents";
import { NotFoundError } from "./errors";
import { resolveSearchScope, type ScopeSources } from "./scope";

export interface WorkWallOptions {
  /** Read when asked, never kept: the Library is made after the modules that ask about walls. */
  library: () => {
    folders(): readonly { id: string; name: string; keepInside: boolean }[];
    /** The nearest Folder keeping its work inside, from `folderId` up; `deleted` reads one in Recently deleted. */
    wallOf(folderId: string, deleted?: boolean): string | null;
    wallsOf(): ReadonlyMap<string, string | null>;
    treeDocumentIds(folderId: string): string[];
    allTreeDocumentIds(folderId: string): string[];
    assign(documentId: string, folderId: string): unknown;
  };
  documents: {
    ids(filter: DocumentFilter): string[];
    getMany(documentIds: readonly string[]): Pick<Document, "status" | "fileStatus">[];
  };
  linkedFolders: { subtree(folderId: string): string[] };
  /** The files IncarnaMind wrote from Notes in these Folders. */
  ownFiles: { writtenFrom(folderIds: readonly string[]): string[] };
  /** The Folder a Note is in: null in none, and once the Note is deleted. */
  folderOfNote(mindId: string | null): string | null;
  /**
   * The Folder a Question is asked in: its Note's, else its conversation's, null with neither.
   * Throws `NotFoundError` once that Note or conversation is deleted.
   */
  folderOfTurn(place: TurnPlace): string | null;
  /**
   * "Every Document" for a search with no Search scope: null when it is all of them. `focusOnly`:
   * `mindId` is only the Note in focus of a Question in the assistant (#3487).
   */
  unscopedDocuments(mindId: string | null, focusOnly?: boolean): string[] | null;
  /** Whether the User can read a Note now. */
  readableNote(mindId: string): boolean;
}

export type WorkWall = ReturnType<typeof createWorkWall>;

export function createWorkWall(options: WorkWallOptions) {
  const { library, documents, linkedFolders, ownFiles, folderOfNote } = options;
  const sources: ScopeSources = {
    folderTree: (folderId) => linkedFolders.subtree(folderId),
    organizedFolderDocuments: (folderId) => library().treeDocumentIds(folderId),
    documentIds: (filter) => documents.ids(filter),
  };

  /** Whether a scope names Folders inside `wallId` only: a Note behind a wall reads such a scope itself (#2427). */
  const scopeInsideWall = (scope: SearchScope, wallId: string): boolean =>
    scope.tagIds.length === 0 &&
    scope.documentIds.length === 0 &&
    scope.folderIds.length > 0 &&
    scope.folderIds.every((id) => library().wallOf(id) === wallId);
  const constrainedScope = (scope: SearchScope, mindId: string | null = null): SearchScope => {
    const own = folderOfNote(mindId);
    const ownWall = own === null ? null : library().wallOf(own);
    if (ownWall !== null) return scopeInsideWall(scope, ownWall) ? scope : folderScope(ownWall);
    return { ...scope, folderIds: scope.folderIds.filter((id) => library().wallOf(id) === null) };
  };
  /** The ids of the live Documents a Search scope covers, read from `mindId`'s side of the walls; null with no Search scope (every Document). */
  const resolveScope = (scope: SearchScope | null, mindId: string | null = null) => {
    const wanted = scope ?? NO_SCOPE;
    const walled = library()
      .folders()
      .filter((folder) => folder.keepInside);
    const own = folderOfNote(mindId);
    const ownWall = own === null ? null : library().wallOf(own);
    const explicitFolderScope = explicitWalledFolderScope(wanted, mindId, (id) =>
      id === null ? null : library().wallOf(id),
    );
    if (ownWall !== null || explicitFolderScope) {
      return resolveSearchScope(
        ownWall !== null ? constrainedScope(wanted, mindId) : wanted,
        sources,
      );
    }
    const constrained = constrainedScope(wanted, mindId);
    if (ownWall === null && hasSearchScope(wanted) && !hasSearchScope(constrained)) return [];
    const resolved = resolveSearchScope(constrained, sources);
    if (ownWall !== null || walled.length === 0) return resolved;
    const excluded = new Set(walledDocuments());
    return (resolved ?? documents.ids({})).filter((id) => !excluded.has(id));
  };
  const folderIdsInScope = (folderIds: readonly string[]) =>
    folderIds.length === 1 && walledFolderId(folderIds[0] ?? null) !== null
      ? [...folderIds]
      : constrainedScope({ folderIds: [...folderIds], tagIds: [], documentIds: [] }).folderIds;
  /** The wall a Folder is behind: itself, or the nearest Folder above it keeping its work inside; null for none, and for no Folder. */
  const walledFolderId = (folderId: string | null): string | null => {
    if (folderId === null || folderId === NOT_IN_A_FOLDER_ID) return null;
    return library().wallOf(folderId);
  };
  // Behind a wall: filed in it or in a Folder inside it, or a file IncarnaMind wrote from one of
  // its Notes, wherever in its tree that Note is, and wherever the file was indexed again (a
  // Linked folder holding the Output location).
  const behindWall = (folderId: string) => {
    const walls = library().wallsOf();
    const inside = [...walls].filter(([, wall]) => wall === folderId).map(([id]) => id);
    return [...library().allTreeDocumentIds(folderId), ...ownFiles.writtenFrom(inside)];
  };
  const wallOfDocument = (documentId: string) =>
    library()
      .folders()
      .find((folder) => folder.keepInside && behindWall(folder.id).includes(documentId));
  /** The wall a Document is behind; null for none. */
  const walledDocument = (documentId: string): string | null =>
    wallOfDocument(documentId)?.id ?? null;
  /** All walls around each Document, including a Note's output indexed again in another Folder. */
  const documentWalls = () => {
    const byDocument = new Map<string, string[]>();
    for (const folder of library().folders()) {
      if (!folder.keepInside) continue;
      for (const id of new Set(behindWall(folder.id))) {
        const walls = byDocument.get(id) ?? [];
        walls.push(folder.id);
        byDocument.set(id, walls);
      }
    }
    return byDocument;
  };
  /** The Documents behind any wall. */
  const walledDocuments = (): string[] =>
    library()
      .folders()
      .filter((folder) => folder.keepInside)
      .flatMap((folder) => behindWall(folder.id));
  /** The wall a thing in Recently deleted was behind: its Folder's, or a deleted Folder's own or its parent's. */
  const deletedWall = (item: DeletedItem): string | null =>
    item.kind === "folder" ? library().wallOf(item.id, true) : walledFolderId(item.groupId);
  const walledFolderName = (documentId: string): string | null =>
    wallOfDocument(documentId)?.name ?? null;
  /**
   * The wall of a Question asked from a Note, else in a conversation with no Note open: the
   * Note's Folder, else the conversation's, judged against today's walls (#1934). Throws
   * `NotFoundError` once that Note or conversation is deleted: it is behind no wall then, nor
   * outside every one.
   */
  const turnWall = (place: TurnPlace): string | null => walledFolderId(options.folderOfTurn(place));
  /** The wall a Note is behind; null when it is behind none. */
  const walledFolder = (mindId: string | null): string | null =>
    walledFolderId(folderOfNote(mindId));
  /**
   * Whether a Note may read again the Document a Citation names (#1934): never a Document kept
   * inside a walled Folder the Note is outside. Recheck, Add to Note, the edit's kept Citations
   * and a figure's inputs all ask this one question, so no path forgets the wall as Edit with AI
   * did (#2746). A caller with no Note (an Answer in the assistant, a Document's viewer) is
   * reading as browsing is, and may.
   */
  const mayRecheckIn = (mindId: string | null, documentId: string): boolean => {
    const wall = walledDocument(documentId);
    return wall === null || mindId === null || wall === walledFolder(mindId);
  };
  /**
   * Whether a Citation may be read again from where it is shown (#1934, #2782): the wall of the
   * Note it is in, or of the conversation it is in when that has no Note; somewhere with neither
   * reads as browsing is, which may. A place whose wall can't be judged (its Note or conversation
   * gone) may not.
   */
  const mayRecheckFrom = (place: TurnPlace, documentId: string): boolean => {
    const wall = walledDocument(documentId);
    if (wall === null) return true;
    if (place.mindId === null && place.conversationId === null) return true;
    try {
      return wall === turnWall(place);
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  };
  /**
   * The one place deciding where the assistant files what it makes (#1934): work behind the wall
   * `wallId` files it in that Folder, or in a Folder inside it when that is the one `asked`; it
   * never leaves the wall. Work outside every wall never files in a walled Folder. Null: it
   * can't be filed, so nothing may be made, as when the wall's Folder is gone or the turn's
   * wall isn't known.
   */
  const filedWithin = (
    wallId: string | null,
    asked: string | null,
  ): { folderId: string | null } | null => {
    if (wallId === null) {
      if (asked === null) return { folderId: null };
      // A Folder that gained a wall takes nothing from outside it; one that is gone takes nothing.
      if (walledFolderId(asked) !== null) return { folderId: null };
      return library()
        .folders()
        .some((folder) => folder.id === asked)
        ? { folderId: asked }
        : null;
    }
    const wall = library()
      .folders()
      .find((folder) => folder.id === wallId);
    // The wall's Folder is gone: nothing may be made. Its wall switched off since: no wall is left
    // to stay inside, so the file goes where it asks, as before it had one (#2250).
    if (!wall) return null;
    if (!wall.keepInside) return filedWithin(null, asked);
    if (asked === null) return { folderId: wallId };
    return library().wallOf(asked) === wallId ? { folderId: asked } : null;
  };
  /**
   * Whether work on the wall `wallId`'s side (null: outside every wall) may be filed in `folderId`
   * now: the walls are read here, and a Document behind another wall (`behind`) never crosses it
   * (#2250). One door for a page, a paste and a move alike.
   */
  const mayFileWithin = (
    wallId: string | null,
    folderId: string | null,
    behind: string | null,
  ): boolean =>
    (behind === null || behind === wallId) && filedWithin(wallId, folderId)?.folderId === folderId;
  /**
   * Files a Document by the walls as they are at this moment (#2250): a wall switched on while the
   * work was under way is judged here, never where it was before. A Document behind another wall
   * stays where it is, and a Folder that gained a wall takes nothing from outside it. Null: it
   * isn't filed, because `filedWithin` gives this side no Folder or the Document is on another side.
   */
  const fileWithin = (
    documentId: string,
    wallId: string | null,
    asked: string | null,
  ): { folderId: string | null } | null => {
    const filed = filedWithin(wallId, asked);
    if (filed === null) return null;
    if (!mayFileWithin(wallId, filed.folderId, walledDocument(documentId))) return null;
    if (filed.folderId !== null) library().assign(documentId, filed.folderId);
    return filed;
  };
  /** The Documents filed in a wall's Folder and the Folders inside it, whoever asks. */
  const filedInWall = (wallId: string): string[] | null =>
    resolveSearchScope(folderScope(wallId), sources);
  /**
   * The Documents a Search scope covers; with no scope, "every Document" as `unscopedDocuments`
   * gives it (#1942, #3083). Every searching surface resolves a default scope here, so all of
   * them follow one rule; the Library count and the renderer state the same rule for browsing.
   */
  const scopeDocuments = (
    scope: SearchScope | null,
    mindId: string | null = null,
    focusOnly = false,
  ): string[] | null => {
    if (scope && hasSearchScope(scope)) return resolveScope(scope, mindId);
    const unscoped = options.unscopedDocuments(mindId, focusOnly);
    const resolved = resolveScope(NO_SCOPE, mindId);
    if (resolved === null) return unscoped;
    if (unscoped === null) return resolved;
    const own = new Set(unscoped);
    return resolved.filter((id) => own.has(id));
  };
  /**
   * The Documents a local search reads for a Question, on its side of the Folder walls (#1934),
   * as the Answer's turn is judged: null for every Document. A place whose Folder isn't recorded
   * reads nothing.
   */
  const documentsToSearch = (
    scope: SearchScope | null,
    place: PassageSearchPlace,
  ): string[] | null => {
    if (place.kind === "turn") {
      const wall = turnWall(place);
      return wall === null ? scopeDocuments(scope, place.mindId) : resolveScope(folderScope(wall));
    }
    const mindId = place.askedFrom?.mindId ?? null;
    const readsMind =
      mindId !== null && place.askedFrom?.deleted !== true && options.readableNote(mindId);
    if (readsMind) return scopeDocuments(scope, mindId, true);
    if (place.folderAskedIn === undefined) return [];
    const wall = walledFolderId(place.folderAskedIn);
    return wall === null ? scopeDocuments(scope, null) : resolveScope(folderScope(wall));
  };
  /** What a Question from a Note searches, by the one rule (`mindSearchScope`); null: every Document. */
  const searchedScope = (scope: SearchScope | null, mindId: string | null) => {
    const folderId = folderOfNote(mindId);
    const wall = walledFolderId(folderId);
    const holds =
      folderId !== null &&
      documents
        .getMany(resolveScope({ folderIds: [folderId], tagIds: [], documentIds: [] }, mindId) ?? [])
        .some(holdsText);
    const searched = mindSearchScope(
      scope ?? { folderIds: [], tagIds: [], documentIds: [] },
      folderId,
      holds,
    );
    // A Note behind a wall reads its own Folder or a Folder inside the wall, never one beside it;
    // with nothing of its own to search, the wall stands for every Document (#2427).
    if (hasSearchScope(searched))
      return wall === null ? searched : constrainedScope(searched, mindId);
    return wall === null ? null : folderScope(wall);
  };

  return {
    scopeInsideWall,
    constrainedScope,
    resolveScope,
    folderIdsInScope,
    walledFolderId,
    walledDocument,
    walledDocuments,
    documentWalls,
    deletedWall,
    walledFolderName,
    turnWall,
    walledFolder,
    mayRecheckIn,
    mayRecheckFrom,
    filedWithin,
    mayFileWithin,
    fileWithin,
    filedInWall,
    scopeDocuments,
    documentsToSearch,
    searchedScope,
  };
}
