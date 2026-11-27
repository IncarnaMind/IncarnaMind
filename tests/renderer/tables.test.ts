import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { describe, expect, onTestFinished, test } from "vitest";
import { CITATION_NODE } from "../../src/core";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { canTurnInto, TURN_INTO } from "../../src/renderer/src/editor/selectionCommands";
import {
  emptyTable,
  runTableAction,
  TABLE_ACTIONS,
  type TableActionId,
  TableKeys,
  tableSpot,
  wholeLines,
} from "../../src/renderer/src/editor/tableCommands";

const paragraph = (text = ""): JSONContent =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };

/** A headless editor holding these top-level Blocks, with the table's keys. */
function editorWith(blocks: JSONContent[]): Editor {
  const editor = new Editor({
    element: null,
    extensions: [...noteExtensions(), TableKeys],
    content: { type: "doc", content: blocks },
  });
  onTestFinished(() => editor.destroy());
  return editor;
}

/** Each row's cells' text, a heading cell's marked with "#". */
function grid(editor: Editor): string[][] {
  const rows: string[][] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "tableRow") return true;
    const cells: string[] = [];
    node.forEach((cell) => {
      cells.push(`${cell.type.name === "tableHeader" ? "#" : ""}${cell.textContent}`);
    });
    rows.push(cells);
    return false;
  });
  return rows;
}

/** The position inside the text of the cell at this row and column. */
function inCell(editor: Editor, row: number, column: number): number {
  let at = -1;
  let rowIndex = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "tableRow") {
      rowIndex++;
      if (rowIndex !== row) return false;
      node.forEach((_cell, cellOffset, index) => {
        if (index === column) at = pos + 1 + cellOffset + 2;
      });
      return false;
    }
    return true;
  });
  return at;
}

const action = (id: TableActionId) => {
  const found = TABLE_ACTIONS.find((each) => each.id === id);
  if (!found) throw new Error(`No table action ${id}.`);
  return found;
};

/** A table with a heading row, its cells named by row and column: "a1", "b2"… */
const named = (): JSONContent => {
  const table = emptyTable(3, 2);
  table.content?.forEach((row, rowIndex) => {
    row.content?.forEach((cell, column) => {
      cell.content = [paragraph(`${"ab"[column]}${rowIndex + 1}`)];
    });
  });
  return table;
};

describe("tables in the editor", () => {
  test('a new table, as "/" inserts one, is a heading row over two rows of three empty cells', () => {
    const editor = editorWith([paragraph("Before"), emptyTable(), paragraph()]);
    expect(grid(editor)).toEqual([
      ["#", "#", "#"],
      ["", "", ""],
      ["", "", ""],
    ]);
    editor.commands.setTextSelection(inCell(editor, 0, 0));
    expect(tableSpot(editor.state)).toMatchObject({ rows: 1, columns: 1, headerRow: true });
  });

  test("the table menu's actions add and delete rows and columns where the cursor is, and switch the heading row", () => {
    const editor = editorWith([named(), paragraph("After")]);
    editor.commands.setTextSelection(inCell(editor, 1, 0));
    expect(editor.state.selection.$head.parent.textContent).toBe("a2");

    runTableAction(editor, action("rowBelow"));
    runTableAction(editor, action("columnRight"));
    expect(grid(editor)).toEqual([
      ["#a1", "#", "#b1"],
      ["a2", "", "b2"],
      ["", "", ""],
      ["a3", "", "b3"],
    ]);
    runTableAction(editor, action("rowAbove"));
    runTableAction(editor, action("columnLeft"));
    expect(grid(editor)[0]).toEqual(["#", "#a1", "#", "#b1"]);
    expect(grid(editor).map((row) => row[1])).toEqual(["#a1", "", "a2", "", "a3"]);

    // The row and the column the cursor is in go.
    editor.commands.setTextSelection(inCell(editor, 1, 0));
    runTableAction(editor, action("deleteRow"));
    editor.commands.setTextSelection(inCell(editor, 0, 0));
    runTableAction(editor, action("deleteColumn"));
    expect(grid(editor).map((row) => row.join(","))).toEqual([
      "#a1,#,#b1",
      "a2,,b2",
      ",,",
      "a3,,b3",
    ]);

    runTableAction(editor, action("headerRow"));
    expect(grid(editor)[0]).toEqual(["a1", "", "b1"]);
    expect(tableSpot(editor.state)?.headerRow).toBe(false);
    runTableAction(editor, action("headerRow"));
    expect(tableSpot(editor.state)?.headerRow).toBe(true);

    runTableAction(editor, action("deleteTable"));
    const types: string[] = [];
    editor.state.doc.forEach((node) => {
      types.push(node.type.name);
    });
    expect(types).not.toContain("table");
    expect(editor.state.doc.textContent).toBe("After");
  });

  test("a selection of cells counts its rows and columns; the table's last row or column can't be deleted", () => {
    const editor = editorWith([named()]);
    const first = inCell(editor, 0, 0) - 2;
    const last = inCell(editor, 2, 0) - 2;
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last)),
    );
    expect(tableSpot(editor.state)).toMatchObject({
      rows: 3,
      columns: 1,
      canDeleteRows: false,
      canDeleteColumns: true,
    });
    expect(runTableAction(editor, action("deleteRow"))).toBe(false);
    expect(grid(editor)).toHaveLength(3);
    expect(runTableAction(editor, action("deleteColumn"))).toBe(true);
    expect(grid(editor)).toEqual([["#b1"], ["b2"], ["b3"]]);
    expect(tableSpot(editor.state)?.canDeleteColumns).toBe(false);
  });

  // protects=the cell bar's Delete takes only rows or columns the selection holds whole, and says which; fails_when=cells dragged across delete their rows, or a column's Delete takes a row; no_claim=where the bar sits.
  test("the cell bar's Delete is for whole rows or whole columns: cells dragged across get none", () => {
    const lettered = (rows: number): JSONContent => {
      const table = emptyTable(rows, 3);
      table.content?.forEach((row, rowIndex) => {
        row.content?.forEach((cell, column) => {
          cell.content = [paragraph(`${"abc"[column]}${rowIndex + 1}`)];
        });
      });
      return table;
    };
    const select = (editor: Editor, from: [number, number], to: [number, number]) => {
      const cell = ([row, column]: [number, number]) => inCell(editor, row, column) - 2;
      editor.view.dispatch(
        editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cell(from), cell(to))),
      );
      return wholeLines(editor.state.selection);
    };
    const deleteWhole = (editor: Editor) => {
      const lines = wholeLines(editor.state.selection);
      if (lines === null) throw new Error("Nothing whole to delete.");
      return runTableAction(editor, action(lines === "columns" ? "deleteColumn" : "deleteRow"));
    };

    const editor = editorWith([lettered(3)]);
    editor.commands.setTextSelection(inCell(editor, 1, 1));
    expect(wholeLines(editor.state.selection)).toBeNull();
    // Two cells, and a block of four: neither whole rows nor whole columns, so no Delete.
    expect(select(editor, [1, 0], [1, 1])).toBeNull();
    expect(select(editor, [1, 0], [2, 1])).toBeNull();

    // A row's handle selects it whole: Delete takes that row and no other.
    expect(select(editor, [1, 0], [1, 2])).toBe("rows");
    expect(deleteWhole(editor)).toBe(true);
    expect(grid(editor)).toEqual([
      ["#a1", "#b1", "#c1"],
      ["a3", "b3", "c3"],
    ]);

    // A column's handle selects it whole: Delete takes the column, not a row.
    expect(select(editor, [0, 1], [1, 1])).toBe("columns");
    expect(deleteWhole(editor)).toBe(true);
    expect(grid(editor)).toEqual([
      ["#a1", "#c1"],
      ["a3", "c3"],
    ]);

    // In a one-row table a column is still a column, and two of its cells are two columns.
    const oneRow = editorWith([lettered(1)]);
    expect(select(oneRow, [0, 1], [0, 1])).toBe("columns");
    expect(deleteWhole(oneRow)).toBe(true);
    expect(grid(oneRow)).toEqual([["#a1", "#c1"]]);
    expect(select(oneRow, [0, 0], [0, 0])).toBe("columns");
  });

  test("outside a table there is no table menu", () => {
    const editor = editorWith([paragraph("Plain")]);
    editor.commands.setTextSelection(2);
    expect(tableSpot(editor.state)).toBeNull();
  });
});

