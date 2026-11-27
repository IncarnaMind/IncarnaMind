import { autoUpdate } from "@floating-ui/dom";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection, cellAround } from "@tiptap/pm/tables";
import { type Editor, useEditorState } from "@tiptap/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CommandId } from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import { keysHere, shortcutLabel } from "../commands/keymap";
import { type CommandContext, commands, labelOf } from "../commands/registry";
import {
  AddColumnRightIcon,
  AddRowBelowIcon,
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CodeIcon,
  ColumnHandleIcon,
  type Icon,
  ItalicIcon,
  PlusLineIcon,
  RowHandleIcon,
  TrashLineIcon,
} from "../components/icons";
import { iconButtonClass } from "../components/ui";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { type Align, formatState, setAlign } from "./formatCommands";
import { runTableAction, TABLE_ACTIONS, type TableSpot } from "./tableCommands";
import { withKeys } from "./withShortcut";
import "./tableHandles.css";

const ADD_ROW = TABLE_ACTIONS.find((action) => action.id === "rowBelow");

type CellAlign = Extract<Align, "left" | "center" | "right">;

/** What the alignment button does next: left, centre and right in turn. */
const nextAlign = (now: string | undefined): CellAlign =>
  now === "left" ? "center" : now === "center" ? "right" : "left";

const ALIGNS: Record<CellAlign, { icon: Icon; label: MessageKey }> = {
  left: { icon: AlignLeftIcon, label: "format.align.left" },
  center: { icon: AlignCenterIcon, label: "format.align.center" },
  right: { icon: AlignRightIcon, label: "format.align.right" },
};

/** The position before a cell the page draws, or null for one that isn't the editor's. */
function cellPos(editor: Editor, cell: Element): number | null {
  if (editor.isDestroyed || !editor.view.dom.contains(cell)) return null;
  const $cell = cellAround(editor.state.doc.resolve(editor.view.posAtDOM(cell, 0)));
  return $cell ? $cell.pos : null;
}

function cursorInto(editor: Editor, cell: Element | undefined): void {
  const pos = cell ? cellPos(editor, cell) : null;
  if (pos === null) return;
  const { state } = editor;
  editor.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))));
}

/** The cell the pointer is over in this editor's tables, kept while it is on a handle. */
function useHoveredCell(editor: Editor, handles: RefObject<HTMLElement | null>) {
  const [cell, setCell] = useState<HTMLTableCellElement | null>(null);
  useEffect(() => {
    const track = (event: PointerEvent) => {
      const over = event.target instanceof Element ? event.target : null;
      if (over && handles.current?.contains(over)) return;
      const found = over?.closest("td, th");
      // Between cells, on a border or the table's own margin: still the same table.
      if (!found && over?.closest(".tableWrapper")) return;
      // A table of the Note's own: not one a Block draws inside it, such as a chart's Show as table.
      const own =
        found instanceof HTMLTableCellElement &&
        found.closest(".tableWrapper") !== null &&
        cellPos(editor, found) !== null;
      setCell(own ? found : null);
    };
    window.addEventListener("pointermove", track, { passive: true });
    return () => window.removeEventListener("pointermove", track);
  }, [editor, handles]);
  // A cell the editor drew again is gone from the page.
  return cell?.isConnected ? cell : null;
}

