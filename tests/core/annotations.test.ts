/**
 * A Document's highlights and notes (#327): the words the User marked, their
 * note, where in the Document they are (ADR-0011), search, Collect into a
 * Mind, a new version's re-anchoring, and a PDF's own annotations.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  sha256,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import { scriptedModel } from "../helpers/models";
import { docxOf } from "../helpers/office";
import { buildPdf } from "../helpers/pdf";

const MARKDOWN = `# Costs

## Contingency

A contingency of 4% is held for weather delays.

## Programme

The programme allows 18 months from notice to handover.
`;

const TEXT = `Spring tides come with the new moon.
Neap tides come a week later.
`;

async function addOne(core: Core, name: string, contents: string | Uint8Array) {
  const sources = await createSourceFolder();
  const [document] = await addAndProcess(core, [await writeSourceFile(sources, name, contents)]);
  return document as Document;
}

const markdownSelection = {
  unit: null,
  text: "A contingency of 4% is held for weather delays.",
};

describe("annotations", () => {
  test("a highlight keeps its quote, Location and a found check, and the counts know it", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);

    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
    });

    expect(annotation).toMatchObject({
      documentId: document.id,
      source: "user",
      colour: "yellow",
      quote: "A contingency of 4% is held for weather delays.",
      check: "found",
      missing: false,
      note: null,
    });
    expect(annotation.location).toMatchObject({ kind: "section", heading: "Contingency" });
    expect(await core.listAnnotations(document.id)).toMatchObject([{ id: annotation.id }]);
    expect(await core.annotationCounts()).toEqual({ [document.id]: 1 });
  });

  test("its note and colour are edited, and a delete is taken back", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
    });

    const noted = await core.updateAnnotation(annotation.id, {
      note: "Ask whether the 4% covers the roof.",
      colour: "green",
    });
    expect(noted).toMatchObject({
      note: "Ask whether the 4% covers the roof.",
      colour: "green",
    });
    const edited = await core.updateAnnotation(annotation.id, { note: "The roof is excluded." });
    expect(edited.note).toBe("The roof is excluded.");

    await core.deleteAnnotation(annotation.id);
    expect(await core.listAnnotations(document.id)).toEqual([]);
    expect(await core.annotationCounts()).toEqual({});

    await core.restoreAnnotation(annotation.id);
    expect(await core.listAnnotations(document.id)).toMatchObject([
      { id: annotation.id, note: "The roof is excluded.", colour: "green" },
    ]);
  });

  test("search finds a note's words and a highlight's words, in English and Chinese", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    const highlighted = await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
    });
    await core.updateAnnotation(highlighted.id, {
      note: "The roof is excluded, check the survey.",
    });

    const english = await core.searchAnnotations("survey");
    expect(english).toMatchObject([{ annotationId: highlighted.id, documentId: document.id }]);
    expect(english[0]?.highlights.length).toBeGreaterThan(0);
    expect((await core.searchAnnotations("contingency")).map((each) => each.annotationId)).toEqual([
      highlighted.id,
    ]);

    const chinese = await addOne(
      core,
      "预算.md",
      "# 预算\n\n应急费按 4% 预留，用于天气延误。\n\n其余费用见明细表。\n",
    );
    const chineseHighlight = await core.createAnnotation({
      documentId: chinese.id,
      parts: [{ unit: null, text: "应急费按 4% 预留，用于天气延误。" }],
      colour: "blue",
    });
    await core.updateAnnotation(chineseHighlight.id, { note: "问一下屋顶是否包含在内。" });

    const found = await core.searchAnnotations("屋顶");
    expect(found).toMatchObject([{ annotationId: chineseHighlight.id, documentId: chinese.id }]);
    expect(found[0]?.highlights.length).toBeGreaterThan(0);
    expect((await core.searchAnnotations("应急费")).map((each) => each.annotationId)).toEqual([
      chineseHighlight.id,
    ]);
  });

  test("a new version re-anchors a highlight by its quote, and one whose words are gone says so", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const path = await writeSourceFile(sources, "Costs.md", MARKDOWN);
    const added = await addAndProcess(core, [path]);
    const document = added[0];
    if (!document) throw new Error("The Document wasn't added.");
    const kept = await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
    });
    const gone = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: null, text: "The programme allows 18 months from notice to handover." }],
      colour: "pink",
    });

    const changed = `${MARKDOWN.replace("## Contingency", "## Weather").replace(
      "The programme allows 18 months from notice to handover.\n",
      "",
    )}\n`;
    await writeFile(path, changed);
    await core.reconcileDocuments();
    const [processed] = await waitForProcessing(core, [document.id]);
    expect(processed?.contentHash).toBe(sha256(changed));

    const listed = await core.listAnnotations(document.id);
    const moved = listed.find((each) => each.id === kept.id);
    expect(moved).toMatchObject({ missing: false, check: "found" });
    expect(moved?.location).toMatchObject({ kind: "section", heading: "Weather" });
    const lost = listed.find((each) => each.id === gone.id);
    expect(lost).toMatchObject({ missing: true, check: "not-found" });
    expect(lost?.quote).toBe("The programme allows 18 months from notice to handover.");

    // The words come back: a later version re-anchors it again.
    await writeFile(path, `${changed}\nThe programme allows 18 months from notice to handover.\n`);
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    expect(await core.listAnnotations(document.id)).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ id: gone.id, missing: false, check: "found" }),
      ]),
    );
  });

  test("Collect groups a Document's highlights, a Folder's, and one colour's, in page order", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await core.createLibraryGroup({ name: "Tender", description: "" });
    const sources = await createSourceFolder();
    const added = await addAndProcess(core, [
      await writeSourceFile(sources, "Costs.md", MARKDOWN),
      await writeSourceFile(sources, "Tides.txt", TEXT),
    ]);
    const first = added[0];
    if (!first) throw new Error("The Documents weren't added.");
    await core.moveToFolder({ documentIds: added.map((each) => each.id), folderId: folder.id });

    const a = await core.createAnnotation({
      documentId: first.id,
      parts: [markdownSelection],
      colour: "yellow",
    });
    await core.deleteAnnotation(a.id);
    await core.restoreAnnotation(a.id);
    const documents = await core.listDocuments();
    const second = documents.find((each) => each.id !== first.id);
    if (!second) throw new Error("The second Document wasn't there.");
    const b = await core.createAnnotation({
      documentId: second.id,
      parts: [{ unit: null, text: "Neap tides come a week later." }],
      colour: "green",
    });

    const inFolder = await core.annotationsIn({ folderId: folder.id });
    expect(inFolder.map((group) => group.documentId).sort()).toEqual([first.id, second.id].sort());
    expect(inFolder.flatMap((group) => group.annotations.map((each) => each.id)).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    const green = await core.annotationsIn({ colour: "green" });
    expect(green.flatMap((group) => group.annotations.map((each) => each.id))).toEqual([b.id]);
    expect(await core.annotationsIn({ documentId: first.id })).toMatchObject([
      { documentId: first.id, documentName: first.name },
    ]);
  });

  test("Collect returns a Document's highlights in page order, though they were made in another", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(
      core,
      "Two pages.pdf",
      buildPdf([{ lines: ["The first page's line."] }, { lines: ["The second page's line."] }]),
    );
    await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: 2, text: "The second page's line." }],
      colour: "yellow",
    });
    await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: 1, text: "The first page's line." }],
      colour: "yellow",
    });

    const groups = await core.annotationsIn({ documentId: document.id });
    expect(groups.map((group) => group.annotations.map((each) => each.quote))).toEqual([
      ["The first page's line.", "The second page's line."],
    ]);
  });

  test("a Document's highlights export to Markdown with their quote, note and Location", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
      note: "The roof is excluded.",
    });

    const saved = await core.saveAnnotationsExport(document.id);
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") return;
    expect(saved.file.name.endsWith(".md")).toBe(true);
    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(saved.file.path, "utf8");
    expect(markdown).toContain("A contingency of 4% is held for weather delays.");
    expect(markdown).toContain("The roof is excluded.");
    expect(markdown).toContain("§ Contingency");
    expect(markdown).toContain(annotation.quote);
  });

  // A real PDF, read by the real pdf.js as the built app reads one: the file's own highlight and note.
  test("a PDF's own highlights and notes are read, marked From the file", async () => {
    const core = startCore(await createTempDataFolder());
    const pdf = buildPdf(
      [
        {
          lines: ["Grocers studied across the eleven chains."],
          marks: [
            {
              subtype: "Highlight",
              rect: [72, 758, 300, 770],
              quadPoints: [72, 770, 300, 770, 72, 758, 300, 758],
              contents: "Compare with Table 3.",
              title: "Priya Raman",
              color: [1, 0.9, 0.2],
            },
            {
              subtype: "Text",
              rect: [320, 700, 340, 720],
              contents: "Check this figure.",
              title: "Priya Raman",
              color: [1, 1, 0],
            },
          ],
        },
        { lines: ["Pooling the cuts, the recovery peaks in the second quarter."] },
      ],
      {},
    );
    const document = await addOne(core, "Rate cuts.pdf", pdf);

    const annotations = await core.listAnnotations(document.id);
    expect(annotations).toHaveLength(2);
    const highlight = annotations.find((each) => each.quote !== "");
    expect(highlight).toMatchObject({
      source: "file",
      author: "Priya Raman",
      note: "Compare with Table 3.",
      pageFrom: 1,
      pageTo: 1,
      check: "found",
      missing: false,
    });
    expect(highlight?.quote).toContain("Grocers studied across the eleven chains.");
    const note = annotations.find((each) => each.quote === "");
    expect(note).toMatchObject({
      source: "file",
      note: "Check this figure.",
      check: "cant-check",
    });
  });

  test("a Word Document's highlight is cited to the section it sits under", async () => {
    const core = startCore(await createTempDataFolder());
    const docx = docxOf([
      { text: "2.1 Sensitivity", heading: 2 },
      { text: "A one point move in rates changes the margin by 0.4 points." },
      { text: "2.2 Scenario", heading: 2 },
      { text: "The downside case holds margins flat." },
    ]);
    const document = await addOne(core, "Margin.docx", docx);

    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: null, text: "A one point move in rates changes the margin by 0.4 points." }],
      colour: "purple",
    });
    expect(annotation).toMatchObject({ check: "found" });
    expect(annotation.location).toMatchObject({ kind: "section", heading: "2.1 Sensitivity" });
  });

  test("a saved web page's highlight is cited to its section and paragraph", async () => {
    const core = startCore(await createTempDataFolder());
    const article = readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8");
    const saved = await core.saveWebPage({
      address: "https://reader.example/tea",
      html: article,
    });
    if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
    await waitForProcessing(core, [saved.document.id]);

    const annotation = await core.createAnnotation({
      documentId: saved.document.id,
      parts: [
        {
          unit: null,
          text: "In the early 17th century, a ship of the Dutch East India Company brought the first green tea leaves to Amsterdam from China.",
        },
      ],
      colour: "blue",
    });
    expect(annotation).toMatchObject({ check: "found" });
    expect(annotation.location).toMatchObject({ kind: "section", heading: "History" });
  });

  test("a plain text Document's highlight is cited to its lines", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Tides.txt", TEXT);
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: null, text: "Neap tides come a week later." }],
      colour: "pink",
    });
    expect(annotation.location).toMatchObject({ kind: "lines" });
    expect(annotation).toMatchObject({ check: "found" });
  });

  test("each action works on every format, and its Location is that format's own", async () => {
    const fixtures: {
      name: string;
      add(core: Core): Promise<Document>;
      quote: string;
      location: Record<string, unknown>;
    }[] = [
      {
        name: "Markdown",
        add: (core) => addOne(core, "Costs.md", MARKDOWN),
        quote: "A contingency of 4% is held for weather delays.",
        location: { kind: "section", heading: "Contingency" },
      },
      {
        name: "plain text",
        add: (core) => addOne(core, "Tides.txt", TEXT),
        quote: "Neap tides come a week later.",
        location: { kind: "lines" },
      },
      {
        name: "Word",
        add: (core) =>
          addOne(
            core,
            "Margin.docx",
            docxOf([
              { text: "2.1 Sensitivity", heading: 2 },
              { text: "A one point move in rates changes the margin by 0.4 points." },
            ]),
          ),
        quote: "A one point move in rates changes the margin by 0.4 points.",
        location: { kind: "section", heading: "2.1 Sensitivity" },
      },
      {
        name: "PDF",
        add: (core) =>
          addOne(
            core,
            "Rate cuts.pdf",
            buildPdf([{ lines: ["Grocers studied across the eleven chains."] }]),
          ),
        quote: "Grocers studied across the eleven chains.",
        location: { kind: "page", from: 1, to: 1 },
      },
      {
        name: "web page",
        add: async (core) => {
          const article = readFileSync(
            new URL("../fixtures/web/article.html", import.meta.url),
            "utf8",
          );
          const saved = await core.saveWebPage({
            address: "https://reader.example/tea",
            html: article,
          });
          if (saved.outcome !== "saved") throw new Error("The web page wasn't saved.");
          await waitForProcessing(core, [saved.document.id]);
          return core.listDocuments().then((each) => {
            const document = each.find((one) => one.id === saved.document.id);
            if (!document) throw new Error("The web page isn't listed.");
            return document;
          });
        },
        quote:
          "In the early 17th century, a ship of the Dutch East India Company brought the first green tea leaves to Amsterdam from China.",
        location: { kind: "section", heading: "History" },
      },
    ];

    for (const fixture of fixtures) {
      const core = startCore(await createTempDataFolder());
      const document = await fixture.add(core);
      const created = await core.createAnnotation({
        documentId: document.id,
        parts: [{ unit: null, text: fixture.quote }],
        colour: "yellow",
      });
      expect(created.location, fixture.name).toMatchObject(fixture.location);
      expect(created.check, fixture.name).toBe("found");

      const noted = await core.updateAnnotation(created.id, {
        note: "Worth a second look.",
        colour: "blue",
      });
      expect(noted, fixture.name).toMatchObject({ note: "Worth a second look.", colour: "blue" });
      const edited = await core.updateAnnotation(created.id, { note: "A third look." });
      expect(edited.note, fixture.name).toBe("A third look.");
      expect((await core.searchAnnotations("third look")).map((each) => each.annotationId)).toEqual(
        [created.id],
      );

      await core.deleteAnnotation(created.id);
      expect(await core.listAnnotations(document.id), fixture.name).toEqual([]);
      await core.restoreAnnotation(created.id);
      expect(await core.listAnnotations(document.id), fixture.name).toMatchObject([
        { id: created.id, note: "A third look.", colour: "blue" },
      ]);
    }
  });

  test("the assistant's search hands it the User's highlights and notes on the words", async () => {
    let searched = "";
    const model = scriptedModel((call) => {
      if (!call.results.some((result) => result.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "station" } }] };
      }
      searched = call.results.find((result) => result.tool === "search_documents")?.text ?? "";
      return { text: "The nearest station is Aldermoor." };
    });
    const { core, documents } = await setUpWithDocuments(model, [
      { name: "Costs.md", contents: MARKDOWN },
    ]);
    const document = documents[0];
    if (!document) throw new Error("The Document wasn't added.");
    await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
      note: "The nearest station is Aldermoor.",
    });

    const asked = await core.askInConversation({
      text: "What did I highlight about the station?",
      mindId: (await core.listMinds())[0]?.id ?? "",
    });
    if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
    expect((await answerEnded(core, asked.answerId)).event).toBe("finished");
    expect(searched).toContain("highlights and notes");
    expect(searched).toContain("Aldermoor");
    expect(searched).toContain("Costs");
  });

  test("a note too long is refused in the interface's words, and so is a highlight that is gone", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
    });
    await expect(
      core.updateAnnotation(annotation.id, { note: "x".repeat(20_001) }),
    ).rejects.toMatchObject({ wording: { key: "error.annotation.note.tooLong" } });
    await expect(core.updateAnnotation("not-a-highlight", { note: "x" })).rejects.toMatchObject({
      wording: { key: "error.annotation.notFound" },
    });
  });

  test("its Markdown export is in the interface's language", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
      note: "屋顶不包含在内。",
    });
    await core.updateSettings({ user: { language: "zh-CN" } });
    const saved = await core.saveAnnotationsExport(document.id);
    if (saved.status !== "saved") throw new Error("The export wasn't saved.");
    const { readFile } = await import("node:fs/promises");
    const markdown = await readFile(saved.file.path, "utf8");
    expect(markdown).toContain("高亮和批注");
    expect(markdown).toContain("屋顶不包含在内。");
    expect(markdown).toContain("§ Contingency");
  });

  test("words the Document doesn't have where they were selected are refused", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    await expect(
      core.createAnnotation({
        documentId: document.id,
        parts: [{ unit: null, text: "This sentence is not in the file at all." }],
        colour: "yellow",
      }),
    ).rejects.toThrow(/highlight/i);
    expect(await core.listAnnotations(document.id)).toEqual([]);
  });

  test("a region drawn on a page is highlighted, with the words in it, and a new version keeps it", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Notice.pdf",
      buildPdf([{ lines: ["The notice period is 18 months."] }]),
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    const area = { x: 0.1, y: 0.1, width: 0.6, height: 0.1 };
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: 1, text: "The notice period is 18 months." }],
      area,
      unit: 1,
      colour: "blue",
    });

    expect(annotation).toMatchObject({
      quote: "The notice period is 18 months.",
      check: "found",
      missing: false,
    });
    expect(annotation.location).toMatchObject({ kind: "page", from: 1, area });
    expect(annotation.anchor).toMatchObject({ unit: 1, area });
    expect(await core.listAnnotations(document.id)).toMatchObject([
      { id: annotation.id, location: { area } },
    ]);

    // A new version of the file: its words are gone, so the region says so, as a highlight does.
    const changed = buildPdf([
      { lines: ["The notice period is 24 months."] },
      { lines: ["Signed at the works."] },
    ]);
    await writeFile(path, changed);
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    const [kept] = await core.listAnnotations(document.id);
    expect(kept).toMatchObject({
      id: annotation.id,
      missing: true,
      check: "not-found",
      pageFrom: 1,
    });
    expect(kept?.location).toMatchObject({ area });
  });

  test("a picture region whose page is gone says it is missing", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Plate.pdf",
      buildPdf([{ lines: ["A diagram of the works."] }, { lines: ["A second plate."] }]),
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    const area = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [],
      area,
      unit: 2,
      colour: "purple",
    });
    expect(annotation).toMatchObject({ missing: false, pageFrom: 2 });
    await writeFile(path, buildPdf([{ lines: ["A diagram of the works."] }]));
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    const [kept] = await core.listAnnotations(document.id);
    expect(kept).toMatchObject({ id: annotation.id, missing: true });
  });

  test("a picture region on a page the Document doesn't have is refused", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(
      core,
      "Plate.pdf",
      buildPdf([{ lines: ["A diagram of the works."] }]),
    );
    await expect(
      core.createAnnotation({
        documentId: document.id,
        parts: [],
        area: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
        unit: 7,
        colour: "yellow",
      }),
    ).rejects.toMatchObject({ wording: { key: "error.annotation.refused" } });
    expect(await core.listAnnotations(document.id)).toEqual([]);
  });

  test("a region whose words aren't on its page is refused", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(
      core,
      "Notice.pdf",
      buildPdf([{ lines: ["The notice period is 18 months."] }]),
    );
    await expect(
      core.createAnnotation({
        documentId: document.id,
        parts: [{ unit: 1, text: "This sentence is not on the page at all." }],
        area: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
        unit: 1,
        colour: "yellow",
      }),
    ).rejects.toMatchObject({ wording: { key: "error.annotation.refused" } });
  });

  test("search leaves out a deleted Document's highlights", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
      note: "The contingency question.",
    });
    expect(await core.searchAnnotations("contingency")).toHaveLength(1);
    await core.deleteDocument(document.id);
    expect(await core.searchAnnotations("contingency")).toEqual([]);
  });

  test("Delete permanently takes the words and the note with the Document", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(core, "Costs.md", MARKDOWN);
    await core.createAnnotation({
      documentId: document.id,
      parts: [markdownSelection],
      colour: "yellow",
      note: "Confidential roof figure.",
    });
    await core.deleteDocument(document.id);
    // Still in Recently deleted: its rows are still there, hidden by the Document.
    expect(await core.listAnnotations(document.id)).toHaveLength(1);
    await core.deletePermanently([{ kind: "document", id: document.id }]);
    expect(
      await core.listAnnotations(document.id),
      "the highlight, its words and its note go with the Document",
    ).toEqual([]);
    expect(
      await core.searchAnnotations("confidential"),
      "and its words leave the search index too",
    ).toEqual([]);
  });

  test("a region of a picture is stored without words, cited as a picture, and not missing", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(
      core,
      "Plate.pdf",
      buildPdf([{ lines: ["A diagram of the works."] }]),
    );
    const area = { x: 0.05, y: 0.05, width: 0.9, height: 0.6 };
    const annotation = await core.createAnnotation({
      documentId: document.id,
      parts: [],
      area,
      unit: 1,
      colour: "green",
    });
    expect(annotation).toMatchObject({
      quote: "",
      check: "cant-check",
      checkReason: "picture",
      missing: false,
    });
    expect(annotation.location).toMatchObject({ kind: "page", from: 1, area });
    expect(annotation.anchor).toMatchObject({ area, unit: 1 });
  });

  test("a re-anchored highlight keeps no Passage of the words a new version dropped", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const before = "# Costs\n\n## Contingency\n\nInsurance covered the roof repair.\n";
    const path = await writeSourceFile(sources, "Cover.md", before);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    const covered = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: null, text: "covered" }],
      colour: "yellow",
    });
    expect(covered).toMatchObject({ check: "found" });
    expect(covered.passageId).not.toBeNull();

    await writeFile(path, "# Costs\n\n## Contingency\n\nInsurance excluded the roof repair.\n");
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);

    const [kept] = await core.listAnnotations(document.id);
    expect(kept).toMatchObject({
      id: covered.id,
      missing: true,
      check: "not-found",
      passageId: null,
    });
  });

  test("Collect re-anchors a highlight whose words are gone before it reads, with no list first", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Cover.md",
      "# Costs\n\n## Contingency\n\nInsurance covered the roof repair.\n",
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    const covered = await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: null, text: "covered" }],
      colour: "yellow",
    });

    await writeFile(path, "# Costs\n\n## Contingency\n\nInsurance excluded the roof repair.\n");
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);

    const groups = await core.annotationsIn({ documentId: document.id });
    const [first] = groups.flatMap((group) => group.annotations);
    expect(first).toMatchObject({
      id: covered.id,
      missing: true,
      check: "not-found",
      passageId: null,
    });
  });

  test("Search re-anchors a highlight whose words are gone before it reads, with no list first", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const path = await writeSourceFile(
      sources,
      "Cover.md",
      "# Costs\n\n## Contingency\n\nInsurance covered the roof repair.\n",
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    await core.createAnnotation({
      documentId: document.id,
      parts: [{ unit: null, text: "covered" }],
      colour: "yellow",
    });

    await writeFile(path, "# Costs\n\n## Contingency\n\nInsurance excluded the roof repair.\n");
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);

    const matches = await core.searchAnnotations("covered");
    expect(matches).toMatchObject([{ missing: true }]);
  });

  test("a PDF's own highlight over one line quotes that line alone", async () => {
    const core = startCore(await createTempDataFolder());
    const document = await addOne(
      core,
      "Lines.pdf",
      buildPdf([
        {
          lines: ["Line one has words.", "Line two has words.", "Line three has words."],
          marks: [
            {
              subtype: "Highlight",
              rect: [72, 744, 300, 756],
              quadPoints: [72, 756, 300, 756, 72, 744, 300, 744],
            },
            {
              subtype: "Highlight",
              rect: [72, 758, 300, 770],
              quadPoints: [72, 770, 300, 770, 72, 758, 300, 758],
            },
          ],
        },
      ]),
    );
    const quotes = (await core.listAnnotations(document.id))
      .filter((each) => each.quote !== "")
      .map((each) => each.quote)
      .sort();
    expect(quotes).toEqual(["Line one has words.", "Line two has words."]);
  });

  test("a PDF's own highlights survive a moved line and one the new version drops says so", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const quoted = {
      subtype: "Highlight" as const,
      rect: [72, 744, 300, 756] as const,
      quadPoints: [72, 756, 300, 756, 72, 744, 300, 744] as const,
      contents: "Compare with Table 3.",
      title: "Priya Raman",
    };
    const droppedMark = {
      subtype: "Highlight" as const,
      rect: [72, 758, 300, 770] as const,
      quadPoints: [72, 770, 300, 770, 72, 758, 300, 758] as const,
      title: "Priya Raman",
    };
    const path = await writeSourceFile(
      sources,
      "Survey.pdf",
      buildPdf([
        {
          lines: ["Alpha report cover.", "Highlighted words here."],
          marks: [droppedMark, quoted],
        },
      ]),
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    const before = await core.listAnnotations(document.id);
    const kept = before.find((each) => each.quote === "Highlighted words here.");
    const gone = before.find((each) => each.quote === "Alpha report cover.");
    if (!kept || !gone) throw new Error("The file's highlights weren't read.");
    expect(kept.note).toBe("Compare with Table 3.");

    const moved = {
      ...quoted,
      rect: [72, 730, 300, 742] as const,
      quadPoints: [72, 742, 300, 742, 72, 730, 300, 730] as const,
    };
    await writeFile(
      path,
      buildPdf([
        {
          lines: ["Added line above.", "Alpha report cover.", "Highlighted words here."],
          marks: [{ ...moved, contents: "Confidential rooftop figure." }],
        },
      ]),
    );
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);

    const after = await core.listAnnotations(document.id);
    expect(after.find((each) => each.id === kept.id)).toMatchObject({
      quote: "Highlighted words here.",
      note: "Confidential rooftop figure.",
      missing: false,
      check: "found",
    });
    expect(after.find((each) => each.id === gone.id)).toMatchObject({
      missing: true,
      check: "not-found",
      passageId: null,
    });
    expect(
      (await core.searchAnnotations("Confidential")).map((each) => each.annotationId),
    ).toContain(kept.id);

    // The User's own note stays theirs when the file's changes again.
    await core.updateAnnotation(kept.id, { note: "Mine" });
    await writeFile(
      path,
      buildPdf([
        {
          lines: ["Added line above.", "Alpha report cover.", "Highlighted words here."],
          marks: [{ ...moved, contents: "Compare with Table 5." }],
        },
      ]),
    );
    await core.reconcileDocuments();
    await waitForProcessing(core, [document.id]);
    expect(
      (await core.listAnnotations(document.id)).find((each) => each.id === kept.id),
    ).toMatchObject({ note: "Mine" });
  });

  test("a PDF's own highlights follow their pages through a cover, a removed page and an added one", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const mark = (contents: string) => ({
      subtype: "Highlight" as const,
      rect: [72, 758, 300, 770] as const,
      quadPoints: [72, 770, 300, 770, 72, 758, 300, 758] as const,
      contents,
      title: "Priya Raman",
    });
    const path = await writeSourceFile(
      sources,
      "Survey.pdf",
      buildPdf([
        { lines: ["Alpha page words.", "Alpha's second line."], marks: [mark("Alpha note.")] },
        { lines: ["Beta page words.", "Beta's second line."], marks: [mark("Beta note.")] },
      ]),
    );
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The Document wasn't added.");
    const before = await core.listAnnotations(document.id);
    const alpha = before.find((each) => each.quote === "Alpha page words.");
    const beta = before.find((each) => each.quote === "Beta page words.");
    if (!alpha || !beta) throw new Error("The file's highlights weren't read.");
    expect(alpha.note).toBe("Alpha note.");
    await core.updateAnnotation(beta.id, { note: "Mine about beta." });

    const reread = async (pages: Parameters<typeof buildPdf>[0]) => {
      await writeFile(path, buildPdf(pages));
      await core.reconcileDocuments();
      await waitForProcessing(core, [document.id]);
      return core.listAnnotations(document.id);
    };

    const covered = await reread([
      { lines: ["Cover page."] },
      { lines: ["Alpha page words.", "Alpha's second line."], marks: [mark("Alpha note.")] },
      { lines: ["Beta page words.", "Beta's second line."], marks: [mark("Beta note.")] },
    ]);
    expect(covered.find((each) => each.id === alpha.id)).toMatchObject({
      pageFrom: 2,
      note: "Alpha note.",
      missing: false,
    });
    expect(covered.find((each) => each.id === beta.id)).toMatchObject({
      pageFrom: 3,
      note: "Mine about beta.",
      missing: false,
    });

    const shortened = await reread([
      { lines: ["Alpha page words.", "Alpha's second line."], marks: [mark("Alpha note.")] },
      { lines: ["Beta page words.", "Beta's second line."], marks: [mark("Beta note.")] },
    ]);
    expect(shortened.find((each) => each.id === alpha.id)).toMatchObject({
      pageFrom: 1,
      note: "Alpha note.",
      missing: false,
    });
    expect(shortened.find((each) => each.id === beta.id)).toMatchObject({
      pageFrom: 2,
      note: "Mine about beta.",
      missing: false,
    });

    const inserted = await reread([
      { lines: ["Alpha page words.", "Alpha's second line."], marks: [mark("Alpha note.")] },
      { lines: ["Inserted page."] },
      { lines: ["Beta page words.", "Beta's second line."], marks: [mark("Beta note.")] },
    ]);
    expect(inserted.find((each) => each.id === alpha.id)).toMatchObject({
      pageFrom: 1,
      note: "Alpha note.",
      missing: false,
    });
    expect(inserted.find((each) => each.id === beta.id)).toMatchObject({
      pageFrom: 3,
      note: "Mine about beta.",
      missing: false,
    });
  });
});
