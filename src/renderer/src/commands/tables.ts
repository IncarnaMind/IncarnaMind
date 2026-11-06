import type { Editor } from "@tiptap/core";
import { isInTable } from "@tiptap/pm/tables";
import { inAnalysisTable } from "../editor/analysisTableCommands";
import { noteHolding } from "../editor/noteKeymap";
import {
  menuKeyApplies,
  runTableAction,
  TABLE_ACTIONS,
  TABLE_MENU_KEYS,
  tableSpot,
  unavailable,
} from "../editor/tableCommands";
import { readMindHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/**
 * The note's keymap gives a command the Block at the cursor as its focus; ⌘K, with nothing chosen,
 * gives the Note in front, and acts on the table the cursor is in there.
 */
function tableNote(ctx: CommandContext): Editor | null {
  const inFront = readMindHandle.current;
  const editor =
    ctx.focus?.kind === "block"
      ? noteHolding(ctx.focus.id)
      : ctx.selection.length === 0 &&
          (ctx.focus === null || (ctx.focus.kind === "mind" && ctx.focus.id === inFront?.mindId))
        ? (inFront?.editor ?? null)
        : null;
  return editor && !editor.isDestroyed && isInTable(editor.state) ? editor : null;
}

export const tableCommands: readonly Command[] = [
  ...TABLE_ACTIONS.map(
    (action): Command => ({
      id: action.command,
      label: action.label,
      ...(action.keys && { shortcut: { keys: action.keys } }),
      group: action.id.startsWith("delete") ? "danger" : "main",
      // The note's own undo (⌘Z) takes it back.
      reversible: true,
      when: (ctx) => {
        // The caption's marker gives its own table's, wherever the cursor is (#2378).
        if (ctx.here?.[action.command]) return true;
        const editor = tableNote(ctx);
        // Only an Analysis's own table has a calculation to convert to text (#2378).
        const analysisOnly = action.id === "convertToText" || action.id === "openCalculation";
        return editor !== null && (!analysisOnly || inAnalysisTable(editor.state));
      },
      enabled(ctx) {
        if (ctx.here?.[action.command]) return true;
        const editor = tableNote(ctx);
        const spot = editor && tableSpot(editor.state);
        const reason = spot && unavailable(action.id, spot);
        return reason ? { reason } : true;
      },
      run(ctx) {
        const here = ctx.here?.[action.command];
        if (here) {
          here();
          return;
        }
        const editor = tableNote(ctx);
        if (editor) runTableAction(editor, action);
      },
    }),
  ),
  {
    id: "table.menu",
    label: "editor.table.menu",
    shortcut: { keys: TABLE_MENU_KEYS },
    palette: false,
    group: "main",
    appliesTo: ["block"],
    reversible: true,
    when(ctx) {
      const editor = tableNote(ctx);
      return editor !== null && menuKeyApplies(editor.state) && !!editor.storage.tableKeys.openMenu;
    },
    run: (ctx) => tableNote(ctx)?.storage.tableKeys.openMenu?.(0),
  },
];
