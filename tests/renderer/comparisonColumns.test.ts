import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON, syncContent } from "../../src/core/answers/blocks";
import {
  addColumn,
  duplicateColumn,
  hideColumn,
  moveColumn,
  removeColumn,
  resizeColumn,
  saveColumnEdit,
  useComparisonColumns,
} from "../../src/renderer/src/comparisonColumns";
import { comparisonTableAt } from "../../src/renderer/src/editor/comparisonCommands";
import { useUndo } from "../../src/renderer/src/undo";
import { comparisonQuestionsOf } from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, typeText } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";

const fills = vi.hoisted(() => ({
  calls: [] as { mindId: string; tableId: string; questionIds?: readonly string[] }[],
}));

/** The core the window's commands ask, when a test bound it to one. */
const bridge = vi.hoisted(() => ({
  core: null as null | {
    editComparisonColumn(input: unknown): Promise<unknown>;
    insertComparisonColumn(input: unknown): Promise<unknown>;
    duplicateComparisonColumn(input: unknown): Promise<unknown>;
    removeComparisonColumn(input: unknown): Promise<unknown>;
    resizeComparisonColumn(input: unknown): Promise<unknown>;
    setComparisonColumnHidden(input: unknown): Promise<unknown>;
    moveComparisonColumn(input: unknown): Promise<unknown>;
    undoComparisonStructure(input: unknown): Promise<unknown>;
    redoComparisonStructure(input: unknown): Promise<unknown>;
  },
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: () => () => undefined,
    fillComparisonTable: async (input: {
      mindId: string;
      tableId: string;
      questionIds?: readonly string[];
    }) => {
      fills.calls.push(input);
      return { started: true, tableId: input.tableId };
    },
    editComparisonColumn: (input: unknown) => bridge.core?.editComparisonColumn(input),
    insertComparisonColumn: (input: unknown) => bridge.core?.insertComparisonColumn(input),
    duplicateComparisonColumn: (input: unknown) => bridge.core?.duplicateComparisonColumn(input),
    removeComparisonColumn: (input: unknown) => bridge.core?.removeComparisonColumn(input),
    resizeComparisonColumn: (input: unknown) => bridge.core?.resizeComparisonColumn(input),
    setComparisonColumnHidden: (input: unknown) => bridge.core?.setComparisonColumnHidden(input),
    moveComparisonColumn: (input: unknown) => bridge.core?.moveComparisonColumn(input),
    undoComparisonStructure: (input: unknown) => bridge.core?.undoComparisonStructure(input),
    redoComparisonStructure: (input: unknown) => bridge.core?.redoComparisonStructure(input),
  },
  files: {},
}));

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const answer = (questionId: string, text: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done" },
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text },
        {
          type: "citation",
          attrs: { documentId: "doc-a", documentName: "A", quote: `${text} quote`, check: "found" },
        },
      ],
    },
  ],
});

/** Two Documents by three Questions, each cell an Answer, as the core fills one. */
const table = (): NodeJSON => ({
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice", label: "Notice" },
      { id: "q2", text: "Liability cap" },
      { id: "q3", text: "Governing law" },
    ],
  },
  content: ["doc-a", "doc-b"].map((documentId) => ({
    type: "comparisonRow",
    attrs: { documentId, documentName: documentId },
    content: [answer("q1", "90 days"), answer("q2", "12 months of fees"), answer("q3", "New York")],
  })),
});

/** An editor bound to a Mind of that table, and the core the window's commands ask. */
async function boundTable() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Suppliers" });
  const client = await connectToMind(core, mind.id);
  client.doc.transact(() => {
    client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([createElement(paragraph("Shortlist")), createElement(table())]);
  });
  await client.settled();
  const editor = boundEditor(client);
  bridge.core = core;
  onTestFinished(() => {
    bridge.core = null;
  });
  return { core, client, editor, mind, handle: { editor, mindId: mind.id, tableId: "table-1" } };
}

const questionsOf = (editor: ReturnType<typeof boundEditor>) => {
  const pos = comparisonTableAt(editor, "table-1");
  const node = pos === null ? null : editor.state.doc.nodeAt(pos);
  return node ? comparisonQuestionsOf(node.attrs) : [];
};

const cellsOf = (editor: ReturnType<typeof boundEditor>) => {
  const pos = comparisonTableAt(editor, "table-1");
  const found = pos === null ? null : editor.state.doc.nodeAt(pos);
  const rows: NodeJSON[] = [];
  found?.forEach((row) => {
    rows.push(row.toJSON());
  });
  return rows.map((row) => row.content ?? []);
};

