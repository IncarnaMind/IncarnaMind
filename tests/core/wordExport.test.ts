/**
 * Exporting a Mind imported from a Word file back into that file (#105),
 * through the core's public interface: what the Mind didn't change is byte
 * for byte what the file had, edits are written into the paragraphs they were
 * made in with their formatting kept, new Blocks take the document's own
 * styles, lists and footnotes, and what can't be kept is said before anything
 * is saved.
 */
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import {
  type CitationAttributes,
  type Core,
  type Document,
  MIND_WORD_FIELD,
  type UnsupportedReason,
  WORD_ATOM_NODE,
} from "../../src/core";
import { elements, parseXml, type XmlElement } from "../../src/core/documents/formats/xml";
import { quitCopyOptions } from "../../src/shared/exportOptions";
import { setMindScope } from "../../src/shared/mindScope";
import { recordProposalRequest } from "../../src/shared/proposals";
import { folderScope } from "../../src/shared/searchScope";
import { wordFileOf, wordImportProgressOf } from "../../src/shared/wordFiles";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { acceptedParagraphs, textOf, unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import {
  commented,
  field,
  NUMBERING,
  PNG,
  paragraph,
  run,
  table,
  tracked,
  type WordFileInput,
  wordFile,
} from "../helpers/word";
import { buildZip } from "../helpers/zip";

async function importFile(core: Core, bytes: Buffer, origin: "own" | "someone-else" = "own") {
  const folder = await createTempDataFolder();
  const path = join(folder, "Memo.docx");
  await writeFile(path, bytes);
  const result = await core.importWordFile({ path, origin });
  if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
  const client = await connectToMind(core, result.mind.id);
  await new Promise<void>((resolve) => {
    const check = () => {
      if (wordFileOf(client.doc) && wordImportProgressOf(client.doc) === null) {
        client.doc.off("update", check);
        resolve();
      }
    };
    client.doc.on("update", check);
    check();
  });
  return { mindId: result.mind.id, client };
}

async function setUp(input: WordFileInput, origin: "own" | "someone-else" = "own") {
  const core = startCore(await createTempDataFolder());
  const bytes = wordFile(input);
  return { core, bytes, ...(await importFile(core, bytes, origin)) };
}

async function exported(core: Core, mindId: string) {
  const result = await core.exportMind(mindId, { format: "docx" });
  const files = unzip(result.data);
  const part = (name: string) => files.get(name)?.toString("utf8") ?? "";
  return { files, word: result.word, document: part("word/document.xml"), part };
}

/** The entries an export changed, added or left out. */
function changed(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter((name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)))
    .sort();
}

/** Changes the text of every text node in the Mind. */
function editText(client: MindClient, change: (text: string) => string): void {
  const visit = (node: JSONContent): JSONContent => ({
    ...node,
    ...(node.text !== undefined && { text: change(node.text) }),
    ...(node.content && { content: node.content.map(visit) }),
  });
  editMind(client, (blocks) => blocks.map(visit));
}

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks.length > 0 && { marks: marks.map((type) => ({ type })) }),
});

const item = (value: string): JSONContent => ({
  type: "listItem",
  content: [{ type: "paragraph", content: [text(value)] }],
});

/** A Citation of the Document, its quote found. */
const citation = (document: Document): JSONContent => ({
  type: "citation",
  attrs: {
    passageId: "p1",
    documentId: document.id,
    documentName: "Tides",
    contentHash: document.contentHash,
    quote: "Spring tides happen at new moon.",
    check: "found",
  },
});

async function tidesDocument(core: Core): Promise<Document> {
  const sources = await createTempDataFolder();
  const path = await writeSourceFile(sources, "Tides.txt", "Spring tides happen at new moon.");
  const [tides] = await addAndProcess(core, [path]);
  return tides as Document;
}

/** The body's paragraphs as written, in order. */
const paragraphsIn = (xml: string) =>
  [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)].map((match) => match[0]);

describe("what the Mind didn't change", () => {
  test("is byte for byte the file's, every entry, when nothing changed", async () => {
    const { core, bytes, mindId } = await setUp({
      body:
        paragraph("Heading", { style: "Heading1" }) +
        paragraph(`${run("Plain and ")}${run("bold", { b: true })}`) +
        paragraph("First item", { numId: 1 }) +
        table([
          ["A", "B"],
          ["C", "D"],
        ]),
      numbering: NUMBERING,
    });
    const { files, word } = await exported(core, mindId);
    expect(changed(unzip(bytes), files)).toEqual([]);
    expect(word).toEqual({ notKept: [], unknownParts: [], keptFurniture: [] });
  });

  test("the package is the Mind's own, whatever its document says the file's hash is", async () => {
    const { core, bytes, mindId, client } = await setUp({ body: paragraph("Text.") });
    const word = client.doc.getMap(MIND_WORD_FIELD);
    word.set("file", { ...(word.get("file") as object), sha256: "../../../Elsewhere/Report" });
    await client.settled();
    const { files } = await exported(core, mindId);
    expect(changed(unzip(bytes), files)).toEqual([]);
  });

  test("a part IncarnaMind doesn't know is copied as it is, and listed", async () => {
    const plain = unzip(wordFile({ body: paragraph("Text.") }));
    const types = plain.get("[Content_Types].xml")?.toString("utf8") ?? "";
    const { core, mindId, client } = await setUp({
      body: paragraph("Text."),
      parts: [
        { name: "vendor/settings.vendor", data: "<vendor>kept</vendor>" },
        {
          name: "[Content_Types].xml",
          data: types.replace(
            "</Types>",
            '<Default Extension="vendor" ContentType="application/vnd.example.settings+xml"/></Types>',
          ),
        },
      ],
    });
    editText(client, (value) => value.replace("Text.", "Text, edited."));
    await client.settled();
    const { files, word } = await exported(core, mindId);
    expect(word?.unknownParts).toEqual(["vendor/settings.vendor"]);
    expect(files.get("vendor/settings.vendor")?.toString("utf8")).toBe("<vendor>kept</vendor>");
  });

  // protects=the export keeps the page the imported file has, its size and margins, whatever the computer's region; fails_when=the export takes the region's paper, as a native Mind's does; no_claim=Page view, which pageSetup.test.ts covers.
  test.each([
    [
      "GB",
      "Letter",
      '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/>',
    ],
    [
      "US",
      "A4",
      '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>',
    ],
  ] as const)(
    "on a computer in %s, a Mind imported from a %s file exports on that page",
    async (region, _paper, sectPr) => {
      const core = startCore(await createTempDataFolder(), { systemRegion: () => region });
      const { mindId, client } = await importFile(
        core,
        wordFile({ body: paragraph("Text."), sectPr }),
      );
      editText(client, (value) => `${value} Edited.`);
      await client.settled();

      const { document } = await exported(core, mindId);
      expect(document).toContain(`<w:sectPr>${sectPr}</w:sectPr>`);
    },
  );
});

