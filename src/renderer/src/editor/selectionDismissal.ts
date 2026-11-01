import type { Editor } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";

/** The selection menu's plugin: its own state says whether it shows, and this closes it. */
export const SELECTION_MENU_KEY = new PluginKey("selectionMenu");

/**
 * The selection the menu was closed over, which keeps it closed until the selection changes, even
 * for an update already waiting.
 */
const dismissedOver = new WeakMap<Editor, string>();

const keyOf = (from: number, to: number) => `${from}-${to}`;

/** Whether the menu stays closed over the selection the editor has now; its mark is forgotten then. */
export function menuClosedOver(editor: Editor): boolean {
  const { from, to } = editor.state.selection;
  if (dismissedOver.get(editor) === keyOf(from, to)) return true;
  dismissedOver.delete(editor);
  return false;
}

/**
 * Keeps the menu closed over the selection `from`–`to` until the selection changes: for one the
 * User didn't make, such as the match find selects as its bar closes (#1355).
 */
export function keepMenuClosed(editor: Editor, from: number, to: number): void {
  dismissedOver.set(editor, keyOf(from, to));
}

/** Forgets the mark, so the menu may open over that selection again. */
export function forgetMenuClosed(editor: Editor): void {
  dismissedOver.delete(editor);
}

/** Closes the menu over the selection as it is: for an action that answers somewhere else (#2348). */
export function closeSelectionMenu(editor: Editor): void {
  if (editor.isDestroyed) return;
  keepMenuClosed(editor, editor.state.selection.from, editor.state.selection.to);
  editor.view.dispatch(editor.state.tr.setMeta(SELECTION_MENU_KEY, "hide"));
}
