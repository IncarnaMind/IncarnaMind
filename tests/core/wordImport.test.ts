/**
 * Importing a Word file as a Mind (#104), through the core's public interface:
 * what becomes editable, what is kept as is, where each node came from, what
 * is refused before any Mind is made, whose document it is, and that the Mind
 * survives a reload, sync, and a quit halfway.
 */
import { readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { updateYFragment } from "@tiptap/y-tiptap";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type Core,
  MIND_TEXT_ORIGINS_FIELD,
  type WordAtomAttributes,
  type WordRefusalReason,
} from "../../src/core";
import { WORD_PACKAGES_FOLDER } from "../../src/core/wordImports";
import { pendingProposals, proposalRequestOf } from "../../src/shared/proposals";
import {
  wordFileOf,
  wordFingerprint,
  wordImportProgressOf,
  wordReportOf,
  wordSourceOf,
} from "../../src/shared/wordFiles";
import { createTempDataFolder, nextTurn, queryDatabase, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, shownWithChanges } from "../helpers/minds";
import { encryptedOfficeFile, legacyOfficeFile } from "../helpers/office";
import {
  commented,
  field,
  NUMBERING,
  PNG,
  paragraph,
  picture,
  run,
  table,
  textBox,
  tracked,
  wordFile,
} from "../helpers/word";
import { buildZip } from "../helpers/zip";

async function saveFile(dataDir: string, name: string, bytes: Buffer): Promise<string> {
  const path = join(dataDir, name);
  await writeFile(path, bytes);
  return path;
}

/** Imports the file and waits until every Block is in the Mind; returns a client of the Mind. */
async function importFile(
  core: Core,
  path: string,
  origin: "own" | "someone-else" = "own",
): Promise<{ mindId: string; client: MindClient }> {
  const result = await core.importWordFile({ path, origin });
  if (!result.ok) throw new Error(`Refused: ${result.refusal}`);
  const client = await connectToMind(core, result.mind.id);
  await importDone(client);
  return { mindId: result.mind.id, client };
}

/** Waits until the Mind's import has written all its Blocks. */
function importDone(client: MindClient): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (wordFileOf(client.doc) && wordImportProgressOf(client.doc) === null) {
        client.doc.off("update", check);
        resolve();
      }
    };
    client.doc.on("update", check);
    check();
  });
}

/** The Mind's top-level Blocks as the editor reads them, ids and the Word look left out. */
function blocksOf(client: MindClient): JSONContent[] {
  const strip = (node: JSONContent): JSONContent => {
    const attrs = Object.fromEntries(
      Object.entries(node.attrs ?? {}).filter(
        ([key, value]) =>
          value !== null && !["id", "includeInContext", "proposal", "wordLook"].includes(key),
      ),
    );
    const marks = node.marks?.map((mark) => mark.type).filter((mark) => mark !== "wordRun");
    return {
      type: node.type,
      ...(Object.keys(attrs).length > 0 && { attrs }),
      ...(node.text !== undefined && { text: node.text }),
      ...(marks && marks.length > 0 && { marks: marks as unknown as JSONContent["marks"] }),
      ...(node.content && { content: joinTexts(node.content.map(strip)) }),
    };
  };
  return (readMind(client).toJSON().content ?? []).map(strip);
}

function joinTexts(content: JSONContent[]): JSONContent[] {
  const joined: JSONContent[] = [];
  for (const node of content) {
    const last = joined.at(-1);
    if (
      node.type === "text" &&
      last?.type === "text" &&
      JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      joined[joined.length - 1] = { ...last, text: `${last.text ?? ""}${node.text ?? ""}` };
    } else {
      joined.push(node);
    }
  }
  return joined;
}

/** Every atom in the Mind, in order: inline and as Blocks. */
function atomsOf(client: MindClient): WordAtomAttributes[] {
  const atoms: WordAtomAttributes[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === "wordAtom" || node.type.name === "wordBlock") {
      atoms.push(node.attrs as WordAtomAttributes);
    }
  });
  return atoms;
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const marked = (value: string, ...marks: string[]): JSONContent => ({
  type: "text",
  text: value,
  marks: marks as unknown as JSONContent["marks"],
});
const para = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

