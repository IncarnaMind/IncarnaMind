import type { JSONContent } from "@tiptap/core";
import { updateYFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type CitationAttributes,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
} from "../../src/core";
import type { NodeJSON } from "../../src/core/answers/blocks";
import { markdownToBlocks } from "../../src/core/answers/markdown";
import { citationState } from "../../src/shared/citations";
import {
  answerEnded,
  askAndFinish,
  citationsIn,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerIn, editMind, note, question, readMind, writeMind } from "../helpers/minds";
import { promptOf } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

/** Two pages about tides. */
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  {
    lines: [
      "Spring and neap tides",
      "Spring tides happen at new moon and at full moon.",
      "Neap tides happen when the Moon is at its first or last quarter.",
    ],
  },
]);
const SPRING = "Spring tides happen at new moon and at full moon.";
const NEAP = "Neap tides happen when the Moon is at its first or last quarter.";

const first = (passages: ShownPassage[]) => {
  const passage = passages[0];
  if (!passage) throw new Error("The search showed no Passages.");
  return passage;
};

/** A model that cites page 2 twice, then writes its Answer as a table with a marker in each body row. */
const tableModel = (answer: string) =>
  citingModel({
    query: "spring and neap tides",
    records: (passages) => [
      { marker: 1, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: SPRING },
      { marker: 2, passage: first(passages).id, pageFrom: 2, pageTo: 2, quote: NEAP },
    ],
    answer,
  });

const TABLE_ANSWER = [
  "They differ by the Moon's phase:",
  "| Tide | When | Range |",
  "|:-----|:-----|------:|",
  "| Spring | At new and full moon [^1] | **Largest** |",
  "| Neap | At the quarters [^2] | Smallest <br> of the month |",
  "",
  "So check the phase first.",
].join("\n");

/** Each row's cells' text, a heading cell marked "#", and a Citation as [n: its check]. */
function rowsOf(table: JSONContent): string[][] {
  let cited = 0;
  const text = (node: JSONContent): string => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "citation") return `[${++cited}: ${node.attrs?.check}]`;
    return (node.content ?? []).map(text).join(node.type === "paragraph" ? "" : " / ");
  };
  return (table.content ?? []).map((row) =>
    (row.content ?? []).map(
      (cell) =>
        `${cell.type === "tableHeader" ? "#" : ""}${(cell.content ?? []).map(text).join(" / ")}`,
    ),
  );
}

/** The first table in the Mind, as JSON. */
function tableIn(client: MindClient): JSONContent {
  let found: JSONContent | null = null;
  readMind(client).descendants((node) => {
    if (!found && node.type.name === "table") found = node.toJSON() as JSONContent;
    return !found;
  });
  if (!found) throw new Error("No table in the Mind.");
  return found;
}

/** A Citation of the Document's page 2, as the core writes one into an Answer. */
const citation = (attrs: Partial<CitationAttributes>): JSONContent => ({
  type: "citation",
  attrs: { passageId: "p", documentName: "Tides", pageFrom: 2, pageTo: 2, ...attrs },
});

const cell = (type: "tableHeader" | "tableCell", ...content: JSONContent[]): JSONContent => ({
  type,
  attrs: { colspan: 1, rowspan: 1 },
  content: [{ type: "paragraph", content }],
});

const text = (value: string): JSONContent => ({ type: "text", text: value });

