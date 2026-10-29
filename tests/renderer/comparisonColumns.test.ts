import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON, syncContent } from "../../src/core/answers/blocks";
import type { CoreEvents } from "../../src/core/api";
import {
  addColumn,
  duplicateColumn,
  hideColumn,
  moveColumn,
  removeColumn,
  resizeColumn,
  saveColumnEdit,
  saveColumnInsert,
  useComparisonColumns,
} from "../../src/renderer/src/comparisonColumns";
import { comparisonTableAt } from "../../src/renderer/src/editor/comparisonCommands";
import {
  redoNoteHistory,
  undoFromMenu,
  undoNoteHistory,
} from "../../src/renderer/src/editor/comparisonStructureUndo";
import { useUndo } from "../../src/renderer/src/undo";
import {
  comparisonLabelOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_QUESTIONS,
} from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor, typeText } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";

const fills = vi.hoisted(() => ({
  calls: [] as { mindId: string; tableId: string; questionIds?: readonly string[] }[],
}));

/** The core the window's commands ask, when a test bound it to one. */
const bridge = vi.hoisted(() => ({
  subscriptions: [] as (() => void)[],
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
    watchComparisonMind(input: unknown): Promise<unknown>;
    unwatchComparisonMind(input: unknown): Promise<unknown>;
    acknowledgeComparisonStructure(input: unknown): Promise<unknown>;
    on<E extends keyof CoreEvents>(
      event: E,
      listener: (payload: CoreEvents[E]) => void,
    ): () => void;
  },
}));

vi.mock("../../src/renderer/src/core", () => ({
  core: {
    on: <E extends keyof CoreEvents>(event: E, listener: (payload: CoreEvents[E]) => void) => {
      if (!bridge.core) {
        bridge.subscriptions.push(() => bridge.core?.on(event, listener));
        return () => undefined;
      }
      return bridge.core.on(event, listener);
    },
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
    watchComparisonMind: (input: unknown) => bridge.core?.watchComparisonMind(input),
    unwatchComparisonMind: (input: unknown) => bridge.core?.unwatchComparisonMind(input),
    acknowledgeComparisonStructure: (input: unknown) =>
      bridge.core?.acknowledgeComparisonStructure(input),
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
const problem = (questionId: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "failed", problem: "not-found" },
  content: [{ type: "paragraph", content: [] }],
});

const writing = (questionId: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "writing" },
  content: [{ type: "paragraph", content: [] }],
});

const table = ({ problem: withProblem = false, writing: withWriting = false } = {}): NodeJSON => ({
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
    content: [
      withProblem ? problem("q1") : withWriting ? writing("q1") : answer("q1", "90 days"),
      answer("q2", "12 months of fees"),
      answer("q3", "New York"),
    ],
  })),
});

/** An editor bound to a Mind of that table, and the core the window's commands ask. */
async function boundTable({ problemInQ1 = false, writingInQ1 = false } = {}) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Suppliers" });
  const client = await connectToMind(core, mind.id);
  client.doc.transact(() => {
    client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([
        createElement(paragraph("Shortlist")),
        createElement(table({ problem: problemInQ1, writing: writingInQ1 })),
      ]);
  });
  await client.settled();
  const editor = boundEditor(client);
  bridge.core = core;
  for (const subscribe of bridge.subscriptions.splice(0)) subscribe();
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

