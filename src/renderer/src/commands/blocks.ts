import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { CommandId } from "../../../shared/commands";
import { contextFlag, setContextFlag } from "../editor/blockCommands";
import { blockAt, noteHolding } from "../editor/noteKeymap";
import { readMindHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/**
 * The Note a command that names a Block acts in: the editor its menu or key came from, as the same
 * Note open in two panes is two editors holding the Block; else the first that holds it.
 */
export function noteOfBlock(ctx: CommandContext): Editor | null {
  if (ctx.focus?.kind !== "block") return null;
  if (ctx.note && !ctx.note.isDestroyed) return ctx.note;
  return noteHolding(ctx.focus.id);
}

/**
 * The Block a command acts on: the one a menu or a key names, else, from ⌘K with the focus in the
 * Note in front, the Block the cursor is in.
 */
export function blockIn(ctx: CommandContext): { editor: Editor; id: string } | null {
  if (ctx.focus?.kind === "block") {
    const editor = noteOfBlock(ctx);
    return editor ? { editor, id: ctx.focus.id } : null;
  }
  const inFront = readMindHandle.current;
  if (!inFront || inFront.editor.isDestroyed || ctx.selection.length > 0) return null;
  if (ctx.place !== "note" || ctx.focus?.kind !== "mind" || ctx.focus.id !== inFront.mindId) {
    return null;
  }
  const at = blockAt(inFront.editor.state.selection);
  return at ? { editor: inFront.editor, id: at.id } : null;
}

/**
 * Whether a command that acts at the cursor is asked about the Block the cursor is in: with no
 * Block named (⌘K, the window's keys) it is, whatever the Block.
 */
export function cursorInFocus(editor: Editor, ctx: CommandContext): boolean {
  return ctx.focus?.kind !== "block" || blockAt(editor.state.selection)?.id === ctx.focus.id;
}

/** A table's menu has Delete table, which is its Delete, so it doesn't say it twice. */
export const withoutOwnDelete = (node: ProseMirrorNode): readonly CommandId[] =>
  node.type.name === "table" ? ["block.delete"] : [];

export const blockCommands: readonly Command[] = [
  {
    id: "block.delete",
    label: "block.delete.command",
    menuLabel: "editor.block.delete",
    shortcut: { keys: "CmdOrCtrl+Shift+Backspace" },
    group: "danger",
    destructive: true,
    appliesTo: ["block", "answer", "chart", "mind"],
    // From ⌘K it deletes where the cursor is, which an Answer can't see.
    assistant: false,
    // The note's own undo (⌘Z) brings it back.
    reversible: true,
    when: (ctx) => ctx.here?.["block.delete"] !== undefined || blockIn(ctx) !== null,
    run(ctx) {
      // An Answer's or a chart's menu deletes it, wherever the cursor is.
      if (ctx.here?.["block.delete"]) return ctx.here["block.delete"]();
      // The Blocks the note's selection touches, the focused one among them.
      blockIn(ctx)?.editor.commands.deleteBlock();
    },
  },
  {
    id: "block.includeInContext",
    label: "question.context.include",
    group: "main",
    appliesTo: ["block", "mind"],
    // It acts where the cursor is, which an Answer can't see.
    assistant: false,
    // The note's own undo (⌘Z) takes it back.
    reversible: true,
    when: (ctx) => {
      const at = blockIn(ctx);
      return at !== null && contextFlag(at.editor, at.id) !== null;
    },
    checked(ctx) {
      const at = blockIn(ctx);
      return at !== null && contextFlag(at.editor, at.id) === true;
    },
    run(ctx) {
      const at = blockIn(ctx);
      const included = at && contextFlag(at.editor, at.id);
      if (at && included !== null) setContextFlag(at.editor, at.id, !included);
    },
  },
];