describe("an Answer that writes a Markdown table", { timeout: 30_000 }, () => {
  test("gets a table, its markers Citations in their cells, checked and found", async () => {
    const model = tableModel(TABLE_ANSWER);
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);

    const { answerId, finished } = await askAndFinish(core, client, mind.id, "Spring or neap?");

    const blocks: string[] = [];
    answerIn(client, answerId).forEach((block) => {
      blocks.push(block.type.name);
    });
    expect(blocks).toEqual(["paragraph", "table", "paragraph"]);
    expect(rowsOf(tableIn(client))).toEqual([
      ["#Tide", "#When", "#Range"],
      ["Spring", "At new and full moon [1: found]", "Largest"],
      ["Neap", "At the quarters [2: found]", "Smallest\nof the month"],
    ]);
    // Each column keeps its alignment, cell by cell.
    const aligns = (tableIn(client).content ?? []).map((row) =>
      (row.content ?? []).map((each) => each.attrs?.align ?? null),
    );
    expect(aligns).toEqual(Array(3).fill(["left", "left", "right"]));
    expect(citationsIn(client, answerId).map((each) => [each.quote, each.check])).toEqual([
      [SPRING, "found"],
      [NEAP, "found"],
    ]);
    expect(finished).toMatchObject({ status: "done", droppedMarkers: 0, droppedRecords: 0 });
    expect(finished.citations).toHaveLength(2);
  });

  test("the editor reads the table as valid Blocks and has nothing to rewrite, and a later Question sees it as a pipe table", async () => {
    const model = tableModel(TABLE_ANSWER);
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    await askAndFinish(core, client, mind.id, "Spring or neap?");

    // readMind checks the document against the editor's schema.
    const reader = await connectToMind(core, mind.id);
    readMind(reader);
    let rewritten = false;
    reader.blocks.observeDeep(() => {
      rewritten = true;
    });
    reader.doc.transact(() =>
      updateYFragment(reader.doc, reader.blocks, readMind(reader), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
    expect(rewritten).toBe(false);

    const calls = model.doStreamCalls.length;
    const asked = question("Which is larger?");
    editMind(client, (blocks) => [...blocks, asked]);
    await client.settled();
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error("The Question wasn't asked.");
    await answerEnded(core, result.answerId);
    const context = promptOf(model, calls)
      .map((message) => message.text)
      .join("\n\n");
    expect(context).toContain(
      [
        "| Tide | When | Range |",
        "| --- | --- | --- |",
        "| Spring | At new and full moon [Tides, p. 2 · C1] | **Largest** |",
        "| Neap | At the quarters [Tides, p. 2 · C2] | Smallest<br>of the month |",
      ].join("\n"),
    );
  });

  test("while it streams, no pipes ever show as text, and the table only grows", async () => {
    const seen: NodeJSON[][] = [];
    for (let cut = 0; cut <= TABLE_ANSWER.length; cut++) {
      seen.push(markdownToBlocks(TABLE_ANSWER.slice(0, cut), { streaming: true }));
    }
    const final = markdownToBlocks(TABLE_ANSWER);
    const textOf = (node: NodeJSON): string =>
      node.text ?? (node.content ?? []).map(textOf).join("");
    let rows = 0;
    for (const blocks of seen) {
      for (const block of blocks) {
        if (block.type === "paragraph") expect(textOf(block)).not.toContain("|");
        if (block.type !== "table") continue;
        const count = block.content?.length ?? 0;
        expect(count).toBeGreaterThanOrEqual(rows);
        rows = count;
        // Its heading row is whole from the start.
        expect(block.content?.[0]).toEqual(final[1]?.content?.[0]);
      }
    }
    expect(rows).toBe(3);
  });
});

describe("reading Markdown tables", () => {
  const rows = (markdown: string) => {
    const table = markdownToBlocks(markdown).find((block) => block.type === "table");
    return table ? rowsOf(table as JSONContent) : null;
  };

  // protects=a ragged row loses nothing: an extra cell's text stays, in the row's last cell (#961); fails_when=it is dropped with its words; no_claim=none beyond protects.
  test("escaped pipes and pipes in code stay in their cell; missing cells are empty and extra ones kept in the last", () => {
    expect(
      rows(
        ["a | b", "--|--", "1 \\| 2 | `x|y`", "| only one |", "| three | cells | here |"].join(
          "\n",
        ),
      ),
    ).toEqual([
      ["#a", "#b"],
      ["1 | 2", "x|y"],
      ["only one", ""],
      ["three", "cells | here"],
    ]);
  });

  test("a table can follow a paragraph's line, and ends at a blank line or a line without a pipe", () => {
    const blocks = markdownToBlocks(
      ["Here:", "| a |", "| - |", "| 1 |", "After, with no pipe."].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
  });

  test("pipes without a delimiter row, or with one of another width, are text", () => {
    expect(rows("| a | b |\n| c | d |")).toBeNull();
    expect(rows("| a | b |\n| --- |")).toBeNull();
    expect(rows("a | b\n---")).toBeNull();
  });
});

describe("a table in a Mind", { timeout: 30_000 }, () => {
  test("keeps its cells and their Citations through sync to another window, edits made apart, and a restart, still found", async () => {
    const { core, client, mind, documents, dataDir } = await setUpWithDocuments(tableModel(""), [
      { name: "Tides.pdf", contents: TIDES },
    ]);
    const tides = documents[0];
    if (!tides) throw new Error("No Document.");
    const found = citation({
      documentId: tides.id,
      contentHash: tides.contentHash,
      quote: SPRING,
      check: "found",
    });
    writeMind(client, [
      note("Tides by phase."),
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [cell("tableHeader", text("Tide")), cell("tableHeader", text("When"))],
          },
          {
            type: "tableRow",
            content: [
              cell("tableCell", text("Spring")),
              cell("tableCell", text("New and full moon "), found),
            ],
          },
        ],
      },
    ]);
    await client.settled();
    const written = rowsOf(tableIn(client));
    expect(written).toEqual([
      ["#Tide", "#When"],
      ["Spring", "New and full moon [1: found]"],
    ]);

    // Another window has the same table, and the same Citation in its cell.
    const other = await connectToMind(core, mind.id);
    expect(rowsOf(tableIn(other))).toEqual(written);
    const cited = (window: MindClient) => {
      const all: CitationAttributes[] = [];
      readMind(window).descendants((node) => {
        if (node.type.name === "citation") all.push(node.attrs as CitationAttributes);
      });
      return all;
    };
    expect(cited(other)).toEqual(cited(client));

    // Both windows edit a cell while apart; once together, both edits are there.
    client.goOffline();
    other.goOffline();
    const editCell = (window: MindClient, row: number, column: number, add: string) => {
      const table = window.blocks.get(1) as Y.XmlElement;
      const target = (table.get(row) as Y.XmlElement).get(column) as Y.XmlElement;
      const words = (target.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      window.doc.transact(() => words.insert(words.length, add));
    };
    editCell(client, 1, 0, " tide");
    editCell(other, 0, 1, " (phase)");
    await client.goOnline();
    await other.goOnline();
    const merged = [
      ["#Tide", "#When (phase)"],
      ["Spring tide", "New and full moon [1: found]"],
    ];
    expect(rowsOf(tableIn(client))).toEqual(merged);
    expect(rowsOf(tableIn(other))).toEqual(merged);

    // After a restart: the table, and a Citation that still checks as found against its Document.
    core.close();
    const restarted = startCore(dataDir);
    const reader = await connectToMind(restarted, mind.id);
    expect(rowsOf(tableIn(reader))).toEqual(merged);
    const [kept] = cited(reader);
    if (!kept) throw new Error("The Citation is gone.");
    expect(citationState(kept, await restarted.listDocuments()).check).toBe("found");
    expect(await restarted.previewMindExport(mind.id, { format: "markdown" })).toMatchObject({
      citations: 1,
      unverifiedCitations: 0,
    });
  });

  test("a Mind written with a table records the content schema version (2 since tables); one written before opens as it was", async () => {
    // Tables came in with version 2; footnotes (#284) and Proposals (#93) raised it again.
    expect(CONTENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    const { core, client, mind } = await setUpWithDocuments(tableModel(""), []);
    const old = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Written by version 1")]);
    old.getXmlFragment(MIND_CONTENT_FIELD).push([paragraph]);
    old.getMap(MIND_SETTINGS_FIELD).set(CONTENT_SCHEMA_VERSION_KEY, 1);
    await core.applyMindUpdate(mind.id, Y.encodeStateAsUpdate(old));
    await client.settled();

    // A version 1 Mind is newer content as it is: it opens to edit, and nothing in it changes.
    const opened = await core.openMind(mind.id);
    expect(opened.access).toBe("edit");
    const stored = new Y.Doc();
    Y.applyUpdate(stored, opened.state);
    expect(stored.getXmlFragment(MIND_CONTENT_FIELD).toString()).toContain("Written by version 1");

    writeMind(client, [
      note("Written by version 1"),
      {
        type: "table",
        content: [{ type: "tableRow", content: [cell("tableHeader", text("A table"))] }],
      },
      question("And now?"),
    ]);
    await client.settled();
    const after = new Y.Doc();
    Y.applyUpdate(after, (await core.openMind(mind.id)).state);
    expect(after.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
      CONTENT_SCHEMA_VERSION,
    );
    expect(rowsOf(tableIn(client))).toEqual([["#A table"]]);
  });
});