const textOf = (cell: NodeJSON | undefined) =>
  (cell?.content ?? [])
    .flatMap((block) => block.content ?? [])
    .map((inline) => (inline.type === "text" ? (inline.text ?? "") : ""))
    .join("");

const answerUnder = (editor: ReturnType<typeof boundEditor>, questionId: string, row = 0) =>
  textOf(cellsOf(editor)[row]?.find((cell) => cell.attrs?.questionId === questionId));

const orderOf = (editor: ReturnType<typeof boundEditor>) =>
  questionsOf(editor).map((question) => question.id);

/** What the core does when a fill lands a cell: find it by Document and Question, set it. */
function fillWrite(writer: { doc: Y.Doc }, documentId: string, questionId: string, text: string) {
  writer.doc.transact(() => {
    const table = writer.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (element): element is Y.XmlElement =>
          element instanceof Y.XmlElement && element.nodeName === "comparisonTable",
      );
    if (!table) throw new Error("No table.");
    for (const row of table.toArray()) {
      if (!(row instanceof Y.XmlElement) || row.getAttribute("documentId") !== documentId) {
        continue;
      }
      for (const cell of row.toArray()) {
        if (cell instanceof Y.XmlElement && cell.getAttribute("questionId") === questionId) {
          cell.setAttribute("status", "done");
          syncContent(cell, [paragraph(text)]);
        }
      }
    }
  });
}

const settled = async (client: Awaited<ReturnType<typeof connectToMind>>) => {
  await client.settled();
};