describe("a Word file becomes a Mind", () => {
  test("headings, paragraphs with their formatting, lists, tables with merged cells, pictures and links are editable", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(
      dataDir,
      "Market entry memo.docx",
      wordFile({
        body: [
          paragraph("Market entry memo", { style: "Title" }),
          paragraph("Summary", { style: "Heading1" }),
          paragraph(
            `${run("Velomark should ")}${run("enter", { b: true })}${run(" Germany ", { i: true })}${run("in 2027", { u: true, strike: true })}${run(".", { highlight: true })}`,
          ),
          paragraph(
            `${run("See ")}<w:hyperlink r:id="rIdLink">${run("the study")}</w:hyperlink>${run(" and ")}<w:hyperlink w:anchor="_Toc1">${run("Options")}</w:hyperlink>`,
          ),
          paragraph("Partners", { numId: 1 }),
          paragraph("Velo Haus", { numId: 1, ilvl: 1 }),
          paragraph("Step one", { numId: 2 }),
          paragraph("Between the steps"),
          paragraph("Step two", { numId: 2 }),
          table([
            [
              '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Both</w:t></w:r></w:p>',
              '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Tall</w:t></w:r></w:p>',
            ],
            ["A", "B", "<w:tcPr><w:vMerge/></w:tcPr><w:p/>"],
          ]),
          paragraph(`${run("A dot: ")}${picture("rIdImage", "A small dot")}`),
          paragraph("一、市场进入"),
          `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc>${paragraph("Clause")}</w:tc></w:tr><w:tr><w:tc>${paragraph("8.2")}</w:tc></w:tr></w:tbl>`,
        ].join(""),
        numbering: NUMBERING,
        media: { rIdImage: { name: "media/image1.png", data: PNG } },
        rels: '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/study" TargetMode="External"/>',
      }),
    );

    const { mindId, client } = await importFile(core, path);

    expect((await core.listMinds()).find((mind) => mind.id === mindId)?.title).toBe(
      "Market entry memo",
    );
    const blocks = blocksOf(client);
    expect(blocks.slice(0, 3)).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [text("Market entry memo")] },
      { type: "heading", attrs: { level: 1 }, content: [text("Summary")] },
      para(
        text("Velomark should "),
        marked("enter", "bold"),
        marked(" Germany ", "italic"),
        marked("in 2027", "strike", "underline"),
        marked(".", "highlight"),
      ),
    ]);
    const links = readMind(client)
      .child(3)
      .content.content.flatMap((node) => node.marks.filter((mark) => mark.type.name === "link"))
      .map((mark) => mark.attrs.href);
    expect(links).toEqual(["https://example.org/study", "#_Toc1"]);
    expect(blocks.slice(4, 8)).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para(text("Partners")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [para(text("Velo Haus"))] }],
              },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 1 },
        content: [{ type: "listItem", content: [para(text("Step one"))] }],
      },
      para(text("Between the steps")),
      // Word goes on counting after the paragraph between: the list starts where Word's numbers are.
      {
        type: "orderedList",
        attrs: { start: 2 },
        content: [{ type: "listItem", content: [para(text("Step two"))] }],
      },
    ]);
    const cell = (value: string, colspan = 1, rowspan = 1) => ({
      type: "tableCell",
      attrs: { colspan, rowspan },
      content: [value ? para(text(value)) : { type: "paragraph" }],
    });
    expect(blocks[8]).toEqual({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("Both", 2), cell("Tall", 1, 2)] },
        { type: "tableRow", content: [cell("A"), cell("B")] },
      ],
    });
    const image = readMind(client).child(9).child(1);
    expect(image.type.name).toBe("image");
    expect(image.attrs).toMatchObject({ alt: "A small dot", width: 100, height: 50 });
    expect(image.attrs.src).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    // Typed numbering stays text.
    expect(blocks[10]).toEqual(para(text("一、市场进入")));
    // A row Word repeats on each page is a heading row; the others aren't.
    expect(blocks[11]).toEqual({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ ...cell("Clause"), type: "tableHeader" }],
        },
        { type: "tableRow", content: [cell("8.2")] },
      ],
    });

    expect(wordReportOf(client.doc)).toMatchObject({
      paragraphs: 17,
      headings: 2,
      listItems: 4,
      tables: 2,
      images: 1,
      links: 2,
      kept: {},
      changes: 0,
      comments: 0,
      sections: 1,
    });
  });

  test("fields, controls, text boxes, shapes, equations, footnotes, headers and footers are kept as they are, their text read", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(
      dataDir,
      "Lease.docx",
      wordFile({
        body: [
          paragraph(`${run("Date: ")}${field('DATE \\@ "d MMMM yyyy"', "9 October 2026")}`),
          paragraph(
            `${run("Party: ")}<w:sdt><w:sdtPr><w:alias w:val="Tenant"/></w:sdtPr><w:sdtContent>${run("Fenwick Studios")}</w:sdtContent></w:sdt><w:fldSimple w:instr=" PAGE ">${run("7")}</w:fldSimple>`,
          ),
          paragraph(textBox(["At a glance", "Route: a partner"])),
          paragraph(
            `${run("Energy ")}<m:oMath><m:r><m:t>E=mc</m:t></m:r></m:oMath>${run(" holds.")}<w:r><w:footnoteReference w:id="1"/></w:r>`,
          ),
          '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Contents</w:t></w:r></w:p><w:p><w:r><w:t>1 Summary</w:t></w:r></w:p></w:sdtContent></w:sdt>',
          '<w:altChunk r:id="rIdChunk"/>',
          paragraph(`${run("Kept: ")}<w:unknownThing><w:r><w:t>odd</w:t></w:r></w:unknownThing>`),
          `<w:p><w:pPr><w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/></w:sectPr></w:pPr>${run("End of section one.")}</w:p>`,
        ].join(""),
        footnotes: `<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r>${run(" Einstein, 1905.")}</w:p></w:footnote>`,
        headers: { rIdH1: paragraph("SUBJECT TO CONTRACT") },
        footers: { rIdF1: paragraph(`${run("Page ")}${field("PAGE", "1")}`) },
      }),
    );

    const { mindId, client } = await importFile(core, path);

    const atoms = atomsOf(client).map(({ kind, label, text: atomText, source, info }) => ({
      kind,
      label,
      text: atomText,
      source,
      ...(info && { info }),
    }));
    expect(atoms).toEqual([
      { kind: "header", label: "", text: "SUBJECT TO CONTRACT", source: "word/header1.xml" },
      {
        kind: "field",
        label: "9 October 2026",
        text: "",
        source: "w:r#1..w:r#5",
        info: { field: "DATE" },
      },
      { kind: "control", label: "Fenwick Studios", text: "", source: "w:sdt#0" },
      { kind: "field", label: "7", text: "", source: "w:fldSimple#0", info: { field: "PAGE" } },
      {
        kind: "textBox",
        label: "",
        text: "At a glance\nRoute: a partner",
        source: "mc:AlternateContent#0",
        info: { display: true },
      },
      { kind: "equation", label: "E=mc", text: "", source: "m:oMath#0" },
      { kind: "footnote", label: "1", text: "Einstein, 1905.", source: "w:footnoteReference#0" },
      {
        kind: "control",
        label: "",
        text: "Contents\n1 Summary",
        source: "w:sdt#1",
        info: { field: "TOC" },
      },
      { kind: "other", label: "", text: "", source: "w:altChunk#0" },
      { kind: "other", label: "odd", text: "", source: "w:unknownThing#0" },
      { kind: "sectionBreak", label: "", text: "", source: "w:sectPr#0" },
      { kind: "footer", label: "", text: "Page 1", source: "word/footer1.xml" },
    ]);
    expect(wordReportOf(client.doc)?.kept).toEqual({
      field: 2,
      control: 2,
      textBox: 1,
      equation: 1,
      footnote: 1,
      other: 2,
      sectionBreak: 1,
      header: 1,
      footer: 1,
    });

    // Their text is read, as a text box's is for Questions: the exports read a Mind the same way.
    const markdown = new TextDecoder().decode(
      (await core.exportMind(mindId, { format: "markdown" })).data,
    );
    for (const shown of [
      "SUBJECT TO CONTRACT",
      "Date: 9 October 2026",
      "Party: Fenwick Studios7",
      "At a glance",
      "Route: a partner",
      "Energy E=mc holds.",
      "Einstein, 1905.",
      "1 Summary",
      "Page 1",
    ]) {
      expect(markdown).toContain(shown);
    }
  });

  test("bookmarks and section breaks are invisible marks, comments are kept read-only, and someone else's tracked changes wait to be accepted or rejected, with their author and date", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const comment = commented(0, "Marcus Hale", "We can't accept this.", run("vacant possession"));
    const path = await saveFile(
      dataDir,
      "Draft 4.docx",
      wordFile({
        body: [
          '<w:bookmarkStart w:id="0" w:name="_Toc1"/>',
          paragraph("Break clause", { style: "Heading1" }),
          '<w:bookmarkEnd w:id="0"/>',
          paragraph(
            `${run("Gives up ")}${comment.inline}${tracked("ins", 5, "Priya Nair", " in full")}${tracked("del", 6, "Priya Nair", " substantially")}${run(".")}`,
          ),
          paragraph(`${run("Next page.")}<w:r><w:br w:type="page"/></w:r>`, {
            sectPr: '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>',
          }),
        ].join(""),
        comments: comment.comment,
      }),
    );

    const { mindId, client } = await importFile(core, path, "someone-else");

    const shown = readMind(client);
    expect(shown.child(0).textContent).toBe("Break clause");
    const kinds = atomsOf(client).map((atom) => [atom.kind, atom.label, atom.info]);
    expect(kinds).toEqual([
      ["bookmark", "", { name: "_Toc1" }],
      ["bookmark", "", null],
      ["range", "", null],
      ["range", "", null],
      ["comment", "", { author: "Marcus Hale", date: "2026-10-02T09:00:00Z" }],
      ["pageBreak", "", null],
      ["sectionBreak", "", null],
    ]);
    const commentAtom = atomsOf(client).find((atom) => atom.kind === "comment");
    expect(commentAtom?.text).toBe("We can't accept this.");

    // The bookmark, the comment's range and its mark are invisible marks (U+FFFC here).
    expect(shownWithChanges(client)[1]).toBe(
      "\uFFFCGives up \uFFFCvacant possession\uFFFC\uFFFC{+ in full+}[- substantially-].",
    );
    const changes = pendingProposals(client.blocks).map((change) =>
      proposalRequestOf(client.doc, change.request),
    );
    expect(changes).toEqual([
      { source: "word-change", author: "Priya Nair", date: "2026-10-02T09:00:00Z" },
      { source: "word-change", author: "Priya Nair", date: "2026-10-02T09:00:00Z" },
    ]);

    // An export shows them as changes, with who made each (#734); no comment is in the text.
    const markdown = new TextDecoder().decode(
      (await core.exportMind(mindId, { format: "markdown" })).data,
    );
    expect(markdown).toContain(
      "Gives up vacant possession{++ in full++}{>>Inserted by Priya Nair, 2 Oct 2026<<}{-- substantially--}{>>Deleted by Priya Nair, 2 Oct 2026<<}.",
    );
    expect(markdown).not.toContain("We can't accept");
    expect(wordReportOf(client.doc)).toMatchObject({ changes: 2, comments: 1, sections: 2 });
  });

  test("each paragraph and table records where it came from, by w14:paraId or by its place, with its fingerprint as imported", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(
      dataDir,
      "Sources.docx",
      wordFile({
        body: [
          paragraph("First", { paraId: "1A2B3C4D" }),
          paragraph("Second"),
          // Shared by two paragraphs, so it names neither.
          paragraph("Third", { paraId: "0000AAAA" }),
          paragraph("Fourth", { paraId: "0000AAAA" }),
          table([["Cell"]]),
        ].join(""),
      }),
    );

    const { client } = await importFile(core, path);

    const doc = readMind(client);
    const sourceOf = (id: string) => wordSourceOf(client.doc, id);
    const ids = [0, 1, 2, 3].map((index) => doc.child(index).attrs.id as string);
    expect(ids.map((id) => sourceOf(id))).toEqual([
      { n: "w:p#0", p: "1A2B3C4D", f: expect.any(String) },
      { n: "w:p#1", f: expect.any(String) },
      { n: "w:p#2", f: expect.any(String) },
      { n: "w:p#3", f: expect.any(String) },
    ]);
    const tableNode = doc.child(4);
    expect(sourceOf(tableNode.attrs.id)?.n).toBe("w:tbl#0");
    expect(sourceOf(tableNode.child(0).child(0).child(0).attrs.id)?.n).toBe("w:p#4");

    // Unedited, a node has its fingerprint as imported; edited, it hasn't.
    const elements = client.blocks.toArray() as Y.XmlElement[];
    const first = elements[0] as Y.XmlElement;
    expect(wordFingerprint(first)).toBe(sourceOf(ids[0] as string)?.f);
    client.doc.transact(() => (first.get(0) as Y.XmlText).insert(5, " edited"));
    expect(wordFingerprint(first)).not.toBe(sourceOf(ids[0] as string)?.f);
    expect(wordFingerprint(elements[1] as Y.XmlElement)).toBe(sourceOf(ids[1] as string)?.f);
  });

  test("the editor leaves an imported Mind exactly as it was written", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const comment = commented(0, "Marcus Hale", "No.", run("this"));
    const path = await saveFile(
      dataDir,
      "Everything.docx",
      wordFile({
        body: [
          paragraph("Title", { style: "Title" }),
          paragraph(
            `${run("Bold", { b: true })}${field("REF _Ref1", "clause 2")}${comment.inline}`,
          ),
          paragraph("Item", { numId: 2 }),
          table([["A", '<w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/>']], 3),
          paragraph(picture("rIdImage", "dot")),
          paragraph(textBox(["Box"])),
          "<w:sdt><w:sdtContent><w:p><w:r><w:t>Control</w:t></w:r></w:p></w:sdtContent></w:sdt>",
          paragraph(
            `${tracked("ins", 1, "Ann", "added")}<w:hyperlink r:id="rIdLink">${run("link")}</w:hyperlink>`,
          ),
        ].join(""),
        numbering: NUMBERING,
        comments: comment.comment,
        media: { rIdImage: { name: "media/image1.png", data: PNG } },
        rels: '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org" TargetMode="External"/>',
      }),
    );
    const { client } = await importFile(core, path, "someone-else");

    // The editor's binding writes back whatever its schema would store differently; here, nothing.
    const changes: Uint8Array[] = [];
    client.doc.on("update", (update: Uint8Array) => changes.push(update));
    client.doc.transact(() =>
      updateYFragment(client.doc, client.blocks, readMind(client), {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
    expect(changes).toEqual([]);
  });

  test("an empty document gives an empty Mind", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(dataDir, "Empty.docx", wordFile({ body: "" }));
    const { client } = await importFile(core, path);
    expect(client.blocks.length).toBe(0);
    expect(wordReportOf(client.doc)).toMatchObject({ paragraphs: 0, sections: 1, kept: {} });
  });
});

