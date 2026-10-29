/**
 * A comparison table's rows (#1837), through the core as the table's menu
 * asks: Documents added later fill their rows alone, a row removed or moved
 * is one structure change that Undo and Redo take back and do again, and a
 * table keeps at least one row and at most a hundred.
 */
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { COMPARISON_TABLE_NODE, InvalidInputError, MIND_CONTENT_FIELD } from "../../src/core";
import { setUpWithDocuments } from "../helpers/citations";
import { cellModel, compare, comparisonRowsIn, copyRows, fillEnded } from "../helpers/comparisons";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import type { MindClient } from "../helpers/mindClient";

const SUPPLIERS = [
  {
    name: "Corvane.txt",
    contents: "Corvane Agreement.\nTermination notice: 90 days.\nLiability cap: 12 months of fees.",
  },
  {
    name: "Halvard.txt",
    contents: "Halvard MSA.\nTermination notice: 6 months.\nLiability cap: twice the annual fees.",
  },
  {
    name: "Lumeric.txt",
    contents: "Lumeric Order Form.\nTermination notice: 30 days.\nGoverning law: New York.",
  },
];

const QUESTION = "Termination notice";

/** A comparison table of `count` Documents by one Question, filled. */
async function filledTable(count = 2) {
  const setup = await setUpWithDocuments(cellModel(), SUPPLIERS);
  const { core, client, mind, documents } = setup;
  const tableId = await compare(core, client, {
    mindId: mind.id,
    documentIds: documents.slice(0, count).map((document) => document.id),
    questions: [QUESTION],
  });
  return { ...setup, tableId };
}

/** Puts a cell in the state a failed fill left it: a cell filling again would write. */
function setCellState(
  client: MindClient,
  documentId: string,
  questionId: string,
  attrs: Record<string, string | null>,
): void {
  client.doc.transact(() => {
    const table = client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (block): block is Y.XmlElement =>
          block instanceof Y.XmlElement && block.nodeName === COMPARISON_TABLE_NODE,
      );
    for (const row of table?.toArray() ?? []) {
      if (!(row instanceof Y.XmlElement) || row.getAttribute("documentId") !== documentId) {
        continue;
      }
      for (const cell of row.toArray()) {
        if (!(cell instanceof Y.XmlElement) || cell.getAttribute("questionId") !== questionId) {
          continue;
        }
        for (const [name, value] of Object.entries(attrs)) {
          if (value === null) cell.removeAttribute(name);
          else cell.setAttribute(name, value);
        }
      }
    }
  });
}

const rowNames = (client: MindClient) => comparisonRowsIn(client).map((row) => row.name);