describe("an edited paragraph", () => {
  test("keeps its own XML: a changed word takes its run's formatting, the other runs and paragraphs stay", async () => {
    const first = paragraph(
      `${run("The rent is ", { font: "Georgia" })}${run("due", { b: true, font: "Georgia" })}${run(" monthly.", { font: "Georgia" })}`,
      { paraId: "1A2B3C4D" },
    );
    const second = paragraph("Unchanged paragraph.", { paraId: "5E6F7A8B" });
    const { core, bytes, mindId, client } = await setUp({ body: first + second });
    editText(client, (value) => (value === " monthly." ? " every month." : value));
    await client.settled();

    const { files, document } = await exported(core, mindId);
    expect(changed(unzip(bytes), files)).toEqual(["word/document.xml"]);
    expect(document).toContain(second);
    expect(document).toContain(
      `<w:p w14:paraId="1A2B3C4D">${run("The rent is ", { font: "Georgia" })}${run("due", { b: true, font: "Georgia" })}`,
    );
    expect(document).toContain(
      '<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:t xml:space="preserve"> every month.</w:t>',
    );
  });

  test("a word made bold, or no longer bold, changes only that toggle: the font stays", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph(
        `${run("Keep ", { font: "Georgia" })}${run("this", { b: true, font: "Georgia" })}`,
      ),
    });
    editMind(client, ([first]) => [{ ...first, content: [text("Keep", "bold"), text(" this")] }]);
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).toContain(
      '<w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">Keep</w:t></w:r>',
    );
    expect(document).toContain(
      '<w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:t xml:space="preserve"> this</w:t></w:r>',
    );
  });

  test("what the import kept as is goes back as it was: a field, a footnote mark, someone's tracked change", async () => {
    const date = field('DATE \\@ "d MMMM yyyy"', "12 October 2026");
    const change = tracked("ins", 7, "Lars", " (draft)");
    const footnoteMark =
      '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>';
    const { core, mindId, client } = await setUp(
      {
        body: paragraph(
          `${run("Dated ")}${date}${run(" and noted")}${footnoteMark}${change}${run(".")}`,
        ),
        footnotes: `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${run(" A note.")}</w:p></w:footnote>`,
      },
      "someone-else",
    );
    editText(client, (value) => value.replace("noted", "signed"));
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).toContain(date);
    expect(document).toContain(change);
    expect(document).toContain(footnoteMark);
    expect(document).toContain("signed");
    expect(document).not.toContain("noted");
  });

  test("a heading's new level takes the document's own heading style", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph("Scope", { style: "Heading1" }) + paragraph("Body."),
    });
    editMind(client, ([heading, ...rest]) => [
      { ...heading, attrs: { ...heading?.attrs, level: 2 } },
      ...rest,
    ]);
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(paragraphsIn(document)[0]).toBe(
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>${run("Scope")}</w:p>`,
    );
  });

  test("a link added to text is a hyperlink with a relationship of its own", async () => {
    const { core, mindId, client, bytes } = await setUp({ body: paragraph("See the site.") });
    editMind(client, ([first]) => [
      {
        ...first,
        content: [
          text("See "),
          {
            type: "text",
            text: "the site",
            marks: [{ type: "link", attrs: { href: "https://example.com/" } }],
          },
          text("."),
        ],
      },
    ]);
    await client.settled();
    const { document, part, files } = await exported(core, mindId);
    const id = /<w:hyperlink r:id="([^"]+)" w:history="1">/.exec(document)?.[1];
    expect(id).toBeDefined();
    expect(part("word/_rels/document.xml.rels")).toContain(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>`,
    );
    // The link's character style is added to the document's styles.
    expect(changed(unzip(bytes), files)).toEqual([
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/styles.xml",
    ]);
  });

  test("a change still waiting goes in as IncarnaMind's tracked change, in its paragraph's own run", async () => {
    const { core, mindId, client, bytes } = await setUp({
      body: paragraph(run("Rent is due monthly.", { font: "Georgia" })) + paragraph("Kept."),
    });
    recordProposalRequest(client.doc, "r1", {
      source: "edit-with-ai",
      providerId: "anthropic",
      modelId: "claude",
      createdAt: "2026-10-12T14:30:00.000Z",
    });
    editMind(client, ([first, second]) => [
      {
        ...first,
        content: [
          text("Rent is due "),
          {
            ...text("monthly"),
            marks: [{ type: "proposalDelete", attrs: { id: "c1", request: "r1" } }],
          },
          {
            ...text("weekly"),
            marks: [{ type: "proposalInsert", attrs: { id: "c1", request: "r1" } }],
          },
          text("."),
        ],
      },
      second as JSONContent,
    ]);
    await client.settled();

    const { document, files } = await exported(core, mindId);

    expect(changed(unzip(bytes), files)).toEqual(["word/document.xml"]);
    const georgia = '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr>';
    expect(document).toContain(
      `<w:del w:id="0" w:author="IncarnaMind" w:date="2026-10-12T14:30:00Z"><w:r>${georgia}<w:delText xml:space="preserve">monthly</w:delText></w:r></w:del><w:ins w:id="1" w:author="IncarnaMind" w:date="2026-10-12T14:30:00Z"><w:r>${georgia}<w:t xml:space="preserve">weekly</w:t></w:r></w:ins>`,
    );
    expect(document).toContain(paragraph("Kept."));
  });
});

