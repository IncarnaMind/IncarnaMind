import type { Editor } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import {
  duplicateComparisonTable,
  plainComparisonTable,
  removeComparisonTable,
} from "../../src/renderer/src/comparisonTableWhole";
import { useUndo } from "../../src/renderer/src/undo";
import { comparisonQuestionsOf, comparisonTitleOf } from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { boundEditorTo } from "../helpers/editor";

vi.mock("../../src/renderer/src/core", () => ({
  core: { on: () => () => undefined, fillComparisonTable: async () => ({ started: false }) },
  files: {},
}));

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const answer = (questionId: string, content: NodeJSON[]): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done" },
  content,
});

const TABLE: NodeJSON = {
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Termination notice", label: "Notice" },
      { id: "q2", text: "Governing law" },
    ],
  },
  content: ["Corvane", "Halvard"].map((name) => ({
    type: "comparisonRow",
    attrs: { documentId: `doc-${name}`, documentName: name },
    content: [
      answer("q1", [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "90 days" },
            { type: "citation", attrs: { documentId: `doc-${name}`, quote: "Notice: 90 days." } },
          ],
        },
      ]),
      name === "Corvane"
        ? answer("q2", [paragraph("New York")])
        : {
            type: "comparisonCell",
            attrs: { questionId: "q2", status: "failed", problem: "not-found" },
            content: [paragraph("")],
          },
    ],
  })),
};

/** A note of a line and the table, and the editor bound to it as the window's is. */
function boundNote(): Editor {
  const doc = new Y.Doc();
  doc
    .getXmlFragment(MIND_CONTENT_FIELD)
    .push([createElement(paragraph("Shortlist")), createElement(TABLE)]);
  return boundEditorTo(doc);
}

const tables = (editor: Editor) => {
  const found: Editor["state"]["doc"][] = [];
  editor.state.doc.forEach((block) => {
    if (block.type.name === "comparisonTable") found.push(block);
  });
  return found;
};

const plainTables = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.forEach((block) => {
    if (block.type.name === "table") found.push(block.textContent);
  });
  return found;
};

const lineNow = () => useUndo.getState().done.at(-1);

const said = (line: ReturnType<typeof lineNow>, language: "en" | "zh-CN"): string | undefined =>
  line?.said(
    (key, params) => translate(language, key, params),
    (value) => value,
  );

/** The note's own ⌘Z, which the app's Undo reaches with the note in front. */
const undo = (editor: Editor) => {
  if (!editor.commands.undo()) throw new Error("The note had nothing to undo.");
};

describe("A comparison table's whole-table actions", () => {
  test("a copy goes below it with its words, its own ids and a name that says it is a copy", async () => {
    const editor = boundNote();
    duplicateComparisonTable({ editor, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(2));
    const [original, copy] = tables(editor);
    const questions = comparisonQuestionsOf(copy?.attrs ?? {});
    expect(questions.map((question) => question.text)).toEqual([
      "Termination notice",
      "Governing law",
    ]);
    expect(questions[0]?.label).toBe("Notice");
    expect(questions.map((question) => question.id)).not.toEqual(["q1", "q2"]);
    expect(comparisonTitleOf(copy?.attrs ?? {})).toBe("Comparison table (copy)");
    expect(copy?.textContent).toBe(original?.textContent);
    expect(copy?.attrs.id).not.toBe("table-1");
  });

  test("one ⌘Z takes the copy out again", async () => {
    const editor = boundNote();
    duplicateComparisonTable({ editor, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(2));
    undo(editor);
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(1));
  });

  test("delete takes the table out whole, and one ⌘Z puts it back with its Answers", async () => {
    const editor = boundNote();
    const before = tables(editor)[0]?.textContent;
    removeComparisonTable({ editor, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(0));
    undo(editor);
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(1));
    expect(tables(editor)[0]?.textContent).toBe(before);
    expect(editor.state.doc.textContent).toContain("Shortlist");
  });

  test("a plain table keeps the words and Citations, and drops the Questions and their fills", async () => {
    const editor = boundNote();
    plainComparisonTable({ editor, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(0));
    const [plain = ""] = plainTables(editor);
    for (const kept of [
      "Document",
      "Notice",
      "Governing law",
      "Corvane",
      "90 days",
      "New York",
      "not found",
    ]) {
      expect(plain).toContain(kept);
    }
    let citations = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "citation") citations++;
      return true;
    });
    expect(citations).toBe(2);
    undo(editor);
    await vi.waitFor(() => expect(tables(editor)).toHaveLength(1));
  });

  test("each action says what it did on the undo line, in both languages", async () => {
    const duplicating = boundNote();
    duplicateComparisonTable({ editor: duplicating, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(duplicating)).toHaveLength(2));
    const copied = lineNow();
    expect(said(copied, "en")).toBe("Duplicated “Comparison table”");
    expect(said(copied, "zh-CN")).toBe("已复制“Comparison table”");

    const deleting = boundNote();
    removeComparisonTable({ editor: deleting, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(deleting)).toHaveLength(0));
    const deleted = lineNow();
    expect(said(deleted, "en")).toBe("Deleted “Comparison table”");
    expect(said(deleted, "zh-CN")).toBe("已删除“Comparison table”");

    const turning = boundNote();
    plainComparisonTable({ editor: turning, mindId: "mind-1", tableId: "table-1" });
    await vi.waitFor(() => expect(tables(turning)).toHaveLength(0));
    const turned = lineNow();
    expect(said(turned, "en")).toBe("Turned “Comparison table” into a plain table");
    expect(said(turned, "zh-CN")).toBe("已将“Comparison table”转为普通表格");
  });
});