describe('the selection menu\'s Text › "Table"', () => {
  const turnIntoTable = (editor: Editor) => {
    const kind = TURN_INTO.find((each) => each.id === "table");
    if (!kind) throw new Error("No table to turn into.");
    return kind.run(editor);
  };
  const marked = (value: string, mark: string): JSONContent => ({
    type: "text",
    text: value,
    marks: [{ type: mark }],
  });
  const cited: JSONContent = {
    type: CITATION_NODE,
    attrs: { passageId: "p1", documentId: "d1", documentName: "Tides", quote: "new moon" },
  };

  test("each line of the Blocks selected becomes a row, cut into cells at tabs, keeping marks and Citations, with no heading row", () => {
    const editor = editorWith([
      {
        type: "paragraph",
        content: [{ type: "text", text: "Spring\tAt " }, marked("new moon", "bold"), cited],
      },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Neap" }] },
      paragraph("After"),
    ]);
    const second = editor.state.doc.child(0).nodeSize + 3;
    editor.commands.setTextSelection({ from: 3, to: second });
    expect(canTurnInto(editor)).toBe(true);

    expect(turnIntoTable(editor)).toBe(true);
    expect(grid(editor)).toEqual([
      ["Spring", "At new moon"],
      ["Neap", ""],
    ]);
    const table = editor.state.doc.child(0);
    expect(table.type.name).toBe("table");
    const cell = table.child(0).child(1).child(0);
    expect(cell.child(1).marks.map((mark) => mark.type.name)).toEqual(["bold"]);
    expect(cell.child(2).type.name).toBe(CITATION_NODE);
    expect(cell.child(2).attrs.quote).toBe("new moon");
    expect(editor.state.doc.child(1).textContent).toBe("After");
    expect(tableSpot(editor.state)?.headerRow).toBe(false);
  });

  test("a list turns as a whole, an item a row; a table itself isn't turned into anything", () => {
    const item = (value: string): JSONContent => ({
      type: "listItem",
      content: [paragraph(value)],
    });
    const editor = editorWith([
      { type: "bulletList", content: [item("High water"), item("Low water")] },
      named(),
    ]);
    editor.commands.setTextSelection(4);
    turnIntoTable(editor);
    expect(grid(editor).slice(0, 2)).toEqual([["High water"], ["Low water"]]);

    editor.commands.setTextSelection(inCell(editor, 2, 1));
    expect(editor.state.selection.$head.parent.textContent).toBe("b1");
    expect(canTurnInto(editor)).toBe(false);
    editor.commands.setTextSelection({ from: 3, to: editor.state.doc.content.size - 3 });
    expect(canTurnInto(editor)).toBe(false);
  });
});
