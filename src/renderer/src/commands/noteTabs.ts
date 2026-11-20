import { openNoteTab } from "../editor/noteTabs";
import { mindEditor } from "../editor/openEditors";
import { useNoteOutlines } from "../noteOutline";
import { deleteTab, newTab, noteTabOf, stepTab, useNoteTabRename } from "../noteTabs";
import type { Command, CommandContext } from "./registry";
import { mindShown, onlyOne } from "./targets";

/*
 * Tabs in a Note (#3414): each tab's menu, its keys in the panel and ⌘K, and New tab, which
 * opens the panel with the new tab's name field.
 */

const unavailable = { reason: "noteTabs.unavailable" } as const;

/** The tab a menu or the panel's keys name, in a Note that can be changed. */
function editableTab(ctx: CommandContext) {
  const found = noteTabOf(ctx.focus);
  return found?.editor.isEditable ? found : null;
}

const moveEnabled = (direction: -1 | 1) => (ctx: CommandContext) => {
  const found = editableTab(ctx);
  if (!found) return unavailable;
  const to = found.index + direction;
  return to >= 0 && to < found.count ? true : unavailable;
};

const MOVE_UP = { mac: "Alt+Shift+Up", other: "Ctrl+Shift+Up" } as const;
const MOVE_DOWN = { mac: "Alt+Shift+Down", other: "Ctrl+Shift+Down" } as const;

export const noteTabCommands: readonly Command[] = [
  {
    id: "noteTab.new",
    label: "noteTabs.newInNote",
    menuLabel: "noteTabs.new",
    group: "main",
    // ⌘Z in the Note takes it back.
    reversible: true,
    when: (ctx) => {
      const mindId = mindShown(ctx);
      return onlyOne(ctx) && mindId !== null && mindEditor(mindId)?.isEditable === true;
    },
    run: (ctx) => {
      const mindId = mindShown(ctx);
      const editor = mindId ? mindEditor(mindId) : null;
      if (!mindId || !editor) return;
      useNoteOutlines.getState().setOpen(mindId, true);
      newTab(editor, mindId);
    },
  },
  {
    id: "noteTab.open",
    label: "noteTabs.open",
    rowKeys: "Enter",
    group: "open",
    appliesTo: ["noteTab"],
    reversible: true,
    enabled: (ctx) => (noteTabOf(ctx.focus) ? true : unavailable),
    run: (ctx) => {
      const found = noteTabOf(ctx.focus);
      if (found) openNoteTab(found.editor, found.index, { focus: true });
    },
  },
  {
    id: "noteTab.moveUp",
    label: "noteTabs.moveUp",
    rowKeys: MOVE_UP,
    group: "move",
    appliesTo: ["noteTab"],
    reversible: true,
    enabled: moveEnabled(-1),
    run: (ctx) => {
      const found = editableTab(ctx);
      if (found) stepTab(found.editor, found.index, -1);
    },
  },
  {
    id: "noteTab.moveDown",
    label: "noteTabs.moveDown",
    rowKeys: MOVE_DOWN,
    group: "move",
    appliesTo: ["noteTab"],
    reversible: true,
    enabled: moveEnabled(1),
    run: (ctx) => {
      const found = editableTab(ctx);
      if (found) stepTab(found.editor, found.index, 1);
    },
  },
  {
    id: "noteTab.rename",
    label: "noteTabs.rename",
    rowKeys: "F2",
    group: "edit",
    appliesTo: ["noteTab"],
    reversible: true,
    enabled: (ctx) => (editableTab(ctx) ? true : unavailable),
    run: (ctx) => {
      const found = editableTab(ctx);
      if (found) useNoteTabRename.getState().ask(found.mindId, found.tab.id);
    },
  },
  {
    id: "noteTab.delete",
    label: "noteTabs.delete",
    rowKeys: "Delete",
    group: "danger",
    appliesTo: ["noteTab"],
    reversible: true,
    destructive: true,
    enabled: (ctx) => {
      const found = editableTab(ctx);
      if (!found) return unavailable;
      return found.count > 1 ? true : ({ reason: "noteTabs.lastTab" } as const);
    },
    run: (ctx) => {
      const found = editableTab(ctx);
      if (found && found.count > 1) deleteTab(found.editor, found.index);
    },
  },
];
