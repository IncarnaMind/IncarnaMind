import type { Editor } from "@tiptap/core";
import { isInTable } from "@tiptap/pm/tables";
import { inAnalysisTable } from "../editor/analysisTableCommands";
import { noteHolding } from "../editor/noteKeymap";
import {
  menuKeyApplies,
  runTableAction,
  TABLE_ACTIONS,
  TABLE_MENU_KEYS,
  type TableAction,
  type TableActionId,
  type TableSpot,
  tableSpot,
  unavailable,
} from "../editor/tableCommands";
import type { Translate } from "../objects";
import { cursorInFocus } from "./blocks";
import { readMindHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/**
 * The note's keymap gives a command the Block at the cursor as its focus; ⌘K, with nothing chosen,
 * gives the Note in front, and acts on the table the cursor is in there. A menu names its Block,
 * and the table is that Block's alone: a chart's menu never acts on the table after it.
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
  return editor && !editor.isDestroyed && isInTable(editor.state) && cursorInFocus(editor, ctx)
    ? editor
    : null;
}

const spotOf = (ctx: CommandContext) => {
  const editor = tableNote(ctx);
  return editor && tableSpot(editor.state);
};

/** The heading row and the totals are switches: the menu ticks each one that is on. */
const SWITCHES: Partial<Record<TableActionId, (spot: TableSpot) => boolean>> = {
  headerRow: (spot) => spot.headerRow,
  totalRow: (spot) => spot.totalRow,
  totalColumn: (spot) => spot.totalColumn,
};

/** A selection of several rows or columns says how many Delete takes. */
function deleteLabel(action: TableAction, ctx: CommandContext, t: Translate): string {
  const spot = spotOf(ctx);
  if (action.id === "deleteRow" && spot && spot.rows > 1) {
    return t("editor.table.deleteRows", { count: spot.rows });
  }
  if (action.id === "deleteColumn" && spot && spot.columns > 1) {
    return t("editor.table.deleteColumns", { count: spot.columns });
  }
  return t(action.label);
}

export const tableCommands: readonly Command[] = [
  ...TABLE_ACTIONS.map((action): Command => {
    const isOn = SWITCHES[action.id];
    return {
      id: action.command,
      label:
        action.id === "deleteRow" || action.id === "deleteColumn"
          ? (ctx, t) => deleteLabel(action, ctx, t)
          : action.label,
      ...(action.keys && { shortcut: { keys: action.keys } }),
      ...(isOn && {
        checked(ctx: CommandContext) {
          const spot = spotOf(ctx);
          return spot !== null && isOn(spot);
        },
      }),
      group: action.id.startsWith("delete")
        ? "danger"
        : action.id === "openCalculation"
          ? "open"
          : "main",
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
        const spot = spotOf(ctx);
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
    };
  }),
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
    run: (ctx) => tableNote(ctx)?.storage.tableKeys.openMenu?.(),
  },
];
