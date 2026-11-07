/**
 * A comparison table exported to CSV (#1839), through the core as the table's
 * "Export to CSV" asks for it: the table as shown, a Sources column, and a byte
 * order mark so Excel and Numbers open Chinese.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { COMPARISON_TABLE_NODE, MIND_CONTENT_FIELD } from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { compareReports } from "../helpers/comparisons";
import type { MindClient } from "../helpers/mindClient";

async function savedCsv(
  core: Awaited<ReturnType<typeof compareReports>>["core"],
  input: {
    mindId: string;
    tableId: string;
    documentIds?: readonly string[];
  },
) {
  const saved = await core.saveComparisonCsvExport(input);
  if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
  const text = await readFile(saved.file.path, "utf8");
  return { saved, text, lines: text.replace(/^﻿/, "").split("\r\n") };
}

const hideColumn = (client: MindClient, tableId: string, questionText: string) => {
  client.doc.transact(() => {
    const table = client.doc
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (block): block is Y.XmlElement =>
          block instanceof Y.XmlElement &&
          block.nodeName === COMPARISON_TABLE_NODE &&
          block.getAttribute("id") === tableId,
      );
    type Asked = { id: string; text: string; hidden?: boolean };
    const asked = table as Y.XmlElement<{ questions: Asked[] }> | undefined;
    const questions = asked?.getAttribute("questions") ?? [];
    asked?.setAttribute(
      "questions",
      questions.map((question) =>
        question.text === questionText ? { ...question, hidden: true } : question,
      ),
    );
  });
};

/** The rows a spreadsheet reads back, RFC 4180: quoted cells with commas, quotes and CRLF inside. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const body = text.replace(/^\uFEFF/, "");
  for (let at = 0; at < body.length; at++) {
    const character = body[at] ?? "";
    if (quoted) {
      if (character !== '"') cell += character;
      else if (body[at + 1] === '"') {
        cell += '"';
        at++;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && body[at + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      at++;
    } else if (character !== "\n") cell += character;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe("A comparison table exported to CSV", () => {
  test("reads back as the table's own rows and columns, each cell whole", async () => {
    const { core, mind, tableId } = await compareReports();
    const { text } = await savedCsv(core, { mindId: mind.id, tableId });
    const rows = readCsv(text);
    expect(rows[0]).toEqual([
      "Document",
      "Revenue",
      "Operating result",
      "Gross margin",
      "Year end",
      "Auditor",
      "Sources",
    ]);
    expect(rows.slice(1).map((row) => row.slice(0, 6))).toEqual([
      ["Acme", "$1.2m", "(3,400)", "12.5%", "31 March 2026", "Smith & Partners, appointed in 2019"],
      ["Brandt", "1,2 Mio. €", "(1,250)", "9.0%", "31 December 2025", "Keller AG"],
    ]);
    expect(rows.slice(1).map((row) => row.length)).toEqual([7, 7]);
  });

  test("has a byte order mark, the table's columns and rows, and a Sources column", async () => {
    const { core, mind, tableId } = await compareReports();
    const { saved, text, lines } = await savedCsv(core, { mindId: mind.id, tableId });
    expect(saved.file.name).toBe("Comparison table.csv");
    expect(text.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe(
      "Document,Revenue,Operating result,Gross margin,Year end,Auditor,Sources",
    );
    const [acme, brandt] = lines.slice(1);
    expect(acme?.startsWith('Acme,$1.2m,"(3,400)",12.5%,31 March 2026,')).toBe(true);
    expect(brandt?.startsWith("Brandt,")).toBe(true);
    // The Sources column names the column, the Document, where, and the quote it checked.
    expect(acme).toContain("Revenue: Acme, line 2 · “Revenue: $1.2m.”");
    expect(acme).toContain("Auditor: Acme");
    expect(acme).toContain("“Auditor: Smith & Partners, appointed in 2019.”");
  });

  test("quotes a cell that holds a comma or a quote, so a spreadsheet reads it whole", async () => {
    const { core, mind, tableId } = await compareReports();
    const { lines } = await savedCsv(core, { mindId: mind.id, tableId });
    const acme = lines[1] ?? "";
    expect(acme).toContain('"Smith & Partners, appointed in 2019"');
    expect(acme).toContain("“Revenue: $1.2m.”");
  });

  test("leaves a hidden column out, as the table shows it", async () => {
    const { core, client, mind, tableId } = await compareReports();
    hideColumn(client, tableId, "Revenue");
    await client.settled();
    const { lines } = await savedCsv(core, { mindId: mind.id, tableId });
    expect(lines[0]).toBe("Document,Operating result,Gross margin,Year end,Auditor,Sources");
  });

  test("keeps only the rows the table shows when a filter hides some", async () => {
    const { core, mind, tableId, documents } = await compareReports();
    const acme = documents.find((document) => document.name === "Acme");
    if (!acme) throw new Error("Acme wasn't added.");
    const { lines } = await savedCsv(core, {
      mindId: mind.id,
      tableId,
      documentIds: [acme.id],
    });
    expect(
      lines
        .slice(1)
        .filter(Boolean)
        .map((line) => line.split(",")[0]),
    ).toEqual(["Acme"]);
  });

  test("names the file and the headings in Chinese, which a spreadsheet reads as it is", async () => {
    const { core, mind, tableId } = await compareReports();
    await core.updateSettings({ user: { language: "zh-CN" } });
    const { saved, lines } = await savedCsv(core, { mindId: mind.id, tableId });
    expect(saved.file.name).toBe("对比表.csv");
    expect(lines[0]?.startsWith("文档,")).toBe(true);
    expect(lines[0]?.endsWith(",来源")).toBe(true);
    expect(lines[1]).toContain("Acme");
  });

  test("says so when the table isn't in the Mind", async () => {
    const { core, mind } = await compareReports();
    await expect(
      core.saveComparisonCsvExport({ mindId: mind.id, tableId: "not-a-table" }),
    ).rejects.toThrow(translate("en", "error.comparison.notFound"));
  });
});
