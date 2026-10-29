import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";

/**
 * Marks the row or column of the cell at `cell` (an offset in `table`) a
 * total, or not one, whatever its label says, for the footing of every figure
 * in it (#1932). A column's role goes on each of its cells, so it survives
 * rows added or moved.
 */
export function setTableRoles(
  tr: Transaction,
  { table, start }: { table: ProseMirrorNode; start: number },
  cell: number,
  axes: readonly ("row" | "column")[],
  total: boolean,
): void {
  const role = total ? "total" : "detail";
  const map = TableMap.get(table);
  const rect = map.findCell(cell);
  if (axes.includes("row")) {
    let offset = 0;
    for (let index = 0; index < rect.top; index++) offset += table.child(index).nodeSize;
    const row = table.child(rect.top);
    tr.setNodeMarkup(start + offset, undefined, { ...row.attrs, figureRowRole: role });
  }
  if (axes.includes("column"))
    for (const offset of new Set(
      map.cellsInRect({ left: rect.left, right: rect.left + 1, top: 0, bottom: map.height }),
    )) {
      const node = table.nodeAt(offset);
      if (node)
        tr.setNodeMarkup(start + offset, undefined, { ...node.attrs, figureColumnRole: role });
    }
}
