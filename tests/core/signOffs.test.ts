import { expect, test } from "vitest";
import * as Y from "yjs";
import { citationSentences } from "../../src/core/answers/checks/sentences";
import { type CalculatedFigure, CITATION_NODE } from "../../src/core/api";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { FORMULA_VERSION } from "../../src/shared/formula";
import {
  addSignOff,
  citationElementId,
  citationSignOffBasis,
  figureSignOffBasis,
  signOffsOf,
} from "../../src/shared/signOffs";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";

/*
 * The User's own "Checked by me" through the core (#1933): a figure's mark rests on what it was
 * checked against, the version kept as the Note was sent is the one the file holds, and a
 * restore never changes the marks. In English and Chinese.
 */

for (const language of ["en", "zh-CN"] as const) {
  // protects=a calculated figure's mark shows as changed once the words of its sentence change, though its own result is the same; fails_when=it still reads checked; no_claim=its inputs' versions, which signOffs.test covers.
  test(`a calculated figure's mark changes with the sentence ${language}`, async () => {
    const marked = await markedCalculation(language, calculation(language));
    await marked.write(language === "en" ? "Costs were " : "支出为 ", calculation(language));
    expect(await marked.state()).toBe("changed");
  });

  // protects=a calculated figure's mark rests on its input as bound, not only as printed: the same quote "1,250" read another way (1.25, not 1,250) changes it, though x − x still shows 0 (#1933); fails_when=it still reads checked; no_claim=how the reading is chosen.
  test(`a calculated figure's mark changes when its input is read another way ${language}`, async () => {
    const read = (value: number, reading: number, decimals: number) =>
      calculation(language, {
        formula: "x - x",
        value: 0,
        shown: "0",
        number: { chars: "1,250", value, reading, decimals },
      });
    const marked = await markedCalculation(language, read(1250, 1, 0));
    await marked.write(marked.words, read(1250, 1, 0));
    expect(await marked.state()).toBe("checked");
    await marked.write(marked.words, read(1.25, 2, 2));
    expect(await marked.state()).toBe("changed");
  });

  // protects=a figure an Analysis gives rests on the result it is bound to: the same atom bound from revenue to costs in the same kept run, both 10, changes its mark (#1933); fails_when=it still reads checked; no_claim=whether the Analysis is still valid.
  test(`a calculated figure's mark changes when it gives another Analysis result ${language}`, async () => {
    const bound = (result: string) => ({
      ...calculation(language),
      formula: "",
      inputs: [],
      analysis: { analysis: 1, result },
    });
    const marked = await markedCalculation(language, bound("revenue"), "run-1");
    await marked.write(marked.words, bound("revenue"), "run-1");
    expect(await marked.state()).toBe("checked");
    await marked.write(marked.words, bound("costs"), "run-1");
    expect(await marked.state()).toBe("changed");
  });

  // protects=a table cell's mark shows as changed once its row's label changes, as the row is what it was checked against; fails_when=it still reads checked; no_claim=another table's cells.
  test(`a table cell's mark changes with its row label ${language}`, async () => {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language, personId: "person-1" } });
    const mind = await core.createMind({ title: "Table" });
    const client = await connectToMind(core, mind.id);
    const cell = (id: string, text: string, header = false) => ({
      type: header ? "tableHeader" : "tableCell",
      content: [{ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] }],
    });
    const write = (label: string) =>
      writeMind(client, [
        {
          type: "table",
          attrs: { id: "t1" },
          content: [
            {
              type: "tableRow",
              content: [cell("corner", "Item", true), cell("column", "Amount", true)],
            },
            { type: "tableRow", content: [cell("label", label), cell("value", "100")] },
          ],
        },
      ]);
    write(language === "en" ? "Revenue" : "营业收入");
    await client.settled();
    const row = (await core.getFigureSchedule(mind.id)).rows.find((r) => r.reading.chars === "100");
    if (!row) throw new Error("Missing table value");
    addSignOff(client.doc, {
      id: "mark-1",
      target: { kind: "figure", id: row.id },
      at: "2026-10-28T09:00:00.000Z",
      contentHash: figureSignOffBasis(row),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();
    expect(
      (await core.getFigureSchedule(mind.id)).rows.find((r) => r.reading.chars === "100")?.signOff
        ?.state,
    ).toBe("checked");
    write(language === "en" ? "Costs" : "支出");
    await client.settled();
    const changed = (await core.getFigureSchedule(mind.id)).rows.find(
      (r) => r.reading.chars === "100",
    );
    expect(changed?.signOff?.state).toBe("changed");
  });

  // protects=the version History keeps as the Note was sent is the text the file holds, even when the User writes while the PDF is made; fails_when=it holds the later text; no_claim=the PDF's look.
  test(`the sent PDF version is the content printed, even after an edit ${language}`, async () => {
    let entered: (() => void) | undefined;
    const printing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let printed = "";
    const core = startCore(await createTempDataFolder(), {
      printer: {
        print: async (document) => {
          printed = document.body;
          entered?.();
          await released;
          return new TextEncoder().encode("%PDF-review-fixture");
        },
      },
    });
    await core.updateSettings({ user: { language } });
    await core.setOutputLocation(await createTempDataFolder());
    const mind = await core.createMind({ title: "Sent content" });
    const client = await connectToMind(core, mind.id);
    const original = language === "en" ? "Approved revenue is ten." : "已批准收入为十。";
    const later = language === "en" ? "Unreviewed costs are twenty." : "尚未核对支出为二十。";
    writeMind(client, [note(original)]);
    await client.settled();
    const sending = core.saveMindExport(mind.id, { format: "pdf" });
    try {
      await printing;
      expect(printed).toContain(original);
      expect(printed).not.toContain(later);
      writeMind(client, [note(later)]);
      await client.settled();
    } finally {
      release?.();
    }
    expect((await sending).status).toBe("saved");
    const sent = (await core.listCheckpoints(mind.id)).checkpoints.find(
      (c) => c.reason === "export",
    );
    if (!sent) throw new Error("No sent checkpoint");
    await core.restoreCheckpoint(mind.id, sent.id);
    await client.settled();
    expect(readMind(client).textContent).toContain(original);
    expect(readMind(client).textContent).not.toContain(later);
  });

  // protects=restoring a version kept before a Citation was marked never changes the mark: the Citation comes back with the id the mark names, whether it is unchanged, its quote was edited, it was deleted or its paragraph was (#1933); fails_when=the restored Citation has another id or none; no_claim=whether the mark then reads checked or changed.
  test.each(["unchanged", "quote edited", "Citation deleted", "paragraph deleted"] as const)(
    `restoring a version from before the mark keeps it on its Citation: %s ${language}`,
    async (since) => {
      const { core, client, mind, attributes, words } = await citedNote(language);
      const beforeMark = await core.saveCheckpoint(mind.id, "accept");
      const id = markCitation(client);
      addSignOff(client.doc, {
        id: "mark-1",
        target: { kind: "citation", id },
        at: "2026-10-28T09:00:00.000Z",
        contentHash: citationSignOffBasis(`${words}\uFFFC.`, attributes),
        deletedAt: null,
        name: "Ada",
        personId: "person-1",
      });
      if (since === "quote edited") citationIn(client).setAttribute("quote", "Tides fall.");
      if (since === "Citation deleted") {
        const citation = citationIn(client);
        const paragraph = citation.parent;
        if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph");
        paragraph.delete(paragraph.toArray().indexOf(citation), 1);
      }
      if (since === "paragraph deleted")
        writeMind(client, [note(language === "en" ? "Later." : "后来。")]);
      await client.settled();

      await core.restoreCheckpoint(mind.id, beforeMark.id);
      await client.settled();

      expect(signOffsOf(client.doc).map((record) => record.target.id)).toEqual([id]);
      expect(citationIn(client).getAttribute("id")).toBe(id);
      expect(citationSentences(client.blocks).has(id)).toBe(true);
    },
  );
}

