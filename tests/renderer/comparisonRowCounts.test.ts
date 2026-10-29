import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import {
  problemCounts,
  rowShows,
  shownRowCount,
} from "../../src/renderer/src/editor/comparisonRowCounts";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";

const schema = getSchema(noteExtensions());

const cell = (questionId: string, status: string, problem?: string): JSONContent => ({
  type: "comparisonCell",
  attrs: { questionId, status, ...(problem && { problem }) },
  content: [{ type: "paragraph", attrs: { id: `block-${questionId}` } }],
});

/** A table whose rows are one Document each: a cell that found nothing, one that failed, one done. */
function table(): ProseMirrorNode {
  return schema.nodeFromJSON({
    type: "comparisonTable",
    attrs: {
      id: "table-1",
      questions: [
        { id: "q1", text: "Termination notice" },
        { id: "q2", text: "Liability cap" },
      ],
    },
    content: [
      {
        type: "comparisonRow",
        attrs: { documentId: "doc-0", documentName: "Found nothing.txt" },
        content: [cell("q1", "failed", "not-found"), cell("q2", "done")],
      },
      {
        type: "comparisonRow",
        attrs: { documentId: "doc-1", documentName: "Failed.txt" },
        content: [cell("q1", "failed", "auth"), cell("q2", "done")],
      },
      {
        type: "comparisonRow",
        attrs: { documentId: "doc-2", documentName: "Done.txt" },
        content: [cell("q1", "done"), cell("q2", "done")],
      },
    ],
  });
}

const rowsOf = (node: ProseMirrorNode): ProseMirrorNode[] => {
  const rows: ProseMirrorNode[] = [];
  node.forEach((row) => rows.push(row));
  return rows;
};

describe("a comparison table's counts and the rows they show", () => {
  test("both counts on show the rows with either kind of cell, not only the rows with both", () => {
    const node = table();
    const rows = rowsOf(node);
    expect(problemCounts(node, new Set())).toEqual({ nothing: 1, failed: 1 });
    const both = new Set(["nothing", "failed"] as const);
    expect(rows.map((row) => rowShows(row, new Set(), both))).toEqual([true, true, false]);
    expect(shownRowCount(node, new Set(), both)).toBe(2);

    // One count shows its own rows alone.
    expect(rows.map((row) => rowShows(row, new Set(), new Set(["nothing"])))).toEqual([
      true,
      false,
      false,
    ]);
    expect(rows.map((row) => rowShows(row, new Set(), new Set(["failed"])))).toEqual([
      false,
      true,
      false,
    ]);

    // A hidden column is out of the counts and out of the rows they show.
    const hidden = new Set(["q1"]);
    expect(problemCounts(node, hidden)).toEqual({ nothing: 0, failed: 0 });
    expect(shownRowCount(node, hidden, both)).toBe(0);
  });
});
