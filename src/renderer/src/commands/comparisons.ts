import { COMPARISON_TABLE_NODE } from "../../../core/api";
import { comparisonCellOf, comparisonQuestionsOf } from "../../../shared/comparisons";
import { comparisonCellHandles, comparisonCellRef } from "../comparisonCellHandle";
import { useComparisonCells } from "../comparisonCellState";
import {
  comparisonCellLocation,
  comparisonCellsAllReviewed,
  comparisonCellsSelected,
  copyComparisonCells,
  refillComparisonCells,
  startComparisonCellEdit,
  toggleComparisonCellsReviewed,
} from "../comparisonCells";
import {
  canInsertColumn,
  comparisonColumnHandles,
  duplicateColumn,
  hideColumn,
  removeColumn,
  resizeColumn,
  startColumnEdit,
  startColumnInsert,
  stepColumn,
} from "../comparisonColumns";
import { fittedColumnWidth } from "../comparisonColumnWidth";
import { refillComparison } from "../comparisonRefill";
import { openRowDocument, removeRow, stepRow } from "../comparisonRows";
import { comparisonCellsInTable } from "../comparisonSelection";
import { startCompareDocuments, useComparisons } from "../comparisons";
import { startTableRename } from "../comparisonTableName";
import {
  comparisonRowHandles,
  comparisonTableHandles,
  useComparisonTables,
} from "../comparisonTableState";
import { comparisonTableAt } from "../editor/comparisonCommands";
import { comparisonRowCount, comparisonRowHere } from "../editor/comparisonRowCommands";
import { exportComparison } from "../exports";
import { currentMindIdOf } from "../layoutSlice";
import { useAppStore } from "../store";
import { noteHandle } from "./handles";
import type { Command, CommandContext } from "./registry";

/** The top-level Block the cursor is in, in the Mind's editor the User last wrote in. */
function cursorBlockIn(mindId: string | null): string | null {
  const note = noteHandle.current;
  if (!mindId || note?.mindId !== mindId || note.editor.isDestroyed) return null;
  const { $from } = note.editor.state.selection;
  const id = $from.depth > 0 ? $from.node(1).attrs.id : null;
  return typeof id === "string" ? id : null;
}

function tableToExport(): { mindId: string; tableId: string } | null {
  const mindId = currentMindIdOf(useAppStore.getState().layout);
  const note = noteHandle.current;
  if (!mindId || note?.mindId !== mindId || note.editor.isDestroyed) return null;
  const tables: string[] = [];
  note.editor.state.doc.forEach((block) => {
    if (block.type.name === COMPARISON_TABLE_NODE && typeof block.attrs.id === "string") {
      tables.push(block.attrs.id);
    }
  });
  const expanded = useComparisons.getState().expanded;
  const atCursor = cursorBlockIn(mindId);
  const tableId =
    (expanded && tables.includes(expanded) ? expanded : null) ??
    (atCursor && tables.includes(atCursor) ? atCursor : null) ??
    (tables.length === 1 ? (tables[0] ?? null) : null);
  return tableId ? { mindId, tableId } : null;
}

function columnHere(ctx: CommandContext) {
  if (ctx.focus?.kind !== "comparisonColumn") return null;
  const handle = comparisonColumnHandles.get(ctx.focus.id);
  if (!handle || handle.editor.isDestroyed || !handle.editor.isEditable) return null;
  const pos = comparisonTableAt(handle.editor, handle.tableId);
  const table = pos === null ? null : handle.editor.state.doc.nodeAt(pos);
  const questions = table ? comparisonQuestionsOf(table.attrs) : [];
  const question = questions.find((each) => each.id === ctx.focus?.id);
  return question ? { handle, question, questions } : null;
}

function actColumn(
  ctx: CommandContext,
  run: (here: NonNullable<ReturnType<typeof columnHere>>) => void,
): void {
  const here = columnHere(ctx);
  if (here) run(here);
}

function cellHere(ctx: CommandContext) {
  if (ctx.focus?.kind !== "comparisonCell") return null;
  const handle = comparisonCellHandles.get(ctx.focus.id);
  if (!handle || handle.editor.isDestroyed || !comparisonCellLocation(handle)) return null;
  return handle;
}