describe("refused before a Mind is made", () => {
  /** What the data folder holds of imports: Minds, kept packages and their rows. */
  async function nothingMade(core: Core, dataDir: string) {
    expect(await core.listMinds()).toEqual([]);
    expect(queryDatabase(dataDir, "SELECT * FROM word_packages")).toEqual([]);
    const kept = await readdir(join(dataDir, WORD_PACKAGES_FOLDER)).catch(() => []);
    expect(kept).toEqual([]);
  }

  async function expectRefused(name: string, bytes: Buffer, reason: WordRefusalReason) {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(dataDir, name, bytes);
    expect((await core.checkWordFile(path)).refusal).toBe(reason);
    expect(await core.importWordFile({ path, origin: "own" })).toEqual({
      ok: false,
      refusal: reason,
    });
    await nothingMade(core, dataDir);
  }

  const simple = () => wordFile({ body: paragraph("Hello") });

  test("a Word 97–2003 file (.doc), whatever its name", async () => {
    await expectRefused("Old.doc", simple(), "legacy");
    await expectRefused("Renamed.docx", legacyOfficeFile(), "legacy");
  });

  test("a file with macros (.docm): its name, its main part's type, or its macros", async () => {
    await expectRefused("Macros.docm", simple(), "macros");
    await expectRefused(
      "Typed.docx",
      wordFile({
        body: paragraph("Hello"),
        contentType: "application/vnd.ms-word.document.macroEnabled.main+xml",
      }),
      "macros",
    );
    await expectRefused(
      "Hidden.docx",
      wordFile({ body: paragraph("Hello"), parts: [{ name: "word/vbaProject.bin", data: "x" }] }),
      "macros",
    );
  });

  test("an encrypted file", async () => {
    await expectRefused("Locked.docx", encryptedOfficeFile(), "encrypted");
  });

  test("Strict Open XML", async () => {
    const strict = buildZip([
      {
        name: "_rels/.rels",
        data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      },
      {
        name: "word/document.xml",
        data: '<?xml version="1.0"?><w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);
    await expectRefused("Strict.docx", strict, "strict");
  });

  test("a damaged file: not a package, broken XML, a DOCTYPE, or not a Word document", async () => {
    await expectRefused("Garbage.docx", Buffer.from("not a zip at all"), "damaged");
    const truncated = simple().subarray(0, 200);
    await expectRefused("Cut.docx", truncated, "damaged");
    await expectRefused(
      "Broken.docx",
      wordFile({ body: "<w:p><w:r><w:t>unclosed</w:r></w:p>" }),
      "damaged",
    );
    // The parser's refusal of a DOCTYPE holds: no entity is ever expanded.
    const doctype = buildZip([
      {
        name: "word/document.xml",
        data: '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "boom">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>',
      },
    ]);
    await expectRefused("Doctype.docx", doctype, "damaged");
    await expectRefused(
      "Sheet.docx",
      wordFile({
        body: paragraph("Hello"),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      }),
      "damaged",
    );
  });

  test("over the size limits: a file over 500 MB is refused unread, and a part that inflates past 64 MB", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const huge = join(dataDir, "Huge.docx");
    await writeFile(huge, "");
    // Sparse: nothing is written, and nothing is read.
    await truncate(huge, 500 * 1024 * 1024 + 1);
    expect((await core.checkWordFile(huge)).refusal).toBe("too-large");
    expect(await core.importWordFile({ path: huge, origin: "own" })).toEqual({
      ok: false,
      refusal: "too-large",
    });
    await rm(huge);
    await nothingMade(core, dataDir);

    const bomb = buildZip([
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${" ".repeat(65 * 1024 * 1024)}</w:body></w:document>`,
      },
    ]);
    await expectRefused("Bomb.docx", bomb, "too-large");
  });

  test("a file that can't be read", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const missing = join(dataDir, "Moved.docx");
    expect((await core.checkWordFile(missing)).refusal).toBe("unreadable");
    expect(await core.importWordFile({ path: missing, origin: "own" })).toEqual({
      ok: false,
      refusal: "unreadable",
    });
    await nothingMade(core, dataDir);
  });
});

describe("whose document it is", () => {
  test("a file with tracked changes or comments is someone else's by default; one without is the User's", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const clean = await saveFile(dataDir, "Mine.docx", wordFile({ body: paragraph("Mine") }));
    expect(await core.checkWordFile(clean)).toEqual({
      fileName: "Mine.docx",
      refusal: null,
      origin: "own",
      authors: [],
      changes: 0,
      comments: 0,
      earlierDraft: null,
    });

    const changed = await saveFile(
      dataDir,
      "Changed.docx",
      wordFile({
        body: paragraph(
          `${tracked("ins", 1, "Priya Nair", "new")}<w:r><w:rPr><w:rPrChange w:id="2" w:author="Marcus Hale"><w:rPr/></w:rPrChange></w:rPr><w:t>old</w:t></w:r>`,
        ),
      }),
    );
    expect(await core.checkWordFile(changed)).toMatchObject({
      origin: "someone-else",
      authors: ["Priya Nair", "Marcus Hale"],
      changes: 2,
      comments: 0,
    });

    const comment = commented(0, "Lena Ortiz", "Why?", run("text"));
    const commentedFile = await saveFile(
      dataDir,
      "Commented.docx",
      wordFile({ body: paragraph(comment.inline), comments: comment.comment }),
    );
    expect(await core.checkWordFile(commentedFile)).toMatchObject({
      origin: "someone-else",
      authors: ["Lena Ortiz"],
      changes: 0,
      comments: 1,
    });
  });

  test("someone else's document makes its Blocks third-party text; the User's own doesn't", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(
      dataDir,
      "Theirs.docx",
      wordFile({ body: [paragraph("One"), table([["Two"]])].join("") }),
    );

    const theirs = await importFile(core, path, "someone-else");
    const origins = theirs.client.doc.getMap(MIND_TEXT_ORIGINS_FIELD);
    const ids = (theirs.client.blocks.toArray() as Y.XmlElement[]).map((block) =>
      block.getAttribute("id"),
    );
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(origins.get(id as string)).toBe("imported");

    const mine = await importFile(core, path, "own");
    expect(mine.client.doc.getMap(MIND_TEXT_ORIGINS_FIELD).size).toBe(0);
  });
});

describe("a long document", () => {
  /** About `pages` pages: twenty paragraphs a page, a heading every five pages and a table every ten. */
  function longDocument(pages: number): Buffer {
    const parts: string[] = [];
    for (let page = 0; page < pages; page++) {
      if (page % 5 === 0) parts.push(paragraph(`Part ${page / 5 + 1}`, { style: "Heading1" }));
      for (let line = 0; line < 20; line++) {
        parts.push(
          paragraph(
            `${run(`Page ${page + 1}, paragraph ${line + 1}: `)}${run("the tenant may end the lease on the fifth anniversary.", { b: line % 2 === 0 })}`,
          ),
        );
      }
      if (page % 10 === 9)
        parts.push(
          table([
            ["Rent", "Review"],
            ["£350,200", "Year 3"],
          ]),
        );
    }
    return wordFile({ body: parts.join("") });
  }

  test("a 300-page document fills in a batch at a time, saying how far it has got", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(dataDir, "Long.docx", longDocument(300));

    const result = await core.importWordFile({ path, origin: "own" });
    if (!result.ok) throw new Error(result.refusal);
    const client = await connectToMind(core, result.mind.id);
    const seen: number[] = [];
    const progress = wordImportProgressOf(client.doc);
    if (progress) seen.push(progress.done);
    client.doc.on("update", () => {
      const now = wordImportProgressOf(client.doc);
      if (now && now.done !== seen.at(-1)) seen.push(now.done);
    });
    await importDone(client);

    expect(progress?.total).toBe(60 + 6000 + 30);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(client.blocks.length).toBe(6090);
    expect(readMind(client).lastChild?.type.name).toBe("table");
    expect(
      queryDatabase<{ completed_at: string | null }>(
        dataDir,
        "SELECT completed_at FROM word_packages",
      )[0]?.completed_at,
    ).not.toBeNull();
  });

  test("an import a quit cut short goes on from where it was at the next start", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const path = await saveFile(dataDir, "Long.docx", longDocument(60));
    const result = await first.importWordFile({ path, origin: "someone-else" });
    if (!result.ok) throw new Error(result.refusal);
    first.close();

    const stopped = new Y.Doc();
    const second = startCore(dataDir);
    const client = await connectToMind(second, result.mind.id);
    Y.applyUpdate(stopped, Y.encodeStateAsUpdate(client.doc));
    await importDone(client);

    const blocks = blocksOf(client);
    expect(blocks).toHaveLength(12 + 1200 + 6);
    expect(blocks[0]).toEqual({ type: "heading", attrs: { level: 1 }, content: [text("Part 1")] });
    expect(blocks.at(-1)?.type).toBe("table");
    const paragraphs = blocks.filter((block) => block.type === "paragraph");
    expect(new Set(paragraphs.map((block) => JSON.stringify(block))).size).toBe(1200);
    // Every Block is someone else's, the ones written after the restart too.
    const origins = client.doc.getMap(MIND_TEXT_ORIGINS_FIELD);
    expect(origins.size).toBe(blocks.length);
  });
});

describe("an import whose Mind is deleted halfway", () => {
  const PARAGRAPHS = 3500;

  function chineseDocument(): Buffer {
    const lines = Array.from({ length: PARAGRAPHS }, (_, index) =>
      paragraph(`第${index + 1}条：承租人可在第五个周年日终止租约。`),
    );
    return wordFile({ body: lines.join("") });
  }

  async function startImport(core: Core, dataDir: string): Promise<string> {
    const path = await saveFile(dataDir, "租约.docx", chineseDocument());
    const result = await core.importWordFile({ path, origin: "own" });
    if (!result.ok) throw new Error(result.refusal);
    return result.mind.id;
  }

  const completed = (dataDir: string) =>
    queryDatabase<{ completed_at: string | null }>(
      dataDir,
      "SELECT completed_at FROM word_packages",
    )[0]?.completed_at ?? null;

  /** Waits for the import to end, then for any second writer to have done what it would. */
  async function finished(client: MindClient): Promise<void> {
    await importDone(client);
    for (let turn = 0; turn < 10; turn++) await nextTurn();
  }

  function expectEveryParagraphOnce(client: MindClient): void {
    const blocks = blocksOf(client);
    expect(blocks).toHaveLength(PARAGRAPHS);
    expect(new Set(blocks.map((block) => JSON.stringify(block))).size).toBe(PARAGRAPHS);
  }

  test("restoring the Mind goes on with the import, with no restart", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mindId = await startImport(core, dataDir);

    await core.deleteMind(mindId);
    await nextTurn();
    expect(completed(dataDir)).toBeNull();

    await core.restore([{ kind: "mind", id: mindId }]);
    const client = await connectToMind(core, mindId);
    await finished(client);

    expectEveryParagraphOnce(client);
    expect(wordImportProgressOf(client.doc)).toBeNull();
    expect(completed(dataDir)).not.toBeNull();
  });

  test("restoring it while the import still runs starts no second writer", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mindId = await startImport(core, dataDir);

    await core.deleteMind(mindId);
    await core.restore([{ kind: "mind", id: mindId }]);
    const client = await connectToMind(core, mindId);
    await finished(client);

    expectEveryParagraphOnce(client);
  });

  test("deleting and restoring it again before the import has resumed starts it once", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mindId = await startImport(core, dataDir);
    const ref = { kind: "mind", id: mindId } as const;

    await core.deleteMind(mindId);
    await nextTurn();
    await core.restore([ref]);
    await core.deleteMind(mindId);
    await core.restore([ref]);
    await core.restore([ref]);
    const client = await connectToMind(core, mindId);
    await finished(client);

    expectEveryParagraphOnce(client);
    expect(wordImportProgressOf(client.doc)).toBeNull();
  });
});

describe("the imported Mind lasts", () => {
  test("it survives a reload and sync, and its package stays when the User's file goes", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const bytes = wordFile({
      body: [paragraph("Clause", { style: "Heading1" }), paragraph(field("PAGE", "3"))].join(""),
    });
    const path = await saveFile(dataDir, "Lease.docx", bytes);
    const { mindId, client } = await importFile(first, path);
    const before = blocksOf(client);
    const sources = client.doc.getMap("wordSources").toJSON();
    first.close();
    await rm(path);

    const second = startCore(dataDir);
    const reopened = await connectToMind(second, mindId);
    expect(blocksOf(reopened)).toEqual(before);
    expect(reopened.doc.getMap("wordSources").toJSON()).toEqual(sources);
    const file = wordFileOf(reopened.doc);
    expect(file).toMatchObject({
      name: "Lease.docx",
      size: bytes.length,
      part: "word/document.xml",
    });

    // Another device that gets the Mind's updates has the same Mind.
    const elsewhere = new Y.Doc();
    Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(reopened.doc));
    expect(wordFileOf(elsewhere)).toEqual(file);
    expect(elsewhere.getXmlFragment("blocks").toJSON()).toBe(reopened.blocks.toJSON());

    const kept = await readFile(join(dataDir, WORD_PACKAGES_FOLDER, `${file?.sha256}.docx`));
    expect(Buffer.compare(kept, bytes)).toBe(0);
  });

  test("its package goes once it is deleted permanently, and not while another Mind keeps it", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const path = await saveFile(dataDir, "Shared.docx", wordFile({ body: paragraph("Hi") }));
    const one = await importFile(core, path);
    const two = await importFile(core, path);
    const folder = join(dataDir, WORD_PACKAGES_FOLDER);
    expect(await readdir(folder)).toHaveLength(1);

    await core.deleteMind(one.mindId);
    await core.deletePermanently([{ kind: "mind", id: one.mindId }]);
    expect(await readdir(folder)).toHaveLength(1);

    await core.deleteMind(two.mindId);
    await core.deletePermanently([{ kind: "mind", id: two.mindId }]);
    expect(await readdir(folder)).toEqual([]);
  });
});
