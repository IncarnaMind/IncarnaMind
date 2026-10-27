import { COMPARISON_TABLE_NODE } from "../../../core/api";
import { comparisonQuestionsOf } from "../../../shared/comparisons";
import {
  canInsertColumn,
  comparisonColumnHandles,
  duplicateColumn,
  removeColumn,
  startColumnEdit,
  startColumnInsert,
} from "../comparisonColumns";
import { startCompareDocuments, useComparisons } from "../comparisons";
import { comparisonTableAt } from "../editor/comparisonCommands";
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

const unavailable = { reason: "comparison.column.unavailable" } as const;
const insertReason = { reason: "comparison.column.maxQuestions" } as const;

const editEnabled = (ctx: CommandContext) => (columnHere(ctx) ? true : unavailable);

const addEnabled = (ctx: CommandContext) => {
  const here = columnHere(ctx);
  if (!here) return unavailable;
  return canInsertColumn(here.questions.length) ? true : insertReason;
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
];