describe("A comparison table's columns, all written by the core", () => {
  beforeEach(() => {
    fills.calls.length = 0;
    useUndo.setState({ done: [], undone: [], line: null, running: null, making: 0 });
    useComparisonColumns.setState({ busy: new Set(), focus: null, stale: {} });
  });

  test("hide then move: ⌘Z twice shows the column again, its Answer under it", async () => {
    const { editor, client, handle } = await boundTable();
    await hideColumn(handle, "q1");
    await settled(client);
    await moveColumn(handle, "q2", 0);
    await settled(client);
    expect(orderOf(editor)).toEqual(["q2", "q1", "q3"]);
    expect(questionsOf(editor).find((question) => question.id === "q1")?.hidden).toBe(true);

    await useUndo.getState().undo();
    await settled(client);
    await useUndo.getState().undo();
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
    expect(cellsOf(editor).map((cells) => cells.length)).toEqual([3, 3]);
    expect(questionsOf(editor).some((question) => question.hidden === true)).toBe(false);
    expect(answerUnder(editor, "q1")).toBe("90 days");
  });

  test("remove then move: ⌘Z twice puts the column and its Answer back", async () => {
    const { editor, client, handle } = await boundTable();
    await removeColumn(handle, "q1");
    await settled(client);
    await moveColumn(handle, "q3", 0);
    await settled(client);
    expect(orderOf(editor)).toEqual(["q3", "q2"]);
    expect(cellsOf(editor).map((cells) => cells.length)).toEqual([2, 2]);

    await useUndo.getState().undo();
    await settled(client);
    await useUndo.getState().undo();
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
    expect(cellsOf(editor).map((cells) => cells.length)).toEqual([3, 3]);
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", text: "Termination notice" });
    expect(answerUnder(editor, "q1")).toBe("90 days");
  });

  test("reword then move: ⌘Z twice brings the old Question and its Answers back, with no stray cell", async () => {
    const { editor, client, handle } = await boundTable();
    await saveColumnEdit(handle, "q1", { text: "Ending the agreement", label: "Ending" });
    await settled(client);
    const reworded = questionsOf(editor).find(
      (question) => question.text === "Ending the agreement",
    );
    if (!reworded) throw new Error("The Question wasn't reworded.");
    await moveColumn(handle, reworded.id, 2);
    await settled(client);

    await useUndo.getState().undo();
    await settled(client);
    await useUndo.getState().undo();
    await settled(client);
    expect(questionsOf(editor).map((question) => question.text)).toEqual([
      "Termination notice",
      "Liability cap",
      "Governing law",
    ]);
    expect(cellsOf(editor)[0]?.map((cell) => cell.attrs?.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(answerUnder(editor, "q1")).toBe("90 days");

    await useUndo.getState().redo();
    await settled(client);
    await useUndo.getState().redo();
    await settled(client);
    expect(orderOf(editor)[2]).toBe(reworded.id);
    expect(cellsOf(editor)[0]?.map((cell) => cell.attrs?.questionId)).toEqual([
      "q2",
      "q3",
      reworded.id,
    ]);
  });

  test("insert, duplicate and resize each survive a move's Undo, then Undo themselves", async () => {
    for (const action of ["insert", "duplicate", "resize"] as const) {
      const { editor, client, handle } = await boundTable();
      if (action === "insert") await addColumn(handle, "Governing law");
      if (action === "duplicate") await duplicateColumn(handle, "q1");
      if (action === "resize") await resizeColumn(handle, "q1", 410);
      await settled(client);
      const afterAction = orderOf(editor);
      expect(afterAction).toHaveLength(action === "resize" ? 3 : 4);
      if (action === "resize") {
        expect(questionsOf(editor)[0]?.width).toBe(410);
      } else {
        await moveColumn(handle, afterAction[3] as string, 0);
        await settled(client);
      }
      await useUndo.getState().undo();
      await settled(client);
      expect(orderOf(editor)).toEqual(afterAction);
      await useUndo.getState().undo();
      await settled(client);
      expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
      if (action === "resize") expect(questionsOf(editor)[0]?.width).toBeUndefined();
    }
  });

  test("move then hide: ⌘Z shows the column, ⌘Z again moves it back", async () => {
    const { editor, client, handle } = await boundTable();
    await moveColumn(handle, "q1", 1);
    await settled(client);
    await hideColumn(handle, "q1");
    await settled(client);
    expect(questionsOf(editor).find((question) => question.id === "q1")?.hidden).toBe(true);

    await useUndo.getState().undo();
    await settled(client);
    expect(questionsOf(editor).find((question) => question.id === "q1")?.hidden).toBeUndefined();
    await useUndo.getState().undo();
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
    expect(cellsOf(editor).map((cells) => cells.length)).toEqual([3, 3]);
  });

  test("a local write while the core changes the table is dropped", async () => {
    const { core, editor, client, handle } = await boundTable();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moving = core.moveComparisonColumn.bind(core);
    core.moveComparisonColumn = async (input) => {
      await held;
      return moving(input);
    };
    const change = moveColumn(handle, "q1", 1);
    await vi.waitFor(() => expect(useComparisonColumns.getState().busy.has("table-1")).toBe(true));
    const before = editor.getJSON();
    const pos = comparisonTableAt(editor, "table-1");
    if (pos === null) throw new Error("No table.");
    editor.commands.setTextSelection(pos + 4);
    typeText(editor, "x");
    const questions = questionsOf(editor);
    editor.view.dispatch(
      editor.state.tr.setNodeAttribute(pos, "questions", [...questions].reverse()),
    );
    expect(editor.getJSON()).toEqual(before);
    release();
    await change;
    await settled(client);
    expect(orderOf(editor)).toEqual(["q2", "q1", "q3"]);
    expect(answerUnder(editor, "q1")).toBe("90 days");
  });

  test("a window offline through a core move and a fill merges both, and a cell edit made away is not in the moved cell", async () => {
    const { core, editor, client, mind, handle } = await boundTable();
    const writer = await connectToMind(core, mind.id);
    client.goOffline();
    const pos = comparisonTableAt(editor, "table-1");
    if (pos === null) throw new Error("No table.");
    const line = editor.state.doc.nodeAt(pos)?.child(0).child(0).child(0);
    if (!line) throw new Error("No cell paragraph.");
    editor.commands.setTextSelection(pos + 4 + line.content.size);
    typeText(editor, " offline");
    // Another editor moves the column and a fill lands in it while this window is away.
    await core.moveComparisonColumn({
      mindId: handle.mindId,
      tableId: "table-1",
      questionId: "q1",
      to: 1,
    });
    fillWrite(writer, "doc-a", "q1", "90 days, as amended");
    await writer.settled();
    await client.goOnline();
    await client.settled();
    expect(orderOf(editor)).toEqual(["q2", "q1", "q3"]);
    const moved = cellsOf(editor)[0]?.find((cell) => cell.attrs?.questionId === "q1");
    expect(textOf(moved)).toContain("90 days, as amended");
    expect(textOf(moved)).not.toContain("offline");
    expect(answerUnder(editor, "q2")).toBe("12 months of fees");
  });

  test("move then reword: ⌘Z twice returns the old Question and its Answers, Redo twice does both again", async () => {
    const { editor, client, handle } = await boundTable();
    await moveColumn(handle, "q1", 1);
    await settled(client);
    await saveColumnEdit(handle, "q1", { text: "Notice period", label: "" });
    await settled(client);
    const reworded = questionsOf(editor).find((question) => question.text === "Notice period");
    if (!reworded) throw new Error("The Question wasn't reworded.");

    await useUndo.getState().undo();
    await settled(client);
    await useUndo.getState().undo();
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", text: "Termination notice" });
    expect(cellsOf(editor)[0]?.map((cell) => cell.attrs?.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(answerUnder(editor, "q1")).toBe("90 days");

    await useUndo.getState().redo();
    await settled(client);
    await useUndo.getState().redo();
    await settled(client);
    expect(orderOf(editor)[1]).toBe(reworded.id);
    expect(questionsOf(editor)[1]?.text).toBe("Notice period");
    expect(cellsOf(editor)[0]?.[1]?.attrs?.questionId).toBe(reworded.id);
  });

  test("hide then remove the last visible column: ⌘Z twice brings both back", async () => {
    const { editor, client, handle } = await boundTable();
    await hideColumn(handle, "q2");
    await settled(client);
    await removeColumn(handle, "q1");
    await settled(client);
    expect(orderOf(editor)).toEqual(["q2", "q3"]);
    expect(questionsOf(editor).find((question) => question.id === "q2")?.hidden).toBe(true);

    await useUndo.getState().undo();
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
    expect(answerUnder(editor, "q1")).toBe("90 days");
    await useUndo.getState().undo();
    await settled(client);
    expect(questionsOf(editor).some((question) => question.hidden === true)).toBe(false);
    expect(cellsOf(editor).map((cells) => cells.length)).toEqual([3, 3]);
  });

  test("width then reword: ⌘Z twice restores the old Question, its width and its Answers", async () => {
    const { editor, client, handle } = await boundTable();
    await resizeColumn(handle, "q1", 300);
    await settled(client);
    await saveColumnEdit(handle, "q1", { text: "Notice period", label: "" });
    await settled(client);
    expect(questionsOf(editor).find((question) => question.text === "Notice period")?.width).toBe(
      300,
    );

    await useUndo.getState().undo();
    await settled(client);
    await useUndo.getState().undo();
    await settled(client);
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", text: "Termination notice" });
    expect(questionsOf(editor)[0]?.width).toBeUndefined();
    expect(answerUnder(editor, "q1")).toBe("90 days");
  });

  test("two windows on one Note: the move takes in the other window's change and holds its edits until it lands", async () => {
    const { core, editor, client, mind, handle } = await boundTable();
    const clientB = await connectToMind(core, mind.id);
    const editorB = boundEditor(clientB);
    // Window B's change is on its way, not yet in the core.
    const apply = core.applyMindUpdate.bind(core);
    core.applyMindUpdate = async (mindId, update) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return apply(mindId, update);
    };
    const typeInCell = (target: typeof editor, text: string) => {
      const pos = comparisonTableAt(target, "table-1");
      if (pos === null) throw new Error("No table.");
      const line = target.state.doc.nodeAt(pos)?.child(0).child(0).child(0);
      if (!line) throw new Error("No cell paragraph.");
      target.commands.setTextSelection(pos + 4 + line.content.size);
      typeText(target, text);
    };
    typeInCell(editorB, " by B");

    // The move waits a turn, so B's change reaches the core first.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const moving = core.moveComparisonColumn.bind(core);
    core.moveComparisonColumn = async (input) => {
      await held;
      return moving(input);
    };
    const change = moveColumn(handle, "q1", 1);
    await vi.waitFor(() => expect(useComparisonColumns.getState().busy.has("table-1")).toBe(true));
    // B tries to edit the table while it is being written: the note drops it.
    const during = editorB.getJSON();
    typeInCell(editorB, " during");
    expect(editorB.getJSON()).toEqual(during);
    release();
    await change;
    await client.settled();
    await clientB.settled();

    for (const each of [editor, editorB]) {
      expect(orderOf(each)).toEqual(["q2", "q1", "q3"]);
      const moved = cellsOf(each)[0]?.find((cell) => cell.attrs?.questionId === "q1");
      expect(textOf(moved)).toContain("by B");
      expect(textOf(moved)).not.toContain("during");
    }
  });

  test("the undo line names the column in English and Chinese", async () => {
    const { client, handle } = await boundTable();
    await moveColumn(handle, "q1", 1);
    await settled(client);
    const entry = useUndo.getState().done.at(-1);
    if (!entry) throw new Error("The move isn't on the undo stack.");
    const cut = (name: string) => name;
    expect(entry.said((key, params) => translate("en", key, params), cut)).toBe("Moved “Notice”");
    expect(entry.said((key, params) => translate("zh-CN", key, params), cut)).toBe(
      "已移动“Notice”列",
    );
  });
});