function editableCellHere(ctx: CommandContext) {
  const handle = cellHere(ctx);
  return handle?.editor.isEditable ? handle : null;
}

const cellEnabled = (ctx: CommandContext) => (cellHere(ctx) ? true : cellUnavailable);
const editableCellEnabled = (ctx: CommandContext) =>
  editableCellHere(ctx) ? true : cellUnavailable;
const oneCell = (ctx: CommandContext) => {
  const handle = editableCellHere(ctx);
  return handle !== null && comparisonCellsSelected(handle).length === 1;
};
const reviewedEnabled = (ctx: CommandContext) => {
  const handle = editableCellHere(ctx);
  if (!handle) return cellUnavailable;
  return comparisonCellsSelected(handle).some((target) => {
    const location = comparisonCellLocation({ ...handle, ...target });
    return location && comparisonCellOf(location.cell.attrs).status === "done";
  })
    ? true
    : cellUnavailable;
};

const unavailable = { reason: "comparison.column.unavailable" } as const;
const tableUnavailable = { reason: "comparison.table.unavailable" } as const;
const rowUnavailable = { reason: "comparison.row.unavailable" } as const;
const cellUnavailable = { reason: "comparison.cell.unavailable" } as const;
const insertReason = { reason: "comparison.column.maxQuestions" } as const;

/** The table a menu or ⌘K names, with the editor showing it. */
function tableHere(ctx: CommandContext) {
  if (ctx.focus?.kind !== "comparisonTable") return null;
  const handle = comparisonTableHandles.get(ctx.focus.id);
  if (!handle || handle.editor.isDestroyed || !handle.editor.isEditable) return null;
  return comparisonTableAt(handle.editor, handle.tableId) === null ? null : handle;
}

/** The row a menu or ⌘K names, where it is now. */
function rowHere(ctx: CommandContext) {
  if (ctx.focus?.kind !== "comparisonRow") return null;
  const handle = comparisonRowHandles.get(ctx.focus.id);
  if (!handle || handle.editor.isDestroyed || !handle.editor.isEditable) return null;
  const here = comparisonRowHere(handle.editor, handle.tableId, handle.documentId);
  if (!here) return null;
  return { handle, here, rows: comparisonRowCount(handle.editor, handle.tableId) };
}

const tableEnabled = (ctx: CommandContext) => (tableHere(ctx) ? true : tableUnavailable);

const rowMoveEnabled = (direction: -1 | 1) => (ctx: CommandContext) => {
  const found = rowHere(ctx);
  if (!found) return rowUnavailable;
  const to = found.here.index + direction;
  return to >= 0 && to < found.rows
    ? true
    : ({ reason: direction < 0 ? "comparison.row.first" : "comparison.row.last" } as const);
};

const editEnabled = (ctx: CommandContext) => (columnHere(ctx) ? true : unavailable);

const addEnabled = (ctx: CommandContext) => {
  const here = columnHere(ctx);
  if (!here) return unavailable;
  return canInsertColumn(here.questions.length) ? true : insertReason;
};

/** The table whose columns are hidden, as Export resolves one: it needs no heading to be focused. */
function hiddenTable(): { mindId: string; tableId: string } | null {
  const table = tableToExport();
  const note = noteHandle.current;
  if (!table || note?.mindId !== table.mindId || note.editor.isDestroyed) return null;
  const pos = comparisonTableAt(note.editor, table.tableId);
  const node = pos === null ? null : note.editor.state.doc.nodeAt(pos);
  const hidden = node
    ? comparisonQuestionsOf(node.attrs).some((question) => question.hidden === true)
    : false;
  return hidden ? table : null;
}

const moveEnabled = (direction: -1 | 1) => (ctx: CommandContext) => {
  const here = columnHere(ctx);
  if (!here) return unavailable;
  const index = here.questions.findIndex((question) => question.id === here.question.id);
  const beside = direction < 0 ? here.questions.slice(0, index) : here.questions.slice(index + 1);
  return beside.some((question) => question.hidden !== true)
    ? true
    : ({
        reason: direction < 0 ? "comparison.column.first" : "comparison.column.last",
      } as const);
};

