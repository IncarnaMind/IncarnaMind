import { type Editor, Extension, type JSONContent } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import {
  CellSelection,
  cellAround,
  isInTable,
  rowIsHeader,
  selectedRect,
  TableMap,
} from "@tiptap/pm/tables";
import type { CommandId, Keys } from "../../../shared/commands";
import { labelRole } from "../../../shared/figureFooting";
import type { MessageKey } from "../../../shared/i18n";
import { setTableRoles } from "./figureTableRoles";
import { asOwnUndoStep } from "./selectionCommands";

export type TableActionId =
  | "rowAbove"
  | "rowBelow"
  | "columnLeft"
  | "columnRight"
  | "headerRow"
  | "totalRow"
  | "totalColumn"
  | "deleteRow"
  | "deleteColumn"
  | "deleteTable";

export interface TableAction {
  id: TableActionId;
  /** Registered in ../commands/tables, which binds the keys and puts it in ⌘K. */
  command: CommandId;
  label: MessageKey;
  keys?: Keys;
  run(editor: Editor): boolean;
}

/** In the menu's order, deleting last (interaction rule 5); the keys are Confluence's. */
export const TABLE_ACTIONS: readonly TableAction[] = [
  {
    id: "rowAbove",
    command: "table.rowAbove",
    label: "editor.table.rowAbove",
    keys: "CmdOrCtrl+Alt+Up",
    run: (editor) => editor.commands.addRowBefore(),
  },
  {
    id: "rowBelow",
    command: "table.rowBelow",
    label: "editor.table.rowBelow",
    keys: "CmdOrCtrl+Alt+Down",
    run: (editor) => editor.commands.addRowAfter(),
  },
  {
    id: "columnLeft",
    command: "table.columnLeft",
    label: "editor.table.columnLeft",
    keys: "CmdOrCtrl+Alt+Left",
    run: (editor) => editor.commands.addColumnBefore(),
  },
  {
    id: "columnRight",
    command: "table.columnRight",
    label: "editor.table.columnRight",
    keys: "CmdOrCtrl+Alt+Right",
    run: (editor) => editor.commands.addColumnAfter(),
  },
  {
    id: "headerRow",
    command: "table.headerRow",
    label: "editor.table.headerRow",
    run: (editor) => editor.commands.toggleHeaderRow(),
  },
  {
    id: "totalRow",
    command: "table.totalRow",
    label: "figures.totalRow",
    run: (editor) => toggleTotal(editor, "row"),
  },
  {
    id: "totalColumn",
    command: "table.totalColumn",
    label: "figures.totalColumn",
    run: (editor) => toggleTotal(editor, "column"),
  },
  {
    id: "deleteRow",
    command: "table.deleteRow",
    label: "editor.table.deleteRow",
    run: (editor) => editor.commands.deleteRow(),
  },
  {
    id: "deleteColumn",
    command: "table.deleteColumn",
    label: "editor.table.deleteColumn",
    run: (editor) => editor.commands.deleteColumn(),
  },
  {
    id: "deleteTable",
    command: "table.delete",
    label: "editor.table.delete",
    run: (editor) => editor.commands.deleteTable(),
  },
];

/** As ⌘/ opens the menu over selected text (#91). */
export const TABLE_MENU_KEYS: Keys = "CmdOrCtrl+/";

/** Not while an input method composes: what it is writing isn't in the cell yet. */
export function runTableAction(editor: Editor, action: TableAction): boolean {
  if (editor.view.composing) return false;
  const done = asOwnUndoStep(editor, () => action.run(editor));
  editor.commands.focus();
  return done;
}

/**
 * Whether the row or column of the cell at `cell` (a position in the
 * document) is footed as a total: the User's Treat as a total, or else its
 * label ("Total", "合计") says so (#1932).
 */
function isTotal(state: EditorState, cell: number, axis: "row" | "column"): boolean {
  const $cell = state.doc.resolve(cell);
  const table = $cell.node(-1);
  const start = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell(cell - start);
  const textAt = (row: number, column: number) => {
    const offset = map.map[row * map.width + column];
    return offset === undefined ? "" : (table.nodeAt(offset)?.textContent ?? "");
  };
  if (axis === "row") {
    const role = table.child(rect.top).attrs.figureRowRole;
    if (role === "total" || role === "detail") return role === "total";
    return labelRole(textAt(rect.top, 0)) !== "detail";
  }
  const role = table.nodeAt(cell - start)?.attrs.figureColumnRole;
  if (role === "total" || role === "detail") return role === "total";
  return labelRole(textAt(0, rect.left)) !== "detail";
}

