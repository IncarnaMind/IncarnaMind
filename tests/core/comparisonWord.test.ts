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
    expect((await core.previewMindExport(mind.id, { format: "docx" })).hiddenColumns).toBe(0);
  });

  // protects=a hidden column is left out of Word and Markdown, and the file says nothing about it, while a column the User sized is wider than the Document column; fails_when=a hidden column's heading or Answers appear, the file mentions a hidden column, or a set width does not reach the Word table; no_claim=Word's and Markdown's own rendering.
  test("leaves a hidden column out with no line, and lays the columns out at the widths the User set", async () => {
    const core = startCore(await createTempDataFolder());
    onTestFinished(() => core.close());
    const mind = await core.createMind({ title: "Suppliers" });
    const client = await connectToMind(core, mind.id);
    const sized: NodeJSON = {
      ...table,
      attrs: {
        ...table.attrs,
        questions: [
          { id: "q1", text: LONG_QUESTION, width: 420 },
          { id: "q2", text: "Operating result", label: "Result", hidden: true },
        ],
      },
    };
    client.doc.transact(() =>
      client.doc.getXmlFragment(MIND_CONTENT_FIELD).push([createElement(sized)]),
    );
    await client.settled();

    const document = part(
      unzip((await core.exportMind(mind.id, { format: "docx" })).data),
      "word/document.xml",
    );
    const wordTable = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(document)?.[0] ?? "";
    const headerRow = /<w:tr>[\s\S]*?<\/w:tr>/.exec(wordTable)?.[0] ?? "";
    expect(
      [...headerRow.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((cell) => textOf(cell[1] as string)),
    ).toEqual(["Document", LONG_QUESTION]);
    const grid = [...wordTable.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((found) =>
      Number(found[1]),
    );
    expect(grid).toHaveLength(2);
    expect(grid[1]).toBeGreaterThan(grid[0] as number);
    // The file leaves the column out and says nothing about it.
    expect(textOf(document.replace(wordTable, ""))).not.toContain("hidden column");
    expect(textOf(document)).not.toContain("Result");

    const markdown = Buffer.from(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    ).toString("utf8");
    const headerLine = markdown.split("\n").find((line) => line.startsWith("| Document |")) ?? "";
    expect(headerLine).not.toContain("Result");
    expect(markdown).not.toContain("hidden column");
    // The app is told the count instead, as the export's preview does.
    const preview = await core.previewMindExport(mind.id, { format: "docx" });
    expect(preview.hiddenColumns).toBe(1);

    // Chinese too: the file says nothing about the column.
    await core.updateSettings({ user: { language: "zh-CN" } });
    const zhMarkdown = Buffer.from(
      (await core.exportMind(mind.id, { format: "markdown" })).data,
    ).toString("utf8");
    expect(zhMarkdown).not.toContain("Result");
    expect(zhMarkdown).not.toContain("隐藏列");
  });
});
