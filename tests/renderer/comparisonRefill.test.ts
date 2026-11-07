import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import {
  ownComparisonCells,
  refillableComparisonCells,
} from "../../src/renderer/src/comparisonRefill";
import { boundEditorTo } from "../helpers/editor";

vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => undefined, fillComparisonTable: async () => ({ started: false }) },
  files: {},
}));

const cell = (questionId: string, text: string, edited = false): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done", ...(edited && { edited: true }) },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const TABLE: NodeJSON = {
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice" },
      { id: "q2", text: "Governing law" },
    ],
  },
  content: [
    {
      type: "comparisonRow",
      attrs: { documentId: "doc-a", documentName: "Corvane" },
      content: [cell("q1", "90 days", true), cell("q2", "New York")],
    },
    {
      type: "comparisonRow",
      attrs: { documentId: "doc-b", documentName: "Halvard" },
      content: [cell("q1", "6 months"), cell("q2", "Delaware")],
    },
  ],
};

function boundTable() {
  const doc = new Y.Doc();
  doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(TABLE)]);
  return { editor: boundEditorTo(doc), mindId: "mind-1", tableId: "table-1" };
}

const all = [
  { documentId: "doc-a", questionId: "q1" },
  { documentId: "doc-a", questionId: "q2" },
  { documentId: "doc-b", questionId: "q1" },
  { documentId: "doc-b", questionId: "q2" },
];

describe("Filling a whole table again", () => {
  test("an edited cell is the User's own, so a whole-table fill leaves it unless they ask", () => {
    const handle = boundTable();
    expect(ownComparisonCells(handle, all)).toEqual([{ documentId: "doc-a", questionId: "q1" }]);
    const own = new Set(
      ownComparisonCells(handle, all).map((each) => `${each.documentId}${each.questionId}`),
    );
    const withoutMine = all.filter((each) => !own.has(`${each.documentId}${each.questionId}`));
    expect(refillableComparisonCells(handle, "refill-all", all)).toHaveLength(4);
    expect(refillableComparisonCells(handle, "refill-all", withoutMine)).toEqual([
      { documentId: "doc-a", questionId: "q2" },
      { documentId: "doc-b", questionId: "q1" },
      { documentId: "doc-b", questionId: "q2" },
    ]);
  });

  test("a cell with nothing of the User's is not one of theirs", () => {
    const handle = boundTable();
    expect(ownComparisonCells(handle, all.slice(1))).toEqual([]);
  });
});
