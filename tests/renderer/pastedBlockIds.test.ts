/**
 * A Block copied and pasted into a Note is a Block of its own (#1885): a comparison table and a
 * chart pasted beside the original, into another Note, dropped with the copy key, and then
 * used through the core, never reach for the original.
 */
import { readFile } from "node:fs/promises";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { COMPARISON_TABLE_NODE, MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON, nodeOf } from "../../src/core/answers/blocks";
import { cellIndex } from "../../src/core/documents/formats/sheetLayout";
import { readWorkbook } from "../../src/core/documents/formats/xlsx";
import { findBlock } from "../../src/renderer/src/editor/blockCommands";
import { changeChart, chartTable, tableUpdate } from "../../src/renderer/src/editor/chartCommands";
import { chartFromTable, gridOfTable, readChart } from "../../src/shared/charts";
import { comparisonQuestionsOf } from "../../src/shared/comparisons";
import {
  addSignOff,
  comparisonCellBasis,
  comparisonCellContent,
  comparisonCellSignOff,
  comparisonCellTarget,
  signOffsOf,
} from "../../src/shared/signOffs";
import { setUpWithDocuments } from "../helpers/citations";
import {
  copiedHtml,
  cutBlock,
  cutRange,
  installDom,
  noteEditor,
  pasteHtml,
} from "../helpers/clipboard";
import {
  ACME_REPORT,
  BRANDT_REPORT,
  cellModel,
  compare,
  compareReports,
  fillEnded,
} from "../helpers/comparisons";
import { boundEditorTo } from "../helpers/editor";

installDom();

let counted = 0;
const paragraph = (words: string, ...inline: NodeJSON[]): NodeJSON => ({
  type: "paragraph",
  attrs: { id: `paragraph-${++counted}` },
  content: [...(words ? [{ type: "text", text: words }] : []), ...inline],
});

const citationOf = (document: string, quote: string): NodeJSON => ({
  type: "citation",
  attrs: {
    passageId: `passage-${document}`,
    documentId: `doc-${document}`,
    documentName: document,
    contentHash: `hash-${document}`,
    pageFrom: 1,
    pageTo: 1,
    quote,
    check: "found",
  },
});

interface Question {
  id: string;
  text: string;
}

function comparison(
  id: string,
  documents: readonly string[],
  questions: readonly Question[],
  { cited = true, waiting = false } = {},
): NodeJSON {
  return {
    type: "comparisonTable",
    attrs: { id, questions },
    content: documents.map((name) => ({
      type: "comparisonRow",
      attrs: { documentId: `doc-${name}`, documentName: name },
      content: questions.map((question) => ({
        type: "comparisonCell",
        attrs: { questionId: question.id, status: waiting ? "waiting" : "done" },
        content: [
          waiting
            ? paragraph("")
            : paragraph(
                `${name}: ${question.text}`,
                ...(cited ? [citationOf(name, `${name}: ${question.text}`)] : []),
              ),
        ],
      })),
    })),
  };
}

const CHART: NodeJSON = {
  type: "chart",
  attrs: {
    id: "chart-1",
    kind: "bar",
    title: "Revenue",
    data: {
      labelHeading: "Quarter",
      series: ["2025"],
      rows: [
        {
          label: "Q1",
          values: [
            {
              shown: "289.4",
              value: 289.4,
              unit: null,
              scale: null,
              citation: {
                passageId: "passage-acme",
                documentId: "doc-acme",
                documentName: "Acme",
                contentHash: "hash-acme",
                pageFrom: 3,
                pageTo: 3,
                quote: "Revenue was 289.4 in Q1.",
                check: "found",
              },
              from: { kind: "cell", row: 1, column: 1 },
            },
          ],
        },
      ],
      cutFrom: null,
      cutRows: [],
    },
    source: { kind: "table", blockId: "plain-table-1" },
  },
};

const ENGLISH = {
  documents: ["Corvane", "Halvard"],
  questions: [
    { id: "q-notice", text: "Termination notice" },
    { id: "q-law", text: "Governing law" },
  ],
};
const CHINESE = {
  documents: ["科文", "哈瓦"],
  questions: [
    { id: "q-notice", text: "终止通知期" },
    { id: "q-law", text: "适用法律" },
  ],
};

function noteOf(blocks: readonly NodeJSON[]): Editor {
  const doc = new Y.Doc();
  doc.getXmlFragment(MIND_CONTENT_FIELD).push(blocks.map(createElement));
  return noteEditor(doc);
}

/** The Note with a heading line, then these Blocks, then an empty line to paste into. */
const noteWith = (...blocks: NodeJSON[]) =>
  noteOf([paragraph("Shortlist"), ...blocks, paragraph("")]);

function blocksOf(editor: Editor, type: string) {
  const found: { node: ProseMirrorNode; pos: number }[] = [];
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === type) found.push({ node, pos });
  });
  return found;
}

function blockWith(editor: Editor, type: string, id: string) {
  const found = blocksOf(editor, type).find(({ node }) => node.attrs.id === id);
  if (!found) throw new Error(`No ${type} ${id}.`);
  return found;
}

function copyOf(editor: Editor, type: string, originalId: string) {
  const copies = blocksOf(editor, type).filter(({ node }) => node.attrs.id !== originalId);
  const [copy] = copies;
  if (copies.length !== 1 || !copy)
    throw new Error(`Expected one copy of ${type}, got ${copies.length}.`);
  return copy;
}

const questionIdsOf = (table: ProseMirrorNode) =>
  comparisonQuestionsOf(table.attrs).map((question) => question.id);