describe("the User's edits as tracked changes (#107)", () => {
  const tracking = { format: "docx", trackChanges: true } as const;

  test("a paragraph a change still waiting adds is IncarnaMind's insertion, its words too, with the User's edits tracked", async () => {
    const { core, mindId, client } = await setUp({ body: paragraph("Kept.") });
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        attrs: { proposal: { id: "c1", request: "r1", kind: "insert" } },
        content: [text("Proposed.")],
      },
    ]);
    await client.settled();

    const document =
      unzip((await core.exportMind(mindId, tracking)).data)
        .get("word/document.xml")
        ?.toString("utf8") ?? "";

    expect(document).toMatch(
      /<w:p><w:pPr><w:rPr><w:ins w:id="\d+" w:author="IncarnaMind"\/><\/w:rPr><\/w:pPr><w:ins w:id="\d+" w:author="IncarnaMind"><w:r><w:t xml:space="preserve">Proposed.<\/w:t><\/w:r><\/w:ins><\/w:p>/,
    );
    expect(document).not.toContain('w:author="Priya Raman"');
  });

  test("a changed word is the User's deletion and insertion, under their name, in the run's own format; off, it is written plainly", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph(run("Rent is due monthly.", { font: "Georgia" })),
    });
    editText(client, (value) => value.replace("monthly", "weekly"));
    await client.settled();
    await core.updateSettings({ user: { authorName: "P. Raman" } });

    const tracked = unzip((await core.exportMind(mindId, tracking)).data);
    const plain = await exported(core, mindId);

    const document = tracked.get("word/document.xml")?.toString("utf8") ?? "";
    const georgia = '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr>';
    expect(document).toMatch(
      new RegExp(
        `<w:del w:id="\\d+" w:author="P. Raman" w:date="[^"]+"><w:r>${georgia}<w:delText xml:space="preserve">monthly</w:delText></w:r></w:del><w:ins w:id="\\d+" w:author="P. Raman" w:date="[^"]+"><w:r>${georgia}<w:t xml:space="preserve">weekly</w:t></w:r></w:ins>`,
      ),
    );
    expect(acceptedParagraphs(document)).toEqual(["Rent is due weekly."]);
    expect(plain.document).not.toMatch(/<w:(ins|del) /);
  });

  test("a deleted paragraph stays as the User's deletion, someone's comment on it with it, and nothing is lost", async () => {
    const remark = commented(0, "Lars Eklund", "Check the date.", run("Due in May."));
    const { core, mindId, client } = await setUp({
      body: paragraph("Kept.") + paragraph(remark.inline) + paragraph("Last."),
      comments: remark.comment,
    });
    editMind(client, ([first, , last]) => [first as JSONContent, last as JSONContent]);
    await client.settled();

    const { data, word } = await core.exportMind(mindId, tracking);
    const files = unzip(data);
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";

    expect(word?.notKept).toEqual([]);
    expect(document).toContain('<w:commentRangeStart w:id="0"/>');
    expect(document).toMatch(
      /<w:del [^>]*w:author="Priya Raman"[^>]*><w:r><w:delText xml:space="preserve">Due in May.<\/w:delText>/,
    );
    expect(document).toMatch(
      /<w:del [^>]*><w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="0"\/>/,
    );
    expect(files.get("word/comments.xml")?.toString("utf8")).toContain("Check the date.");
    expect(acceptedParagraphs(document)).toEqual(["Kept.", "Last."]);
  });

  test("a new paragraph is the User's insertion, its paragraph mark too; a moved one their deletion where it was and insertion where it is", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph("One.") + paragraph("Two.") + paragraph("Three."),
    });
    editMind(client, ([one, two, three]) => [
      three as JSONContent,
      one as JSONContent,
      { type: "paragraph", content: [text("New.")] },
      two as JSONContent,
    ]);
    await client.settled();

    const document =
      unzip((await core.exportMind(mindId, tracking)).data)
        .get("word/document.xml")
        ?.toString("utf8") ?? "";

    expect(document).toMatch(
      /<w:p><w:pPr><w:rPr><w:ins w:id="\d+" w:author="Priya Raman"[^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">New.<\/w:t><\/w:r><\/w:ins><\/w:p>/,
    );
    // The body's last paragraph mark is never deleted: Word keeps an empty paragraph there.
    expect(acceptedParagraphs(document)).toEqual(["Three.", "One.", "New.", "Two.", ""]);
    expect([
      ...document.matchAll(/<w:delText xml:space="preserve">Three.<\/w:delText>/g),
    ]).toHaveLength(1);
  });

  test("bold turned on says what the run was (w:rPrChange), and a heading's new level what the paragraph was (w:pPrChange)", async () => {
    const { core, mindId, client } = await setUp({
      body:
        paragraph("Terms", { style: "Heading1" }) +
        paragraph(run("Rent is due monthly.", { font: "Georgia" })),
    });
    editMind(client, ([title, body]) => [
      { ...(title as JSONContent), attrs: { ...(title as JSONContent).attrs, level: 2 } },
      {
        ...(body as JSONContent),
        content: [text("Rent is due "), text("monthly", "bold"), text(".")],
      },
    ]);
    await client.settled();

    const document =
      unzip((await core.exportMind(mindId, tracking)).data)
        .get("word/document.xml")
        ?.toString("utf8") ?? "";

    expect(document).toMatch(
      /<w:pStyle w:val="Heading2"\/><w:pPrChange w:id="\d+" w:author="Priya Raman" w:date="[^"]+"><w:pPr><w:pStyle w:val="Heading1"\/><\/w:pPr><\/w:pPrChange>/,
    );
    expect(document).toMatch(
      /<w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"\/><w:b\/><w:bCs\/><w:rPrChange w:id="\d+" w:author="Priya Raman" w:date="[^"]+"><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"\/><\/w:rPr><\/w:rPrChange><\/w:rPr><w:t xml:space="preserve">monthly<\/w:t><\/w:r>/,
    );
    expect(document).not.toMatch(/<w:(ins|del) /);
  });

  test("a table's row added and one deleted are the User's row insertion and deletion", async () => {
    const { core, mindId, client } = await setUp({
      body: table([
        ["A1", "B1"],
        ["A2", "B2"],
      ]),
    });
    editMind(client, ([grid]) => {
      const rows = (grid as JSONContent).content ?? [];
      const cell = (value: string): JSONContent => ({
        type: "tableCell",
        content: [{ type: "paragraph", content: [text(value)] }],
      });
      return [
        {
          ...(grid as JSONContent),
          content: [
            rows[0] as JSONContent,
            { type: "tableRow", content: [cell("A3"), cell("B3")] },
            { type: "tableRow", content: [cell("A4"), cell("B4")] },
          ],
        },
      ];
    });
    await client.settled();

    const document =
      unzip((await core.exportMind(mindId, tracking)).data)
        .get("word/document.xml")
        ?.toString("utf8") ?? "";

    expect(document).toMatch(
      /<w:tr><w:trPr><w:del w:id="\d+" w:author="Priya Raman"[^>]*\/><\/w:trPr>/,
    );
    expect(document).toMatch(
      /<w:tr><w:trPr><w:ins w:id="\d+" w:author="Priya Raman"[^>]*\/><\/w:trPr>/,
    );
    expect([...document.matchAll(/<w:trPr><w:ins /g)]).toHaveLength(2);
    expect(acceptedParagraphs(document)).toEqual(["A1", "B1", "A3", "B3", "A4", "B4"]);
  });
});

describe("IncarnaMind's comments in an imported file (#107)", () => {
  test("AI text added gets IncarnaMind's comment, after the comments the file has", async () => {
    const remark = commented(0, "Lars Eklund", "Check the date.", run("Due in May."));
    const { core, mindId, client } = await setUp({
      body: paragraph(remark.inline),
      comments: remark.comment,
    });
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        content: [{ ...text("Rent rises with inflation."), marks: [{ type: "generated" }] }],
      },
    ]);
    await client.settled();

    const files = unzip((await core.exportMind(mindId, { format: "docx", markAiText: true })).data);
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";

    expect(
      [...comments.matchAll(/<w:comment w:id="(\d+)" w:author="([^"]+)"/g)].map((m) => m[2]),
    ).toEqual(["Lars Eklund", "IncarnaMind"]);
    const id = /<w:comment w:id="(\d+)" w:author="IncarnaMind"/.exec(comments)?.[1];
    expect(id).not.toBe("0");
    expect(document).toContain(`<w:commentRangeStart w:id="${id}"/>`);
    expect(document).toContain(`<w:commentReference w:id="${id}"/>`);
    expect(comments).toContain("Written by IncarnaMind");
  });
});

