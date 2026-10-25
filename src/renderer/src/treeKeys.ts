import { createContext, type KeyboardEvent, useContext } from "react";
import { pressed } from "./commands/keys";

/*
 * The keys of the sidebar's tree (docs/agents/interaction.md, rules 1, 2 and
 * 7): Enter opens a row, F2 renames it, ⇧⌘M (Ctrl+Shift+M) is "Move to…",
 * and the arrow keys move through the rows. The tree's own keys (←, →,
 * typing a name, Delete) are `useTreeKeyboard`'s.
 */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether a key is "Move to…". */
export const isMoveToKey = (event: KeyboardEvent) =>
  event.code === "KeyM" &&
  event.shiftKey &&
  !event.altKey &&
  (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/** A Library row's "Tags…", besides T alone. */
export const TAGS_KEYS = "CmdOrCtrl+Alt+T";

/** Whether a key is a Library row's "Tags…": T, or ⌥⌘T (Ctrl+Alt+T). */
export const isTagsKey = (event: KeyboardEvent) =>
  !event.nativeEvent.isComposing &&
  (pressed("T", event, isMac) || pressed(TAGS_KEYS, event, isMac));

/** A Library row's Delete, as Finder's Move to Trash. */
export const DELETE_KEYS = "CmdOrCtrl+Backspace";

export const isDeleteKey = (event: KeyboardEvent) => pressed(DELETE_KEYS, event, isMac);

/** The sidebar's Delete: ⌘⌫ as in Finder, and Delete on Windows and Linux, as in Explorer. */
export const isTreeDeleteKey = (event: KeyboardEvent) =>
  isDeleteKey(event) || (!isMac && pressed("Delete", event, false));

/** Marks a row's main button as a stop for the arrow keys (`moveThroughRows`). */
export const TREE_ROW = { "data-tree-row": "" } as const;

/** Sent from a row's main button: it is what the User is looking at, so Tab and the arrows start there. */
export const SHOWN_ROW_EVENT = "incarnamind-shown-row";

/**
 * ↑ and ↓ (and Home, End) on a row move to the row above or below, through
 * Folders, Minds and Documents alike. True if the key was used.
 */
export function moveThroughRows(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
  const target = event.target as HTMLElement;
  if (!target.matches("[data-tree-row]")) return false;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-tree-row]"));
  const at = rows.indexOf(target);
  const next =
    event.key === "Home"
      ? rows[0]
      : event.key === "End"
        ? rows.at(-1)
        : rows[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (!next) return false;
  event.preventDefault();
  next.focus();
  return true;
}

/** How many levels deeper a row is than its place says: those listed under a group's heading. */
export const TreeLevelOffset = createContext(0);

/**
 * What a sidebar row's main button says to a screen reader and to the tree's
 * keys: a tree item at its level (`depth` 0 is the top), open or closed if it
 * holds anything, selected or not if it can be, and a stop for the arrow keys.
 * `useTreeKeyboard` keeps one of them in the Tab order.
 */
export function useTreeItem({
  depth,
  expanded,
  selected,
}: {
  depth: number;
  expanded?: boolean;
  selected?: boolean;
}) {
  const offset = useContext(TreeLevelOffset);
  return {
    role: "treeitem",
    "aria-level": depth + 1 + offset,
    "aria-expanded": expanded,
    "aria-selected": selected,
    ...TREE_ROW,
  } as const;
}

/** → opens a closed row and ← closes an open one; stepping in and out is `useTreeKeyboard`'s. */
export const foldKeys = (expanded: boolean, toggle: () => void) => (event: KeyboardEvent) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded)) {
    event.preventDefault();
    toggle();
  }
};