/** Each row's cells as the Question they answer, by the table's own Questions: "(none)" for a cell that names none of them. */
function answeredQuestions(table: ProseMirrorNode): string[][] {
  const texts = new Map(comparisonQuestionsOf(table.attrs).map((each) => [each.id, each.text]));
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      cells.push(texts.get(String(cell.attrs.questionId)) ?? "(none)");
    });
    rows.push(cells);
  });
  return rows;
}

function citationsOf(table: ProseMirrorNode) {
  const found: Record<string, unknown>[] = [];
  table.descendants((node) => {
    if (node.type.name === "citation")
      found.push({
        documentId: node.attrs.documentId,
        contentHash: node.attrs.contentHash,
        quote: node.attrs.quote,
      });
  });
  return found;
}

const rowDocuments = (table: ProseMirrorNode) => {
  const found: unknown[] = [];
  table.forEach((row) => {
    found.push([row.attrs.documentId, row.attrs.documentName]);
  });
  return found;
};

/** Every id a Block of the Note holds more than once, Blocks nested in a table or a list included. */
function sharedBlockIds(editor: Editor): string[] {
  const seen = new Map<string, number>();
  editor.state.doc.descendants((node) => {
    const id: unknown = node.attrs.id;
    if (typeof id === "string" && node.type.name !== "citation")
      seen.set(id, (seen.get(id) ?? 0) + 1);
  });
  return [...seen].filter(([, held]) => held > 1).map(([id]) => id);
}

function sharedQuestionIds(editor: Editor): string[] {
  const seen = new Map<string, number>();
  for (const { node } of blocksOf(editor, "comparisonTable"))
    for (const id of questionIdsOf(node)) seen.set(id, (seen.get(id) ?? 0) + 1);
  return [...seen].filter(([, held]) => held > 1).map(([id]) => id);
}

/** Pastes after the last Block, as a person puts the caret on a new line at the end and pastes. */
function pasteAtEnd(editor: Editor, html: string): void {
  const { paragraph: lineType } = editor.state.schema.nodes;
  if (!lineType) throw new Error("The Note has no paragraph.");
  editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, lineType.create()));
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  pasteHtml(editor, html);
}