describe("The Word copy offered when quitting follows the User's answer about marking (#1536)", () => {
  // protects=the quit-time copy of a Mind with text IncarnaMind wrote carries the comment on it only when the User chose Mark it, and none with Leave it out or no answer yet; fails_when=it marks for an answer of "leave" or none, or leaves out the mark for "mark"; no_claim=the save dialog.
  test.each([
    { answer: "mark" as const, marked: true },
    { answer: "leave" as const, marked: false },
    { answer: null, marked: false },
  ])("with the answer $answer, the copy marked is $marked", async ({ answer, marked }) => {
    const { core, mindId, client } = await setUp({ body: paragraph(run("Due in May.")) });
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        content: [{ ...text("Rent rises with inflation."), marks: [{ type: "generated" }] }],
      },
    ]);
    await client.settled();
    const { user } = await core.getSettings();
    await core.updateSettings({
      user: {
        exportOptions: {
          ...user.exportOptions,
          docx: { ...user.exportOptions.docx, markAiText: answer },
        },
      },
    });

    const preferences = (await core.getSettings()).user.exportOptions;
    const files = unzip((await core.exportMind(mindId, quitCopyOptions(preferences))).data);
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";

    expect(comments.includes("Written by IncarnaMind")).toBe(marked);
  });
});

