import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
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