describe("a comparison table pasted into the Note it was copied from", () => {
  // protects=a pasted comparison table has a table id and Question ids of its own, each cell names its own table's Question, and the original is as it was; fails_when=the copy shares a Question id with the original, or a cell is left naming the other table's Question; no_claim=none beyond protects.
  test.each([
    ["English", ENGLISH],
    ["Chinese", CHINESE],
  ])("is a table of its own, answering its own Questions (%s)", (_, language) => {
    const editor = noteWith(comparison("table-1", language.documents, language.questions));
    const original = blockWith(editor, "comparisonTable", "table-1");
    const before = original.node.toJSON();
    const asked = language.questions.map((question) => question.text);
    pasteAtEnd(editor, copiedHtml(editor, original.pos));

    const { node: copy } = copyOf(editor, "comparisonTable", "table-1");
    expect(copy.attrs.id).toEqual(expect.any(String));
    expect(questionIdsOf(copy)).toHaveLength(2);
    expect(questionIdsOf(copy).filter((id) => questionIdsOf(original.node).includes(id))).toEqual(
      [],
    );
    expect(answeredQuestions(copy)).toEqual([asked, asked]);
    expect(answeredQuestions(blockWith(editor, "comparisonTable", "table-1").node)).toEqual([
      asked,
      asked,
    ]);
    expect(copy.textContent).toBe(original.node.textContent);
    expect(rowDocuments(copy)).toEqual(rowDocuments(original.node));
    expect(citationsOf(copy)).toHaveLength(4);
    expect(citationsOf(copy)).toEqual(citationsOf(original.node));
    expect(blockWith(editor, "comparisonTable", "table-1").node.toJSON()).toEqual(before);
    expect(sharedBlockIds(editor)).toEqual([]);
    expect(sharedQuestionIds(editor)).toEqual([]);
  });

  // protects=each paste of the same table is another table, so three tables share no id; fails_when=a second paste is given the first copy's ids, or the original's; no_claim=none beyond protects.
  test("pasted twice, makes three tables that share no id", () => {
    const editor = noteWith(comparison("table-1", ENGLISH.documents, ENGLISH.questions));
    const html = copiedHtml(editor, blockWith(editor, "comparisonTable", "table-1").pos);
    pasteAtEnd(editor, html);
    pasteAtEnd(editor, html);

    expect(blocksOf(editor, "comparisonTable")).toHaveLength(3);
    expect(sharedBlockIds(editor)).toEqual([]);
    expect(sharedQuestionIds(editor)).toEqual([]);
    for (const { node } of blocksOf(editor, "comparisonTable"))
      expect(answeredQuestions(node)).toEqual([
        ["Termination notice", "Governing law"],
        ["Termination notice", "Governing law"],
      ]);
  });

  // protects=a table waiting for its Answers is copied whole, its cells empty and naming their own Questions; fails_when=an empty cell keeps the other table's Question, or the paste loses a row; no_claim=none beyond protects.
  test("a table still waiting for its Answers is copied whole", () => {
    const editor = noteWith(
      comparison("table-1", ENGLISH.documents, ENGLISH.questions, { waiting: true }),
    );
    pasteAtEnd(editor, copiedHtml(editor, blockWith(editor, "comparisonTable", "table-1").pos));

    const { node: copy } = copyOf(editor, "comparisonTable", "table-1");
    expect(answeredQuestions(copy)).toEqual([
      ["Termination notice", "Governing law"],
      ["Termination notice", "Governing law"],
    ]);
    expect(copy.textContent).toBe("");
    expect(sharedQuestionIds(editor)).toEqual([]);
  });

  // protects=a table whose Questions can't be read is still pasted, as a Block of its own, its cells left as they were; fails_when=the paste throws, or the cells are rewritten to nothing; no_claim=none beyond protects.
  test("a table whose Questions are damaged pastes with an id of its own and its cells as they were", () => {
    const damaged = comparison("table-1", ["Corvane"], ENGLISH.questions);
    const editor = noteWith({ ...damaged, attrs: { id: "table-1" } });
    pasteAtEnd(editor, copiedHtml(editor, blockWith(editor, "comparisonTable", "table-1").pos));

    const { node: copy } = copyOf(editor, "comparisonTable", "table-1");
    expect(copy.attrs.id).not.toBe("table-1");
    const ids: unknown[] = [];
    copy.descendants((node) => {
      if (node.type.name === "comparisonCell") ids.push(node.attrs.questionId);
    });
    expect(ids).toEqual(["q-notice", "q-law"]);
  });

  // protects=a table of 100 Documents by 12 Questions is pasted with every cell on its own table's Question; fails_when=a cell of the large table is left on the original's Question; no_claim=speed.
  test("a table of 100 Documents and 12 Questions has every cell on its own Question", () => {
    const questions = Array.from({ length: 12 }, (_, index) => ({
      id: `q-${index}`,
      text: `Question ${index}`,
    }));
    const documents = Array.from({ length: 100 }, (_, index) => `Document ${index}`);
    const editor = noteWith(comparison("table-1", documents, questions, { cited: false }));
    pasteAtEnd(editor, copiedHtml(editor, blockWith(editor, "comparisonTable", "table-1").pos));

    const { node: copy } = copyOf(editor, "comparisonTable", "table-1");
    expect(questionIdsOf(copy)).toHaveLength(12);
    expect(sharedQuestionIds(editor)).toEqual([]);
    const rows = answeredQuestions(copy);
    expect(rows).toHaveLength(100);
    for (const row of rows) expect(row).toEqual(questions.map((question) => question.text));
    expect(sharedBlockIds(editor)).toEqual([]);
  });

  // protects=Undo takes the whole paste out in one step, and Redo puts back the table it took out, with the ids the paste gave it; fails_when=Undo leaves part of the paste, or Redo gives the copy the original's ids; no_claim=the clipboard (the paste is made as a transaction with the editor's paste mark).
  test("Undo takes the paste out in one step, and Redo puts the same table back", () => {
    const doc = new Y.Doc();
    doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push(
        [
          paragraph("Shortlist"),
          comparison("table-1", ENGLISH.documents, ENGLISH.questions),
          paragraph("End"),
        ].map(createElement),
      );
    const editor = boundEditorTo(doc);
    const before = editor.state.doc.toJSON();
    const original = blockWith(editor, "comparisonTable", "table-1").node;
    editor.view.dispatch(
      editor.state.tr
        .insert(editor.state.doc.content.size, original)
        .setMeta("paste", true)
        .setMeta("uiEvent", "paste"),
    );
    const { node: copy } = copyOf(editor, "comparisonTable", "table-1");
    const copyId = copy.attrs.id;
    const copyQuestions = questionIdsOf(copy);
    expect(sharedQuestionIds(editor)).toEqual([]);

    expect(editor.commands.undo()).toBe(true);
    expect(blocksOf(editor, "comparisonTable")).toHaveLength(1);
    expect(editor.state.doc.toJSON()).toEqual(before);

    expect(editor.commands.redo()).toBe(true);
    const { node: back } = copyOf(editor, "comparisonTable", "table-1");
    expect(back.attrs.id).toBe(copyId);
    expect(questionIdsOf(back)).toEqual(copyQuestions);
    expect(answeredQuestions(back)).toEqual(answeredQuestions(copy));
  });
});

describe("a comparison table pasted into another Note", () => {
  // protects=a table pasted into another Note takes ids of its own there, so its Questions are not the first Note's; fails_when=the second Note's table keeps a Question id of the first's; no_claim=none beyond protects.
  test("takes ids of its own, and the first Note's table is as it was", () => {
    const first = noteWith(comparison("table-1", ENGLISH.documents, ENGLISH.questions));
    const second = noteOf([paragraph("Another note"), paragraph("")]);
    const original = blockWith(first, "comparisonTable", "table-1");
    const before = original.node.toJSON();
    second.commands.setTextSelection(second.state.doc.content.size - 1);
    pasteHtml(second, copiedHtml(first, original.pos));

    const [pasted] = blocksOf(second, "comparisonTable");
    if (!pasted) throw new Error("Nothing was pasted.");
    expect(pasted.node.attrs.id).not.toBe("table-1");
    expect(questionIdsOf(pasted.node).filter((id) => ["q-notice", "q-law"].includes(id))).toEqual(
      [],
    );
    expect(answeredQuestions(pasted.node)).toEqual([
      ["Termination notice", "Governing law"],
      ["Termination notice", "Governing law"],
    ]);
    expect(citationsOf(pasted.node)).toEqual(citationsOf(original.node));
    expect(blockWith(first, "comparisonTable", "table-1").node.toJSON()).toEqual(before);
  });
});