export const comparisonCommands: readonly Command[] = [
  {
    // Compare Documents (#98): the sheet at the foot of the Mind in front, or of a new Mind.
    id: "comparison.start",
    label: "command.compareDocuments",
    keywords: ["command.compareDocuments.keywords"],
    group: "main",
    // Opening the sheet changes nothing; the table it makes is a change to accept.
    reversible: true,
    run: () => {
      const mindId = currentMindIdOf(useAppStore.getState().layout);
      return startCompareDocuments(mindId, cursorBlockIn(mindId));
    },
  },
  {
    id: "comparison.exportExcel",
    label: "export.excel.command",
    keywords: ["export.excel.keywords"],
    group: "main",
    // A new file under a free name: nothing is replaced, and the file stays the User's to delete.
    reversible: true,
    when: () => tableToExport() !== null,
    run: () => {
      const table = tableToExport();
      if (table) return exportComparison(table.mindId, table.tableId);
    },
  },
  {
    id: "comparison.column.edit",
    label: "comparison.column.edit",
    rowKeys: "F2",
    group: "main",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: editEnabled,
    run: (ctx) => actColumn(ctx, ({ handle, question }) => startColumnEdit(handle, question.id)),
  },
  {
    id: "comparison.column.insertLeft",
    label: "comparison.column.insertLeft",
    group: "main",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: addEnabled,
    run: (ctx) =>
      actColumn(ctx, ({ handle, question }) => startColumnInsert(handle, question.id, "left")),
  },
  {
    id: "comparison.column.insertRight",
    label: "comparison.column.insertRight",
    group: "main",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: addEnabled,
    run: (ctx) =>
      actColumn(ctx, ({ handle, question }) => startColumnInsert(handle, question.id, "right")),
  },
  {
    id: "comparison.column.duplicate",
    label: "comparison.column.duplicate",
    group: "main",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: addEnabled,
    run: (ctx) => actColumn(ctx, ({ handle, question }) => duplicateColumn(handle, question.id)),
  },
  {
    id: "comparison.column.moveLeft",
    label: "comparison.column.moveLeft",
    rowKeys: { mac: "Alt+Shift+Left", other: "Ctrl+Shift+Left" },
    group: "move",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: moveEnabled(-1),
    run: (ctx) =>
      actColumn(ctx, ({ handle, question }) => void stepColumn(handle, question.id, -1)),
  },
  {
    id: "comparison.column.moveRight",
    label: "comparison.column.moveRight",
    rowKeys: { mac: "Alt+Shift+Right", other: "Ctrl+Shift+Right" },
    group: "move",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: moveEnabled(1),
    run: (ctx) => actColumn(ctx, ({ handle, question }) => void stepColumn(handle, question.id, 1)),
  },
  {
    id: "comparison.column.hide",
    label: "comparison.column.hide",
    menuLabel: "comparison.column.hideMenu",
    group: "edit",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: editEnabled,
    run: (ctx) => actColumn(ctx, ({ handle, question }) => hideColumn(handle, question.id)),
  },
  {
    id: "comparison.column.showHidden",
    label: "comparison.column.showHidden",
    group: "edit",
    reversible: true,
    // Any table with a hidden column, even one with every column hidden: Export's way of resolving it.
    when: () => hiddenTable() !== null,
    // The table's own ⋯ is the picker: it lists each hidden column, and every way to show one.
    run: () => {
      const table = hiddenTable();
      if (!table) return;
      const button = document.querySelector<HTMLButtonElement>(
        `.comparison-table[data-comparison-table="${CSS.escape(table.tableId)}"] [data-testid="comparison-table-menu"]`,
      );
      requestAnimationFrame(() => button?.click());
    },
  },
  {
    id: "comparison.column.fit",
    label: "comparison.column.fit",
    group: "edit",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: editEnabled,
    run: (ctx) =>
      actColumn(ctx, ({ handle, question }) => {
        const table = document.querySelector<HTMLElement>(
          `.comparison-table[data-comparison-table="${CSS.escape(handle.tableId)}"]`,
        );
        const width = table ? fittedColumnWidth(table, question.id) : null;
        if (width !== null) resizeColumn(handle, question.id, width);
      }),
  },
  {
    id: "comparison.column.remove",
    label: "comparison.column.remove",
    rowKeys: "Delete",
    group: "danger",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    destructive: true,
    // The last column stays: a table without one has nothing to compare by.
    when: (ctx) => (columnHere(ctx)?.questions.length ?? 0) > 1,
    run: (ctx) => actColumn(ctx, ({ handle, question }) => removeColumn(handle, question.id)),
  },
  {
    id: "comparison.table.addDocuments",
    label: "comparison.table.addDocuments",
    group: "main",
    appliesTo: ["comparisonTable"],
    reversible: true,
    enabled: (ctx) => (tableHere(ctx) ? true : tableUnavailable),
    run: (ctx) => {
      const handle = tableHere(ctx);
      if (handle) useComparisonTables.getState().openAddDocuments(handle.tableId);
    },
  },
  {
    id: "comparison.table.rename",
    label: "comparison.table.rename",
    rowKeys: "F2",
    group: "edit",
    appliesTo: ["comparisonTable"],
    reversible: true,
    enabled: (ctx) => (tableHere(ctx) ? true : tableUnavailable),
    run: (ctx) => {
      const handle = tableHere(ctx);
      if (handle) startTableRename(handle.tableId);
    },
  },
  {
    id: "comparisonRow.open",
    label: "comparison.row.open",
    rowKeys: "Enter",
    group: "open",
    appliesTo: ["comparisonRow"],
    reversible: true,
    enabled: (ctx) => {
      const found = rowHere(ctx);
      if (!found) return rowUnavailable;
      return useAppStore.getState().documents.some((each) => each.id === found.here.documentId)
        ? true
        : ({ reason: "comparison.cell.sourceRemoved" } as const);
    },
    run: (ctx) => {
      const found = rowHere(ctx);
      if (found) openRowDocument(found.here.documentId);
    },
  },
  {
    id: "comparisonRow.moveUp",
    label: "comparison.row.moveUp",
    rowKeys: { mac: "Alt+Shift+Up", other: "Ctrl+Shift+Up" },
    group: "move",
    appliesTo: ["comparisonRow"],
    reversible: true,
    enabled: rowMoveEnabled(-1),
    run: (ctx) => {
      const found = rowHere(ctx);
      if (found) void stepRow(found.handle, found.here.documentId, -1);
    },
  },
  {
    id: "comparisonRow.moveDown",
    label: "comparison.row.moveDown",
    rowKeys: { mac: "Alt+Shift+Down", other: "Ctrl+Shift+Down" },
    group: "move",
    appliesTo: ["comparisonRow"],
    reversible: true,
    enabled: rowMoveEnabled(1),
    run: (ctx) => {
      const found = rowHere(ctx);
      if (found) void stepRow(found.handle, found.here.documentId, 1);
    },
  },
  {
    id: "comparison.row.refill",
    label: "comparison.row.refill",
    group: "main",
    appliesTo: ["comparisonRow"],
    reversible: true,
    enabled: (ctx) => (rowHere(ctx) ? true : rowUnavailable),
    run: (ctx) => {
      const found = rowHere(ctx);
      if (found) {
        refillComparison(
          found.handle,
          "refill",
          comparisonCellsInTable(found.handle, false).filter(
            (cell) => cell.documentId === found.here.documentId,
          ),
          "row",
        );
      }
    },
  },
  {
    id: "comparisonRow.remove",
    label: "comparison.row.remove",
    rowKeys: "Delete",
    group: "danger",
    appliesTo: ["comparisonRow"],
    reversible: true,
    destructive: true,
    // The last row stays, as the last column does.
    enabled: (ctx) => {
      const found = rowHere(ctx);
      if (!found) return rowUnavailable;
      return found.rows > 1 ? true : ({ reason: "comparison.table.lastRow" } as const);
    },
    run: (ctx) => {
      const found = rowHere(ctx);
      if (found && found.rows > 1) void removeRow(found.handle, found.here.documentId);
    },
  },
  {
    id: "comparison.table.refillAll",
    label: "comparison.table.refillAll",
    group: "main",
    appliesTo: ["comparisonTable"],
    reversible: true,
    enabled: tableEnabled,
    run: (ctx) => {
      const here = tableHere(ctx);
      if (here) {
        refillComparison(here, "refill-all", comparisonCellsInTable(here, false));
      }
    },
  },
  {
    id: "comparison.table.refillProblems",
    label: "comparison.table.refillProblems",
    group: "main",
    appliesTo: ["comparisonTable"],
    reversible: true,
    enabled: tableEnabled,
    run: (ctx) => {
      const here = tableHere(ctx);
      if (here) {
        refillComparison(here, "refill-problems", comparisonCellsInTable(here, false));
      }
    },
  },
  {
    id: "comparison.column.refill",
    label: "comparison.column.refill",
    group: "main",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: editEnabled,
    run: (ctx) =>
      actColumn(ctx, ({ handle, question }) =>
        refillComparison(
          handle,
          "refill",
          comparisonCellsInTable(handle, false).filter((cell) => cell.questionId === question.id),
          "column",
        ),
      ),
  },
  {
    id: "comparison.column.reviewed",
    label: "comparison.column.reviewed",
    assistant: { never: "signOff" },
    checked: (ctx) => {
      const here = columnHere(ctx);
      const cells = here
        ? comparisonCellsInTable(here.handle, false).filter(
            (cell) => cell.questionId === here.question.id,
          )
        : [];
      return here ? comparisonCellsAllReviewed(here.handle, cells) : false;
    },
    group: "main",
    appliesTo: ["comparisonColumn"],
    reversible: true,
    enabled: (ctx) => {
      const here = columnHere(ctx);
      if (!here) return unavailable;
      return comparisonCellsInTable(here.handle, false).some(
        (cell) =>
          cell.questionId === here.question.id &&
          comparisonCellOf(comparisonCellLocation({ ...here.handle, ...cell })?.cell.attrs ?? {})
            .status === "done",
      )
        ? true
        : unavailable;
    },
    run: (ctx) =>
      actColumn(ctx, ({ handle, question }) =>
        toggleComparisonCellsReviewed(
          handle,
          comparisonCellsInTable(handle, false).filter((cell) => cell.questionId === question.id),
        ),
      ),
  },
  {
    id: "comparison.cell.open",
    label: "comparison.cell.openCard",
    rowKeys: "Enter",
    group: "open",
    appliesTo: ["comparisonCell"],
    reversible: true,
    enabled: cellEnabled,
    run: (ctx) => {
      const handle = cellHere(ctx);
      if (handle) useComparisonCells.getState().openCard(comparisonCellRef(handle));
    },
  },
  {
    id: "comparison.cell.refill",
    label: "comparison.cell.fillAgain",
    group: "main",
    appliesTo: ["comparisonCell"],
    reversible: true,
    enabled: editableCellEnabled,
    run: (ctx) => {
      const handle = editableCellHere(ctx);
      if (!handle) return;
      const selected = comparisonCellsSelected(handle, ctx.surface !== "palette");
      const location = comparisonCellLocation(handle);
      if (selected.length === 1 && location && comparisonCellOf(location.cell.attrs).edited) {
        useComparisonCells.getState().openCard(comparisonCellRef(handle), true);
      } else refillComparisonCells(handle, "refill", ctx.surface !== "palette");
    },
  },
  {
    id: "comparison.cell.edit",
    label: "comparison.cell.edit",
    rowKeys: "F2",
    group: "edit",
    appliesTo: ["comparisonCell"],
    reversible: true,
    when: oneCell,
    run: (ctx) => {
      const handle = editableCellHere(ctx);
      if (handle) startComparisonCellEdit(handle);
    },
  },
  {
    id: "comparison.cell.reviewed",
    label: "comparison.cell.markReviewed",
    assistant: { never: "signOff" },
    checked: (ctx) => {
      const handle = cellHere(ctx);
      const selected = handle ? comparisonCellsSelected(handle) : [];
      return handle ? comparisonCellsAllReviewed(handle, selected) : false;
    },
    group: "main",
    appliesTo: ["comparisonCell"],
    reversible: true,
    enabled: reviewedEnabled,
    run: (ctx) => {
      const handle = editableCellHere(ctx);
      if (handle) toggleComparisonCellsReviewed(handle, comparisonCellsSelected(handle));
    },
  },
  {
    id: "comparison.cell.copy",
    label: "object.copy",
    rowKeys: "CmdOrCtrl+C",
    group: "edit",
    appliesTo: ["comparisonCell"],
    reversible: true,
    enabled: cellEnabled,
    run: async (ctx) => {
      const handle = cellHere(ctx);
      if (handle) await copyComparisonCells(handle, ctx.surface !== "palette");
    },
  },
];