describe("A comparison table's rows, all written by the core", () => {
  test("Documents added later fill their new rows alone, and the rest keep their Answers and problems", async () => {
    const { core, client, mind, documents, tableId } = await filledTable(2);
    // A cell the first fill left failed: a whole-table fill would write it again.
    const first = documents[0];
    if (!first) throw new Error("No first Document.");
    setCellState(client, first.id, comparisonRowsIn(client)[0]?.cells[0]?.questionId ?? "", {
      status: "failed",
      problem: "auth",
    });
    await client.settled();
    expect(comparisonRowsIn(client)[0]?.cells[0]).toMatchObject({
      status: "failed",
      problem: "auth",
    });

    const third = documents[2];
    if (!third) throw new Error("No third Document.");
    const added = await core.addComparisonRows({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentIds: [third.id],
    });
    expect(added).toMatchObject({ documentIds: [third.id], labels: [third.name], fill: true });
    expect(added.step).not.toBe("");
    expect(rowNames(client)).toEqual([documents[0]?.name, documents[1]?.name, third.name]);

    const ended = fillEnded(core, tableId);
    await core.fillComparisonTable({ mindId: mind.id, tableId, documentIds: added.documentIds });
    await ended;
    await client.settled();

    expect(comparisonRowsIn(client).map((row) => row.cells[0]?.status)).toEqual([
      "failed",
      "done",
      "done",
    ]);
    expect(comparisonRowsIn(client)[2]?.cells[0]?.text).toBe("30 days");

    // The whole table fills that one cell now: the fill before was for the new row alone.
    const again = fillEnded(core, tableId);
    await core.fillComparisonTable({ mindId: mind.id, tableId });
    await again;
    await client.settled();
    expect(comparisonRowsIn(client)[0]?.cells[0]).toMatchObject({ status: "done" });
  });

  test("Undo takes added rows out whole, and Redo puts them back with their Answers", async () => {
    const { core, client, mind, documents, tableId } = await filledTable(2);
    const third = documents[2];
    if (!third) throw new Error("No third Document.");
    const added = await core.addComparisonRows({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentIds: [third.id],
    });
    const ended = fillEnded(core, tableId);
    await core.fillComparisonTable({ mindId: mind.id, tableId, documentIds: added.documentIds });
    await ended;
    await client.settled();
    const before = comparisonRowsIn(client);

    await core.undoComparisonStructure({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      step: added.step,
    });
    await client.settled();
    expect(rowNames(client)).toEqual([documents[0]?.name, documents[1]?.name]);

    await core.redoComparisonStructure({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      step: added.step,
    });
    await client.settled();
    expect(comparisonRowsIn(client)).toEqual(before);
  });

  test("a row removed comes back whole with Undo, and the last row can't be removed", async () => {
    const { core, client, mind, documents, tableId } = await filledTable(3);
    const before = comparisonRowsIn(client);
    const removed = await core.removeComparisonRow({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentId: documents[0]?.id ?? "",
    });
    await client.settled();
    expect(removed.label).toBe(documents[0]?.name);
    expect(removed.focusDocumentId).toBe(documents[1]?.id);
    expect(comparisonRowsIn(client)).toEqual(before.slice(1));

    // A later change of the table refuses the Undo: only the window and the latest step undo.
    const moved = await core.moveComparisonRow({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentId: documents[2]?.id ?? "",
      to: 0,
    });
    await client.settled();
    expect(moved.moved).toBe(true);
    expect(
      await core.undoComparisonStructure({
        mindId: mind.id,
        clientId: "window-a",
        tableId,
        step: removed.step,
      }),
    ).toEqual({ moved: false, reason: "changed" });

    // One row left: it stays.
    await core.removeComparisonRow({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentId: documents[1]?.id ?? "",
    });
    await client.settled();
    expect(rowNames(client)).toEqual([documents[2]?.name]);
    await expect(
      core.removeComparisonRow({
        mindId: mind.id,
        clientId: "window-a",
        tableId,
        documentId: documents[2]?.id ?? "",
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  test("a moved row lands where it was dropped, and Undo and Redo move it back and forward", async () => {
    const { core, client, mind, documents, tableId } = await filledTable(3);
    const names = documents.map((document) => document.name);
    const moved = await core.moveComparisonRow({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentId: documents[0]?.id ?? "",
      to: 2,
    });
    await client.settled();
    expect(moved).toMatchObject({ index: 2, moved: true });
    expect(rowNames(client)).toEqual([names[1], names[2], names[0]]);
    expect(comparisonRowsIn(client)[2]?.cells[0]?.text).toBe("90 days");

    await core.undoComparisonStructure({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      step: moved.step,
    });
    await client.settled();
    expect(rowNames(client)).toEqual(names);

    await core.redoComparisonStructure({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      step: moved.step,
    });
    await client.settled();
    expect(rowNames(client)).toEqual([names[1], names[2], names[0]]);
  });

  test("a table takes up to 100 Documents, and adding one more says so plainly", async () => {
    const { core, client, mind, documents, tableId } = await filledTable(2);
    await copyRows(client, tableId, 100);
    expect(comparisonRowsIn(client)).toHaveLength(100);
    const folder = await createSourceFolder();
    const [fourth] = await addAndProcess(core, [
      await writeSourceFile(folder, "Fourth.txt", "Fourth MSA.\nTermination notice: 45 days."),
    ]);
    if (!fourth) throw new Error("No fourth Document.");
    await expect(
      core.addComparisonRows({
        mindId: mind.id,
        clientId: "window-a",
        tableId,
        documentIds: [fourth.id],
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(comparisonRowsIn(client)).toHaveLength(100);
    // A Document already in the table is dropped rather than counted twice.
    const again = await core.addComparisonRows({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentIds: [documents[0]?.id ?? ""],
    });
    expect(again).toMatchObject({ documentIds: [], step: "" });
  });

  test("a Document checks leave out is not added, and a row for a removed source keeps its row", async () => {
    const { core, client, mind, documents, tableId } = await filledTable(2);
    const removed = documents[1];
    if (!removed) throw new Error("No second Document.");
    await core.deleteDocument(removed.id);
    await client.settled();
    expect(rowNames(client)).toEqual([documents[0]?.name, removed.name]);
    const added = await core.addComparisonRows({
      mindId: mind.id,
      clientId: "window-a",
      tableId,
      documentIds: [removed.id],
    });
    expect(added.documentIds).toEqual([]);
  });
});