describe("a chart pasted into the Note it was copied from", () => {
  // protects=a pasted chart is a Block of its own that keeps its values, their Citations and its source; fails_when=the copy keeps the original's id, or loses a value's Citation or its source table; no_claim=none beyond protects.
  test("has an id of its own and everything the original holds", () => {
    const editor = noteWith(CHART);
    const original = blockWith(editor, "chart", "chart-1");
    const before = original.node.toJSON();
    pasteAtEnd(editor, copiedHtml(editor, original.pos));

    const { node: copy } = copyOf(editor, "chart", "chart-1");
    expect(copy.attrs.id).toEqual(expect.any(String));
    const copied = readChart(copy.attrs);
    expect(copied).toEqual(readChart(original.node.attrs));
    expect(copied.source).toEqual({ kind: "table", blockId: "plain-table-1" });
    expect(copied.data.rows[0]?.values[0]?.citation).toMatchObject({
      documentId: "doc-acme",
      contentHash: "hash-acme",
      quote: "Revenue was 289.4 in Q1.",
    });
    expect(sharedBlockIds(editor)).toEqual([]);
    expect(blockWith(editor, "chart", "chart-1").node.toJSON()).toEqual(before);
  });
});

describe("a Block dropped with the copy key", () => {
  /** What dropping a copy of a range at `at` does to the Note, as ProseMirror's drop makes it. */
  const dropCopy = (editor: Editor, from: number, to: number, at: number) =>
    editor.view.dispatch(
      editor.state.tr
        .insert(at, editor.state.doc.slice(from, to).content)
        .setMeta("uiEvent", "drop"),
    );

  // protects=a comparison table and a chart copied by dragging take ids of their own, and the table's cells follow its new Questions; fails_when=either copy shares an id with the original, or a cell is left on the original's Question; no_claim=the browser's own drag events.
  test("is a Block of its own: a table with Questions of its own, and a chart", () => {
    const editor = noteWith(comparison("table-1", ENGLISH.documents, ENGLISH.questions), CHART);
    const table = blockWith(editor, "comparisonTable", "table-1");
    const chart = blockWith(editor, "chart", "chart-1");
    dropCopy(editor, table.pos, table.pos + table.node.nodeSize, editor.state.doc.content.size);
    dropCopy(editor, chart.pos, chart.pos + chart.node.nodeSize, editor.state.doc.content.size);

    const { node: copy } = copyOf(editor, "comparisonTable", "table-1");
    expect(answeredQuestions(copy)).toEqual([
      ["Termination notice", "Governing law"],
      ["Termination notice", "Governing law"],
    ]);
    expect(copyOf(editor, "chart", "chart-1").node.attrs.id).toEqual(expect.any(String));
    expect(sharedBlockIds(editor)).toEqual([]);
    expect(sharedQuestionIds(editor)).toEqual([]);
  });

  // protects=a Block moved keeps its id, its Questions and its cells' links, which the Note's marks and checks are kept under; fails_when=moving a table gives it new ids; no_claim=none beyond protects.
  test("moved, not copied, keeps every id it had", () => {
    const editor = noteWith(comparison("table-1", ENGLISH.documents, ENGLISH.questions), CHART);
    const table = blockWith(editor, "comparisonTable", "table-1");
    const chart = blockWith(editor, "chart", "chart-1");
    const questions = questionIdsOf(table.node);
    const tr = editor.state.tr.delete(table.pos, table.pos + table.node.nodeSize);
    tr.insert(tr.mapping.map(chart.pos) + chart.node.nodeSize, table.node).setMeta(
      "uiEvent",
      "drop",
    );
    editor.view.dispatch(tr);

    const moved = blockWith(editor, "comparisonTable", "table-1");
    expect(moved.pos).toBeGreaterThan(blockWith(editor, "chart", "chart-1").pos);
    expect(questionIdsOf(moved.node)).toEqual(questions);
    expect(answeredQuestions(moved.node)[0]).toEqual(["Termination notice", "Governing law"]);
  });

  // protects=an Answer copied with its Question follows the copy of the Question, and the original's stays with the original; fails_when=the copy of an Answer is left answering the original Question; no_claim=none beyond protects.
  test("a Question and its Answer are copied as a pair", () => {
    const editor = noteOf([
      { type: "question", attrs: { id: "question-1" }, content: [{ type: "text", text: "Why?" }] },
      {
        type: "answer",
        attrs: { id: "answer-1", questionId: "question-1", status: "done" },
        content: [paragraph("Because.")],
      },
      paragraph(""),
    ]);
    const [question] = blocksOf(editor, "question");
    const [answer] = blocksOf(editor, "answer");
    if (!question || !answer) throw new Error("No Question and Answer.");
    dropCopy(
      editor,
      question.pos,
      answer.pos + answer.node.nodeSize,
      editor.state.doc.content.size,
    );

    const questions = blocksOf(editor, "question");
    const answers = blocksOf(editor, "answer");
    expect(questions).toHaveLength(2);
    expect(answers).toHaveLength(2);
    expect(new Set(questions.map(({ node }) => node.attrs.id)).size).toBe(2);
    expect(answers.map(({ node }) => node.attrs.questionId).sort()).toEqual(
      questions.map(({ node }) => node.attrs.id).sort(),
    );
    expect(blockWith(editor, "answer", "answer-1").node.attrs.questionId).toBe("question-1");
  });
});