describe("sentences whose check isn't good, in an imported file (#900)", () => {
  const checked = (
    value: string,
    state: "contradicted" | "unsupported",
    says: string | null,
    unsupported: UnsupportedReason | null = null,
    more: Record<string, unknown> = {},
  ) => ({
    ...text(value),
    marks: [
      {
        type: "claimCheck",
        attrs: {
          id: `check-${state}-${value.length}`,
          request: "r1",
          action: "check-against-documents",
          state,
          reason: null,
          detail: null,
          text: value,
          evidence: null,
          says,
          unsupported,
          calculation: null,
          scope: { folderId: null, widened: false },
          versions: [],
          excluded: [],
          checkedAt: "2026-10-12T14:30:00.000Z",
          ...more,
        },
      },
    ],
  });

  test.each([
    {
      language: "en" as const,
      cited:
        "Unsupported: your Citation supports the moon phases, not the parts about the harbour.",
      own: "Unsupported: only your own working file says this.",
    },
    {
      language: "zh-CN" as const,
      cited: "无依据：引用支持the moon phases，但不支持the harbour的部分。",
      own: "无依据：只有你自己的工作文件这样写。",
    },
  ])(
    "$language: a cited sentence's comment says what its Citation supports, and one only the User's workings say says so, as their cards do",
    async ({ language, cited, own }) => {
      const { core, mindId, client } = await setUp({
        body:
          paragraph("Spring tides rise in the harbour.") + paragraph("Margins widened in 2026."),
      });
      const tides = await tidesDocument(core);
      await core.updateSettings({ user: { language } });
      editMind(client, ([first, second]) => [
        {
          ...(first as JSONContent),
          content: [
            checked(
              "Spring tides rise in the harbour",
              "unsupported",
              null,
              { reason: null, covered: "the moon phases", uncovered: "the harbour" },
              // The sentence as checked holds its Citation, as an inline node.
              { text: "Spring tides rise in the harbour\uFFFC." },
            ),
            citation(tides),
            text("."),
          ],
        },
        {
          ...(second as JSONContent),
          content: [
            checked("Margins widened in 2026.", "unsupported", null, null, {
              excluded: [
                { documentId: "workings", documentName: "Workings", reason: "own-workings" },
              ],
            }),
          ],
        },
      ]);
      await client.settled();

      const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
      const comments = textOf(unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "");

      expect(result.sentenceChecks).toMatchObject({ unsupported: 2, commented: true });
      expect(comments).toContain(cited);
      expect(comments).toContain(own);
    },
  );

  test.each([
    {
      language: "en" as const,
      cited: "Unsupported: Tides doesn’t mention the harbour.",
      found: "Unsupported: The report gives no margins.",
      nothing: "Not found: I didn’t find this in “All Documents”.",
    },
    {
      language: "zh-CN" as const,
      cited: "无依据：Tides doesn’t mention the harbour.",
      found: "无依据：The report gives no margins.",
      nothing: "未找到：未在“全部文档”中找到。",
    },
  ])(
    "$language: a cited sentence with no part named, and one whose check found a Passage, say Unsupported with the check's words, as their cards do; only one nothing in scope was about says Not found",
    async ({ language, cited, found, nothing }) => {
      const { core, mindId, client } = await setUp({
        body:
          paragraph("Spring tides rise in the harbour.") +
          paragraph("Margins widened in 2026.") +
          paragraph("Costs fell in 2025."),
      });
      const tides = await tidesDocument(core);
      await core.updateSettings({ user: { language } });
      const reason = (why: string, more: { found?: true } = {}) => ({
        reason: why,
        covered: null,
        uncovered: null,
        ...more,
      });
      editMind(client, ([first, second, third]) => [
        {
          ...(first as JSONContent),
          content: [
            checked(
              "Spring tides rise in the harbour",
              "unsupported",
              null,
              reason("Tides doesn’t mention the harbour."),
              { text: "Spring tides rise in the harbour\uFFFC." },
            ),
            citation(tides),
            text("."),
          ],
        },
        {
          ...(second as JSONContent),
          content: [
            checked(
              "Margins widened in 2026.",
              "unsupported",
              null,
              reason("The report gives no margins.", { found: true }),
            ),
          ],
        },
        {
          ...(third as JSONContent),
          content: [checked("Costs fell in 2025.", "unsupported", null)],
        },
      ]);
      await client.settled();

      const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
      const comments = textOf(unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "");

      expect(comments).toContain(cited);
      expect(comments).toContain(found);
      expect(comments).toContain(nothing);
      expect(comments.match(/Not found|未找到/g)).toHaveLength(1);
    },
  );

  test("each gets a comment on its own words, written into its paragraph; the others stay as they were", async () => {
    const { core, bytes, mindId, client } = await setUp({
      body:
        paragraph("Halden held cash of £192.9m.") +
        paragraph("Nothing to check here.") +
        paragraph("Margins widened in 2026."),
    });
    editMind(client, ([first, second, third]) => [
      {
        ...(first as JSONContent),
        content: [
          checked("Halden held cash of £192.9m.", "contradicted", "The report says £182.9m."),
        ],
      },
      second as JSONContent,
      {
        ...(third as JSONContent),
        content: [checked("Margins widened in 2026.", "unsupported", null)],
      },
    ]);
    await client.settled();

    const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
    const files = unzip(result.data);
    const comments = files.get("word/comments.xml")?.toString("utf8") ?? "";
    const document = files.get("word/document.xml")?.toString("utf8") ?? "";

    expect(result.sentenceChecks).toEqual({
      contradicted: 1,
      notFound: 1,
      unsupported: 0,
      needsRecheck: 0,
      commented: true,
    });
    expect([...comments.matchAll(/<w:comment /g)]).toHaveLength(2);
    expect(textOf(comments)).toContain("Contradicted: The report says £182.9m.");
    expect(textOf(comments)).toContain("Not found: I didn’t find this in “All Documents”.");
    const [first, second, third] = paragraphsIn(document);
    expect(first).toMatch(
      /<w:commentRangeStart w:id="(\d+)"\/>[\s\S]*Halden held cash of £192\.9m\.[\s\S]*<w:commentRangeEnd w:id="\1"\/>/,
    );
    expect(third).toMatch(
      /<w:commentRangeStart w:id="(\d+)"\/>[\s\S]*Margins widened in 2026\.[\s\S]*<w:commentRangeEnd w:id="\1"\/>/,
    );
    const before = paragraphsIn(unzip(bytes).get("word/document.xml")?.toString("utf8") ?? "");
    expect(second).toBe(before[1]);
  });

  const STAFF = "Staff may work from home two days a week.";
  const CLAUSE = "The Employee may work from home two days a week";
  const quoted: CitationAttributes = {
    passageId: "passage-1",
    documentId: "agreement",
    documentName: "Employment Agreement",
    contentHash: "hash-1",
    pageFrom: 1,
    pageTo: 1,
    location: null,
    quote: CLAUSE,
    check: "found",
    checkReason: null,
  };
  test.each([
    {
      language: "en" as const,
      covered: "home working two days a week",
      uncovered: "staff in general",
      covers: `Unsupported: your Documents support home working two days a week, not the parts about staff in general (“${CLAUSE}”, Employment Agreement, p. 1)`,
      nothing: "Not found: I didn’t find this in “All Documents”.",
    },
    {
      language: "zh-CN" as const,
      covered: "每周在家工作两天",
      uncovered: "全体员工",
      covers: `无依据：你的文档支持每周在家工作两天，但不支持全体员工的部分（“${CLAUSE}”，Employment Agreement，第 1 页）`,
      nothing: "未找到：未在“全部文档”中找到。",
    },
  ])(
    "$language: a sentence the check quoted a Passage for part of says what it supports, as its card does; one nothing backs keeps its words",
    async ({ language, covered, uncovered, covers, nothing }) => {
      const { core, mindId, client } = await setUp({
        body: paragraph(STAFF) + paragraph("Margins widened in 2026."),
      });
      await core.updateSettings({ user: { language } });
      editMind(client, ([first, second]) => [
        {
          ...(first as JSONContent),
          content: [
            checked(STAFF, "unsupported", null, { reason: null, covered, uncovered, quoted }),
          ],
        },
        {
          ...(second as JSONContent),
          content: [checked("Margins widened in 2026.", "unsupported", null)],
        },
      ]);
      await client.settled();

      const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
      const comments = textOf(unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "");

      expect(result.sentenceChecks).toMatchObject({
        unsupported: 1,
        notFound: 1,
        commented: true,
      });
      expect(comments).toContain(covers);
      expect(comments).toContain(nothing);
    },
  );

  test.each([
    {
      language: "en" as const,
      one: "Not found: I didn’t find this in “Okoro agreement”.",
      two: "Not found: I didn’t find this in “Okoro agreement” or 1 more.",
      changed: "Needs re-check: the Mind’s Search scope has changed since.",
    },
    {
      language: "zh-CN" as const,
      one: "未找到：未在“Okoro agreement”中找到。",
      two: "未找到：未在“Okoro agreement”等 2 项中找到。",
      changed: "需重新核对：这个 Mind 的搜索范围已更改。",
    },
  ])(
    // protects=the Word comment of a sentence checked in the Mind's chosen scope names that scope, as its card does, and one checked in another scope than the Mind's now needs a re-check (#1623); fails_when=it says All Documents, another wording than the card's, or keeps a verdict made elsewhere; no_claim=the card itself (e2e).
    "$language: a sentence checked in the Mind's chosen scope says where it looked, as its card does",
    async ({ language, one, two, changed }) => {
      const { core, mindId, client } = await setUp({
        body: paragraph("Margins widened in 2026.") + paragraph("Costs fell in 2025."),
      });
      await core.updateSettings({ user: { language } });
      const okoro = await core.saveTextAsDocument({ name: "Okoro agreement", text: "Notice." });
      const adeyemi = await core.saveTextAsDocument({ name: "Adeyemi agreement", text: "Leave." });
      const scopeOf = (documentIds: string[]) => ({ folderIds: [], tagIds: [], documentIds });
      const inScope = (value: string, documentIds: string[]) => {
        const marked = checked(value, "unsupported", null);
        const [mark] = marked.marks;
        if (!mark) throw new Error("No mark.");
        const scope = { folderId: null, widened: false, chosen: scopeOf(documentIds) };
        return { ...marked, marks: [{ ...mark, attrs: { ...mark.attrs, scope } }] };
      };
      editMind(client, ([first, second]) => [
        { ...(first as JSONContent), content: [inScope("Margins widened in 2026.", [okoro.id])] },
        {
          ...(second as JSONContent),
          content: [inScope("Costs fell in 2025.", [okoro.id, adeyemi.id])],
        },
      ]);
      const commentsWith = async (documentIds: string[]) => {
        setMindScope(client.doc, scopeOf(documentIds));
        await client.settled();
        const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
        return textOf(unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "");
      };

      const inOkoro = await commentsWith([okoro.id]);
      expect(inOkoro).toContain(one);
      expect(inOkoro).toContain(changed);
      const inBoth = await commentsWith([okoro.id, adeyemi.id]);
      expect(inBoth).toContain(two);
      expect(inBoth).toContain(changed);
      expect(inBoth).not.toContain(one);
    },
  );

  // protects=a Linked folder chosen as the Mind's scope is named by its own name in the Word comment, and a Folder deleted since still reads as deleted; fails_when=the Linked folder reads as a deleted Folder; no_claim=the card, which names it from the window's Folders.
  test("a sentence checked in a Linked folder chosen as the scope names that folder, and one in a Folder since deleted says it was deleted", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph("Leave is 30 days.") + paragraph("Margins widened in 2026."),
    });
    const notes = join(await createTempDataFolder(), "Notes");
    await writeSourceFile(notes, "Holiday.md", "# Holiday\n\nLeave is 25 days.\n");
    await linkAndProcess(core, notes);
    const linked = (await core.listFolders()).find((folder) => folder.name === "Notes");
    if (!linked) throw new Error("The Linked folder has no Folder.");
    const gone = await core.createLibraryGroup({ name: "Old harbours", description: "" });
    const inFolder = (value: string, folderId: string) => {
      const scope = { folderId: null, widened: false, chosen: folderScope(folderId) };
      return checked(value, "unsupported", null, null, { scope });
    };
    editMind(client, ([first, second]) => [
      { ...(first as JSONContent), content: [inFolder("Leave is 30 days.", linked.id)] },
      { ...(second as JSONContent), content: [inFolder("Margins widened in 2026.", gone.id)] },
    ]);
    await core.deleteLibraryGroup(gone.id);
    const commentsIn = async (folderId: string) => {
      setMindScope(client.doc, folderScope(folderId));
      await client.settled();
      const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: true });
      return textOf(unzip(result.data).get("word/comments.xml")?.toString("utf8") ?? "");
    };

    expect(await commentsIn(linked.id)).toContain("Not found: I didn’t find this in “Notes”.");
    expect(await commentsIn(gone.id)).toContain(
      "Not found: I didn’t find this in “Deleted Folder”.",
    );
  });

  test("with the option off the file is the one it was", async () => {
    const { core, bytes, mindId, client } = await setUp({
      body: paragraph("Halden held cash of £192.9m."),
    });
    editMind(client, ([first]) => [
      {
        ...(first as JSONContent),
        content: [
          checked("Halden held cash of £192.9m.", "contradicted", "The report says £182.9m."),
        ],
      },
    ]);
    await client.settled();

    const result = await core.exportMind(mindId, { format: "docx", commentFailedChecks: false });

    expect(changed(unzip(bytes), unzip(result.data))).toEqual([]);
    expect(result.sentenceChecks.commented).toBe(false);
  });
});

