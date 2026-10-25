import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ComparisonProblem } from "../../src/core";
import { addComparisonColumn } from "../../src/renderer/src/editor/comparisonCommands";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import {
  cellProblemMessage,
  cellToFill,
  comparisonCellOf,
  comparisonQuestionsOf,
  MAX_COMPARISON_QUESTIONS,
} from "../../src/shared/comparisons";
import { translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";
import { zhCN } from "../../src/shared/i18n/zh-CN";

const cell = (questionId: string, status = "done"): JSONContent => ({
  type: "comparisonCell",
  attrs: { questionId, status },
  content: [{ type: "paragraph", content: [{ type: "text", text: `${questionId} answer` }] }],
});

/** A headless editor holding a comparison table of two Documents and one Question, after a Note. */
function editorWithTable(): Editor {
  const editor = new Editor({
    element: null,
    extensions: noteExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Shortlist" }] },
        {
          type: "comparisonTable",
          attrs: { id: "table-1", questions: [{ id: "q1", text: "Termination notice" }] },
          content: ["doc-a", "doc-b"].map((documentId) => ({
            type: "comparisonRow",
            attrs: { documentId, documentName: documentId },
            content: [cell("q1")],
          })),
        },
      ],
    },
  });
  onTestFinished(() => editor.destroy());
  return editor;
}

describe("A comparison table in the editor", () => {
  test("“+ Question” adds a column, and a cell waiting in each row, as one change Undo takes back", () => {
    const editor = editorWithTable();
    expect(addComparisonColumn(editor, "table-1", "  Governing   law ")).toBe(true);

    const table = editor.state.doc.child(1);
    expect(comparisonQuestionsOf(table.attrs).map((question) => question.text)).toEqual([
      "Termination notice",
      "Governing law",
    ]);
    const added = comparisonQuestionsOf(table.attrs)[1]?.id;
    table.forEach((row) => {
      expect(row.childCount).toBe(2);
      expect(comparisonCellOf(row.child(1).attrs)).toMatchObject({
        questionId: added,
        status: "waiting",
      });
    });
    expect(() => editor.state.doc.check()).not.toThrow();

    // Nothing to add: no column. A table that isn't there: nothing.
    expect(addComparisonColumn(editor, "table-1", "   ")).toBe(false);
    expect(addComparisonColumn(editor, "no-table", "Liability cap")).toBe(false);
  });

  test("a table holds at most so many Questions", () => {
    const editor = editorWithTable();
    for (let added = 1; added < MAX_COMPARISON_QUESTIONS; added++) {
      expect(addComparisonColumn(editor, "table-1", `Question ${added}`)).toBe(true);
    }
    expect(addComparisonColumn(editor, "table-1", "One too many")).toBe(false);
  });
});

describe("Reading a comparison table", () => {
  test("malformed columns and cells read as their defaults", () => {
    expect(comparisonQuestionsOf({ questions: "nope" })).toEqual([]);
    expect(
      comparisonQuestionsOf({
        questions: [{ id: "q1", text: "A" }, { id: "q1", text: "again" }, { text: "no id" }, null],
      }),
    ).toEqual([{ id: "q1", text: "A" }]);
    expect(comparisonCellOf({ status: "odd" })).toMatchObject({ status: "waiting", problem: null });
    expect(comparisonCellOf({ status: "failed" })).toMatchObject({ problem: "unknown" });
  });

  test("filling again writes cells with no Answer, but not those whose Document can't answer", () => {
    expect(cellToFill({ status: "waiting", problem: null })).toBe(true);
    expect(cellToFill({ status: "done", problem: null })).toBe(false);
    for (const problem of ["cost-cap", "plan-limit", "network", "rate-limit"] as const) {
      expect(cellToFill({ status: "failed", problem })).toBe(true);
    }
    for (const problem of ["not-found", "nothing-to-search", "source-removed"] as const) {
      expect(cellToFill({ status: "failed", problem })).toBe(false);
    }
  });

  test("every cell without an Answer says why, in English and Chinese", () => {
    const problems: ComparisonProblem[] = [
      "not-found",
      "scale-changed",
      "nothing-to-search",
      "source-removed",
      "left-out",
      "not-cited",
      "cost-cap",
      "plan-limit",
      "auth",
      "rate-limit",
      "network",
      "consent-declined",
      "local-mode",
      "too-long",
      "provider",
      "unknown",
    ];
    for (const problem of problems) {
      const { key, params } = cellProblemMessage(problem);
      expect(translate("en", key, params)).not.toBe("");
      expect(translate("zh-CN", key, params)).not.toBe("");
    }
    expect(translate("en", cellProblemMessage("cost-cap").key)).toBe("not checked: cost cap");
    expect(translate("zh-CN", cellProblemMessage("not-found").key)).toBe("未找到");
    const scale = cellProblemMessage("scale-changed", "310000 GBP thousands");
    expect(translate("en", scale.key, scale.params)).toBe(
      "scale differs from the Document, which gives 310000 GBP thousands",
    );
    const yuan = cellProblemMessage("scale-changed", "31000 万元");
    expect(translate("zh-CN", yuan.key, yuan.params)).toBe(
      "金额单位与文档不符，文档写的是 31000 万元",
    );
  });

  test("the interface says Compare Documents and comparison table, never Matrix", () => {
    expect(en["command.compareDocuments"]).toBe("Compare Documents…");
    expect(en["comparison.title"]).toBe("Comparison table");
    for (const text of [...Object.values(en), ...Object.values(zhCN)]) {
      expect(text).not.toMatch(/matrix/i);
    }
  });
});
