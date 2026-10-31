import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { citationSentences } from "../../src/core/answers/checks/sentences";
import { type CalculatedFigure, CITATION_NODE, type Document } from "../../src/core/api";
import { calculatedFigureNode } from "../../src/shared/calculatedFigures";
import { pendingPart } from "../../src/shared/claimParts";
import { formatDate } from "../../src/shared/dates";
import { FORMULA_VERSION } from "../../src/shared/formula";
import { translate } from "../../src/shared/i18n";
import {
  addSignOff,
  citationElementId,
  citationSignOffBasis,
  figureSignOffBasis,
  signOffsOf,
} from "../../src/shared/signOffs";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { parseCsv } from "../helpers/csv";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { footnotesOf, paragraphsOf, part, textOf as textOfDocx, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

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

  // protects=a restore to a version without a Citation the User checked says how many it leaves out, the check record keeps a row for the mark as "Not in this Note now" with who checked it and when, and a later restore that brings the Citation back brings its mark back (#1933), in English and Chinese; fails_when=the count is missing, the row goes, or the mark stays off the Citation that came back; no_claim=History's line itself, which the smoke spec covers.
  test(`a restore counts a checked Citation it leaves out, the record keeps its row, and a later restore brings the mark back ${language}`, async () => {
    const out = await createTempDataFolder();
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language, personId: "person-1" } });
    await core.setOutputLocation(out);
    const mind = await core.createMind({ title: "Gone" });
    const client = await connectToMind(core, mind.id);
    const words = language === "en" ? "The sea rises" : "海平面上升";
    writeMind(client, [note(words)]);
    await client.settled();
    const without = await core.saveCheckpoint(mind.id, "accept");
    const attributes = {
      passageId: "passage-1",
      documentId: "document-1",
      documentName: "Tides",
      contentHash: "v1",
      quote: "Tides rise.",
      check: "found",
    };
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text: words },
          { type: "citation", attrs: { ...attributes, id: "c1" } },
          { type: "text", text: "." },
        ],
      },
    ]);
    addSignOff(client.doc, {
      id: "mark-1",
      target: { kind: "citation", id: "c1" },
      at: "2026-10-28T09:00:00.000Z",
      contentHash: citationSignOffBasis(`${words}\uFFFC.`, attributes),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();

    const restored = await core.restoreCheckpoint(mind.id, without.id);
    await client.settled();
    expect(restored.checkedLeftOut).toBe(1);

    const saved = await core.saveCheckRecord(mind.id);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = readFileSync(
      join(out, `${saved.file.name.replace(/\.(pdf|csv)$/, "")}.csv`),
      "utf8",
    );
    const gone = parseCsv(csv).find((row) =>
      row.includes(translate(language, "checkRecord.notInNote")),
    );
    expect(gone?.some((cell) => cell.startsWith("Ada · "))).toBe(true);

    expect((await core.restoreCheckpoint(mind.id, restored.before.id)).checkedLeftOut).toBe(0);
    await client.settled();
    expect(citationSentences(client.blocks).has("c1")).toBe(true);
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

// protects=an export says each person's check under the source it is on, never for the whole document: Numbered in the Word file's and the PDF's footnotes, a Numbered list and a shared page's notes; a note style (Chicago notes) in each note; APA, IEEE and GB/T 7714 under each Document's reference. A mark made before its Citation changed reads "before it changed", never as checked, and the check record names the person on each row (#1933), in English and Chinese; fails_when=a source lacks its line, the changed one reads as checked, or a line speaks for the document; no_claim=how each style words its own entries.
test.each(["en", "zh-CN"] as const)(
  "an export says each check under its own source (%s)",
  async (language) => {
    const { printed, printer } = fakePrinter();
    const core = startCore(await createTempDataFolder(), { printer });
    await core.updateSettings({ user: { language, personId: "person-1" } });
    const sources = await createTempDataFolder();
    const [tides, harbours] = await addAndProcess(core, [
      await writeSourceFile(sources, "Tides.txt", "Tides rise twice a day."),
      await writeSourceFile(sources, "Harbours.txt", "Harbours fill at high water."),
    ]);
    if (!tides || !harbours) throw new Error("The Documents weren't added.");
    const mind = await core.createMind({ title: "Checked sources" });
    const client = await connectToMind(core, mind.id);
    const cited = (id: string, document: Document, quote: string) => ({
      type: "citation",
      attrs: {
        passageId: `passage-${id}`,
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        pageFrom: null,
        pageTo: null,
        quote,
        check: "found",
        id,
      },
    });
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text: language === "en" ? "The sea rises" : "海平面上升" },
          cited("c1", tides, "Tides rise twice a day."),
          { type: "text", text: language === "en" ? ". Harbours fill" : "。港口满了" },
          cited("c2", harbours, "Harbours fill at high water."),
          { type: "text", text: "." },
        ],
      },
    ]);
    await client.settled();
    const sentences = citationSentences(client.blocks);
    const at = "2026-10-28T09:00:00.000Z";
    for (const [id, document, quote, changed] of [
      ["c1", tides, "Tides rise twice a day.", false],
      ["c2", harbours, "Harbours fill at high water.", true],
    ] as const) {
      addSignOff(client.doc, {
        id: `mark-${id}`,
        target: { kind: "citation", id },
        at,
        contentHash: changed
          ? "checked-before-it-changed"
          : citationSignOffBasis(sentences.get(id)?.sentence ?? "", {
              documentId: document.id,
              contentHash: document.contentHash,
              quote,
            }),
        deletedAt: null,
        name: "Ada",
        personId: "person-1",
      });
    }
    await client.settled();
    const date = formatDate(at, language);
    const checked = translate(language, "export.checkedBy", { name: "Ada", date });
    const changed = translate(language, "export.checkedBy.changed", { name: "Ada", date });
    const count = (text: string, part: string) => text.split(part).length - 1;
    // Each source's own line, and the person named nowhere else: no line for the whole document.
    const says = (text: string, style: string) => {
      expect(count(text, checked), style).toBe(1);
      expect(count(text, changed), style).toBe(1);
      expect(count(text, "Ada"), style).toBe(2);
    };
    const pdf = () => `${printed.at(-1)?.body ?? ""}${printed.at(-1)?.notes.join("") ?? ""}`;

    for (const style of ["numbered", "apa", "chicago-notes", "ieee", "gb-t-7714-2015-numeric"]) {
      await core.setMindCitationStyle(mind.id, style);
      const word = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
      says(
        `${textOfDocx(part(word, "word/document.xml"))}${Object.values(footnotesOf(part(word, "word/footnotes.xml"))).join("")}`,
        `${style} docx`,
      );
      await core.exportMind(mind.id, { format: "pdf" });
      says(pdf(), `${style} pdf`);
    }
    await core.setMindCitationStyle(mind.id, null);
    await core.exportMind(mind.id, { format: "pdf", citationPlace: "list" });
    says(pdf(), "numbered list");
    const page = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "share-page", citationCards: false })).data,
    );
    says(page, "share page");

    // The check record names the person on each row, the changed one as changed since.
    const out = await createTempDataFolder();
    await core.setOutputLocation(out);
    const saved = await core.saveCheckRecord(mind.id);
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    const csv = readFileSync(
      join(out, `${saved.file.name.replace(/\.(pdf|csv)$/, "")}.csv`),
      "utf8",
    );
    const time = (row: string[]) => row.find((cell) => cell.startsWith("Ada · ")) ?? "";
    const rows = parseCsv(csv).filter((row) => time(row) !== "");
    expect(rows).toHaveLength(2);
    const since =
      translate(language, "checkRecord.person.changed", { name: "\u0000", time: "\u0000" })
        .split("\u0000")
        .at(-1) ?? "";
    expect(rows.filter((row) => time(row).endsWith(since))).toHaveLength(1);
  },
);

