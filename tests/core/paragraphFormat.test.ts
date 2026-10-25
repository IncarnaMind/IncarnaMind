/**
 * Paragraph formatting and text colour, font, size and raise (#912), through the core's public
 * interface: a Word file's direct formatting is read into them while the look keeps what its
 * styles give, with nothing drawn differently; a Mind whose look an earlier version read keeps
 * the User's edits through the reading again; and each setting goes out as Word's own property
 * and comes back the same.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CLAIM_CHECK_MARK,
  type Core,
  MIND_CONTENT_FIELD,
  PARAGRAPH_FORMAT_ATTRIBUTE,
  type ParagraphFormat,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  TEXT_FONT_MARK,
  TEXT_SIZE_MARK,
  WORD_ATOM_NODE,
  WORD_LOOK_ATTRIBUTE,
} from "../../src/core";
import { readWordStructure } from "../../src/core/documents/formats/docxImport";
import { WORD_LOOK_VERSION } from "../../src/core/documents/formats/docxLook";
import { openWordPackage, reviewOf } from "../../src/core/documents/formats/docxPackage";
import { wordLookOf } from "../../src/shared/wordLook";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { textOf, unzip } from "../helpers/docx";
import { recordingLog } from "../helpers/log";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { paragraph, run, STYLES, wordFile } from "../helpers/word";
import { drawnParagraphs, wordFixtures } from "../helpers/wordLookResolved";
import { importWordBytes } from "../helpers/wordMinds";

const FIXTURES = join(__dirname, "../fixtures/word-look");
const MARK_TYPES: readonly string[] = [TEXT_COLOR_MARK, SUPERSCRIPT_MARK, SUBSCRIPT_MARK];

describe("a Word file's direct formatting is the paragraph's format and the text's marks", () => {
  test("every paragraph of every Word fixture draws as the look of version 4 drew it", async () => {
    const before: Record<string, string> = JSON.parse(
      await readFile(join(FIXTURES, "v4-drawn.json"), "utf8"),
    );
    const files = wordFixtures();
    let compared = 0;
    const moved = { formats: 0, marks: 0 };
    const count = (node: JSONContent) => {
      if (node.attrs?.[PARAGRAPH_FORMAT_ATTRIBUTE]) moved.formats++;
      if (node.marks?.some((mark) => MARK_TYPES.includes(mark.type))) moved.marks++;
      for (const child of node.content ?? []) count(child);
    };
    for (const [name, bytes] of files) {
      const was = before[name];
      if (was === undefined) continue;
      const pkg = await openWordPackage(bytes);
      const structure = await readWordStructure(pkg, await reviewOf(pkg));
      for (const block of structure.blocks) count(block);
      const now = drawnParagraphs(structure.blocks, structure.look).split(" ");
      const differs = was.split(" ").findIndex((hash, index) => hash !== now[index]);
      expect(differs, `${name}, paragraph ${differs}`).toBe(-1);
      expect(now.length, name).toBe(was.split(" ").length);
      compared++;
    }
    expect(compared).toBe(Object.keys(before).length);
    // The fixtures' direct formatting did move out of the look.
    expect(moved.formats).toBeGreaterThan(500);
    expect(moved.marks).toBeGreaterThan(50);
  }, 120_000);

  test("Chinese 2-character first-line indents stay in characters, measured in the style's size", async () => {
    const bytes = await readFile(
      join(__dirname, "../../eval/word/breadth/government/nmpa-device-gcp-drafting-note.docx"),
    );
    const pkg = await openWordPackage(bytes);
    const structure = await readWordStructure(pkg, await reviewOf(pkg));
    const formats: { format: ParagraphFormat; look: string | undefined }[] = [];
    const visit = (node: JSONContent) => {
      const format = node.attrs?.[PARAGRAPH_FORMAT_ATTRIBUTE];
      if (format?.firstLineChars !== undefined) {
        formats.push({ format, look: node.attrs?.[WORD_LOOK_ATTRIBUTE] });
      }
      for (const child of node.content ?? []) visit(child);
    };
    for (const block of structure.blocks) visit(block);
    expect(formats.map((each) => each.format.firstLineChars)).toContain(2);
    for (const { format, look } of formats) {
      expect(format.firstLine).toBeUndefined();
      expect(look && structure.look.paragraphs[look]?.characterSize).toBeGreaterThan(0);
    }
  });
});

interface Case {
  text: string;
  format: ParagraphFormat;
}

const CASES: readonly Case[] = [
  { text: "Centred.", format: { align: "center" } },
  { text: "Right.", format: { align: "right" } },
  { text: "Justified.", format: { align: "justify" } },
  { text: "Indented left.", format: { left: 36 } },
  { text: "Indented right.", format: { right: 18 } },
  { text: "A first line in points.", format: { firstLine: 21 } },
  { text: "A hanging indent.", format: { left: 36, firstLine: -18 } },
  { text: "首行缩进两个字符。", format: { firstLineChars: 2 } },
  { text: "Space before.", format: { before: 12 } },
  { text: "Space after.", format: { after: 6 } },
  { text: "Line 1.5.", format: { line: { rule: "auto", value: 1.5 } } },
  { text: "Line 1.15.", format: { line: { rule: "auto", value: 1.15 } } },
  { text: "Line exactly 18 pt.", format: { line: { rule: "exact", value: 18 } } },
  { text: "Line at least 14 pt.", format: { line: { rule: "atLeast", value: 14 } } },
];

const MARKED = [
  { text: "In red.", marks: [{ type: TEXT_COLOR_MARK, attrs: { color: "C00000" } }] },
  { text: "Raised.", marks: [{ type: SUPERSCRIPT_MARK }] },
  { text: "Lowered.", marks: [{ type: SUBSCRIPT_MARK }] },
];

function blocksOf(client: MindClient): ProseMirrorNode[] {
  const found: ProseMirrorNode[] = [];
  readMind(client).descendants((node) => {
    if (node.isTextblock) found.push(node);
    return !node.isTextblock;
  });
  return found;
}

function formatOf(client: MindClient, text: string): ParagraphFormat | null {
  const node = blocksOf(client).find((each) => each.textContent === text);
  if (!node) throw new Error(`No "${text}".`);
  return node.attrs[PARAGRAPH_FORMAT_ATTRIBUTE] ?? null;
}

function marksOf(client: MindClient, text: string): string[] {
  const found: string[] = [];
  readMind(client).descendants((node) => {
    if (node.isText && node.text === text) {
      for (const mark of node.marks) {
        if (mark.type.name === TEXT_COLOR_MARK) found.push(`${mark.type.name} ${mark.attrs.color}`);
        else if ([SUPERSCRIPT_MARK, SUBSCRIPT_MARK].includes(mark.type.name)) {
          found.push(mark.type.name);
        }
      }
    }
    return true;
  });
  return found.sort();
}

/** The `w:p` of the document holding `text`. */
function paragraphXml(document: string, text: string): string {
  const found = [...document.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find((match) =>
    textOf(match[0]).includes(text),
  );
  if (!found) throw new Error(`No paragraph "${text}".`);
  return found[0];
}

async function reimported(core: Core, dataDir: string, data: Uint8Array): Promise<MindClient> {
  const { client } = await importWordBytes(core, dataDir, Buffer.from(data), {
    name: `Export ${randomUUID()}.docx`,
    origin: "own",
  });
  return client;
}

function expectEachBack(client: MindClient): void {
  for (const { text, format } of CASES) expect(formatOf(client, text), text).toEqual(format);
  for (const { text, marks } of MARKED) {
    expect(marksOf(client, text), text).toEqual(
      marks.map((mark) => ("attrs" in mark ? `${mark.type} ${mark.attrs.color}` : mark.type)),
    );
  }
}

describe("each setting goes out as Word's own and comes back the same", () => {
  test("from a Mind written here", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const mind = await core.createMind({ title: "Lease" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      ...CASES.map(({ text, format }) => ({
        type: "paragraph",
        attrs: { [PARAGRAPH_FORMAT_ATTRIBUTE]: format },
        content: [{ type: "text", text }],
      })),
      ...MARKED.map(({ text, marks }) => ({
        type: "paragraph",
        content: [
          { type: "text", text: "Plain, then " },
          { type: "text", text, marks },
        ],
      })),
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "In Georgia at 14 pt.",
            marks: [
              { type: TEXT_FONT_MARK, attrs: { family: "Georgia" } },
              { type: TEXT_SIZE_MARK, attrs: { size: 14 } },
            ],
          },
        ],
      },
    ]);
    await client.settled();

    const result = await core.exportMind(mind.id, { format: "docx" });
    const document = unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "";
    expect(paragraphXml(document, "Centred.")).toContain('<w:jc w:val="center"/>');
    expect(paragraphXml(document, "Justified.")).toContain('<w:jc w:val="both"/>');
    expect(paragraphXml(document, "首行缩进")).toContain('w:firstLineChars="200"');
    expect(paragraphXml(document, "首行缩进")).not.toContain("w:firstLine=");
    expect(paragraphXml(document, "A hanging indent.")).toContain('w:hanging="360"');
    expect(paragraphXml(document, "Line 1.5.")).toMatch(/w:line="360" w:lineRule="auto"/);
    expect(paragraphXml(document, "In red.")).toContain('<w:color w:val="C00000"/>');
    expect(paragraphXml(document, "Raised.")).toContain('<w:vertAlign w:val="superscript"/>');
    expect(paragraphXml(document, "In Georgia")).toContain('w:ascii="Georgia"');
    expect(paragraphXml(document, "In Georgia")).toContain('<w:sz w:val="28"/>');

    expectEachBack(await reimported(core, dataDir, result.data));
  });

  test("from a Mind imported from Word, over its look: a setting made here wins over the file's style and survives export", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const centredTitle = STYLES.replace(
      '<w:name w:val="Title"/><w:basedOn w:val="Normal"/>',
      '<w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr>',
    );
    const bytes = wordFile({
      styles: centredTitle,
      body: [
        paragraph("Lease of 14 Elm Row", { style: "Title" }),
        ...CASES.map(({ text }) => paragraph(text)),
        ...MARKED.map(({ text }) => paragraph(`${run("Plain, then ")}${run(text)}`)),
      ].join(""),
    });
    const { mindId, client } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
    expect(formatOf(client, "Lease of 14 Elm Row")).toBeNull();
    client.doc.transact(() => {
      for (const element of client.blocks.toArray()) {
        if (!(element instanceof Y.XmlElement)) continue;
        const text = element.toArray().find((child) => child instanceof Y.XmlText);
        const plain = text instanceof Y.XmlText ? text.toString() : "";
        const wanted =
          plain === "Lease of 14 Elm Row"
            ? { align: "left" }
            : CASES.find((each) => each.text === plain)?.format;
        if (wanted) {
          const formatted: Y.XmlElement<Record<string, string | object>> = element;
          formatted.setAttribute(PARAGRAPH_FORMAT_ATTRIBUTE, wanted);
        }
        const marked = MARKED.find((each) => plain.endsWith(each.text));
        if (marked && text instanceof Y.XmlText) {
          text.format(
            plain.length - marked.text.length,
            marked.text.length,
            Object.fromEntries(
              marked.marks.map((mark) => [mark.type, "attrs" in mark ? mark.attrs : {}]),
            ),
          );
        }
      }
    });
    await client.settled();

    const result = await core.exportMind(mindId, { format: "docx" });
    const document = unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "";
    expect(paragraphXml(document, "Lease of 14 Elm Row")).toContain('<w:jc w:val="left"/>');
    expect(paragraphXml(document, "首行缩进")).toContain('w:firstLineChars="200"');
    expect(paragraphXml(document, "Raised.")).toContain('<w:vertAlign w:val="superscript"/>');

    const again = await reimported(core, dataDir, result.data);
    expectEachBack(again);
    expect(formatOf(again, "Lease of 14 Elm Row")).toEqual({ align: "left" });
  });
});