const typeInCell = (editor: ReturnType<typeof boundEditor>, text: string) => {
  const pos = comparisonTableAt(editor, "table-1");
  if (pos === null) throw new Error("No table.");
  const line = editor.state.doc.nodeAt(pos)?.child(0).child(0).child(0);
  if (!line) throw new Error("No cell paragraph.");
  editor.commands.setTextSelection(pos + 4 + line.content.size);
  typeText(editor, text);
};

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
    useComparisonColumns.setState({ holds: new Map(), focus: null, stale: {} });
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

  test("a reword over a cell still writing comes back waiting, and Redo and Undo leave it fillable", async () => {
    const { editor, client, handle } = await boundTable({ writingInQ1: true });
    await saveColumnEdit(handle, "q1", { text: "Ending the agreement", label: "Ending" });
    await settled(client);
    await useUndo.getState().undo();
    await settled(client);
    const first = cellsOf(editor)[0]?.find((cell) => cell.attrs?.questionId === "q1");
    expect(first?.attrs).toMatchObject({ status: "waiting" });

    await useUndo.getState().redo();
    await settled(client);
    const reworded = questionsOf(editor).find(
      (question) => question.text === "Ending the agreement",
    );
    if (!reworded) throw new Error("The Question wasn't reworded again.");
    const second = cellsOf(editor)[0]?.find((cell) => cell.attrs?.questionId === reworded.id);
    expect(second?.attrs).toMatchObject({ status: "waiting" });

    await useUndo.getState().undo();
    await settled(client);
    const third = cellsOf(editor)[0]?.find((cell) => cell.attrs?.questionId === "q1");
    expect(third?.attrs).toMatchObject({ status: "waiting" });
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
    await vi.waitFor(() => expect(useComparisonColumns.getState().holds.has("table-1")).toBe(true));
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
      clientId: "test-window",
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

  test("two windows on one Note: the move waits for the other window's changes and holds its edits until it lands", async () => {
    const { core, editor, client, mind, handle } = await boundTable();
    const clientB = await connectToMind(core, mind.id);
    const editorB = boundEditor(clientB);
    // Window B's change is on its way, not yet in the core.
    const apply = core.applyMindUpdate.bind(core);
    core.applyMindUpdate = async (mindId, update) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return apply(mindId, update);
    };
    // Both windows watch the Mind and answer once their changes have reached the core.
    await core.watchComparisonMind({ mindId: mind.id, clientId: "window-a" });
    await core.watchComparisonMind({ mindId: mind.id, clientId: "window-b" });
    let releaseAcks = () => {};
    const acksHeld = new Promise<void>((resolve) => {
      releaseAcks = resolve;
    });
    const stop = core.on("comparison.structure", ({ requestId, writing }) => {
      if (!writing) return;
      void (async () => {
        await Promise.all([client.settled(), clientB.settled()]);
        await acksHeld;
        await core.acknowledgeComparisonStructure({ requestId, clientId: "window-a" });
        await core.acknowledgeComparisonStructure({ requestId, clientId: "window-b" });
      })();
    });
    const typeInCell = (target: typeof editor, text: string) => {
      const pos = comparisonTableAt(target, "table-1");
      if (pos === null) throw new Error("No table.");
      const line = target.state.doc.nodeAt(pos)?.child(0).child(0).child(0);
      if (!line) throw new Error("No cell paragraph.");
      target.commands.setTextSelection(pos + 4 + line.content.size);
      typeText(target, text);
    };
    typeInCell(editorB, " by B");

    const change = moveColumn(handle, "q1", 1);
    // The table is held while the core waits for both windows. B's edit during it is dropped.
    await vi.waitFor(() => expect(useComparisonColumns.getState().holds.has("table-1")).toBe(true));
    const during = editorB.getJSON();
    typeInCell(editorB, " during");
    expect(editorB.getJSON()).toEqual(during);
    releaseAcks();

    await change;
    await client.settled();
    await clientB.settled();
    stop();
    await core.unwatchComparisonMind({ mindId: mind.id, clientId: "window-a" });
    await core.unwatchComparisonMind({ mindId: mind.id, clientId: "window-b" });
    for (const each of [editor, editorB]) {
      expect(orderOf(each)).toEqual(["q2", "q1", "q3"]);
      const moved = cellsOf(each)[0]?.find((cell) => cell.attrs?.questionId === "q1");
      expect(textOf(moved)).toContain("by B");
      expect(textOf(moved)).not.toContain("during");
    }
  });

  test("a note edit after a move is undone first, then the move; Edit › Undo does the same", async () => {
    const { editor, client, handle } = await boundTable();
    await moveColumn(handle, "q1", 1);
    await settled(client);
    const line = editor.state.doc.firstChild;
    if (!line) throw new Error("No note line.");
    editor.commands.setTextSelection(1 + line.content.size);
    typeText(editor, " edited");
    expect(editor.getText()).toContain("edited");

    expect(undoFromMenu(editor)).toBe(true);
    expect(editor.getText()).not.toContain("edited");
    expect(orderOf(editor)).toEqual(["q2", "q1", "q3"]);
    expect(undoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]));

    expect(redoNoteHistory(editor)).toBe(true);
    await vi.waitFor(() => expect(orderOf(editor)).toEqual(["q2", "q1", "q3"]));
    expect(redoNoteHistory(editor)).toBe(true);
    expect(editor.getText()).toContain("edited");
  });

  test("another window cannot undo this window's change, and a later change refuses it", async () => {
    const { core, editor, client, mind } = await boundTable();
    const moved = await core.moveComparisonColumn({
      mindId: mind.id,
      clientId: "window-a",
      tableId: "table-1",
      questionId: "q1",
      to: 1,
    });
    await settled(client);
    expect(
      await core.undoComparisonStructure({
        mindId: mind.id,
        clientId: "window-b",
        tableId: "table-1",
        step: moved.step,
      }),
    ).toEqual({ moved: false, reason: "changed" });
    expect(orderOf(editor)).toEqual(["q2", "q1", "q3"]);

    const hidden = await core.setComparisonColumnHidden({
      mindId: mind.id,
      clientId: "window-a",
      tableId: "table-1",
      questionId: "q2",
      hidden: true,
    });
    if (!hidden) throw new Error("Nothing was hidden.");
    await settled(client);
    expect(
      await core.undoComparisonStructure({
        mindId: mind.id,
        clientId: "window-a",
        tableId: "table-1",
        step: moved.step,
      }),
    ).toEqual({ moved: false, reason: "changed" });
    expect(
      await core.undoComparisonStructure({
        mindId: mind.id,
        clientId: "window-a",
        tableId: "table-1",
        step: hidden.step,
      }),
    ).toEqual({ moved: true });
    await settled(client);
    expect(
      await core.undoComparisonStructure({
        mindId: mind.id,
        clientId: "window-a",
        tableId: "table-1",
        step: moved.step,
      }),
    ).toEqual({ moved: true });
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
  });

  test("a refused undo shows a problem line in English and Chinese", async () => {
    const { core, client, mind, handle } = await boundTable();
    await moveColumn(handle, "q1", 1);
    await settled(client);
    // Another window changes the same table after the move.
    await core.setComparisonColumnHidden({
      mindId: mind.id,
      clientId: "another-window",
      tableId: "table-1",
      questionId: "q2",
      hidden: true,
    });
    await settled(client);
    const entry = useUndo.getState().done.at(-1);
    if (!entry) throw new Error("No change to undo.");
    await useUndo.getState().undo(entry);
    const problem = useUndo.getState().line?.problem;
    if (!problem) throw new Error("The refusal showed no problem line.");
    expect(problem.step).toBe("undo");
    expect(problem.reason((key) => translate("en", key))).toBe(
      "The table changed after this column change, so it can’t be undone.",
    );
    expect(problem.reason((key) => translate("zh-CN", key))).toBe(
      "这次列改动之后表格又改过，无法撤销。",
    );
  });

  test("an Undo of a column change holds the table while it is written", async () => {
    const { core, editor, client, handle } = await boundTable();
    await moveColumn(handle, "q1", 1);
    await settled(client);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const undo = core.undoComparisonStructure.bind(core);
    core.undoComparisonStructure = async (input) => {
      await held;
      return undo(input);
    };
    const undoing = useUndo.getState().undo();
    await vi.waitFor(() => expect(useComparisonColumns.getState().holds.has("table-1")).toBe(true));
    const before = editor.getJSON();
    typeInCell(editor, " during undo");
    expect(editor.getJSON()).toEqual(before);
    release();
    await undoing;
    await settled(client);
    expect(orderOf(editor)).toEqual(["q1", "q2", "q3"]);
  });

  test("a table held by two requests stays held until both end", () => {
    useComparisonColumns.getState().hold("table-1", "first");
    useComparisonColumns.getState().hold("table-1", "second");
    expect(useComparisonColumns.getState().holds.get("table-1")?.size).toBe(2);
    useComparisonColumns.getState().release("table-1", "first");
    expect(useComparisonColumns.getState().holds.has("table-1")).toBe(true);
    useComparisonColumns.getState().release("table-1", "second");
    expect(useComparisonColumns.getState().holds.has("table-1")).toBe(false);
  });

  test("the last column can't be removed, and the table keeps it", async () => {
    const { core, editor, client, mind } = await boundTable();
    for (const questionId of ["q2", "q3"]) {
      expect(
        await core.removeComparisonColumn({
          mindId: mind.id,
          clientId: "window-a",
          tableId: "table-1",
          questionId,
        }),
      ).not.toBeNull();
    }
    await settled(client);
    await expect(
      core.removeComparisonColumn({
        mindId: mind.id,
        clientId: "window-a",
        tableId: "table-1",
        questionId: "q1",
      }),
    ).rejects.toThrow();
    expect(orderOf(editor)).toEqual(["q1"]);
    expect(cellsOf(editor)[0]?.map((cell) => cell.attrs?.questionId)).toEqual(["q1"]);
  });

  test("a table holds at most 12 columns", async () => {
    const { core, editor, client, mind } = await boundTable();
    for (let count = orderOf(editor).length; count < MAX_COMPARISON_QUESTIONS; count++) {
      expect(
        await core.insertComparisonColumn({
          mindId: mind.id,
          clientId: "window-a",
          tableId: "table-1",
          questionId: orderOf(editor)[0] as string,
          side: "right",
          text: `Question ${count + 1}`,
        }),
      ).not.toBeNull();
    }
    await settled(client);
    expect(orderOf(editor)).toHaveLength(MAX_COMPARISON_QUESTIONS);
    await expect(
      core.insertComparisonColumn({
        mindId: mind.id,
        clientId: "window-a",
        tableId: "table-1",
        questionId: orderOf(editor)[0] as string,
        side: "right",
        text: "One too many",
      }),
    ).rejects.toThrow();
  });

  test("a label alone refills nothing, and the heading takes its line", async () => {
    const { editor, client, handle } = await boundTable();
    await saveColumnEdit(handle, "q1", { text: "Termination notice", label: "Notice period" });
    await settled(client);
    expect(fills.calls).toEqual([]);
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", label: "Notice period" });
    expect(useUndo.getState().done.at(-1)?.said).toBeTruthy();
  });

  test("a reword makes new cells for its column alone, and Undo puts the old cells back whole", async () => {
    const { editor, client, handle } = await boundTable();
    const before = cellsOf(editor).map((row) => row.map((cell) => cell.attrs?.questionId));
    await saveColumnEdit(handle, "q1", { text: "Ending the agreement", label: "Ending" });
    await settled(client);
    const reworded = questionsOf(editor).find(
      (question) => question.text === "Ending the agreement",
    );
    if (!reworded) throw new Error("The Question wasn't reworded.");
    expect(cellsOf(editor).map((row) => row.map((cell) => cell.attrs?.questionId))).toEqual(
      before.map((row) => [reworded.id, ...row.slice(1)]),
    );
    expect(fills.calls.at(-1)?.questionIds).toEqual([reworded.id]);

    await useUndo.getState().undo();
    await settled(client);
    expect(cellsOf(editor).map((row) => row.map((cell) => cell.attrs?.questionId))).toEqual(before);
    expect(answerUnder(editor, "q1")).toBe("90 days");
  });

  test("an unchanged save changes nothing and keeps the heading focused", async () => {
    const { client, handle } = await boundTable();
    const entries = useUndo.getState().done.length;
    await saveColumnEdit(handle, "q1", { text: "Termination notice", label: "Notice" });
    await settled(client);
    expect(useUndo.getState().done.length).toBe(entries);
    expect(useComparisonColumns.getState().focus).toEqual({
      tableId: "table-1",
      questionId: "q1",
    });
    expect(fills.calls).toEqual([]);
  });

  test("insert leaves a waiting cell at the column's place in every row and fills that column alone", async () => {
    const { editor, client, handle } = await boundTable();
    await saveColumnInsert(handle, "q2", "left", "Notice period");
    await settled(client);
    const added = questionsOf(editor)[1];
    if (!added) throw new Error("No new column.");
    expect(added.text).toBe("Notice period");
    expect(cellsOf(editor).map((row) => row.map((cell) => cell.attrs?.questionId))).toEqual([
      ["q1", added.id, "q2", "q3"],
      ["q1", added.id, "q2", "q3"],
    ]);
    expect(cellsOf(editor).map((row) => row[1]?.attrs?.status)).toEqual(["waiting", "waiting"]);
    expect(fills.calls.at(-1)?.questionIds).toEqual([added.id]);
  });

  test("a duplicate copies the label, Question and Answers under a new id", async () => {
    const { editor, client, handle } = await boundTable();
    await duplicateColumn(handle, "q1");
    await settled(client);
    const copy = questionsOf(editor)[1];
    if (!copy) throw new Error("No copied column.");
    expect(copy.id).not.toBe("q1");
    expect(copy).toMatchObject({ text: "Termination notice", label: "Notice" });
    expect(answerUnder(editor, copy.id)).toBe("90 days");
  });

  test("a width and a hidden column stay with the Question, one step of Undo each", async () => {
    const { editor, client, handle } = await boundTable();
    await resizeColumn(handle, "q1", 410);
    await settled(client);
    await hideColumn(handle, "q2");
    await settled(client);
    const find = (id: string) => questionsOf(editor).find((question) => question.id === id);
    expect(find("q1")?.width).toBe(410);
    expect(find("q2")?.hidden).toBe(true);

    await useUndo.getState().undo();
    await settled(client);
    expect(find("q2")?.hidden).toBeFalsy();
    expect(find("q1")?.width).toBe(410);

    await useUndo.getState().undo();
    await settled(client);
    expect(find("q1")?.width).toBeUndefined();
  });

  test("a heading is its label trimmed, else its Question shortened, and the limit is worded in both languages", () => {
    expect(comparisonLabelOf({ text: "Termination notice", label: "  Notice  " })).toBe("Notice");
    expect(comparisonLabelOf({ text: "Termination notice" })).toBe("Termination notice");
    const long = "A Question about the termination notice period in every one of the agreements";
    const heading = comparisonLabelOf({ text: long });
    expect(heading.endsWith("…")).toBe(true);
    expect(heading.length).toBeLessThan(long.length);
    expect(translate("en", "error.comparison.questionTooLong", { max: 500 })).toContain("500");
    expect(translate("zh-CN", "error.comparison.questionTooLong", { max: 500 })).toContain("500");
  });

  test("a duplicate keeps its cell's problem", async () => {
    const { editor, client, handle } = await boundTable({ problemInQ1: true });
    await duplicateColumn(handle, "q1");
    await settled(client);
    const copied = questionsOf(editor)[1]?.id;
    if (!copied) throw new Error("No copied column.");
    const cell = cellsOf(editor)[0]?.find((each) => each.attrs?.questionId === copied);
    expect(cell?.attrs).toMatchObject({ status: "failed", problem: "not-found" });
  });

  test("an empty Question is refused and the heading keeps the focus", async () => {
    const { editor, client, handle } = await boundTable();
    await saveColumnEdit(handle, "q1", { text: "   ", label: "" });
    await settled(client);
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", text: "Termination notice" });
    expect(useComparisonColumns.getState().focus).toEqual({
      tableId: "table-1",
      questionId: "q1",
    });
    await saveColumnInsert(handle, "q3", "right", "   ");
    await settled(client);
    expect(orderOf(editor)).toHaveLength(3);
    expect(useComparisonColumns.getState().focus).toEqual({
      tableId: "table-1",
      questionId: "q3",
    });
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
