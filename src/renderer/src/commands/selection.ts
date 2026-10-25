import { dialogOrMenuOpen } from "../escapeDismiss";
import { type SelectSurface, useSelection } from "../selection";
import { typesText } from "../undo";
import { type Command, type CommandContext, fromMenu } from "./registry";

const surfaceOf = (ctx: CommandContext): SelectSurface | null =>
  ctx.surface === "sidebar" ||
  ctx.surface === "library" ||
  ctx.surface === "deleted" ||
  ctx.surface === "home"
    ? ctx.surface
    : null;

/** Select All and Esc, the keys a list takes for its rows (docs/agents/interaction.md, rule 6). */
export const selectionCommands: readonly Command[] = [
  {
    ...fromMenu("edit.selectAll"),
    // In a field, the note or the composer, ⌘A selects their text, as it always does.
    shortcut: { keys: "CmdOrCtrl+A", outsideText: true },
    palette: false,
    group: "edit",
    reversible: true,
    run(ctx) {
      const surface = surfaceOf(ctx);
      // The Edit menu's Select All comes here too, from wherever the focus is. In a list, ⌘A is
      // the rows' even while the focus is on its bar: the page's own Select All would highlight
      // every label (#1350).
      if (surface && !typesText(document.activeElement)) {
        useSelection.getState().all(surface);
      } else {
        document.execCommand("selectAll");
      }
    },
  },
  {
    id: "selection.clear",
    label: "command.selection.clear",
    shortcut: { keys: "Escape", list: true },
    palette: false,
    group: "edit",
    reversible: true,
    // The window's one selection, wherever it is held: the sidebar's says "Esc clears" in the Library too.
    // Not while a picker or menu is open, even one drawn from a selected row: Esc closes that first.
    when: (ctx) =>
      surfaceOf(ctx) !== null && useSelection.getState().items.length > 0 && !dialogOrMenuOpen(),
    run() {
      useSelection.getState().clear();
    },
  },
];
