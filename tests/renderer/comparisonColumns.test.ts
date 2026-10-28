import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import * as Y from "yjs";
import { type ComparisonProblem, MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import {
  duplicateColumn,
  saveColumnEdit,
  saveColumnInsert,
  useComparisonColumns,
} from "../../src/renderer/src/comparisonColumns";
import {
  duplicateComparisonColumn,
  editComparisonColumn,
  insertComparisonColumnAt,
  insertComparisonColumnBeside,
  moveComparisonColumn,
  moveComparisonColumnBy,
  removeComparisonColumn,
  setComparisonColumnHidden,
  setComparisonColumnWidth,
} from "../../src/renderer/src/editor/comparisonColumnCommands";
import { comparisonTableAt } from "../../src/renderer/src/editor/comparisonCommands";
import { undoStackOf } from "../../src/renderer/src/editor/editorUndo";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  comparisonLabelOf,
  comparisonNameOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_COLUMN_WIDTH,
  MAX_COMPARISON_QUESTIONS,
} from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { boundEditor } from "../helpers/editor";
import { connectToMind } from "../helpers/mindClient";

/** Each fill the window asked the core for, as the column commands ask it. */
const fills = vi.hoisted(() => ({
  calls: [] as { mindId: string; tableId: string; questionIds?: readonly string[] }[],
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
  },
  files: {},
}));

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const answer = (
  questionId: string,
  text: string,
  { problem }: { problem?: ComparisonProblem } = {},
): NodeJSON => ({
  type: "comparisonCell",
  attrs: problem ? { questionId, status: "failed", problem } : { questionId, status: "done" },
  content: problem
    ? [paragraph("")]
    : [
        {
          type: "paragraph",
          content: [
            { type: "text", text },
            { type: "citation", attrs: { quote: `${text} quote` } },
          ],
        },
      ],
});

/** A table of two columns and two rows, its Answers cited, as the core fills one. */
const table = (firstProblem?: ComparisonProblem): NodeJSON => ({
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice", label: "Notice" },
      { id: "q2", text: "Liability cap" },
    ],
  },
  content: ["doc-a", "doc-b"].map((documentId) => ({
    type: "comparisonRow",
    attrs: { documentId, documentName: documentId },
    content: [answer("q1", "90 days", { problem: firstProblem }), answer("q2", "12 months")],
  })),
});

/** A Mind's editor holding that table, bound to Yjs so ⌘Z is the note's own. */
async function boundTable(firstProblem?: ComparisonProblem) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  onTestFinished(() => core.close());
  const mind = await core.createMind({ title: "Suppliers" });
  const client = await connectToMind(core, mind.id);
  client.doc.transact(() => {
    client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push([createElement(paragraph("Shortlist")), createElement(table(firstProblem))]);
  });
  await client.settled();
  const editor = boundEditor(client);
  const before = editor.getJSON();
  return { core, client, editor, before };
}

const questionsOf = (editor: Editor) => {
  const pos = comparisonTableAt(editor, "table-1");
  const node = pos === null ? null : editor.state.doc.nodeAt(pos);
  return node ? comparisonQuestionsOf(node.attrs) : [];
};

/** Each row's cells, as the note draws them: their attributes and their words. */
const cellsOf = (editor: Editor) => {
  const pos = comparisonTableAt(editor, "table-1");
  const found = pos === null ? null : editor.state.doc.nodeAt(pos);
  const rows: JSONContent[] = [];
  found?.forEach((row) => {
    rows.push(row.toJSON());
  });
  return rows.map((row) => row.content ?? []);
};