const SENTENCE_CHECK = {
  id: "check-1",
  request: "r1",
  action: "check",
  state: "supported",
  reason: null,
  detail: null,
  text: "Signed by both parties.",
  evidence: null,
  scope: { folderId: null, widened: false },
  versions: [],
  excluded: [],
  checkedAt: "2026-10-13T09:00:00.000Z",
};

function elementWith(blocks: Y.XmlFragment, text: string): Y.XmlElement {
  const found = blocks
    .toArray()
    .find(
      (child): child is Y.XmlElement =>
        child instanceof Y.XmlElement && child.toString().includes(text),
    );
  if (!found) throw new Error(`No "${text}".`);
  return found;
}

function textIn(element: Y.XmlElement): Y.XmlText {
  const text = element.toArray().find((child) => child instanceof Y.XmlText);
  if (!(text instanceof Y.XmlText)) throw new Error("No text.");
  return text;
}

describe("a Mind whose look version 4 read is read again", () => {
  test("its User's edits come through: text, their own format, comments and checks", async () => {
    const bytes = await readFile(join(FIXTURES, "direct-before.docx"));
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mindId } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
    core.close();

    const before = new Y.Doc();
    Y.applyUpdate(before, await readFile(join(FIXTURES, "direct-before.yjs")));
    const blocks = before.getXmlFragment(MIND_CONTENT_FIELD);
    expect(wordLookOf(before)?.version).toBe(4);
    before.transact(() => {
      const rent = textIn(elementWith(blocks, "The rent is"));
      const at = rent.toString().indexOf("£1,200");
      rent.delete(at, "£1,200".length);
      rent.insert(at, "£1,250");
      const lease: Y.XmlElement<Record<string, string | object>> = elementWith(blocks, "第一条");
      lease.setAttribute(PARAGRAPH_FORMAT_ATTRIBUTE, { align: "right" });
      const signed = textIn(elementWith(blocks, "Signed by both parties."));
      signed.format(0, signed.length, { [CLAIM_CHECK_MARK]: SENTENCE_CHECK });
    });
    const at = new Date().toISOString();
    queryDatabase(dataDir, "DELETE FROM mind_updates WHERE mind_id = ?", [mindId]);
    queryDatabase(
      dataDir,
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), mindId, Y.encodeStateAsUpdate(before), at, at],
    );
    queryDatabase(dataDir, "UPDATE word_packages SET look_version = 4 WHERE mind_id = ?", [mindId]);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() => expect(wordLookOf(after.doc)?.version).toBe(WORD_LOOK_VERSION), {
      timeout: 10_000,
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "word.look.added",
        fields: expect.objectContaining({ mindId, editedSinceImport: 3 }),
      }),
    );

    expect(blocksOf(after).map((node) => node.textContent)).toEqual([
      "Lease of 14 Elm Row",
      "第一条 租赁物为本合同所述房屋。",
      "The rent is £1,250 per month and is due on the 1st.",
      expect.stringContaining("Notice is one month."),
      "Water is H2O.",
      "Signed by both parties.",
    ]);
    // The edited paragraph keeps its look and gets the file's formatting back where its words are the file's.
    const rent = blocksOf(after).find((node) => node.textContent.startsWith("The rent is"));
    expect(rent?.attrs[WORD_LOOK_ATTRIBUTE]).toEqual(expect.any(String));
    expect(formatOf(after, "The rent is £1,250 per month and is due on the 1st.")).toEqual({
      align: "justify",
      before: 12,
      after: 0,
      line: { rule: "auto", value: 1.5 },
    });
    expect(marksOf(after, "st")).toEqual([SUPERSCRIPT_MARK]);
    // The User's own setting wins; what they didn't set is the file's.
    expect(formatOf(after, "第一条 租赁物为本合同所述房屋。")).toEqual({
      align: "right",
      firstLineChars: 2,
    });
    expect(marksOf(after, "租赁物")).toEqual([`${TEXT_COLOR_MARK} C00000`]);
    // Unedited, given all of it.
    expect(formatOf(after, "Lease of 14 Elm Row")).toEqual({ align: "left" });
    expect(marksOf(after, "2")).toEqual([SUBSCRIPT_MARK, `${TEXT_COLOR_MARK} 2E74B5`]);
    let checked = false;
    let comments = 0;
    readMind(after).descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === CLAIM_CHECK_MARK)) {
        checked = node.text === "Signed by both parties.";
      }
      if (node.type.name === WORD_ATOM_NODE && node.attrs.kind === "comment") comments++;
      return true;
    });
    expect(checked).toBe(true);
    expect(comments).toBe(1);
    expect(formatOf(after, "Signed by both parties.")).toEqual({ left: 36, right: 18 });

    const result = await restarted.exportMind(mindId, { format: "docx" });
    const document = unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "";
    const exported = paragraphXml(document, "The rent is");
    expect(exported).toContain("£1,250");
    expect(exported).toContain('<w:jc w:val="both"/>');
    expect(exported).toContain('w:line="360"');
    expect(exported).toContain('<w:vertAlign w:val="superscript"/>');
    const lease = paragraphXml(document, "第一条");
    expect(lease).toContain('<w:jc w:val="right"/>');
    expect(lease).toContain('w:firstLineChars="200"');
    expect(document).toContain("w:commentReference");
    restarted.close();
  });

  test("until it is read again, an edited paragraph exports with the file's formatting", async () => {
    const bytes = await readFile(join(FIXTURES, "direct-before.docx"));
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const { mindId } = await importWordBytes(core, dataDir, bytes, { origin: "own" });
    core.close();
    const at = new Date().toISOString();
    queryDatabase(dataDir, "DELETE FROM mind_updates WHERE mind_id = ?", [mindId]);
    queryDatabase(
      dataDir,
      "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), mindId, await readFile(join(FIXTURES, "direct-before.yjs")), at, at],
    );

    const restarted = startCore(dataDir);
    const client = await connectToMind(restarted, mindId);
    expect(wordLookOf(client.doc)?.version).toBe(4);
    const rent = textIn(elementWith(client.blocks, "The rent is"));
    client.doc.transact(() => {
      const from = rent.toString().indexOf("£1,200") + "£1,2".length;
      rent.delete(from, 1);
      rent.insert(from, "5");
    });
    await client.settled();

    const result = await restarted.exportMind(mindId, { format: "docx" });
    const exported = paragraphXml(
      unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "",
      "The rent is",
    );
    expect(textOf(exported)).toContain("£1,250");
    expect(exported).toContain('<w:jc w:val="both"/>');
    expect(exported).toContain('w:line="360"');
    expect(exported).toContain('<w:vertAlign w:val="superscript"/>');
    expect(wordLookOf(client.doc)?.version).toBe(4);
    restarted.close();
  });
});
