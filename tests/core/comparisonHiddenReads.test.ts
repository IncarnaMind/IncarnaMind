/**
 * A comparison table's hidden columns in its readers (#1833): hiding is
 * display only, so the assistant and the check record keep them; an export
 * leaves them out and says nothing about them.
 */
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { readMind } from "../../src/core/answers/context";
import { blocksText } from "../../src/core/exports/comparisonSheet";
import { type Footnote, readBlock, readBlocks, reviewReading } from "../../src/core/mindText";

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

const content = (): Y.XmlFragment => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("content");
  fragment.push([createElement(table)]);
  return fragment;
};

const footnote = (): Footnote => ({ source: "", unverified: false });

/** What the check record reads: each top-level Block as its file's rows. */
const checkRecordText = (): string => {
  const fragment = content();
  const options = {
    includeQuestions: false,
    footnote,
    trimBeforeCitation: false,
    review: reviewReading(fragment),
  };
  const blocks = fragment
    .toArray()
    .flatMap((child) => (child instanceof Y.XmlElement ? readBlock(child, options) : []));
  return blocksText(blocks);
};

/** What an export writes: the same Blocks, hidden columns left out. */
const exportText = (): string => {
  const blocks = readBlocks(content(), {
    includeQuestions: false,
    footnote,
    trimBeforeCitation: true,
    leaveOutHiddenColumns: true,
  });
  return blocksText(blocks);
};

describe("A comparison table's hidden columns for its readers", () => {
  test("the assistant and the check record read them; an export leaves them out silently", () => {
    const assistant = readMind(content(), "Shortlist", null).section().text;
    expect(assistant).toContain("Liability cap");
    expect(assistant).toContain("12 months");
    expect(checkRecordText()).toContain("Liability cap");
    expect(checkRecordText()).toContain("12 months");
    expect(exportText()).not.toContain("Liability cap");
    expect(exportText()).not.toContain("12 months");
    expect(exportText()).not.toContain("Left out");
  });
});