describe("a comparison table and a chart copied into one Note", () => {
  const exportedHeading = async (path: string) => {
    const { sheets } = await readWorkbook(new Uint8Array(await readFile(path)), undefined, {});
    const sheet = sheets[0];
    const cell = sheet?.cells.find((each) => each.row === 1 && each.column === 1);
    return sheet?.layout?.shown.get(cellIndex(1, 1))?.text ?? cell?.value;
  };

  // protects=a pasted table and a pasted chart are used on their own: a column changed, the table filled and exported, and the chart changed leave the other as it was; fails_when=the core, the export or a chart's id finds the original instead of the copy; no_claim=none beyond protects.
  test("stay independent when one is changed, filled and exported", async () => {
    const { core, client, mind, tableId } = await compareReports();
    client.doc.transact(() => {
      client.blocks.push([createElement(CHART), createElement(paragraph(""))]);
    });
    await client.settled();
    const editor = noteEditor(client.doc);

    pasteAtEnd(editor, copiedHtml(editor, blockWith(editor, "comparisonTable", tableId).pos));
    pasteAtEnd(editor, copiedHtml(editor, blockWith(editor, "chart", "chart-1").pos));
    await client.settled();

    const tableElement = (id: string) => {
      const found = client.blocks
        .toArray()
        .find(
          (block): block is Y.XmlElement =>
            block instanceof Y.XmlElement &&
            block.nodeName === "comparisonTable" &&
            block.getAttribute("id") === id,
        );
      if (!found) throw new Error(`The core has no table ${id}.`);
      return found;
    };
    const copy = copyOf(editor, "comparisonTable", tableId);
    const copyId = String(copy.node.attrs.id);
    const snapshot = JSON.stringify(nodeOf(tableElement(tableId)));
    const chartBefore = JSON.stringify(blockWith(editor, "chart", "chart-1").node.toJSON());

    const column = comparisonQuestionsOf(copy.node.attrs)[0];
    if (!column) throw new Error("The copy has no column.");
    await core.editComparisonColumn({
      mindId: mind.id,
      tableId: copyId,
      clientId: "window-1",
      questionId: column.id,
      text: column.text,
      label: "Sales",
    });
    await vi.waitFor(() =>
      expect(comparisonQuestionsOf(tableElement(copyId).getAttributes())[0]?.label).toBe("Sales"),
    );
    expect(JSON.stringify(nodeOf(tableElement(tableId)))).toBe(snapshot);

    const writeFirstCell = (id: string, words: string) => {
      const found = blockWith(editor, "comparisonTable", id);
      let text: { from: number; to: number } | null = null;
      found.node.descendants((node, offset) => {
        if (!text && node.isText) {
          const from = found.pos + 1 + offset;
          text = { from, to: from + node.nodeSize };
        }
        return !text;
      });
      const range = text as { from: number; to: number } | null;
      if (!range) throw new Error("The table has no text.");
      editor.view.dispatch(editor.state.tr.insertText(words, range.from, range.to));
    };
    writeFirstCell(copyId, "COPY EDIT");
    writeFirstCell(tableId, "ORIGINAL EDIT");
    await client.settled();
    const editedOriginal = JSON.stringify(nodeOf(tableElement(tableId)));

    const ended = fillEnded(core, copyId);
    await core.fillComparisonTable({ mindId: mind.id, tableId: copyId, mode: "refill-all" });
    await ended;
    await client.settled();
    expect(JSON.stringify(nodeOf(tableElement(tableId)))).toBe(editedOriginal);
    expect(blockWith(editor, "comparisonTable", tableId).node.textContent).toContain(
      "ORIGINAL EDIT",
    );
    await vi.waitFor(() =>
      expect(blockWith(editor, "comparisonTable", copyId).node.textContent).not.toContain(
        "COPY EDIT",
      ),
    );

    const savedCopy = await core.saveComparisonExport({ mindId: mind.id, tableId: copyId });
    if (savedCopy.status !== "saved") throw new Error(`Not saved: ${savedCopy.status}`);
    expect(await exportedHeading(savedCopy.file.path)).toBe("Sales");
    const savedOriginal = await core.saveComparisonExport({ mindId: mind.id, tableId });
    if (savedOriginal.status !== "saved") throw new Error(`Not saved: ${savedOriginal.status}`);
    expect(await exportedHeading(savedOriginal.file.path)).toBe("Revenue");

    const second = copyOf(editor, "chart", "chart-1");
    const found = findBlock(editor.state.doc, String(second.node.attrs.id));
    expect(found?.pos).toBe(second.pos);
    expect(changeChart(editor, second.pos, { kind: "line" })).toBe(true);
    const kindOf = (id: string) => readChart(blockWith(editor, "chart", id).node.attrs).kind;
    expect(kindOf(String(second.node.attrs.id))).toBe("line");
    expect(kindOf("chart-1")).toBe("bar");
    expect(JSON.stringify(blockWith(editor, "chart", "chart-1").node.toJSON())).toBe(chartBefore);
  }, 120_000);
});

function plainTable(id: string, rows: readonly (readonly string[])[]): NodeJSON {
  return {
    type: "table",
    attrs: { id },
    content: rows.map((row, at) => ({
      type: "tableRow",
      content: row.map((words) => ({
        type: at === 0 ? "tableHeader" : "tableCell",
        attrs: { colspan: 1, rowspan: 1 },
        content: [paragraph(words)],
      })),
    })),
  };
}

/** The chart "Make a chart" draws from this table, as the app makes it: its source is the table's id. */
function chartDrawnFrom(table: NodeJSON, id: string): NodeJSON {
  const chart = chartFromTable(gridOfTable(table), {
    blockId: String(table.attrs?.id),
    title: "Revenue",
    language: "en",
  });
  if (!chart) throw new Error("The table makes no chart.");
  return { type: "chart", attrs: { id, ...chart } };
}

const REVENUE = (id: string) =>
  plainTable(id, [
    ["Quarter", "2025"],
    ["Q1", "289.4"],
    ["Q2", "301.2"],
  ]);
const COSTS = (id: string) =>
  plainTable(id, [
    ["Quarter", "2025"],
    ["Q1", "88.1"],
    ["Q2", "90.3"],
  ]);

