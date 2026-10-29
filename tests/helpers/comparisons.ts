/**
 * Comparison tables made in tests (#98): a model that writes each cell as a
 * careful one does, from the one line of its Document that answers its
 * Question, and a way to wait for a table to fill.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import {
  COMPARISON_ROW_NODE,
  COMPARISON_TABLE_NODE,
  type Core,
  type CoreEvents,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { type ShownPassage, setUpWithDocuments, shownPassages } from "./citations";
import type { MindClient } from "./mindClient";
import { type ModelCall, type ScriptedReply, scriptedModel } from "./models";

/** What a cell's request asks: its Question, and the Document its row is. */
export function cellAsked(call: ModelCall): { question: string; document: string } {
  const user = call.options.prompt
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
    )
    .join("\n");
  return {
    question: user.split("\n\n").at(-1) ?? "",
    document: /its row is the Document "([^"]+)"/.exec(user)?.[1] ?? "",
  };
}

/** The line of a Passage that shares a word of four letters or more with the Question. */
function lineFor(passages: readonly ShownPassage[], question: string) {
  const words = question
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length >= 4);
  for (const passage of passages) {
    for (const line of passage.text.split("\n")) {
      if (words.some((word) => line.toLowerCase().includes(word))) return { passage, line };
    }
  }
  return null;
}

/**
 * A model that writes cells as a careful one does: it searches the Question,
 * cites the line that answers it and answers with that line, or replies
 * NOT_FOUND when the Document has none. `before` may answer a request first;
 * `hold` keeps each cell's last words from finishing until it resolves.
 */
export function cellModel(
  before?: (call: ModelCall, asked: ReturnType<typeof cellAsked>) => ScriptedReply | null,
  hold?: Promise<void>,
  holdWhen?: (asked: ReturnType<typeof cellAsked>) => boolean,
) {
  return scriptedModel((call) => {
    const asked = cellAsked(call);
    const early = before?.(call, asked);
    if (early) return early;
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: asked.question } }] };
    }
    const found = lineFor(shownPassages(searches.at(-1)?.text ?? ""), asked.question);
    if (!found) return { text: "NOT_FOUND" };
    if (!call.results.some((result) => result.tool === "cite")) {
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: found.passage.id, quote: found.line }] },
          },
        ],
      };
    }
    const value = (found.line.split(": ")[1] ?? found.line).replace(/\.$/, "");
    const text = `${value} [^1]`;
    return hold && (!holdWhen || holdWhen(asked))
      ? { text, pause: { after: text.length, until: hold } }
      : { text };
  });
}

/** Resolves once the table's fill has ended. */
export const fillEnded = (core: Core, tableId: string) =>
  new Promise<void>((resolve) => {
    const stop = core.on("comparison.filling", (event) => {
      if (event.tableId === tableId && !event.filling) {
        stop();
        resolve();
      }
    });
  });

/** Asks for a comparison table and waits for it to fill. */
export async function compare(
  core: Core,
  client: MindClient,
  input: Parameters<Core["compareDocuments"]>[0],
) {
  const filling: CoreEvents["comparison.filling"][] = [];
  const stop = core.on("comparison.filling", (event) => filling.push(event));
  const result = await core.compareDocuments(input);
  if (!result.started) throw new Error(`The table wasn't made: ${JSON.stringify(result)}`);
  if (filling.at(-1)?.filling !== false) await fillEnded(core, result.tableId);
  stop();
  await client.settled();
  return result.tableId;
}

/** Two companies' reports whose lines are single figures, a day and a sentence: what an Excel export makes numbers of. */
export const ACME_REPORT = [
  "Acme annual report.",
  "Revenue: $1.2m.",
  "Operating result: (3,400).",
  "Gross margin: 12.5%.",
  "Year end: 31 March 2026.",
  "Auditor: Smith & Partners, appointed in 2019.",
].join("\n");
export const BRANDT_REPORT = [
  "Brandt Jahresbericht.",
  "Revenue: 1,2 Mio. €.",
  "Operating result: (1,250).",
  "Gross margin: 9.0%.",
  "Year end: 31 December 2025.",
  "Auditor: Keller AG.",
].join("\n");
export const REPORT_QUESTIONS = [
  "Revenue",
  "Operating result",
  "Gross margin",
  "Year end",
  "Auditor",
];

/** A Mind ("Tides") with the two reports compared by the five Questions, its table filled. */
export async function compareReports() {
  const setup = await setUpWithDocuments(cellModel(), [
    { name: "Acme.txt", contents: ACME_REPORT },
    { name: "Brandt.txt", contents: BRANDT_REPORT },
  ]);
  const { core, client, mind, documents } = setup;
  const tableId = await compare(core, client, {
    mindId: mind.id,
    documentIds: documents.map((document) => document.id),
    questions: REPORT_QUESTIONS,
  });
  return { ...setup, tableId };
}

/** Copies the table's first row until it has `rows` rows, for a table as long as no fill would make. */
export async function copyRows(client: MindClient, tableId: string, rows: number): Promise<void> {
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
    const row = table?.toArray().find((each) => each instanceof Y.XmlElement);
    if (!table || !(row instanceof Y.XmlElement) || row.nodeName !== COMPARISON_ROW_NODE) {
      throw new Error("No row to copy.");
    }
    table.push(Array.from({ length: rows - table.length }, () => row.clone()));
  });
  await client.settled();
}

/** The final workbook of #1798, its amounts in GBP thousands in a Unit column, beside a draft in GBP million. */
export const CEDAR_FINAL = "Cedar Q3 2026 final.xlsx";
const CEDAR_DRAFT = {
  name: "Cedar Q3 2026 draft.txt",
  contents: "Cedar Q3 2026 draft, superseded.\nAll amounts in GBP million.\nNet debt: 340.\n",
};

/**
 * A model that writes a net debt cell from the line it cites, as a careless one does: GBP
 * thousands as "310,000 GBP million", and the draft's 340 as "GBP 340 million". While `fixes()`
 * says so, being told the scale changed, it writes "GBP 310 million" instead.
 */
export function rescalingModel(fixes: () => boolean) {
  return scriptedModel((call) => {
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "net debt" } }] };
    }
    const found = lineFor(shownPassages(searches.at(-1)?.text ?? ""), "net debt");
    if (!found) return { text: "NOT_FOUND" };
    if (!call.results.some((result) => result.tool === "cite")) {
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: found.passage.id, quote: found.line }] },
          },
        ],
      };
    }
    if (!found.line.includes("thousands")) return { text: "GBP 340 million [^1]" };
    return {
      text:
        call.prompt.includes("Your cell writes") && fixes()
          ? "GBP 310 million [^1]"
          : "310,000 GBP million [^1]",
    };
  });
}

/** The final workbook and the draft compared by their net debt, by `model`, its table filled. */
export async function compareCedar(model: ReturnType<typeof rescalingModel>) {
  const book = await readFile(join(import.meta.dirname, "../fixtures/comparisons", CEDAR_FINAL));
  const setup = await setUpWithDocuments(model, [
    { name: CEDAR_FINAL, contents: new Uint8Array(book) },
    CEDAR_DRAFT,
  ]);
  const { core, client, mind, documents } = setup;
  const tableId = await compare(core, client, {
    mindId: mind.id,
    documentIds: documents.map((document) => document.id),
    questions: ["Net debt at Q3 2026, in GBP millions"],
  });
  return { ...setup, tableId };
}
