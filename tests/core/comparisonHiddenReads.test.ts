/**
 * A comparison table's hidden columns in its readers (#1833): hiding is
 * display only, so every reader but an export keeps them; an export leaves
 * them out and says nothing about them.
 */
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { contentMarkdownOf } from "../../src/core/answers/contextText";
import { blocksText } from "../../src/core/exports/comparisonSheet";
import { readBlocks } from "../../src/core/mindText";

const answer = (questionId: string, text: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done" },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const table: NodeJSON = {
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: "Notice" },
      { id: "q2", text: "Liability cap", hidden: true },
    ],
  },
  content: [
    {
      type: "comparisonRow",
      attrs: { documentId: "doc", documentName: "Acme" },
      content: [answer("q1", "90 days"), answer("q2", "12 months")],
    },
  ],
};

const content = () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("content");
  fragment.push([createElement(table)]);
  return fragment;
};

const read = (leaveOutHiddenColumns: boolean): string => {
  const blocks = readBlocks(content(), {
    includeQuestions: false,
    footnote: () => ({ source: "", unverified: false }),
    trimBeforeCitation: true,
    leaveOutHiddenColumns,
  });
  return blocks.map((block) => (block.kind === "table" ? blocksText([block]) : "")).join("\n");
};

describe("A comparison table's hidden columns for its readers", () => {
  test("the assistant and the check record read them; an export leaves them out silently", () => {
    const markdown = contentMarkdownOf(content() as unknown as Y.XmlElement);
    expect(markdown).toContain("Liability cap");
    expect(markdown).toContain("12 months");
    expect(markdown).not.toContain("Left out");
    expect(read(false)).toContain("Liability cap");
    expect(read(false)).toContain("12 months");
    expect(read(true)).not.toContain("Liability cap");
    expect(read(true)).not.toContain("12 months");
    expect(read(true)).not.toContain("Left out");
  });
});
