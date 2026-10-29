import { expect, test } from "vitest";
import { comparisonCellsInTable } from "../../src/renderer/src/comparisonSelection";
import { headlessEditor } from "../helpers/editor";

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
