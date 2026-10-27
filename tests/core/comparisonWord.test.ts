/**
 * A comparison table exported to Word and Markdown (#1833): each column is
 * named by its label, or by its whole Question, since a file has room for it.
 */
import { describe, expect, onTestFinished, test } from "vitest";
import { MIND_CONTENT_FIELD } from "../../src/core";
import { createElement, type NodeJSON } from "../../src/core/answers/blocks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { part, textOf, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";

const LONG_QUESTION =
  "What notice, in days, must either party give to end the agreement, and from when?";

const paragraph = (text: string): NodeJSON => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const answer = (questionId: string, text: string): NodeJSON => ({
  type: "comparisonCell",
  attrs: { questionId, status: "done" },
  content: [paragraph(text)],
});

const table: NodeJSON = {
  type: "comparisonTable",
  attrs: {
    id: "table-1",
    questions: [
      { id: "q1", text: LONG_QUESTION },
      { id: "q2", text: "Operating result", label: "Result" },
    ],
  },
  content: [
    {
      type: "comparisonRow",
      attrs: { documentId: "acme", documentName: "Acme" },
      content: [answer("q1", "90 days"), answer("q2", "12 months")],
    },
  ],
};

describe("A comparison table exported", () => {
  // protects=a column's heading in a file is its label, or its whole Question however long, never a heading's shortening; fails_when=a Question over 40 characters arrives cut off with "…", or a label is ignored; no_claim=Word's and Markdown's own rendering.
  test("names each column by its label, or its whole Question, in Word and Markdown", async () => {
    const core = startCore(await createTempDataFolder());
    onTestFinished(() => core.close());
    const mind = await core.createMind({ title: "Suppliers" });
    const client = await connectToMind(core, mind.id);
    client.doc.transact(() =>
      client.doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(table)]),
    );
    await client.settled();

    const word = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    const wordTable = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(part(word, "word/document.xml"))?.[0] ?? "";
    expect(wordTable).toContain("<w:trPr><w:tblHeader/></w:trPr>");
    const headerRow = /<w:tr>[\s\S]*?<\/w:tr>/.exec(wordTable)?.[0] ?? "";
    expect(
      [...headerRow.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((cell) => textOf(cell[1] as string)),
    ).toEqual(["Document", LONG_QUESTION, "Result"]);

    const markdown = Buffer.from(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    ).toString("utf8");
    const headerLine = markdown.split("\n").find((line) => line.startsWith("| Document |")) ?? "";
    expect(headerLine).toContain(`| ${LONG_QUESTION} |`);
    expect(headerLine).toContain("| Result |");
    expect(headerLine).not.toContain("…");
  });
});