// protects=a Document that leaves the Library keeps its source's check line in APA, IEEE and GB/T 7714: the line is the cited work's own record, never a live Document's (#1933), in English and Chinese; fails_when=the removed Document's reference loses its line or the line speaks for the whole document; no_claim=how each style words its own entries.
test.each(["en", "zh-CN"] as const)(
  "a check stays under its source after its Document leaves the Library (%s)",
  async (language) => {
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language, personId: "person-1" } });
    const sources = await createTempDataFolder();
    const [gone, live] = await addAndProcess(core, [
      await writeSourceFile(sources, "Gone.txt", "The old harbour filled at high water."),
      await writeSourceFile(sources, "Live.txt", "The new harbour fills at high water."),
    ]);
    if (!gone || !live) throw new Error("The Documents weren't added.");
    const mind = await core.createMind({ title: "A source that left" });
    const client = await connectToMind(core, mind.id);
    const cited = (id: string, document: Document, quote: string) => ({
      type: "citation",
      attrs: {
        passageId: `passage-${id}`,
        documentId: document.id,
        documentName: document.name,
        contentHash: document.contentHash,
        pageFrom: null,
        pageTo: null,
        quote,
        check: "found",
        id,
      },
    });
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text: language === "en" ? "The harbour fills" : "港口满了" },
          cited("c-gone", gone, "The old harbour filled at high water."),
          { type: "text", text: language === "en" ? ", and again" : "，又一次" },
          cited("c-live", live, "The new harbour fills at high water."),
          { type: "text", text: "." },
        ],
      },
    ]);
    await client.settled();
    const sentences = citationSentences(client.blocks);
    const at = "2026-10-28T09:00:00.000Z";
    addSignOff(client.doc, {
      id: "mark-gone",
      target: { kind: "citation", id: "c-gone" },
      at,
      contentHash: citationSignOffBasis(sentences.get("c-gone")?.sentence ?? "", {
        documentId: gone.id,
        contentHash: gone.contentHash,
        quote: "The old harbour filled at high water.",
      }),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    addSignOff(client.doc, {
      id: "mark-live",
      target: { kind: "citation", id: "c-live" },
      at,
      contentHash: "checked-before-it-changed",
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();
    await core.deleteDocument(gone.id);
    await client.settled();

    const date = formatDate(at, language);
    const checked = translate(language, "export.checkedBy", { name: "Ada", date });
    const changed = translate(language, "export.checkedBy.changed", { name: "Ada", date });
    const count = (text: string, part: string) => text.split(part).length - 1;
    for (const style of ["apa", "ieee", "gb-t-7714-2015-numeric"]) {
      await core.setMindCitationStyle(mind.id, style);
      const word = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
      const text = `${textOfDocx(part(word, "word/document.xml"))}${Object.values(footnotesOf(part(word, "word/footnotes.xml"))).join("")}`;
      expect(count(text, checked), style).toBe(1);
      expect(count(text, changed), style).toBe(1);
      // Each line sits in the entry of the source it is for, the gone one checked and the live
      // one changed, never the other's or outside an entry.
      const entries = paragraphsOf(part(word, "word/document.xml")).map((each) => each.text);
      const goneEntry = entries.find((each) => each.includes(checked)) ?? "";
      const liveEntry = entries.find((each) => each.includes(changed)) ?? "";
      expect(goneEntry, style).toContain(gone.name);
      expect(goneEntry, style).not.toContain(live.name);
      expect(liveEntry, style).toContain(live.name);
      expect(liveEntry, style).not.toContain(gone.name);
    }
  },
);

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

for (const language of ["en", "zh-CN"] as const) {
  test(`a part Citation keeps its independent human record through reload, word changes and restore (${language})`, async () => {
    const out = await createTempDataFolder();
    const core = startCore(await createTempDataFolder());
    await core.updateSettings({ user: { language, personId: "person-1" } });
    await core.setOutputLocation(out);
    const mind = await core.createMind({ title: "Part receipts" });
    const client = await connectToMind(core, mind.id);
    const words = language === "en" ? "Revenue rose." : "收入增长。";
    const receipt = {
      id: "part-citation",
      passageId: "p",
      documentId: "source",
      documentName: "Results",
      contentHash: "v1",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: "Revenue rose.",
      check: "found",
      checkReason: null,
    };
    const attrs = {
      id: "check",
      request: "request",
      action: "check-against-documents",
      state: "supported",
      text: words,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-28T09:00:00.000Z",
      parts: [
        {
          ...pendingPart({ span: { start: 0, end: words.length }, kind: "fact" }),
          verdict: "supported",
          evidence: [receipt],
        },
      ],
    };
    const write = (text: string) =>
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text, marks: [{ type: "claimCheck", attrs }] }],
        },
      ]);
    write(words);
    addSignOff(client.doc, {
      id: "human",
      target: { kind: "citation", id: receipt.id },
      at: "2026-10-28T09:00:00.000Z",
      contentHash: citationSignOffBasis(words, receipt),
      deletedAt: null,
      name: "Ada",
      personId: "person-1",
    });
    await client.settled();
    const kept = await core.saveCheckpoint(mind.id, "accept");
    const csv = async () => {
      const saved = await core.saveCheckRecord(mind.id);
      if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
      return readFileSync(join(out, saved.file.name.replace(/\.(pdf|csv)$/, ".csv")), "utf8");
    };
    const initial = await csv();
    expect(
      parseCsv(initial).filter((row) => row.some((cell) => cell.startsWith("Ada · "))),
    ).toHaveLength(1);
    expect(initial).not.toContain(translate(language, "checkRecord.notInNote"));
    const reopened = await connectToMind(core, mind.id);
    expect(citationSentences(reopened.blocks).has(receipt.id)).toBe(true);
    write(`Updated ${words}`);
    await client.settled();
    expect(await csv()).toContain(
      translate(language, "checkRecord.person.changed", {
        name: "Ada",
        time: "2026-10-28T09:00:00.000Z",
      }),
    );
    writeMind(client, [note("Removed.")]);
    await client.settled();
    expect(await csv()).toContain(translate(language, "checkRecord.notInNote"));
    expect((await core.restoreCheckpoint(mind.id, kept.id)).checkedLeftOut).toBe(0);
    await client.settled();
    expect(citationSentences(client.blocks).has(receipt.id)).toBe(true);
    expect(await csv()).not.toContain(translate(language, "checkRecord.notInNote"));
  });
}