function calculation(
  language: "en" | "zh-CN",
  change: {
    formula?: string;
    value?: number;
    shown?: string;
    number?: { chars: string; value: number; reading: number | null; decimals: number };
  } = {},
): CalculatedFigure {
  const number = change.number ?? { chars: "10", value: 10, reading: null, decimals: 0 };
  return {
    label: "value",
    formula: change.formula ?? "x",
    inputs: [
      {
        name: "x",
        label: "value",
        citation: {
          passageId: "passage-1",
          documentId: "document-1",
          documentName: "Values",
          contentHash: "v1",
          pageFrom: 1,
          pageTo: 1,
          location: { kind: "page", from: 1, to: 1 },
          quote: number.chars,
          check: "found",
          checkReason: null,
        },
        number: {
          chars: number.chars,
          at: 0,
          value: number.value,
          scale: 1,
          scaleWord: null,
          unit: { kind: "plain" },
          decimals: number.decimals,
          approximate: false,
          reading: number.reading,
        },
        cell: null,
        unitStatement: null,
      },
    ],
    value: change.value ?? 10,
    unit: { kind: "plain" },
    approximate: false,
    shown: change.shown ?? "10",
    show: { language, as: "number", decimals: 0, scale: null },
    literals: [],
    engine: FORMULA_VERSION,
    written: null,
  };
}