describe("A comparison table's columns", () => {
  test("a new Question makes new cells for its column alone, and ⌘Z puts the old cells back whole", async () => {
    const { editor, before, client } = await boundTable();
    expect(JSON.stringify(before)).toContain('"citation"');

    const done = editComparisonColumn(editor, "table-1", "q1", {
      text: "Termination notice, in days?",
      label: "Notice",
    });
    expect(done).toMatchObject({ changed: true, refilled: true });
    const questions = questionsOf(editor);
    expect(questions[0]).toMatchObject({ text: "Termination notice, in days?", label: "Notice" });
    expect(questions[0]?.id).not.toBe("q1");
    expect(questions[1]?.id).toBe("q2");
    const [first, second] = cellsOf(editor);
    expect(first?.[0]?.attrs).toMatchObject({
      questionId: questions[0]?.id,
      status: "waiting",
    });
    expect(first?.[1]?.attrs).toMatchObject({ questionId: "q2", status: "done" });
    expect(second?.[0]?.attrs).toMatchObject({ status: "waiting" });

    // The core writes the new Answer into the new cells, as a fill does, outside the note's Undo.
    client.doc.transact(() => {
      const table = client.doc
        .getXmlFragment(MIND_CONTENT_FIELD)
        .toArray()
        .find(
          (element): element is Y.XmlElement =>
            element instanceof Y.XmlElement &&
            element.nodeName === "comparisonTable" &&
            element.getAttribute("id") === "table-1",
        );
      for (const row of table?.toArray() ?? []) {
        if (!(row instanceof Y.XmlElement) || row.nodeName !== "comparisonRow") continue;
        const cell = row
          .toArray()
          .find(
            (each): each is Y.XmlElement =>
              each instanceof Y.XmlElement && each.getAttribute("questionId") === questions[0]?.id,
          );
        const written = new Y.XmlElement("paragraph");
        written.insert(0, [new Y.XmlText("The new Answer.")]);
        cell?.insert(0, [written]);
      }
    });
    await client.settled();
    expect(JSON.stringify(editor.getJSON())).toContain("The new Answer.");

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  test("a label alone changes nothing but the heading, and an unchanged Question changes nothing", async () => {
    const { editor, before } = await boundTable();
    const cells = JSON.stringify(cellsOf(editor));
    const length = undoStackOf(editor)?.undoStack.length ?? 0;

    const done = editComparisonColumn(editor, "table-1", "q1", {
      text: "Termination notice",
      label: "Terms",
    });
    expect(done).toMatchObject({ changed: true, refilled: false });
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", label: "Terms" });
    expect(JSON.stringify(cellsOf(editor))).toBe(cells);
    expect(undoStackOf(editor)?.undoStack.length).toBe(length + 1);

    const again = editComparisonColumn(editor, "table-1", "q1", {
      text: "Termination notice",
      label: "Terms",
    });
    expect(again).toMatchObject({ changed: false, refilled: false });
    expect(undoStackOf(editor)?.undoStack.length).toBe(length + 1);

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  test("remove takes a column and its cells, restores them whole, and never takes the last one", async () => {
    const { editor, before } = await boundTable();
    expect(editComparisonColumn(editor, "table-1", "q1", { text: "", label: "" })).toBeNull();

    const removed = removeComparisonColumn(editor, "table-1", "q1");
    expect(removed).toMatchObject({ label: "Notice", focusId: "q2" });
    expect(questionsOf(editor).map((question) => question.id)).toEqual(["q2"]);
    expect(cellsOf(editor).map((cells) => cells.length)).toEqual([1, 1]);

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);

    expect(removeComparisonColumn(editor, "table-1", "q2")).toMatchObject({ focusId: "q1" });
    expect(removeComparisonColumn(editor, "table-1", "q1")).toBeNull();
    expect(questionsOf(editor)).toHaveLength(1);
  });

  test("move takes the column and its Answers to a new place, past hidden ones, and ⌘Z puts it back", async () => {
    const { editor, before } = await boundTable();
    expect(moveComparisonColumn(editor, "table-1", "q1", 1)).toMatchObject({
      label: "Notice",
      index: 1,
    });
    expect(questionsOf(editor).map((question) => question.id)).toEqual(["q2", "q1"]);
    for (const cells of cellsOf(editor)) {
      expect(cells.map((cell) => cell.attrs?.questionId)).toEqual(["q2", "q1"]);
    }
    // Its Answer and Citation move with it, not a new cell.
    expect(cellsOf(editor)[0]?.[1]?.content?.[0]?.content?.[0]?.text).toBe("90 days");
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);

    // One visible column right, hidden ones passed over.
    expect(setComparisonColumnHidden(editor, "table-1", "q2", true)).not.toBeNull();
    const added = insertComparisonColumnAt(editor, "table-1", 2, "Governing law");
    expect(added).not.toBeNull();
    expect(moveComparisonColumnBy(editor, "table-1", "q1", 1)).toMatchObject({ index: 2 });
    expect(
      questionsOf(editor)
        .filter((question) => question.hidden !== true)
        .map((question) => question.text),
    ).toEqual(["Governing law", "Termination notice"]);
    expect(moveComparisonColumnBy(editor, "table-1", "q1", 1)).toBeNull();
  });

  test("a column's width and hidden state stay with its Question, one step of Undo each", async () => {
    const { editor, before } = await boundTable();
    expect(setComparisonColumnWidth(editor, "table-1", "q1", 410)).toMatchObject({
      label: "Notice",
      width: 410,
    });
    expect(questionsOf(editor)[0]).toMatchObject({ id: "q1", width: 410 });
    expect(setComparisonColumnWidth(editor, "table-1", "q1", 410)).toBeNull();
    expect(setComparisonColumnWidth(editor, "table-1", "q1", 99_999)?.width).toBe(
      MAX_COMPARISON_COLUMN_WIDTH,
    );
    editor.commands.undo();
    expect(questionsOf(editor)[0]?.width).toBe(410);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);

    expect(setComparisonColumnHidden(editor, "table-1", "q1", true)).toMatchObject({
      label: "Notice",
      hidden: true,
      focusId: "q2",
    });
    expect(questionsOf(editor)[0]).toMatchObject({ hidden: true });
    expect(setComparisonColumnHidden(editor, "table-1", "q1", true)).toBeNull();
    expect(setComparisonColumnHidden(editor, "table-1", "q1", false)).toMatchObject({
      hidden: false,
      focusId: "q1",
    });
    expect(questionsOf(editor)[0]?.hidden).toBeUndefined();
    editor.commands.undo();
    expect(questionsOf(editor)[0]?.hidden).toBe(true);
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  test("duplicate copies the label, Question and Answers under a new id, and keeps a problem with its cell", async () => {
    const { editor, before } = await boundTable("not-found");
    const copied = duplicateComparisonColumn(editor, "table-1", "q1");
    expect(copied).toMatchObject({ label: "Notice", fill: false });
    const questions = questionsOf(editor);
    expect(questions).toHaveLength(3);
    expect(questions[1]).toMatchObject({ text: "Termination notice", label: "Notice" });
    expect(questions[1]?.id).not.toBe("q1");
    const [first] = cellsOf(editor);
    expect(first?.[1]?.attrs).toMatchObject({
      questionId: questions[1]?.id,
      status: "failed",
      problem: "not-found",
    });
    expect(first?.[0]?.attrs).toMatchObject({ questionId: "q1", status: "failed" });

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  });

  test("insert puts a waiting cell at the column's place in every row; a full table takes no more", async () => {
    const { editor, before } = await boundTable();
    const id = insertComparisonColumnBeside(editor, "table-1", "q1", "left", "Governing law");
    expect(id).not.toBeNull();
    expect(questionsOf(editor).map((question) => question.text)).toEqual([
      "Governing law",
      "Termination notice",
      "Liability cap",
    ]);
    for (const cells of cellsOf(editor)) {
      expect(cells[0]?.attrs).toMatchObject({ questionId: id, status: "waiting" });
      expect(cells).toHaveLength(3);
    }
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);

    expect(
      insertComparisonColumnBeside(editor, "table-1", "q2", "right", "Governing law"),
    ).not.toBeNull();
    expect(questionsOf(editor).at(-1)?.text).toBe("Governing law");

    const plain = new Editor({
      element: null,
      extensions: noteExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "comparisonTable",
            attrs: {
              id: "full",
              questions: Array.from({ length: MAX_COMPARISON_QUESTIONS }, (_each, at) => ({
                id: `q${at}`,
                text: `Question ${at + 1}`,
              })),
            },
            content: [
              {
                type: "comparisonRow",
                attrs: { documentId: "doc-a", documentName: "Acme" },
                content: Array.from({ length: MAX_COMPARISON_QUESTIONS }, (_each, at) =>
                  answer(`q${at}`, `answer ${at}`),
                ),
              },
            ],
          },
        ],
      },
    });
    onTestFinished(() => plain.destroy());
    expect(insertComparisonColumnAt(plain, "full", 0, "One too many")).toBeNull();
    expect(duplicateComparisonColumn(plain, "full", "q0")).toBeNull();
  });

  test("a column's heading is its label, trimmed, else its Question shortened; the limit says so in both languages", () => {
    expect(
      comparisonQuestionsOf({
        questions: [
          { id: "q1", text: "Termination notice", label: "  Notice " },
          { id: "q2", text: "Liability cap", label: "   " },
          { id: "q3", text: "Governing law", width: 240, hidden: true },
        ],
      }),
    ).toEqual([
      { id: "q1", text: "Termination notice", label: "Notice" },
      { id: "q2", text: "Liability cap" },
      { id: "q3", text: "Governing law", width: 240, hidden: true },
    ]);
    expect(comparisonLabelOf({ text: "Termination notice", label: "Notice" })).toBe("Notice");
    expect(comparisonLabelOf({ text: "Liability cap" })).toBe("Liability cap");
    const long = comparisonLabelOf({
      text: "What notice, in days, must either party give to end the agreement?",
    });
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThan(50);
    expect(
      comparisonNameOf({
        text: "What notice, in days, must either party give to end the agreement?",
      }),
    ).toBe("What notice, in days, must either party give to end the agreement?");
    expect(
      comparisonNameOf({
        text: "What notice, in days, must either party give to end the agreement?",
        label: " Notice ",
      }),
    ).toBe("Notice");

    for (const language of ["en", "zh-CN"] as const) {
      expect(translate(language, "comparison.column.maxQuestions")).toContain(
        String(MAX_COMPARISON_QUESTIONS),
      );
      expect(translate(language, "comparison.column.edit")).not.toBe("");
      expect(translate(language, "comparison.column.remove")).not.toBe("");
      expect(translate(language, "comparison.column.removed", { label: "Notice" })).toContain(
        "Notice",
      );
    }
  });

  test("a reworded, added or duplicated column fills that column alone; a new label alone fills nothing", async () => {
    fills.calls.length = 0;
    const { editor } = await boundTable("network");
    const handle = { editor, mindId: "mind-1", tableId: "table-1" };

    duplicateColumn(handle, "q1");
    expect(fills.calls.at(-1)).toMatchObject({ mindId: "mind-1", tableId: "table-1" });
    expect(fills.calls.at(-1)?.questionIds).toEqual([questionsOf(editor)[1]?.id]);

    saveColumnEdit(handle, "q1", { text: "Termination notice, in days?", label: "Notice" });
    expect(fills.calls.at(-1)?.questionIds).toEqual([questionsOf(editor)[0]?.id]);
    const [edited] = questionsOf(editor);
    if (!edited) throw new Error("The column is gone.");
    expect(useComparisonColumns.getState().focus).toEqual({
      tableId: "table-1",
      questionId: edited.id,
    });

    const count = fills.calls.length;
    saveColumnEdit(handle, edited.id, { text: edited.text, label: "Terms" });
    expect(fills.calls).toHaveLength(count);

    saveColumnInsert(handle, edited.id, "right", "Governing law");
    const inserted = questionsOf(editor).find((question) => question.text === "Governing law");
    expect(fills.calls.at(-1)?.questionIds).toEqual([inserted?.id]);
  });

  test("a save that is refused or changes nothing leaves the heading focused, as Esc does", async () => {
    const { editor } = await boundTable();
    const handle = { editor, mindId: "mind-1", tableId: "table-1" };
    const [column] = questionsOf(editor);
    if (!column) throw new Error("The column is gone.");
    const focus = () => useComparisonColumns.getState().focus;
    const heading = { tableId: "table-1", questionId: column.id };

    // An empty Question is refused: the field closes and the heading takes the focus back.
    saveColumnEdit(handle, column.id, { text: "   ", label: "Notice" });
    expect(focus()).toEqual(heading);
    useComparisonColumns.getState().clearFocus("table-1", column.id);

    // The same Question and label change nothing, and the heading takes the focus back too.
    saveColumnEdit(handle, column.id, { text: column.text, label: column.label ?? "" });
    expect(focus()).toEqual(heading);
    expect(questionsOf(editor)[0]).toEqual(column);
  });
});