/** Places each part against the hovered cell and the cell bar's cell, in `frame`'s coordinates. */
function place(
  frame: HTMLElement,
  parts: { row: HTMLElement; column: HTMLElement; add: HTMLElement; bar: HTMLElement },
  hovered: HTMLTableCellElement | null,
  barCell: HTMLElement | null,
): void {
  const origin = frame.getBoundingClientRect();
  if (hovered) {
    const table = hovered.closest("table")?.getBoundingClientRect();
    const shown = hovered.closest(".tableWrapper")?.getBoundingClientRect() ?? table;
    const row = hovered.parentElement?.getBoundingClientRect();
    const box = hovered.getBoundingClientRect();
    if (table && shown && row) {
      const left = Math.max(table.left, shown.left);
      const right = Math.min(table.right, shown.right);
      parts.row.style.left = `${left - origin.left}px`;
      parts.row.style.top = `${row.top + row.height / 2 - origin.top}px`;
      const middle = (Math.max(box.left, left) + Math.min(box.right, right)) / 2;
      parts.column.style.left = `${middle - origin.left}px`;
      parts.column.style.top = `${table.top - origin.top}px`;
      parts.add.style.left = `${left - origin.left}px`;
      parts.add.style.width = `${right - left}px`;
      parts.add.style.top = `${table.bottom - origin.top}px`;
    }
  }
  if (barCell) {
    const box = barCell.getBoundingClientRect();
    parts.bar.style.left = `${box.left + box.width / 2 - origin.left}px`;
    parts.bar.style.top = `${box.top - origin.top}px`;
  }
}

/**
 * A table's everyday edits by pointer (#3761): a handle at the left of the row under the pointer
 * and at the top of its column, which selects that row or column and opens the table's menu on
 * it; a bar under the table that adds a row at its end; and a small bar over selected cells that
 * formats them, adds a row or a column beside them, or deletes their rows or columns. Each does
 * what the table's menu and its keys do, which stay the keyboard's way (⌘/ and the menu's keys).
 */