/** A Note with one calculated figure in a sentence, marked Checked by me as the schedule shows it. */
async function markedCalculation(
  language: "en" | "zh-CN",
  figure: CalculatedFigure,
  analysisId: string | null = null,
) {
  const core = startCore(await createTempDataFolder());
  await core.updateSettings({ user: { language, personId: "person-1" } });
  const mind = await core.createMind({ title: "Review fixture" });
  const client = await connectToMind(core, mind.id);
  const words = language === "en" ? "Revenue was " : "营业收入为 ";
  const write = async (text: string, shown: CalculatedFigure, run: string | null = null) => {
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text },
          calculatedFigureNode(shown, "atom-1", run),
          { type: "text", text: "." },
        ],
      },
    ]);
    await client.settled();
  };
  const row = async () =>
    (await core.getFigureSchedule(mind.id)).rows.find((r) => r.id === "atom-1");
  await write(words, figure, analysisId);
  const marked = await row();
  if (!marked) throw new Error("Missing calculated figure");
  addSignOff(client.doc, {
    id: "mark-1",
    target: { kind: "figure", id: marked.id },
    at: "2026-10-28T09:00:00.000Z",
    contentHash: figureSignOffBasis(marked),
    deletedAt: null,
    name: "Ada",
    personId: "person-1",
  });
  await client.settled();
  expect((await row())?.signOff?.state).toBe("checked");
  return { words, write, state: async () => (await row())?.signOff?.state };
}

async function citedNote(language: "en" | "zh-CN") {
  const core = startCore(await createTempDataFolder());
  const mind = await core.createMind({ title: "Restore evidence" });
  const client = await connectToMind(core, mind.id);
  const words = language === "en" ? "The sea rises" : "海平面上升";
  const attributes = {
    passageId: "passage-1",
    documentId: "document-1",
    documentName: "Tides",
    contentHash: "v1",
    pageFrom: 1,
    pageTo: 1,
    quote: "Tides rise.",
    check: "found",
  };
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [
        { type: "text", text: words },
        { type: "citation", attrs: attributes },
        { type: "text", text: "." },
      ],
    },
  ]);
  await client.settled();
  return { core, client, mind, attributes, words };
}

/** Gives the Citation the id the editor gives one it marks first, as the mark's step does. */
function markCitation(client: { blocks: Y.XmlFragment }): string {
  const citation = citationIn(client);
  const id = citationElementId(citation);
  if (!id) throw new Error("The Citation isn't in the Note");
  citation.setAttribute("id", id);
  return id;
}

function citationIn(client: { blocks: Y.XmlFragment }): Y.XmlElement {
  for (const block of client.blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    for (const node of block.createTreeWalker((each) => each instanceof Y.XmlElement))
      if (node instanceof Y.XmlElement && node.nodeName === CITATION_NODE) return node;
  }
  throw new Error("No Citation in the Note");
}

// protects=when History can't keep the Note as it was sent, the file is still saved and the result says so, so the User learns it where it happened (#1933); fails_when=the save reports nothing wrong; no_claim=why storage refused.
test("a sent version History couldn't keep is said with the saved file", async () => {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  await core.setOutputLocation(await createTempDataFolder());
  const mind = await core.createMind({ title: "Sent content" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note("Approved revenue is ten.")]);
  await client.settled();
  queryDatabase(
    dataDir,
    `CREATE TRIGGER refuse_sent BEFORE INSERT ON mind_checkpoints WHEN NEW.reason = 'export'
     BEGIN SELECT RAISE(ABORT, 'storage refused the write'); END`,
  );

  const sent = await core.saveMindExport(mind.id, { format: "docx" });

  expect(sent).toMatchObject({ status: "saved", sentKept: false });
  expect((await core.listCheckpoints(mind.id)).checkpoints).toEqual([]);
});
