/**
 * Moving Minds, Documents and conversations between Folders, as the sidebar's
 * drag and drop, a Mind's "Move to…" and (#212) the Library's do it: one shape for what is
 * moved, the store as it looks at once (before the core confirms), the line
 * that says what happened, and the moves that take it back. Pure: no store,
 * no bridge, so the tests import it.
 */

import type {
  Conversation,
  Document,
  DocumentGroupAssignment,
  FolderMove,
  LibrarySnapshot,
  Mind,
  MovedItem,
} from "../../core/api";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { conversationName, mindName } from "../../shared/naming";
import { applyAssignments } from "./documentUpdates";

/** What a move takes: Minds, Documents and conversations, by id, any number of each. */
export interface MoveItems {
  mindIds?: readonly string[];
  documentIds?: readonly string[];
  conversationIds?: readonly string[];
}

/** The ids of each kind, each once. */
export function itemsOf(items: MoveItems): {
  mindIds: string[];
  documentIds: string[];
  conversationIds: string[];
} {
  return {
    mindIds: [...new Set(items.mindIds ?? [])],
    documentIds: [...new Set(items.documentIds ?? [])],
    conversationIds: [...new Set(items.conversationIds ?? [])],
  };
}

/** The Minds and the Library as they are once these have moved, shown before the core says so. */
export function movedLocally(
  state: { minds: readonly Mind[]; library: LibrarySnapshot | null },
  items: MoveItems,
  folderId: string | null,
): { minds: Mind[]; library: LibrarySnapshot | null } {
  const { mindIds, documentIds } = itemsOf(items);
  const moving = new Set(mindIds);
  const minds = state.minds.map((mind) => (moving.has(mind.id) ? { ...mind, folderId } : mind));
  if (!state.library || documentIds.length === 0) return { minds, library: state.library };
  const current = new Map(state.library.assignments.map((each) => [each.documentId, each]));
  const changed = new Map<string, DocumentGroupAssignment>(
    documentIds.map((documentId) => [
      documentId,
      {
        documentId,
        model: null,
        ...current.get(documentId),
        groupId: folderId,
        source: "user",
        suggested: false,
        status: "classified",
        error: null,
      },
    ]),
  );
  return { minds, library: applyAssignments(state.library, changed) };
}

/**
 * The moves that take a move's Minds and conversations back: each to the Folder
 * it was in, in as few moves as there were Folders they came from. Those that
 * didn't move are left. Its Documents go back with `restoreAssignment`, so an
 * automatic choice stays automatic.
 */
export function undoMoves(move: FolderMove): { items: MoveItems; folderId: string | null }[] {
  const back = new Map<string | null, { mindIds?: string[]; conversationIds?: string[] }>();
  const add = (kind: "mindIds" | "conversationIds", { id, from }: MovedItem) => {
    if (from === move.folderId) return;
    const items = back.get(from) ?? {};
    items[kind] = [...(items[kind] ?? []), id];
    back.set(from, items);
  };
  for (const item of move.minds) add("mindIds", item);
  for (const item of move.conversations) add("conversationIds", item);
  return [...back].map(([folderId, items]) => ({ folderId, items }));
}

/** The Folders a move's undo puts things back in, each once. */
export function foldersMovedFrom(move: FolderMove): string[] {
  const from = [
    ...move.minds.map((item) => item.from),
    ...move.conversations.map((item) => item.from),
    ...move.documents.map((item) => item.previous?.groupId ?? null),
  ];
  return [...new Set(from.filter((id): id is string => id !== null && id !== move.folderId))];
}

/** The names of these Folders, for the refusal when one is gone by the time an undo puts something back in it. */
export function namesOfFolders(
  library: LibrarySnapshot | null,
  ids: readonly (string | null)[],
): Map<string, string> {
  const wanted = new Set(ids);
  return new Map(
    (library?.groups ?? [])
      .filter((group) => wanted.has(group.id))
      .map((group) => [group.id, group.name]),
  );
}

type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface Names {
  minds: readonly Pick<Mind, "id" | "title" | "autoTitle">[];
  documents: readonly Pick<Document, "id" | "name">[];
  conversations?: readonly Pick<Conversation, "id" | "title" | "autoTitle">[];
}

/**
 * `names` kept to what a line about these items says: the one item, by the fields its name is
 * made from, when there is one, and none when it says only how many. A line made from the result
 * holds nothing of the lists the names were found in.
 */