describe("Blocks added, deleted and moved", () => {
  test("a new paragraph with a Citation goes after the one before it, in its look; the Citation is a footnote", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph(run("Intro.", { font: "Georgia" })) + paragraph("Outro."),
    });
    const tides = await tidesDocument(core);
    editMind(client, ([first, last]) => [
      first as JSONContent,
      { type: "paragraph", content: [text("Tides are strongest at new moon. "), citation(tides)] },
      last as JSONContent,
    ]);
    await client.settled();
    const { document, part } = await exported(core, mindId);
    // As if Enter were pressed at the end of the paragraph before: its text's look.
    expect(paragraphsIn(document)[1]).toBe(
      '<w:p><w:r><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:t xml:space="preserve">Tides are strongest at new moon.</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>',
    );
    expect(part("word/footnotes.xml")).toContain("Tides");
    const styles = part("word/styles.xml");
    expect(styles).toContain('w:styleId="FootnoteText"');
    expect(styles).toContain('w:styleId="FootnoteReference"');
    expect(part("[Content_Types].xml")).toContain(
      '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>',
    );
  });

  test("in a citation style, a new Citation is written in the text and the Bibliography goes at the end", async () => {
    const { core, mindId, client } = await setUp({ body: paragraph("Intro.") });
    const tides = await tidesDocument(core);
    await core.setMindCitationStyle(mindId, "apa");
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        content: [text("Tides are strongest at new moon "), citation(tides), text(".")],
      },
    ]);
    await client.settled();
    const { document, files } = await exported(core, mindId);
    const paragraphs = paragraphsIn(document);
    expect(textOf(paragraphs[1] ?? "")).toBe("Tides are strongest at new moon (Tides, n.d.).");
    expect(textOf(paragraphs.at(-2) ?? "")).toBe("References");
    // A Document with no details is listed by its name alone, never a placeholder (#1910).
    expect(textOf(paragraphs.at(-1) ?? "")).toBe("Tides.");
    expect(document).not.toContain("needs details");
    expect(document).toMatch(/<\/w:p><w:sectPr>/);
    expect(files.has("word/footnotes.xml")).toBe(false);
  });

  test("a reused Citation's bookmark takes a name the file doesn't already have (#1552)", async () => {
    const footnoteMark =
      '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>';
    const ownBookmark =
      '<w:bookmarkStart w:id="7" w:name="_Ref900000002"/><w:bookmarkEnd w:id="7"/>';
    const { core, mindId, client } = await setUp({
      body: paragraph(`${ownBookmark}${run("Noted")}${footnoteMark}${run(".")}`),
      footnotes: `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${run(" A note.")}</w:p></w:footnote>`,
    });
    const tides = await tidesDocument(core);
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", content: [text("Tides rise. "), citation(tides)] },
      { type: "paragraph", content: [text("Again. "), citation(tides)] },
    ]);
    await client.settled();
    const { document } = await exported(core, mindId);
    const names = [...document.matchAll(/<w:bookmarkStart\b[^>]*w:name="([^"]+)"/g)].map(
      (found) => found[1],
    );
    expect(names.filter((name) => name === "_Ref900000002")).toHaveLength(1);
    expect(names).toContain("_Ref900000002_2");
    expect(/NOTEREF (_Ref\S+) \\f \\h /.exec(document)?.[1]).toBe("_Ref900000002_2");
  });

  test("with the list at the end, a new Citation is [1] in the text and the file's own footnote stays", async () => {
    const footnoteMark =
      '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>';
    const { core, mindId, client } = await setUp({
      body: paragraph(`${run("Noted")}${footnoteMark}${run(".")}`),
      footnotes: `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${run(" A note.")}</w:p></w:footnote>`,
    });
    const tides = await tidesDocument(core);
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        content: [text("Tides are strongest at new moon "), citation(tides), text(".")],
      },
    ]);
    await client.settled();
    const result = await core.exportMind(mindId, { format: "docx", citationPlace: "list" });
    const files = unzip(result.data);
    const part = (name: string) => files.get(name)?.toString("utf8") ?? "";
    const written = paragraphsIn(part("word/document.xml"));
    const paragraphs = written.map(textOf);

    expect(written[0]).toContain(footnoteMark);
    expect(paragraphs[1]).toBe("Tides are strongest at new moon [1].");
    expect(paragraphs.slice(-2)).toEqual(["Bibliography", "[1]\tTides"]);
    expect(part("word/document.xml").match(/<w:footnoteReference/g)).toHaveLength(1);
    expect(part("word/footnotes.xml")).toContain("A note.");
    expect(part("word/footnotes.xml")).not.toContain("Tides");
  });

  test("with the list at the end, Citations in changes still waiting are markers in the tracked insertion and deletion, and each has its entry", async () => {
    const { core, mindId, client } = await setUp({ body: paragraph("Intro.") });
    const tides = await tidesDocument(core);
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        attrs: { proposal: { id: "c1", request: "r1", kind: "insert" } },
        content: [text("Proposed "), citation(tides)],
      },
      {
        type: "paragraph",
        attrs: { proposal: { id: "c2", request: "r1", kind: "delete" } },
        content: [text("Removed "), citation(tides)],
      },
    ]);
    await client.settled();

    const result = await core.exportMind(mindId, { format: "docx", citationPlace: "list" });
    const document = unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "";

    expect(document.match(/<w:ins [^>]*>[\s\S]*?<\/w:ins>/g)?.join("")).toContain("[1]");
    expect(document.match(/<w:del [^>]*>[\s\S]*?<\/w:del>/g)?.join("")).toContain("[1]");
    const paragraphs = paragraphsIn(document).map(textOf);
    expect(paragraphs.slice(-2)).toEqual(["Bibliography", "[1]\tTides"]);
    expect(document).not.toContain("w:footnoteReference");
  });

  test("an empty document takes new paragraphs before its section's properties", async () => {
    const { core, mindId, client } = await setUp({ body: "" });
    editMind(client, () => [{ type: "paragraph", content: [text("First words.")] }]);
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).toContain(
      '<w:body><w:p><w:r><w:t xml:space="preserve">First words.</w:t></w:r></w:p><w:sectPr>',
    );
  });

  test("a deleted paragraph goes, and a moved one moves as it was written", async () => {
    const one = paragraph("One.", { paraId: "00000001" });
    const two = paragraph("Two.", { paraId: "00000002" });
    const three = paragraph("Three.", { paraId: "00000003" });
    const { core, mindId, client } = await setUp({ body: one + two + three });
    editMind(client, ([first, , third]) => [third as JSONContent, first as JSONContent]);
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).toContain(`<w:body>${three}${one}<w:sectPr>`);
  });

  test("a deleted section break leaves its paragraph in the next section, with no properties of its own, and the rest as it was", async () => {
    const one = paragraph("One.", {
      paraId: "00000001",
      sectPr: '<w:sectPr><w:pgSz w:orient="landscape"/></w:sectPr>',
    });
    const two = paragraph("Two.", { paraId: "00000002" });
    const { core, mindId, client } = await setUp({ body: one + two });
    editMind(client, ([first, ...rest]) => [
      {
        ...first,
        content: (first?.content ?? []).filter((node) => node.type !== WORD_ATOM_NODE),
      } as JSONContent,
      ...rest,
    ]);
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).not.toContain("landscape");
    expect(document).toContain(
      `<w:body>${paragraph("One.", { paraId: "00000001" })}${two}<w:sectPr>`,
    );
  });

  test("a new item in a list goes on with the list's own numbering", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph("First", { numId: 2 }) + paragraph("Second", { numId: 2 }),
      numbering: NUMBERING,
    });
    editMind(client, ([list]) => [{ ...list, content: [...(list?.content ?? []), item("Third")] }]);
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(paragraphsIn(document).at(-1)).toBe(
      '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Third</w:t></w:r></w:p>',
    );
  });

  test("a new list is a list of its own in the document's numbering, after those it has", async () => {
    const { core, mindId, client, bytes } = await setUp({
      body: paragraph("Text."),
      numbering: NUMBERING,
    });
    editMind(client, (blocks) => [
      ...blocks,
      { type: "orderedList", attrs: { start: 1 }, content: [item("New")] },
    ]);
    await client.settled();
    const { document, part } = await exported(core, mindId);
    expect(document).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>');
    const numbering = part("word/numbering.xml");
    const original = unzip(bytes).get("word/numbering.xml")?.toString("utf8") ?? "";
    // The document's own lists are as they were: the new definition follows its definitions, the new list its lists.
    expect(numbering).toContain(
      original.slice(original.indexOf("<w:abstractNum "), original.indexOf("<w:num ")),
    );
    expect(numbering.indexOf('w:abstractNumId="2"')).toBeLessThan(
      numbering.indexOf('<w:num w:numId="1">'),
    );
    expect(numbering).toContain('<w:num w:numId="3"><w:abstractNumId w:val="2"/>');
  });

  test("a table is written into cell by cell; a new row writes it again, its properties kept", async () => {
    const { core, mindId, client } = await setUp({
      body: table([
        ["A", "B"],
        ["C", "D"],
      ]),
    });
    editText(client, (value) => (value === "D" ? "D, edited" : value));
    await client.settled();
    let { document } = await exported(core, mindId);
    expect(document).toContain(`${paragraph("A")}</w:tc><w:tc>${paragraph("B")}`);
    expect(document).toContain("D, edited");

    editMind(client, ([grid, ...rest]) => [
      {
        ...grid,
        content: [
          ...(grid?.content ?? []),
          {
            type: "tableRow",
            content: ["E", "F"].map((cell) => ({
              type: "tableCell",
              content: [{ type: "paragraph", content: [text(cell)] }],
            })),
          },
        ],
      },
      ...rest,
    ]);
    await client.settled();
    ({ document } = await exported(core, mindId));
    expect(document).toContain('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>');
    expect([...document.matchAll(/<w:tr>/g)]).toHaveLength(3);
    expect(document).toMatch(/E<\/w:t>[\s\S]*F<\/w:t>/);
  });

  test("a new picture is a media part of its own, with its relationship, content type and a drawing id the document hasn't used", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph(
        '<w:r><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/><wp:docPr id="7" name="Existing"/></wp:anchor></w:drawing></w:r>',
      ),
    });
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        content: [
          {
            type: "image",
            attrs: { src: `data:image/png;base64,${PNG.toString("base64")}`, alt: "A dot" },
          },
        ],
      },
    ]);
    await client.settled();
    const { files, part, document } = await exported(core, mindId);
    expect(files.get("word/media/image1.png")?.equals(PNG)).toBe(true);
    expect(part("[Content_Types].xml")).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
    expect(document).toContain('<wp:docPr id="1" name="Picture 1" descr="A dot"/>');
    expect([...document.matchAll(/<wp:docPr id="7"/g)]).toHaveLength(1);
  });
});

