import { COMPARISON_TABLE_NODE } from "../../../core/api";
import { startCompareDocuments, useComparisons } from "../comparisons";
import { exportComparison } from "../exports";
import { currentMindIdOf } from "../layoutSlice";
import { useAppStore } from "../store";
import { noteHandle } from "./handles";
import type { Command } from "./registry";

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
];
