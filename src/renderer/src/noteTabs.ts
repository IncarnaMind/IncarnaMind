import type { Editor } from "@tiptap/core";
import { create } from "zustand";
import {
  addNoteTab,
  deleteNoteTab,
  moveNoteTab,
  type NoteTab,
  noteTabsOf,
} from "./editor/noteTabs";
import { mindEditor } from "./editor/openEditors";
import { translateNow } from "./i18n";
import type { ObjectRef, Translate } from "./objects";

/** A tab's name as the panel shows it: its title, else "Tab 2" by its place (#3414). */
export const tabName = (tab: NoteTab, index: number, t: Translate): string =>
  tab.title || t("noteTabs.defaultTitle", { n: index + 1 });

const defaultTitle = (n: number) => translateNow("noteTabs.defaultTitle", { n });

/** How the menus, the keys and ⌘K name a tab: its Note and the key its tab Block gives it. */
export const noteTabRef = (mindId: string, tab: NoteTab): ObjectRef => ({
  kind: "noteTab",
  id: `${mindId}/${tab.id ?? ""}`,
});

/** The tab a ref names, where it is now, with the editor showing its Note; null when neither is. */
export function noteTabOf(ref: ObjectRef | null | undefined): {
  editor: Editor;
  mindId: string;
  index: number;
  tab: NoteTab;
  count: number;
} | null {
  if (ref?.kind !== "noteTab") return null;
  const cut = ref.id.indexOf("/");
  if (cut < 0) return null;
  const mindId = ref.id.slice(0, cut);
  const key = ref.id.slice(cut + 1);
  const editor = mindEditor(mindId);
  if (!editor) return null;
  const { tabs } = noteTabsOf(editor.state);
  const index = tabs.findIndex((tab) => (tab.id ?? "") === key);
  const tab = tabs[index];
  return tab ? { editor, mindId, index, tab, count: tabs.length } : null;
}

interface NoteTabRename {
  /**
   * The tab whose name field is open, by its Note and its tab Block's id; `fresh` for a tab just
   * made, whose text takes the focus once it is named.
   */
  asked: { mindId: string; id: string | null; fresh: boolean } | null;
  ask(mindId: string, id: string | null, fresh?: boolean): void;
  done(): void;
}

/** Which tab's name is being typed in the panel: F2, a double-click, a menu or a new tab. */
export const useNoteTabRename = create<NoteTabRename>()((set) => ({
  asked: null,
  ask: (mindId, id, fresh = false) => set({ asked: { mindId, id, fresh } }),
  done: () => set({ asked: null }),
}));

/** Adds a tab to the Note, opens it and its name field (#3414). */
export function newTab(editor: Editor, mindId: string): void {
  const id = addNoteTab(editor, defaultTitle);
  if (id) useNoteTabRename.getState().ask(mindId, id, true);
}

/** Moves a tab one place up (-1) or down (1), with its line. */
export function stepTab(editor: Editor, index: number, direction: -1 | 1): void {
  moveTab(editor, index, index + direction);
}

/** Moves a tab to be the `to`th, with its line. */
export function moveTab(editor: Editor, index: number, to: number): void {
  const tab = noteTabsOf(editor.state).tabs[index];
  if (!tab) return;
  const name = tab.title || defaultTitle(index + 1);
  moveNoteTab(editor, index, to, defaultTitle, (t, cut) =>
    t("noteTabs.moved", { title: cut(name) }),
  );
}

/** Deletes a tab and its Blocks, with its line and Undo. */
export function deleteTab(editor: Editor, index: number): void {
  const tab = noteTabsOf(editor.state).tabs[index];
  if (!tab) return;
  const name = tab.title || defaultTitle(index + 1);
  deleteNoteTab(editor, index, (t, cut) => t("noteTabs.deleted", { title: cut(name) }));
}