export function TableHandles({
  editor,
  spot,
  block,
  focused,
  menuOpen,
}: {
  editor: Editor;
  /** The cell the cursor or the cell selection is in, as the table's menu has it. */
  spot: TableSpot | null;
  /** The table's Block, which the bar's commands name. */
  block: string | null;
  /** The Note has the focus: cells selected in a Note left for elsewhere keep no bar. */
  focused: boolean;
  /** The table's menu is open: the cell bar keeps out of its way. */
  menuOpen: boolean;
}) {
  const t = useT();
  const handles = useRef<HTMLDivElement>(null);
  const rowHandle = useRef<HTMLButtonElement>(null);
  const columnHandle = useRef<HTMLButtonElement>(null);
  const addRow = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const hovered = useHoveredCell(editor, handles);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      cells: current.state.selection instanceof CellSelection,
      columns:
        current.state.selection instanceof CellSelection &&
        current.state.selection.isColSelection() &&
        !current.state.selection.isRowSelection(),
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      code: current.isActive("code"),
      align: current.state.selection instanceof CellSelection ? formatState(current).align : "left",
    }),
  });
  const barDom =
    spot !== null && block !== null && state.cells && focused && !menuOpen && !editor.isDestroyed
      ? editor.view.nodeDOM(spot.cell)
      : null;
  const barCell = barDom instanceof HTMLElement ? barDom : null;
  const hoverShown = hovered !== null && editor.isEditable;

  useLayoutEffect(() => {
    const container = handles.current;
    const frame = container?.parentElement;
    const [row, column, add, cellBar] = [
      rowHandle.current,
      columnHandle.current,
      addRow.current,
      bar.current,
    ];
    if (!container || !frame || !row || !column || !add || !cellBar) return;
    const reference = hovered ?? barCell;
    if (!reference) return;
    return autoUpdate(reference, container, () =>
      place(frame, { row, column, add, bar: cellBar }, hovered, barCell),
    );
  }, [hovered, barCell]);

  const ctx = (): CommandContext => ({
    selection: [],
    focus: block === null ? null : { kind: "block", id: block },
    surface: "mind",
    note: editor,
  });
  const run = (id: CommandId) => {
    commands.run(id, ctx()).catch(useAppStore.getState().reportError);
  };

  const selectLine = (axis: "row" | "column") => {
    const pos = hovered && cellPos(editor, hovered);
    if (pos === null || pos === undefined) return;
    const $cell = editor.state.doc.resolve(pos);
    const selection =
      axis === "row" ? CellSelection.rowSelection($cell) : CellSelection.colSelection($cell);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
    editor.storage.tableKeys.openMenu?.();
  };

  const appendRow = () => {
    const table = hovered?.closest("table");
    if (!table || !ADD_ROW) return;
    cursorInto(editor, table.rows[table.rows.length - 1]?.cells[0]);
    runTableAction(editor, ADD_ROW);
    cursorInto(editor, table.rows[table.rows.length - 1]?.cells[0]);
  };

  const commandButton = (id: CommandId, Glyph: Icon, danger = false) => {
    const command = commands.get(id);
    if (!command || block === null) return null;
    const label = labelOf(command, ctx(), t);
    const keys = command.shortcut ? shortcutLabel(id) : null;
    const enabled = command.enabled?.(ctx()) ?? true;
    return (
      <button
        type="button"
        data-testid={`table-bar-${id}`}
        aria-label={label}
        title={enabled === true ? withKeys(t, label, keys) : t(enabled.reason)}
        aria-disabled={enabled === true ? undefined : true}
        className={`${iconButtonClass} table-bar-button${danger ? " table-bar-delete" : ""}`}
        onClick={() => run(id)}
      >
        <Glyph />
      </button>
    );
  };

  const markButton = (
    label: string,
    pressed: boolean,
    Glyph: Icon,
    toggle: () => void,
    keys: string,
  ): ReactNode => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={withKeys(t, label, keys)}
      className={`${iconButtonClass} table-bar-button`}
      onClick={toggle}
    >
      <Glyph />
    </button>
  );

  const align = nextAlign(state.align);
  const AlignGlyph = ALIGNS[align].icon;

  return (
    <div
      ref={handles}
      className="table-handles"
      // Keep the cursor, or the cells selected, in the table: the handles act there.
      onMouseDownCapture={(event) => event.preventDefault()}
    >
      <button
        ref={rowHandle}
        type="button"
        tabIndex={-1}
        hidden={!hoverShown}
        data-testid="table-row-handle"
        aria-label={t("editor.table.rowHandle")}
        title={t("editor.table.rowHandle")}
        className="table-handle table-handle--row"
        onClick={() => selectLine("row")}
      >
        <RowHandleIcon />
      </button>
      <button
        ref={columnHandle}
        type="button"
        tabIndex={-1}
        hidden={!hoverShown}
        data-testid="table-column-handle"
        aria-label={t("editor.table.columnHandle")}
        title={t("editor.table.columnHandle")}
        className="table-handle table-handle--column"
        onClick={() => selectLine("column")}
      >
        <ColumnHandleIcon />
      </button>
      <button
        ref={addRow}
        type="button"
        tabIndex={-1}
        hidden={!hoverShown}
        data-testid="table-add-row"
        className="table-add-row"
        onClick={appendRow}
      >
        <PlusLineIcon />
        <span>{t("editor.table.addRow")}</span>
      </button>
      <div
        ref={bar}
        role="toolbar"
        aria-label={t("editor.table.cellBar")}
        data-testid="table-cell-bar"
        hidden={barCell === null}
        className="table-cell-bar"
      >
        {markButton(
          t("editor.format.bold"),
          state.bold,
          BoldIcon,
          () => editor.chain().focus().toggleBold().run(),
          keysHere("CmdOrCtrl+B"),
        )}
        {markButton(
          t("editor.format.italic"),
          state.italic,
          ItalicIcon,
          () => editor.chain().focus().toggleItalic().run(),
          keysHere("CmdOrCtrl+I"),
        )}
        {markButton(
          t("editor.format.code"),
          state.code,
          CodeIcon,
          () => editor.chain().focus().toggleCode().run(),
          keysHere("CmdOrCtrl+E"),
        )}
        <button
          type="button"
          aria-label={t(ALIGNS[align].label)}
          title={t(ALIGNS[align].label)}
          className={`${iconButtonClass} table-bar-button`}
          onClick={() => setAlign(editor, align)}
        >
          <AlignGlyph />
        </button>
        <span className="table-bar-rule" />
        {commandButton("table.rowBelow", AddRowBelowIcon)}
        {commandButton("table.columnRight", AddColumnRightIcon)}
        <span className="table-bar-rule" />
        {commandButton(
          state.columns ? "table.deleteColumn" : "table.deleteRow",
          TrashLineIcon,
          true,
        )}
      </div>
    </div>
  );
}
