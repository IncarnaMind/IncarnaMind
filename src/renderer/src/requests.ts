import { create } from "zustand";
import type { DeletedItem, LinkedFolder } from "../../core/api";

/**
 * The questions a command puts to the User before it acts: whether to unlink a
 * Linked folder, or delete from Recently deleted for good. A menu on any surface asks for one, and `RequestedDialogs` (mounted
 * once) shows it, so no row owns a dialog; a Meeting's audio asks on its own
 * line. Deleting asks nothing: it goes to Recently deleted, with Undo.
 */
interface Requests {
  unlink: { linked: LinkedFolder; name: string } | null;
  /** Items to delete permanently, once the User has read what is lost; `empty` when it is all of Recently deleted. */
  deletePermanently: { items: readonly DeletedItem[]; empty: boolean } | null;
  /** The Meeting whose audio the User is asked about, on that Meeting's line. */
  deleteAudio: { meetingId: string } | null;
  chooseLocalModel: true | null;
  /** The Folder whose name and description the Library opens to edit. */
  editFolder: string | null;
  /** The Tag Manage Tags opens on, to edit, or to merge into another. */
  manageTag: { id: string; mode?: "edit" | "merge" } | null;
  /** The Folder just made, whose name field the sidebar opens in its row. */
  nameFolder: string | null;
  /** The Linked folder just linked: the sidebar shows where it is, and its row is washed for a moment (#763). */
  showLinked: string | null;
  ask(request: Partial<Omit<Requests, "ask" | "clear">>): void;
  clear(key: keyof Omit<Requests, "ask" | "clear">): void;
}

export const useRequests = create<Requests>((set) => ({
  unlink: null,
  deletePermanently: null,
  deleteAudio: null,
  chooseLocalModel: null,
  editFolder: null,
  manageTag: null,
  nameFolder: null,
  showLinked: null,
  ask: (request) => set(request),
  clear: (key) => set({ [key]: null }),
}));