describe("what can't be kept", () => {
  test("someone's comment on a paragraph the User deleted is said before saving, and goes only once they say so", async () => {
    const { inline, comment } = commented(
      5,
      "Lars Eklund",
      "Check duty rates first",
      run("Duty adds 12%."),
    );
    const { core, mindId, client } = await setUp(
      { body: paragraph("Keep.") + paragraph(inline), comments: comment },
      "someone-else",
    );
    const output = await createTempDataFolder();
    await core.setOutputLocation(output);
    editMind(client, (blocks) => blocks.slice(0, 1));
    await client.settled();

    const review = await core.saveMindExport(mindId, { format: "docx" });
    expect(review).toEqual({
      status: "review",
      word: {
        notKept: [
          {
            key: expect.stringMatching(/^comment:/),
            kind: "comment",
            author: "Lars Eklund",
            text: "Check duty rates first",
          },
        ],
        unknownParts: [],
        keptFurniture: [],
      },
    });
    expect(await readdir(output)).toEqual([]);

    if (review.status !== "review") throw new Error("Not a review.");
    const saved = await core.saveMindExport(mindId, {
      format: "docx",
      accept: review.word.notKept.map((loss) => loss.key),
    });
    expect(saved).toMatchObject({ status: "saved", file: { name: "Memo.docx" } });
    const { document } = await exported(core, mindId);
    expect(document).not.toContain("comment");
  });

  test("a deleted header stays in the file, and is listed", async () => {
    const { core, mindId, client, bytes } = await setUp({
      body: paragraph("Body."),
      headers: { rIdH1: paragraph("Confidential") },
      sectPr: '<w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="11906" w:h="16838"/>',
    });
    editMind(client, (blocks) => blocks.filter((block) => block.type !== "wordBlock"));
    await client.settled();
    const { files, word } = await exported(core, mindId);
    expect(word?.keptFurniture).toEqual(["header"]);
    expect(changed(unzip(bytes), files)).toEqual([]);
  });

  test("a part that can't be written stops the export, naming it, and nothing is saved", async () => {
    const files = unzip(wordFile({ body: paragraph("Cafe.") }));
    const original = files.get("word/document.xml") ?? Buffer.alloc(0);
    // A byte that isn't UTF-8 in the main part: its text can't be written back without changing it.
    const at = original.indexOf("Cafe") + 3;
    const broken = Buffer.concat([
      original.subarray(0, at),
      Buffer.from([0xe9]),
      original.subarray(at + 1),
    ]);
    const bytes = buildZip(
      [...files].map(([name, data]) => ({
        name,
        data: name === "word/document.xml" ? broken : data,
      })),
    );
    const core = startCore(await createTempDataFolder());
    const { mindId, client } = await importFile(core, bytes);
    const output = await createTempDataFolder();
    await core.setOutputLocation(output);
    editText(client, (value) => `${value} Edited.`);
    await client.settled();
    await expect(core.saveMindExport(mindId, { format: "docx" })).rejects.toThrow(
      "word/document.xml",
    );
    expect(await readdir(output)).toEqual([]);
  });
});