export function namesOfMoving(items: MoveItems, names: Names): Names {
  const { mindIds, documentIds, conversationIds } = itemsOf(items);
  const one = mindIds.length + documentIds.length + conversationIds.length === 1;
  const mind = one ? names.minds.find((each) => each.id === mindIds[0]) : undefined;
  const document = one ? names.documents.find((each) => each.id === documentIds[0]) : undefined;
  const conversation = one
    ? names.conversations?.find((each) => each.id === conversationIds[0])
    : undefined;
  return {
    minds: mind ? [{ id: mind.id, title: mind.title, autoTitle: mind.autoTitle }] : [],
    documents: document ? [{ id: document.id, name: document.name }] : [],
    conversations: conversation
      ? [{ id: conversation.id, title: conversation.title, autoTitle: conversation.autoTitle }]
      : [],
  };
}

/** What moves, as the line and the Edit menu say it: one by its name, several by how many of what. */
function whatMoves(
  t: Translate,
  items: MoveItems,
  names: Names,
): { name: string } | { count: number; kind: "minds" | "documents" | "conversations" | "items" } {
  const { mindIds, documentIds, conversationIds } = itemsOf(items);
  const count = mindIds.length + documentIds.length + conversationIds.length;
  if (count === 1) {
    const mind = names.minds.find((each) => each.id === mindIds[0]);
    const document = names.documents.find((each) => each.id === documentIds[0]);
    const conversation = names.conversations?.find((each) => each.id === conversationIds[0]);
    const name = mind
      ? mindName(mind) || t("mind.untitled")
      : conversation
        ? conversationName(conversation) || t("conversation.untitled")
        : (document?.name ?? "");
    return { name };
  }
  const only = (ids: readonly string[]) => ids.length === count;
  const kind = only(mindIds)
    ? "minds"
    : only(documentIds)
      ? "documents"
      : only(conversationIds)
        ? "conversations"
        : "items";
  return { count, kind };
}

/**
 * What the line says once something moved: "Moved “Shortlist” to Finance",
 * or for several, how many of what ("Moved 3 Documents to Finance").
 */
export function moveMessage(
  t: Translate,
  items: MoveItems,
  folderName: string,
  names: Names,
): string {
  const what = whatMoves(t, items, names);
  if ("name" in what) return t("move.done", { name: what.name, folder: folderName });
  return t(`move.done.${what.kind}`, { count: what.count, folder: folderName });
}

/** What a drop on a Folder would do, as its target says it: "Move to Finance", "Move 3 Documents to Finance". */
export function moveLabel(t: Translate, items: MoveItems, folderName: string): string {
  const what = whatMoves(t, items, { minds: [], documents: [] });
  if ("name" in what) return t("drop.moveTo", { folder: folderName });
  return t(`drop.moveTo.${what.kind}`, { count: what.count, folder: folderName });
}

/**
 * What the line says once a Folder is made: "Made “Chapter 2”", and with what
 * went into it, "Made “Chapter 2” with 3 Documents".
 */
export function madeMessage(
  t: Translate,
  folderName: string,
  items: MoveItems | null,
  names: Names,
): string {
  const held = itemsOf(items ?? {});
  if (held.mindIds.length + held.documentIds.length === 0) {
    return t("folder.made", { name: folderName });
  }
  const what = whatMoves(t, held, names);
  if ("name" in what) return t("folder.made.one", { name: folderName, item: what.name });
  const kind = what.kind === "minds" || what.kind === "documents" ? what.kind : "items";
  return t(`folder.made.${kind}`, { name: folderName, count: what.count });
}

/** What is moved, as its drag and "Move to…" name it: "Shortlist", "3 Documents", "3 items". */
export function movingName(t: Translate, items: MoveItems, names: Names): string {
  const what = whatMoves(t, items, names);
  if ("name" in what) return what.name;
  if (what.kind === "minds") return t("mind.count", { count: what.count });
  if (what.kind === "documents") return t("library.count", { count: what.count });
  return t("move.items", { count: what.count });
}

/** The move as the Edit menu names it: "Move “Shortlist”", "Move 3 Documents". */
export function moveName(t: Translate, items: MoveItems, names: Names): string {
  const what = whatMoves(t, items, names);
  if ("name" in what) return t("undo.name.move", { name: what.name });
  return t(`undo.name.move.${what.kind}`, { count: what.count });
}