function toggleTotal(editor: Editor, axis: "row" | "column"): boolean {
  const spot = tableSpot(editor.state);
  if (!spot) return false;
  const total = axis === "row" ? spot.totalRow : spot.totalColumn;
  return editor.commands.command(({ tr, state }) => {
    const $cell = state.doc.resolve(spot.cell);
    setTableRoles(
      tr,
      { table: $cell.node(-1), start: $cell.start(-1) },
      spot.cell - $cell.start(-1),
      [axis],
      !total,
    );
    return tr.docChanged;
  });
}

export interface TableSpot {
  /** Before the cell the menu sits on: the cursor's, or a cell selection's head. */
  cell: number;
  /** Selected. */
  rows: number;
  columns: number;
  headerRow: boolean;
  /** Its row, or its column, is footed as a total. */
  totalRow: boolean;
  totalColumn: boolean;
  /** A table keeps at least one row and one column. */
  canDeleteRows: boolean;
  canDeleteColumns: boolean;
}

export function tableSpot(state: EditorState): TableSpot | null {
  if (!isInTable(state)) return null;
  const { selection } = state;
  const $cell =
    selection instanceof CellSelection ? selection.$headCell : cellAround(selection.$head);
  if (!$cell) return null;
  const rect = selectedRect(state);
  return {
    cell: $cell.pos,
    rows: rect.bottom - rect.top,
    columns: rect.right - rect.left,
    headerRow: rowIsHeader(rect.map, rect.table, 0),
    totalRow: isTotal(state, $cell.pos, "row"),
    totalColumn: isTotal(state, $cell.pos, "column"),
    canDeleteRows: rect.bottom - rect.top < rect.map.height,
    canDeleteColumns: rect.right - rect.left < rect.map.width,
  };
}

export const sameSpot = (a: TableSpot | null, b: TableSpot | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.cell === b.cell &&
    a.rows === b.rows &&
    a.columns === b.columns &&
    a.headerRow === b.headerRow &&
    a.totalRow === b.totalRow &&
    a.totalColumn === b.totalColumn &&
    a.canDeleteRows === b.canDeleteRows &&
    a.canDeleteColumns === b.canDeleteColumns);

export function unavailable(id: TableActionId, spot: TableSpot): MessageKey | null {
  if (id === "deleteRow" && !spot.canDeleteRows) return "editor.table.lastRow";
  if (id === "deleteColumn" && !spot.canDeleteColumns) return "editor.table.lastColumn";
  return null;
}

/** With text selected, ⌘/ is the selection menu's. */
export function menuKeyApplies(state: EditorState): boolean {
  const { selection } = state;
  return isInTable(state) && (selection.empty || selection instanceof CellSelection);
}

export function emptyTable(rows = 3, columns = 3): JSONContent {
  const row = (type: "tableHeader" | "tableCell"): JSONContent => ({
    type: "tableRow",
    content: Array.from({ length: columns }, () => ({ type, content: [{ type: "paragraph" }] })),
  });
  return {
    type: "table",
    content: [row("tableHeader"), ...Array.from({ length: rows - 1 }, () => row("tableCell"))],
  };
}

export interface TableKeysStorage {
  /**
   * Opens the table menu (see `TableMenu`, which sets it), on the cell the
   * cursor is in; `buttons`: the mouse buttons still held, for a right-click.
   */
  openMenu: ((buttons: number) => void) | null;
}

declare module "@tiptap/core" {
  interface Storage {
    tableKeys: TableKeysStorage;
  }
}

/**
 * Tab and Shift-Tab never take the focus out of the Mind from a table (as
 * Shift-Tab at its first cell would), and a right-click in a cell opens the
 * table menu there. The menu's keys are commands, in ../commands/tables.
 */
export const TableKeys = Extension.create<Record<string, never>, TableKeysStorage>({
  name: "tableKeys",
  // After Tiptap's Table (and lists in cells): their Tab and Shift-Tab go first.
  priority: 50,

  addStorage() {
    return { openMenu: null };
  },

  addKeyboardShortcuts() {
    const inTable = () => isInTable(this.editor.state);
    return { Tab: inTable, "Shift-Tab": inTable };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey("tableRightClick"),
        props: {
          handleDOMEvents: {
            contextmenu: (view, event) => {
              const open = storage.openMenu;
              if (!open || !view.editable) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const $cell = at && cellAround(view.state.doc.resolve(at.pos));
              if (!at || !$cell) return false;
              event.preventDefault();
              const { selection } = view.state;
              let onSelection = false;
              if (selection instanceof CellSelection) {
                selection.forEachCell((_cell, pos) => {
                  if (pos === $cell.pos) onSelection = true;
                });
              } else {
                const cellEnd = $cell.pos + ($cell.nodeAfter?.nodeSize ?? 0);
                onSelection = selection.from > $cell.pos && selection.to < cellEnd;
              }
              if (!onSelection) {
                view.dispatch(
                  view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))),
                );
              }
              view.focus();
              open(event.buttons);
              return true;
            },
          },
        },
      }),
    ];
  },
});