describe("Word's rules", () => {
  test("a new footnote's id is one the document hasn't used, below 0x80000000; the document's own start tag stays", async () => {
    const { core, mindId, client, bytes } = await setUp({
      body: paragraph(
        `${run("Text.")}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`,
      ),
      footnotes: `<w:footnote w:id="1"><w:p>${run("Old.")}</w:p></w:footnote>`,
    });
    const tides = await tidesDocument(core);
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", content: [text("New."), citation(tides)] },
    ]);
    await client.settled();
    const { document, part } = await exported(core, mindId);
    const ids = [...part("word/footnotes.xml").matchAll(/<w:footnote\b[^>]*w:id="(-?\d+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(ids).toEqual([-1, 0, 1, 2]);
    const original = unzip(bytes).get("word/document.xml")?.toString("utf8") ?? "";
    const head = (xml: string) => xml.slice(0, xml.indexOf("<w:body>"));
    expect(head(document)).toBe(head(original));
  });

  test("a Citation of a source and place the document already cites in a new paragraph is a cross-reference to that note, numbered after the document's own", async () => {
    const { core, mindId, client } = await setUp({
      body: paragraph(
        `${run("Text.")}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`,
      ),
      footnotes: `<w:footnote w:id="1"><w:p>${run("Old.")}</w:p></w:footnote>`,
    });
    const tides = await tidesDocument(core);
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", content: [text("New."), citation(tides)] },
      { type: "paragraph", content: [text("Again."), citation(tides)] },
    ]);
    await client.settled();
    const { document, part } = await exported(core, mindId);
    const ids = [...part("word/footnotes.xml").matchAll(/<w:footnote\b[^>]*w:id="(-?\d+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(ids).toEqual([-1, 0, 1, 2]);
    const bookmark =
      /<w:bookmarkStart w:id="(\d+)" w:name="(_Ref\d+)"\/>(<w:r>(?:(?!<\/w:r>).)*<w:footnoteReference w:id="2"\/><\/w:r>)<w:bookmarkEnd w:id="\1"\/>/.exec(
        document,
      );
    expect(bookmark).not.toBeNull();
    expect(document).toContain(`NOTEREF ${bookmark?.[2]} \\f \\h `);
    // The document's own note is 1 and the new one 2, which the reference shows until Word updates it.
    expect(document).toMatch(
      /w:fldCharType="separate"\/><\/w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"\/><\/w:rPr><w:t>2<\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="end"\/>/,
    );
    expect(document).not.toContain("⟦");
    const taken = [...document.matchAll(/<w:bookmarkStart w:id="(\d+)"/g)].map((match) => match[1]);
    expect(new Set(taken).size).toBe(taken.length);
  });

  test("an export that cites a source again imports as a Word file: the note is a footnote, each cross-reference a field with its number, and nothing changes on the way back", async () => {
    const core = startCore(await createTempDataFolder());
    const tides = await tidesDocument(core);
    const mind = await core.createMind({ title: "Memo" });
    const author = await connectToMind(core, mind.id);
    writeMind(author, [
      { type: "paragraph", content: [text("One."), citation(tides)] },
      { type: "paragraph", content: [text("Two."), citation(tides)] },
      { type: "paragraph", content: [text("Three."), citation(tides)] },
    ]);
    await author.settled();
    const made = await core.exportMind(mind.id, { format: "docx" });
    const { mindId, client } = await importFile(core, Buffer.from(made.data));

    const atoms: { kind?: unknown; label?: unknown; info?: unknown }[] = [];
    const visit = (node: JSONContent) => {
      if (node.type === WORD_ATOM_NODE) atoms.push(node.attrs ?? {});
      for (const child of node.content ?? []) visit(child);
    };
    visit(readMind(client).toJSON());
    // The bookmark around the note's mark, both ends, and what the file has of the rest.
    expect(atoms.filter((atom) => atom.kind === "bookmark")).toHaveLength(2);
    const shown = atoms.filter((atom) => atom.kind !== "bookmark");
    expect(shown.map((atom) => [atom.kind, atom.label])).toEqual([
      ["footnote", "1"],
      ["field", "1"],
      ["field", "1"],
    ]);
    expect(shown.slice(1).map((atom) => atom.info)).toEqual([
      { field: "NOTEREF" },
      { field: "NOTEREF" },
    ]);

    const before = unzip(made.data);
    const back = await exported(core, mindId);
    expect(changed(before, back.files)).toEqual([]);
  });

  test("a table nested 2,000 deep keeps its depth, and every cell still ends with a paragraph when the one after the nested table goes", async () => {
    const { core, mindId, client } = await setUp({
      body: nestedTable(0, NESTED, (level) => paragraph(`After level ${level}`)),
    });
    const withoutAfter = (node: JSONContent): JSONContent => ({
      ...node,
      ...(node.content && {
        content: node.content
          .filter((each) => each.content?.[0]?.text !== "After level 0")
          .map(withoutAfter),
      }),
    });
    editMind(client, (blocks) => blocks.map(withoutAfter));
    editText(client, (value) => (value === "Level 0" ? "Level 0, edited" : value));
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).toContain("Level 0, edited");
    expect(document).not.toContain("After level 0");
    expect(document).toContain("After level 1");
    const { lastInCell, depth } = cellEndsAndDepth(document);
    expect(depth).toBe(NESTED);
    expect(lastInCell).toHaveLength(NESTED);
    expect(new Set(lastInCell)).toEqual(new Set(["w:p"]));
  });

  test("a cell that ended with its nested table in the file still does, the table byte for byte and as deep", async () => {
    const { core, mindId, client } = await setUp({ body: nestedTable(0, NESTED, () => "") });
    editText(client, (value) => (value === "Level 0" ? "Level 0, edited" : value));
    await client.settled();
    const { document } = await exported(core, mindId);
    expect(document).toContain("Level 0, edited");
    expect(document).toContain(`${nestedTable(1, NESTED, () => "")}</w:tc>`);
    expect(cellEndsAndDepth(document).depth).toBe(NESTED);
  });
});

const NESTED = 2_000;

function nestedTable(
  fromLevel: number,
  untilLevel: number,
  afterNested: (level: number) => string,
): string {
  let inner = "";
  for (let level = untilLevel - 1; level >= fromLevel; level--) {
    inner = table([[`${paragraph(`Level ${level}`)}${inner && inner + afterNested(level)}`]]);
  }
  return inner;
}

function cellEndsAndDepth(xml: string): { lastInCell: string[]; depth: number } {
  const lastInCell: string[] = [];
  let depth = 0;
  const stack: [XmlElement, number][] = [[parseXml(xml), 0]];
  for (let at = stack.pop(); at; at = stack.pop()) {
    const [element, outside] = at;
    const tables = element.name === "w:tbl" ? outside + 1 : outside;
    depth = Math.max(depth, tables);
    if (element.name === "w:tc") lastInCell.push(elements(element).at(-1)?.name ?? "");
    for (const each of elements(element)) stack.push([each, tables]);
  }
  return { lastInCell, depth };
}