const sourceOf = (chart: ProseMirrorNode) => {
  const { source } = readChart(chart.attrs);
  return source.kind === "table" ? source.blockId : null;
};

/** The tables of the Note that are none of these, in the order the Note holds them. */
const pastedTables = (editor: Editor, originals: readonly string[]) =>
  blocksOf(editor, "table").filter(({ node }) => !originals.includes(String(node.attrs.id)));

/** The table a chart draws from, found as "Update from its table" finds it. */
const tableOf = (editor: Editor, chart: ProseMirrorNode) =>
  chartTable(editor.state.doc, readChart(chart.attrs));

/** Writes `words` over the first text in the Block at `pos` that reads `was`. */
function rewrite(editor: Editor, pos: number, was: string, words: string): void {
  const block = editor.state.doc.nodeAt(pos);
  let range: { from: number; to: number } | null = null;
  block?.descendants((node, offset) => {
    if (!range && node.isText && node.text === was) {
      const from = pos + 1 + offset;
      range = { from, to: from + node.nodeSize };
    }
    return !range;
  });
  const found = range as { from: number; to: number } | null;
  if (!found) throw new Error(`No "${was}" to rewrite.`);
  editor.view.dispatch(editor.state.tr.insertText(words, found.from, found.to));
}

describe("a chart pasted with the table it was drawn from", () => {
  const pasteBoth = (editor: Editor, from: number, to: number) =>
    pasteAtEnd(editor, copiedHtml(editor, from, to));

  // protects=a chart pasted with its table, in the same Note, is drawn from the copy: Update from its table reads the copy, and the original's chart still reads the original; fails_when=the copy's chart finds the original table, or the original's chart loses it; no_claim=a real mouse or a real clipboard.
  test("in the same Note, follows the copy and leaves the original's chart on the original", () => {
    const table = REVENUE("table-r");
    const editor = noteWith(table, chartDrawnFrom(table, "chart-r"));
    const first = blockWith(editor, "table", "table-r");
    const chart = blockWith(editor, "chart", "chart-r");
    pasteBoth(editor, first.pos, chart.pos + chart.node.nodeSize);

    const copyTable = copyOf(editor, "table", "table-r");
    const copyChart = copyOf(editor, "chart", "chart-r");
    expect(sourceOf(copyChart.node)).toBe(copyTable.node.attrs.id);
    expect(sourceOf(blockWith(editor, "chart", "chart-r").node)).toBe("table-r");
    expect(sharedBlockIds(editor)).toEqual([]);

    rewrite(editor, copyOf(editor, "table", "table-r").pos, "301.2", "310.0");
    const copied = copyOf(editor, "chart", "chart-r").node;
    expect(tableOf(editor, copied)?.attrs.id).toBe(copyTable.node.attrs.id);
    expect(tableUpdate(editor.state.doc, copied.attrs, "en")?.rows[1]?.values[0]?.shown).toBe(
      "310.0",
    );
    expect(
      tableUpdate(editor.state.doc, blockWith(editor, "chart", "chart-r").node.attrs, "en"),
    ).toBeNull();
  });

  // protects=a chart and its table pasted into another Note are drawn from the pasted table there; fails_when=the pasted chart names a table the Note doesn't hold; no_claim=none beyond protects.
  test("in another Note, follows the table pasted with it", () => {
    const table = REVENUE("table-r");
    const first = noteWith(table, chartDrawnFrom(table, "chart-r"));
    const second = noteOf([paragraph("Another note"), paragraph("")]);
    const chart = blockWith(first, "chart", "chart-r");
    second.commands.setTextSelection(second.state.doc.content.size - 1);
    pasteHtml(
      second,
      copiedHtml(first, blockWith(first, "table", "table-r").pos, chart.pos + chart.node.nodeSize),
    );

    const [pastedTable] = blocksOf(second, "table");
    const [pastedChart] = blocksOf(second, "chart");
    if (!pastedTable || !pastedChart) throw new Error("Nothing was pasted.");
    expect(pastedTable.node.attrs.id).not.toBe("table-r");
    expect(sourceOf(pastedChart.node)).toBe(pastedTable.node.attrs.id);
    expect(tableOf(second, pastedChart.node)?.attrs.id).toBe(pastedTable.node.attrs.id);
    expect(sourceOf(blockWith(first, "chart", "chart-r").node)).toBe("table-r");
  });

  // protects=of several tables pasted with a chart, the chart follows the one it was drawn from; fails_when=it follows the first table, the last, or the original; no_claim=none beyond protects.
  test("with two tables, follows the one it was drawn from", () => {
    const editor = noteWith(
      REVENUE("table-r"),
      COSTS("table-c"),
      chartDrawnFrom(COSTS("table-c"), "chart-c"),
    );
    const chart = blockWith(editor, "chart", "chart-c");
    pasteBoth(editor, blockWith(editor, "table", "table-r").pos, chart.pos + chart.node.nodeSize);

    const [, copiedCosts] = pastedTables(editor, ["table-r", "table-c"]);
    const copyChart = copyOf(editor, "chart", "chart-c").node;
    expect(copiedCosts?.node.textContent).toContain("88.1");
    expect(sourceOf(copyChart)).toBe(copiedCosts?.node.attrs.id);
    expect(sourceOf(blockWith(editor, "chart", "chart-c").node)).toBe("table-c");
  });

  // protects=a chart copied with a table it was not drawn from keeps drawing from its own table, in the Note it came from and in another; fails_when=the chart is pointed at the table that happened to come with it; no_claim=none beyond protects.
  test("with a table it was not drawn from, keeps the table it was drawn from", () => {
    const revenue = REVENUE("table-r");
    const editor = noteWith(
      revenue,
      chartDrawnFrom(revenue, "chart-r"),
      paragraph("Costs"),
      COSTS("table-c"),
    );
    const chart = blockWith(editor, "chart", "chart-r");
    const costs = blockWith(editor, "table", "table-c");
    const html = copiedHtml(editor, chart.pos, costs.pos + costs.node.nodeSize);
    pasteAtEnd(editor, html);

    const pasted = copyOf(editor, "chart", "chart-r").node;
    expect(pastedTables(editor, ["table-r", "table-c"])).toHaveLength(1);
    expect(sourceOf(pasted)).toBe("table-r");
    expect(tableOf(editor, pasted)?.attrs.id).toBe("table-r");

    const second = noteOf([paragraph("Another note"), paragraph("")]);
    second.commands.setTextSelection(second.state.doc.content.size - 1);
    pasteHtml(second, html);
    const [elsewhere] = blocksOf(second, "chart");
    expect(elsewhere && sourceOf(elsewhere.node)).toBe("table-r");
    expect(elsewhere && tableOf(second, elsewhere.node)).toBeNull();
  });
});

