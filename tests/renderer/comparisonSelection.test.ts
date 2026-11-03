import { expect, test, vi } from "vitest";
import { refillableComparisonCells } from "../../src/renderer/src/comparisonRefill";
import { comparisonCellsInTable } from "../../src/renderer/src/comparisonSelection";
import { headlessEditor } from "../helpers/editor";

vi.mock("../../src/renderer/src/core", () => ({ core: { on: () => () => {} } }));

test("a one-row column refill does not count an edited cell as eligible", () => {
  const editor = headlessEditor();
  editor.commands.insertContent({
    type: "comparisonTable",
    attrs: { id: "table", questions: [{ id: "question", text: "Question" }] },
    content: [
      {
        type: "comparisonRow",
        attrs: { documentId: "document" },
        content: [
          {
            type: "comparisonCell",
            attrs: { questionId: "question", status: "done", edited: true },
            content: [{ type: "paragraph" }],
          },
        ],
      },
    ],
  });
  const handle = { editor, tableId: "table", mindId: "mind" };
  const requested = [{ documentId: "document", questionId: "question" }];

  expect(refillableComparisonCells(handle, "refill", requested)).toHaveLength(1);
  expect(refillableComparisonCells(handle, "refill", requested, "column")).toHaveLength(0);
});

test("refill candidates exclude hidden columns unless browsing includes them", () => {
  const editor = headlessEditor();
  editor.commands.insertContent({
    type: "comparisonTable",
    attrs: {
      id: "table",
      questions: [
        { id: "visible", text: "Visible" },
        { id: "hidden", text: "Hidden", hidden: true },
      ],
    },
    content: [
      {
        type: "comparisonRow",
        attrs: { documentId: "document" },
        content: [
          {
            type: "comparisonCell",
            attrs: { questionId: "visible", status: "done" },
            content: [{ type: "paragraph" }],
          },
          {
            type: "comparisonCell",
            attrs: { questionId: "hidden", status: "done" },
            content: [{ type: "paragraph" }],
          },
        ],
      },
    ],
  });
  const handle = { editor, tableId: "table" };

  expect(comparisonCellsInTable(handle, false)).toEqual([
    { documentId: "document", questionId: "visible" },
  ]);
  expect(comparisonCellsInTable(handle, true)).toEqual([
    { documentId: "document", questionId: "visible" },
    { documentId: "document", questionId: "hidden" },
  ]);
});