describe("a table cut and pasted inside its Note", () => {
  const tableIn = (doc: Y.Doc, id: string) => {
    const found = doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (block): block is Y.XmlElement =>
          block instanceof Y.XmlElement &&
          block.nodeName === COMPARISON_TABLE_NODE &&
          block.getAttribute("id") === id,
      );
    if (!found) throw new Error(`The Note has no table ${id}.`);
    return found;
  };
  const cellOf = (table: Y.XmlElement, documentId: string) => {
    const row = table
      .toArray()
      .find(
        (each): each is Y.XmlElement =>
          each instanceof Y.XmlElement && each.getAttribute("documentId") === documentId,
      );
    const cell = row?.toArray()[0];
    if (!(cell instanceof Y.XmlElement)) throw new Error("The row has no cell.");
    return cell;
  };

  /** "Checked by me" on the cell's Answer as it is now, as the editor records it. */
  const check = (doc: Y.Doc, tableId: string, documentId: string, questionId: string) =>
    addSignOff(doc, {
      id: "sign-off-1",
      target: comparisonCellTarget(tableId, documentId, questionId),
      at: "2026-11-01T10:00:00.000Z",
      contentHash: comparisonCellBasis(
        comparisonCellContent(nodeOf(cellOf(tableIn(doc, tableId), documentId))),
      ),
      deletedAt: null,
      name: "Ada Lovelace",
      personId: "person-ada",
    });
  const markOn = (doc: Y.Doc, tableId: string, documentId: string, questionId: string) =>
    comparisonCellSignOff(
      signOffsOf(doc),
      comparisonCellTarget(tableId, documentId, questionId),
      comparisonCellContent(nodeOf(cellOf(tableIn(doc, tableId), documentId))),
      null,
      null,
    )?.state ?? null;

  // protects=a comparison table cut and pasted lower in its own Note is the same table: its cells' marks still show, and a refill of its column leaves the checked cell alone; fails_when=the pasted table has a table id or Question ids the marks are not kept under, so the cell reads as never checked and the refill rewrites it; no_claim=a real clipboard or the app's refill button.
  test("keeps the marks on its cells, and a refill leaves the checked cell alone", async () => {
    const asked: string[] = [];
    const { core, client, mind, documents } = await setUpWithDocuments(
      cellModel((_call, cell) => {
        asked.push(cell.document);
        return null;
      }),
      [
        { name: "Acme.txt", contents: ACME_REPORT },
        { name: "Brandt.txt", contents: BRANDT_REPORT },
      ],
    );
    const tableId = await compare(core, client, {
      mindId: mind.id,
      documentIds: documents.map((document) => document.id),
      questions: ["Revenue"],
    });
    const [acme, brandt] = documents;
    const column = comparisonQuestionsOf(tableIn(client.doc, tableId).getAttributes())[0];
    if (!acme || !brandt || !column) throw new Error("The table is not what the test needs.");
    client.doc.transact(() => {
      client.blocks.push([createElement(paragraph("Below")), createElement(paragraph(""))]);
    });
    await client.settled();
    check(client.doc, tableId, acme.id, column.id);
    expect(markOn(client.doc, tableId, acme.id, column.id)).toBe("checked");
    const editor = noteEditor(client.doc);

    const cut = cutBlock(editor, blockWith(editor, "comparisonTable", tableId).pos);
    expect(blocksOf(editor, "comparisonTable")).toHaveLength(0);
    pasteAtEnd(editor, cut);
    await client.settled();

    const { node: pasted } = blocksOf(editor, "comparisonTable")[0] ?? {};
    expect(pasted?.attrs.id).toBe(tableId);
    expect(pasted && questionIdsOf(pasted)).toEqual([column.id]);
    expect(markOn(client.doc, tableId, acme.id, column.id)).toBe("checked");

    client.doc.transact(() => {
      for (const { id } of documents)
        cellOf(tableIn(client.doc, tableId), id).setAttribute("fillId", "pass-column");
    });
    const checkedCell = cellOf(tableIn(client.doc, tableId), acme.id).toString();
    asked.length = 0;
    const ended = fillEnded(core, tableId);
    const result = await core.fillComparisonTable({
      mindId: mind.id,
      tableId,
      questionIds: [column.id],
      mode: "refill",
      pass: "pass-column",
    });
    if (!result.started) throw new Error(`The refill did not start: ${JSON.stringify(result)}`);
    await ended;
    await client.settled();
    expect([...new Set(asked)]).toEqual(["Brandt"]);
    expect(cellOf(tableIn(client.doc, tableId), acme.id).toString()).toBe(checkedCell);
    expect(markOn(client.doc, tableId, acme.id, column.id)).toBe("checked");
  }, 120_000);

  // protects=a chart that stays where it is keeps finding its table while the table is cut and pasted lower: Update from its table still reads it, and no other table is taken for it; fails_when=the pasted table has an id the chart does not name, so the chart loses its table; no_claim=none beyond protects.
  test("a chart that stays in place still finds the table", () => {
    const table = REVENUE("table-r");
    const doc = new Y.Doc();
    doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push(
        [
          paragraph("Costs"),
          table,
          paragraph("Notes"),
          chartDrawnFrom(table, "chart-r"),
          paragraph("Below"),
          paragraph(""),
        ].map(createElement),
      );
    const editor = noteEditor(doc);
    const before = editor.state.doc.toJSON();
    const apart = () => yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
    const { pos, node } = blockWith(editor, "table", "table-r");
    const cut = cutRange(editor, pos - 1, pos + node.nodeSize + 1);
    apart();
    const chart = blockWith(editor, "chart", "chart-r").node;
    expect(blocksOf(editor, "table")).toHaveLength(0);
    expect(tableOf(editor, chart)).toBeNull();
    pasteAtEnd(editor, cut);

    expect(blocksOf(editor, "table")).toHaveLength(1);
    const pasted = blockWith(editor, "table", "table-r");
    expect(pasted.pos).toBeGreaterThan(blockWith(editor, "chart", "chart-r").pos);
    expect(sourceOf(blockWith(editor, "chart", "chart-r").node)).toBe("table-r");
    rewrite(editor, pasted.pos, "301.2", "310.0");
    expect(
      tableUpdate(editor.state.doc, blockWith(editor, "chart", "chart-r").node.attrs, "en")?.rows[1]
        ?.values[0]?.shown,
    ).toBe("310.0");

    apart();
    expect(editor.commands.undo()).toBe(true);
    expect(blocksOf(editor, "table")).toHaveLength(0);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(tableOf(editor, blockWith(editor, "chart", "chart-r").node)?.attrs.id).toBe("table-r");
  });

  // protects=pasting the same cut a second time makes a table of its own, and so does pasting it into another Note, where its cells start unchecked; fails_when=a second paste shares the first one's table id or Question ids, or another Note's table keeps this Note's; no_claim=none beyond protects.
  test("pasted a second time, or into another Note, is a copy with ids of its own", () => {
    const editor = noteOf([
      paragraph("Shortlist"),
      comparison("table-1", ENGLISH.documents, ENGLISH.questions),
      paragraph("Below"),
      paragraph(""),
    ]);
    const questions = questionIdsOf(blockWith(editor, "comparisonTable", "table-1").node);
    const cut = cutBlock(editor, blockWith(editor, "comparisonTable", "table-1").pos);
    pasteAtEnd(editor, cut);
    expect(questionIdsOf(blockWith(editor, "comparisonTable", "table-1").node)).toEqual(questions);

    pasteAtEnd(editor, cut);
    const { node: second } = copyOf(editor, "comparisonTable", "table-1");
    expect(second.attrs.id).not.toBe("table-1");
    expect(questionIdsOf(second).filter((id) => questions.includes(id))).toEqual([]);
    expect(sharedBlockIds(editor)).toEqual([]);
    expect(sharedQuestionIds(editor)).toEqual([]);

    const other = noteOf([paragraph("Another note"), paragraph("")]);
    other.commands.setTextSelection(other.state.doc.content.size - 1);
    pasteHtml(other, cut);
    const [elsewhere] = blocksOf(other, "comparisonTable");
    expect(elsewhere?.node.attrs.id).not.toBe("table-1");
    expect(
      elsewhere && questionIdsOf(elsewhere.node).filter((id) => questions.includes(id)),
    ).toEqual([]);
  });

  // protects=Undo takes a moved table out of its new place in one step and puts it back where it was with the ids it had; a table pasted again after that is the same table again; fails_when=Undo leaves the pasted table, brings back a table with other ids, or the paste after it is made a copy; no_claim=the clipboard (cut and paste go through the editor's own handlers, Undo through the Yjs undo manager).
  test("Undo puts the cut table back where it was, with the ids it had", () => {
    const doc = new Y.Doc();
    doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .push(
        [
          paragraph("Shortlist"),
          comparison("table-1", ENGLISH.documents, ENGLISH.questions),
          paragraph("Below"),
          paragraph(""),
        ].map(createElement),
      );
    check(doc, "table-1", "doc-Corvane", "q-notice");
    const editor = noteEditor(doc);
    const before = editor.state.doc.toJSON();
    const questions = questionIdsOf(blockWith(editor, "comparisonTable", "table-1").node);
    const apart = () => yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();

    const cut = cutBlock(editor, blockWith(editor, "comparisonTable", "table-1").pos);
    apart();
    pasteAtEnd(editor, cut);
    expect(questionIdsOf(blockWith(editor, "comparisonTable", "table-1").node)).toEqual(questions);
    expect(markOn(doc, "table-1", "doc-Corvane", "q-notice")).toBe("checked");

    expect(editor.commands.undo()).toBe(true);
    expect(blocksOf(editor, "comparisonTable")).toHaveLength(0);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(markOn(doc, "table-1", "doc-Corvane", "q-notice")).toBe("checked");

    pasteAtEnd(editor, cut);
    const { node: again } = copyOf(editor, "comparisonTable", "table-1");
    expect(again.attrs.id).not.toBe("table-1");
    expect(sharedQuestionIds(editor)).toEqual([]);
  });
});
