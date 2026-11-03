/**
 * A Word file's footnotes, endnotes and page breaks are the Note's own
 * (#746), through the core's public interface: imported as the Note's
 * footnotes, edited there, and written back into `footnotes.xml` and
 * `endnotes.xml` with their ids, the notes the User didn't touch byte for
 * byte as the file had them; a Note imported before is converted when it
 * is opened.
 */
import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type Core,
  FOOTNOTE_NODE,
  MIND_WORD_FIELD,
  PAGE_BREAK_NODE,
  WORD_ATOM_NODE,
} from "../../src/core";
import {
  setWordSource,
  wordFingerprint,
  wordNoteNumberingOf,
  wordReportOf,
  wordSourceOf,
} from "../../src/shared/wordFiles";
import { noteLabel } from "../../src/shared/wordNotes";
import { createTempDataFolder, startCore } from "../helpers/core";
import { unzip } from "../helpers/docx";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";
import {
  field,
  note,
  noteMark,
  PNG,
  paragraph,
  picture,
  run,
  table,
  type WordFileInput,
  wordFile,
} from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

async function setUp(input: WordFileInput) {
  const core = startCore(await createTempDataFolder());
  const bytes = wordFile(input);
  const imported = await importWordBytes(core, await createTempDataFolder(), bytes, {
    origin: "own",
  });
  return { core, bytes, ...imported };
}

async function exported(core: Core, mindId: string) {
  const files = unzip((await core.exportMind(mindId, { format: "docx" })).data);
  return { files, part: (name: string) => files.get(name)?.toString("utf8") ?? "" };
}

/** The entries an export changed, added or left out. */
function changed(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names]
    .filter((name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)))
    .sort();
}

/** A note's element as a part has it, by its id. */
const noteXml = (xml: string, kind: "footnote" | "endnote", id: number) =>
  new RegExp(`<w:${kind} w:id="${id}">[\\s\\S]*?</w:${kind}>`).exec(xml)?.[0] ?? null;

/** The Note's footnotes, in order, as JSON. */
function footnotesOf(client: MindClient): JSONContent[] {
  const found: JSONContent[] = [];
  readMind(client).descendants((node) => {
    if (node.type.name === FOOTNOTE_NODE) found.push(node.toJSON());
  });
  return found;
}

const plain = (content: JSONContent[] | undefined) =>
  (content ?? []).map((node) => (node.type === "hardBreak" ? "\n" : (node.text ?? ""))).join("");

/** Changes the text of the footnote whose text is `from`, as typing in it does. */
function editFootnote(client: MindClient, from: string, change: (text: string) => string): void {
  const visit = (node: JSONContent): JSONContent => {
    if (node.type === FOOTNOTE_NODE && plain(node.content) === from) {
      return {
        ...node,
        content: node.content?.map((each) =>
          each.type === "text" ? { ...each, text: change(each.text ?? "") } : each,
        ),
      };
    }
    return node.content ? { ...node, content: node.content.map(visit) } : node;
  };
  editMind(client, (blocks) => blocks.map(visit));
}

const SETTINGS = `<w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr><w:endnotePr><w:numFmt w:val="lowerRoman"/></w:endnotePr>`;

const brief = (): WordFileInput => ({
  body: [
    paragraph(`${run("The lease ends in 2030.")}${noteMark("footnote", 1)}`),
    paragraph(`${run("Rent is reviewed yearly.")}${noteMark("footnote", 2)}`),
    paragraph(`${run("See the schedule.")}${noteMark("endnote", 1)}`),
  ].join(""),
  footnotes: [
    note("footnote", 1, [`${run("See ")}${run("Hale v Nair", { i: true })}${run(", 2019.")}`]),
    note("footnote", 2, ["Clause 4.2.", "Read with clause 9."]),
  ].join(""),
  endnotes: note("endnote", 1, ["Schedule 3 lists the fittings."]),
  settings: SETTINGS,
});

describe("a Word file's notes are the Note's own footnotes", () => {
  test("each footnote and endnote is a footnote holding its text, with its marks and a line per paragraph, an endnote marked as one", async () => {
    const { client } = await setUp(brief());
    const notes = footnotesOf(client);
    expect(notes.map((each) => [each.attrs?.source, each.attrs?.endnote ?? null])).toEqual([
      ["w:footnoteReference#0", null],
      ["w:footnoteReference#1", null],
      ["w:endnoteReference#0", true],
    ]);
    // The space after the note's own number isn't part of its text.
    expect(notes[0]?.content).toEqual([
      { type: "text", text: "See " },
      { type: "text", text: "Hale v Nair", marks: [{ type: "italic" }] },
      { type: "text", text: ", 2019." },
    ]);
    expect(plain(notes[1]?.content)).toBe("Clause 4.2.\nRead with clause 9.");
    expect(plain(notes[2]?.content)).toBe("Schedule 3 lists the fittings.");
    expect(wordReportOf(client.doc)).toMatchObject({ footnotes: 2, endnotes: 1 });
    expect(wordReportOf(client.doc)?.kept.footnote).toBeUndefined();
    expect(wordNoteNumberingOf(client.doc)).toEqual({
      footnote: { format: "decimal", start: 1 },
      endnote: { format: "lowerRoman", start: 1 },
    });
  });

  test("a note a footnote can't hold (a table), with someone's change (a move, a custom XML element's insertion, a paragraph's properties) or with a mark of its own is kept as is", async () => {
    const { client } = await setUp({
      body: paragraph(
        `${run("Odd")}${noteMark("footnote", 1)}${run(" and starred")}<w:r><w:footnoteReference w:customMarkFollows="1" w:id="2"/><w:t>*</w:t></w:r>${run(" and moved")}${noteMark("footnote", 3)}${run(" and restyled")}${noteMark("footnote", 4)}${run(" and tagged")}${noteMark("footnote", 5)}`,
      ),
      footnotes: [
        `<w:footnote w:id="1">${table([["A", "B"]])}</w:footnote>`,
        note("footnote", 2, ["Starred note."]),
        note("footnote", 3, [
          `<w:moveTo w:id="9" w:author="Priya Nair" w:date="2026-10-02T09:00:00Z">${run("Moved here.")}</w:moveTo>`,
        ]),
        `<w:footnote w:id="4"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/><w:pPrChange w:id="10" w:author="Priya Nair" w:date="2026-10-02T09:00:00Z"><w:pPr/></w:pPrChange></w:pPr><w:r><w:footnoteRef/></w:r>${run(" Restyled.")}</w:p></w:footnote>`,
        `<w:footnote w:id="5"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:footnoteRef/></w:r><w:customXmlInsRangeStart w:id="11" w:author="Priya Nair" w:date="2026-10-02T09:00:00Z"/>${run(" Tagged.")}<w:customXmlInsRangeEnd w:id="11"/></w:p></w:footnote>`,
      ].join(""),
    });
    const atoms: JSONContent[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name === WORD_ATOM_NODE) atoms.push(node.toJSON());
    });
    expect(atoms.map((atom) => [atom.attrs?.kind, atom.attrs?.text])).toEqual([
      ["footnote", "A\tB"],
      ["footnote", "Starred note."],
      ["footnote", "Moved here."],
      ["footnote", "Restyled."],
      ["footnote", "Tagged."],
    ]);
    expect(footnotesOf(client)).toEqual([]);
  });

  test("an edited footnote is written back into its own note, with its id and properties; every other part and note is byte for byte the file's", async () => {
    const { core, bytes, mindId, client } = await setUp(brief());
    editFootnote(client, "See Hale v Nair, 2019.", (text) => text.replace("2019", "2021"));
    await client.settled();

    const before = unzip(bytes);
    const { files, part } = await exported(core, mindId);
    // Only the footnotes part: the paragraph holding the mark is as it was.
    expect(changed(before, files)).toEqual(["word/footnotes.xml"]);
    const was = before.get("word/footnotes.xml")?.toString("utf8") ?? "";
    const now = part("word/footnotes.xml");
    expect(noteXml(now, "footnote", 2)).toBe(noteXml(was, "footnote", 2));
    const edited = noteXml(now, "footnote", 1) ?? "";
    expect(edited).toContain('<w:pStyle w:val="FootnoteText"/>');
    expect(edited).toContain("<w:footnoteRef/>");
    expect(edited).toContain('<w:t xml:space="preserve"> </w:t>');
    expect(edited).toContain("<w:i/>");
    expect(edited).toContain("2021");
    expect(edited).not.toContain("2019");

    // Opened again, the file has the edit, under the same mark.
    const made = await core.exportMind(mindId, { format: "docx" });
    const back = await importWordBytes(core, await createTempDataFolder(), Buffer.from(made.data), {
      origin: "own",
      name: "Back.docx",
    });
    const notes = footnotesOf(back.client);
    expect(plain(notes[0]?.content)).toBe("See Hale v Nair, 2021.");
    expect(notes[0]?.attrs?.source).toBe("w:footnoteReference#0");
  });

  test("an edited endnote stays an endnote, written back into endnotes.xml with its id; the footnotes are untouched", async () => {
    const { core, bytes, mindId, client } = await setUp(brief());
    editFootnote(client, "Schedule 3 lists the fittings.", (text) =>
      text.replace("fittings", "fixtures"),
    );
    await client.settled();

    const before = unzip(bytes);
    const { files, part } = await exported(core, mindId);
    expect(changed(before, files)).toEqual(["word/endnotes.xml"]);
    const edited = noteXml(part("word/endnotes.xml"), "endnote", 1) ?? "";
    expect(edited).toContain("<w:endnoteRef/>");
    expect(edited).toContain("fixtures");
    expect(part("word/document.xml")).toContain('<w:endnoteReference w:id="1"/>');
  });

  test("a Chinese note is edited and written back as any is", async () => {
    const { core, bytes, mindId, client } = await setUp({
      body: paragraph(`${run("合同自签署之日起生效。")}${noteMark("footnote", 1)}`),
      footnotes: note("footnote", 1, ["见《民法典》第五百零二条。"]),
    });
    editFootnote(client, "见《民法典》第五百零二条。", (text) => text.replace("。", "第一款。"));
    await client.settled();
    const { files, part } = await exported(core, mindId);
    expect(changed(unzip(bytes), files)).toEqual(["word/footnotes.xml"]);
    expect(noteXml(part("word/footnotes.xml"), "footnote", 1)).toContain(
      "见《民法典》第五百零二条第一款。",
    );
  });

  test('a note typed as an ordinary one ("normal"), in English or Chinese, is a footnote like any, edited and written back with its start tag', async () => {
    const typed = (xml: string) => xml.replace(/^<w:(footnote|endnote) /, '<w:$1 w:type="normal" ');
    const { core, mindId, client } = await setUp({
      body: [
        paragraph(`${run("The lease ends in 2030.")}${noteMark("footnote", 1)}`),
        paragraph(`${run("合同自签署之日起生效。")}${noteMark("endnote", 1)}`),
      ].join(""),
      footnotes: typed(note("footnote", 1, ["See clause 4."])),
      endnotes: typed(note("endnote", 1, ["见《民法典》第五百零二条。"])),
    });
    expect(
      footnotesOf(client).map((each) => [plain(each.content), each.attrs?.endnote ?? null]),
    ).toEqual([
      ["See clause 4.", null],
      ["见《民法典》第五百零二条。", true],
    ]);
    editFootnote(client, "See clause 4.", (text) => text.replace("4", "9"));
    editFootnote(client, "见《民法典》第五百零二条。", (text) => text.replace("。", "第一款。"));
    await client.settled();
    const { part } = await exported(core, mindId);
    const typedNote = (xml: string, kind: "footnote" | "endnote") =>
      new RegExp(`<w:${kind} w:type="normal" w:id="1">[\\s\\S]*?</w:${kind}>`).exec(xml)?.[0] ?? "";
    expect(typedNote(part("word/footnotes.xml"), "footnote")).toContain("See clause 9.");
    expect(typedNote(part("word/endnotes.xml"), "endnote")).toContain(
      "见《民法典》第五百零二条第一款。",
    );
  });

  test("a note of two paragraphs keeps both, the edit in the second", async () => {
    const { core, mindId, client } = await setUp(brief());
    editFootnote(client, "Clause 4.2.\nRead with clause 9.", (text) =>
      text.replace("clause 9", "clause 10"),
    );
    await client.settled();
    const { part } = await exported(core, mindId);
    const edited = noteXml(part("word/footnotes.xml"), "footnote", 2) ?? "";
    expect(edited.match(/<w:p>/g)).toHaveLength(2);
    expect(edited).toMatch(/Clause 4\.2\.<\/w:t><\/w:r><\/w:p><w:p>/);
    expect(edited).toContain("Read with clause 10.");
  });

  test("the Saved line counts the edited footnotes as the file's own, and leaves the endnotes out", async () => {
    const { core, mindId, client } = await setUp(brief());
    editFootnote(client, "See Hale v Nair, 2019.", (text) => `${text} Affirmed.`);
    await client.settled();
    expect((await core.exportMind(mindId, { format: "docx" })).footnotes).toBe(2);
  });

  test("a footnote deleted from the Note goes from the file, its mark and its note", async () => {
    const { core, mindId, client } = await setUp(brief());
    const strip = (node: JSONContent): JSONContent => ({
      ...node,
      ...(node.content && {
        content: node.content
          .filter(
            (each) =>
              !(each.type === FOOTNOTE_NODE && plain(each.content).startsWith("Clause 4.2")),
          )
          .map(strip),
      }),
    });
    editMind(client, (blocks) => blocks.map(strip));
    await client.settled();
    const { part } = await exported(core, mindId);
    expect(part("word/document.xml")).not.toContain('<w:footnoteReference w:id="2"/>');
    expect(noteXml(part("word/footnotes.xml"), "footnote", 2)).toBeNull();
    expect(noteXml(part("word/footnotes.xml"), "footnote", 1)).not.toBeNull();
  });

  test.each(["after", "before"] as const)(
    "a copy of a note's mark %s it, in its paragraph, is a new footnote: the original keeps its id, and its untouched note stays byte for byte",
    async (where) => {
      const { core, bytes, mindId, client } = await setUp(brief());
      const original = "See Hale v Nair, 2019.";
      const copyOf = (node: JSONContent): JSONContent => ({
        type: FOOTNOTE_NODE,
        // A copy the editor didn't write: its own id, the note's place still on it.
        attrs: { id: randomUUID(), source: node.attrs?.source },
        content: [{ type: "text", text: "Independent copied footnote." }],
      });
      const withCopy = (node: JSONContent): JSONContent => ({
        ...node,
        ...(node.content && {
          content: node.content.flatMap((each) =>
            each.type === FOOTNOTE_NODE && plain(each.content) === original
              ? where === "after"
                ? [each, copyOf(each)]
                : [copyOf(each), each]
              : [withCopy(each)],
          ),
        }),
      });
      editMind(client, (blocks) => blocks.map(withCopy));
      await client.settled();

      const was = unzip(bytes).get("word/footnotes.xml")?.toString("utf8") ?? "";
      const { part } = await exported(core, mindId);
      const document = part("word/document.xml");
      const footnotes = part("word/footnotes.xml");
      expect(document.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1);
      expect(noteXml(footnotes, "footnote", 1)).toBe(noteXml(was, "footnote", 1));
      const ids = [...document.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map((match) =>
        Number(match[1]),
      );
      const added = ids.filter((id) => id > 2);
      expect(added).toHaveLength(1);
      expect(noteXml(footnotes, "footnote", added[0] ?? 0)).toContain(
        "Independent copied footnote.",
      );
      expect(footnotes.match(/Independent copied footnote\./g)).toHaveLength(1);
    },
  );

  test("a note the file marks twice stays while either mark does; it goes with the last", async () => {
    const { core, mindId, client } = await setUp({
      body: [
        paragraph(`${run("First mark.")}${noteMark("footnote", 1)}`),
        paragraph(`${run("Second mark.")}${noteMark("footnote", 1)}`),
      ].join(""),
      footnotes: note("footnote", 1, ["Shared note."]),
    });
    const without = (drop: (node: JSONContent) => boolean) => (node: JSONContent) => {
      const strip = (each: JSONContent): JSONContent => ({
        ...each,
        ...(each.content && { content: each.content.filter((one) => !drop(one)).map(strip) }),
      });
      return strip(node);
    };
    const footnoteMark = (node: JSONContent) => node.type === FOOTNOTE_NODE;
    const keptMark = (node: JSONContent) =>
      node.type === WORD_ATOM_NODE && node.attrs?.kind === "footnote";
    const marks: string[] = [];
    readMind(client).descendants((node) => {
      if (footnoteMark(node.toJSON())) marks.push("footnote");
      else if (keptMark(node.toJSON())) marks.push("kept");
    });
    expect(marks).toEqual(["footnote", "kept"]);

    editMind(client, (blocks) => blocks.map(without(footnoteMark)));
    await client.settled();
    let { part } = await exported(core, mindId);
    expect(part("word/document.xml").match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1);
    expect(noteXml(part("word/footnotes.xml"), "footnote", 1)).toContain("Shared note.");

    editMind(client, (blocks) => blocks.map(without(keptMark)));
    await client.settled();
    ({ part } = await exported(core, mindId));
    expect(part("word/document.xml")).not.toContain("<w:footnoteReference");
    expect(noteXml(part("word/footnotes.xml"), "footnote", 1)).toBeNull();
  });
});

describe("a note or page break from another file's Note", () => {
  test.each([
    [
      "English",
      "The lease ends.",
      "B's own note.",
      "From A's endnote.",
      "From A's third footnote.",
    ],
    ["Chinese", "租约到期。", "乙方自己的脚注。", "来自甲文件的尾注。", "来自甲文件的第三条脚注。"],
  ])(
    "is written as a new one, never dropped, and the file's own notes stay byte for byte (%s)",
    async (_, body, own, endnote, footnote) => {
      // B has one footnote, no endnotes, and a column break at the place A's page break names.
      const { core, bytes, mindId, client } = await setUp({
        body: [
          paragraph(`${run(body)}${noteMark("footnote", 1)}`),
          paragraph(`${run("Part two.")}<w:r><w:br w:type="column"/></w:r>${run("Column two.")}`),
        ].join(""),
        footnotes: note("footnote", 1, [own]),
      });
      // As the core receives them from anything but this device's editor, which takes the places off.
      const fromA: JSONContent[] = [
        {
          type: FOOTNOTE_NODE,
          attrs: { id: randomUUID(), source: "w:endnoteReference#0", endnote: true },
          content: [{ type: "text", text: endnote }],
        },
        {
          type: FOOTNOTE_NODE,
          attrs: { id: randomUUID(), source: "w:footnoteReference#3" },
          content: [{ type: "text", text: footnote }],
        },
        { type: PAGE_BREAK_NODE, attrs: { source: "w:br#7" } },
        { type: "text", text: "After." },
        { type: PAGE_BREAK_NODE, attrs: { source: "w:br#0" } },
      ];
      editMind(client, (blocks) => [
        { ...(blocks[0] as JSONContent), content: [...(blocks[0]?.content ?? []), ...fromA] },
        blocks[1] as JSONContent,
      ]);
      await client.settled();

      const was = unzip(bytes).get("word/footnotes.xml")?.toString("utf8") ?? "";
      const { files, part } = await exported(core, mindId);
      const document = part("word/document.xml");
      const footnotes = part("word/footnotes.xml");
      expect(noteXml(footnotes, "footnote", 1)).toBe(noteXml(was, "footnote", 1));
      const ids = [...document.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toHaveLength(3);
      const added = ids.filter((id) => id !== 1);
      expect(added.map((id) => noteXml(footnotes, "footnote", id))).toEqual([
        expect.stringContaining(endnote),
        expect.stringContaining(footnote),
      ]);
      expect(files.has("word/endnotes.xml")).toBe(false);
      expect(document.match(/<w:br w:type="page"\/>/g)).toHaveLength(2);
      expect(document.match(/<w:br w:type="column"\/>/g)).toHaveLength(1);
    },
  );
  test.each([
    ["English", "Part two.", "A's picture"],
    ["Chinese", "第二部分。", "甲文件的图片"],
  ])(
    "a picture is a new image part of its own where it was pasted, and the file's own picture stays byte for byte (%s)",
    async (_, text, alt) => {
      const logo = paragraph(`${run("Logo:")}${picture("rIdImage", "B's logo")}`);
      const { core, mindId, client } = await setUp({
        body: [logo, paragraph(text)].join(""),
        media: { rIdImage: { name: "media/image1.png", data: PNG } },
      });
      const fromA = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        "base64",
      );
      // At the place of B's own picture, and at one B doesn't have.
      const pasted = (source: string): JSONContent => ({
        type: "image",
        attrs: { src: `data:image/png;base64,${fromA.toString("base64")}`, alt, source },
      });
      editMind(client, (blocks) => [
        blocks[0] as JSONContent,
        {
          ...(blocks[1] as JSONContent),
          content: [...(blocks[1]?.content ?? []), pasted("w:drawing#0"), pasted("w:drawing#5")],
        },
      ]);
      await client.settled();

      const { files, part } = await exported(core, mindId);
      const document = part("word/document.xml");
      expect(files.get("word/media/image1.png")?.equals(PNG)).toBe(true);
      expect(document).toContain(logo);
      const added = [...files]
        .filter(([name, data]) => name.startsWith("word/media/") && data.equals(fromA))
        .map(([name]) => name.slice("word/".length));
      expect(added).toHaveLength(2);
      const relationships = part("word/_rels/document.xml.rels");
      const where = [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
        .map((match) => match[0])
        .find((each) => each.includes(text));
      for (const name of added) {
        const id = new RegExp(`<Relationship [^>]*Id="([^"]+)"[^>]*Target="${name}"`).exec(
          relationships,
        )?.[1];
        expect(where).toContain(`r:embed="${id}"`);
      }
    },
  );

  test.each([
    ["English", "A's photo"],
    ["Chinese", "甲文件的照片"],
  ])(
    "a picture is written at the size the Note shows it at, and a WebP or a BMP as an image part of its kind (%s)",
    async (_, alt) => {
      const { core, mindId, client } = await setUp({ body: paragraph("Target here.") });
      const webp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
      // One pixel, 24 bits, in a header of 40 bytes, as Word's own BMPs are.
      const bmp = Buffer.alloc(58);
      bmp.write("BM", 0, "latin1");
      bmp.writeUInt32LE(58, 2);
      bmp.writeUInt32LE(54, 10);
      bmp.writeUInt32LE(40, 14);
      bmp.writeInt32LE(1, 18);
      bmp.writeInt32LE(-1, 22);
      bmp.writeUInt16LE(1, 26);
      bmp.writeUInt16LE(24, 28);
      const pasted = (type: string, data: Buffer): JSONContent => ({
        type: "image",
        attrs: {
          src: `data:image/${type};base64,${data.toString("base64")}`,
          alt,
          width: 100,
          height: 50,
          source: "w:drawing#3",
        },
      });
      editMind(client, (blocks) => [
        {
          ...(blocks[0] as JSONContent),
          content: [
            ...(blocks[0]?.content ?? []),
            pasted("png", PNG),
            pasted("webp", webp),
            pasted("bmp", bmp),
          ],
        },
      ]);
      await client.settled();

      const { files, part } = await exported(core, mindId);
      const document = part("word/document.xml");
      // 100 by 50 pixels, at 9,525 EMU a pixel, though each image is 1 by 1.
      expect(document.match(/<wp:extent cx="952500" cy="476250"\/>/g)).toHaveLength(3);
      expect(document.match(/<w:drawing>/g)).toHaveLength(3);
      expect(document.split(alt)).toHaveLength(7);
      expect([...files].find(([name]) => name.endsWith(".webp"))?.[1].equals(webp)).toBe(true);
      expect([...files].find(([name]) => name.endsWith(".bmp"))?.[1].equals(bmp)).toBe(true);
      const types = part("[Content_Types].xml");
      expect(types).toContain('<Default Extension="webp" ContentType="image/webp"/>');
      expect(types).toContain('<Default Extension="bmp" ContentType="image/bmp"/>');
    },
  );
});

describe("what another file's import kept as is: a field, a note and a picture (an SVG)", () => {
  interface FromA {
    field: string;
    note: string;
    chart: string;
  }
  const LANGUAGES: [string, FromA][] = [
    ["English", { field: "2026-01-01", note: "A note with a picture.", chart: "A's chart" }],
    ["Chinese", { field: "2026年1月1日", note: "甲文件带图片的脚注。", chart: "甲文件的图表" }],
  ];
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

  /** A note a footnote can't hold, so the import keeps it as is: it has a table. */
  const keptNote = (id: number, text: string, type = "") =>
    `<w:footnote${type ? ` w:type="${type}"` : ""} w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:footnoteRef/></w:r>${run(` ${text}`)}</w:p>${table([["In a table"]])}</w:footnote>`;

  /**
   * File A, imported: a field at its runs 5 to 9, a note kept as is at its
   * second note's mark, an SVG at its first drawing, and a field in a note.
   */
  const fileA = (a: FromA): WordFileInput => ({
    body: [
      paragraph(["A0", "A1", "A2", "A3", "A4"].map((each) => run(each)).join("")),
      paragraph(field("DATE", a.field)),
      paragraph(`${run("Own.")}${noteMark("footnote", 1)}`),
      paragraph(`${run("Kept.")}${noteMark("footnote", 2)}`),
      paragraph(`${run("Chart: ")}${picture("rIdSvg", a.chart)}`),
    ].join(""),
    footnotes: [
      note("footnote", 1, [`${run("See ")}${field("DATE", a.field)}`]),
      keptNote(2, a.note),
    ].join(""),
    media: { rIdSvg: { name: "media/image1.svg", data: SVG } },
  });

  /**
   * What A's import kept as is, as pasting it from A's Note carries it: with
   * A's places, or with none, as this device's editor leaves a paste.
   */
  async function keptFromA(core: Core, a: FromA, placed: boolean) {
    const { client } = await importWordBytes(
      core,
      await createTempDataFolder(),
      wordFile(fileA(a)),
      {
        origin: "own",
        name: "A.docx",
      },
    );
    const atoms: JSONContent[] = [];
    readMind(client).descendants((node) => {
      if (node.type.name === WORD_ATOM_NODE) atoms.push(node.toJSON());
    });
    const inNote = atoms.filter((atom) => String(atom.attrs?.source).includes("!"));
    const body = atoms
      .filter((atom) => !inNote.includes(atom))
      .map((atom) => (placed ? atom : { ...atom, attrs: { ...atom.attrs, source: null } }));
    expect(body.map((atom) => [atom.attrs?.kind, atom.attrs?.source])).toEqual([
      ["field", placed ? "w:r#5..w:r#9" : null],
      ["footnote", placed ? "w:footnoteReference#1" : null],
      ["picture", placed ? "w:drawing#0" : null],
    ]);
    return { body, inNote: inNote[0] as JSONContent };
  }

  /** Puts A's atoms at the end of B's first paragraph, which reads "Target here.". */
  const pasteInto = (client: MindClient, atoms: JSONContent[]) =>
    editMind(client, (blocks) => [
      { ...(blocks[0] as JSONContent), content: [...(blocks[0]?.content ?? []), ...atoms] },
      ...blocks.slice(1),
    ]);

  const paragraphWith = (document: string, text: string) =>
    [...document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
      .map((match) => match[0])
      .find((each) => each.includes(text)) ?? "";

  /** What the export wrote for A's atoms: A's text where they were put, A's note a new footnote. */
  async function expectWrittenAsA(core: Core, mindId: string, a: FromA) {
    const result = await core.exportMind(mindId, { format: "docx" });
    const files = unzip(result.data);
    const part = (name: string) => files.get(name)?.toString("utf8") ?? "";
    const target = paragraphWith(part("word/document.xml"), "Target here.");
    expect(target).toContain(a.field);
    expect(target).toContain(a.chart);
    expect(target).not.toContain("<w:drawing");
    expect(target).not.toContain("fldChar");
    const ids = [...target.matchAll(/<w:footnoteReference w:id="(\d+)"\/>/g)].map((match) =>
      Number(match[1]),
    );
    expect(ids).toHaveLength(1);
    expect(noteXml(part("word/footnotes.xml"), "footnote", ids[0] ?? 0)).toContain(a.note);
    expect(result.word?.notKept).toEqual([
      expect.objectContaining({ kind: "copy", text: a.field }),
      expect.objectContaining({ kind: "copy", text: expect.stringContaining(a.note) }),
      expect.objectContaining({ kind: "copy", text: a.chart }),
    ]);
    return { files, part };
  }

  test.each(LANGUAGES)(
    "pasted into B, where B has a deleted note, its own runs and its own SVG at their places, is A's, and B's stay as they were (%s)",
    async (_, a) => {
      const diagram = paragraph(`${run("Diagram: ")}${picture("rIdSvg", "B's diagram")}`);
      const dated = paragraph(
        `${run("Dated ")}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("2025-12-31")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      );
      const secret = paragraph(["B5", "B6", "B7", "B8"].map((each) => run(each)).join(""));
      // B's runs 5 to 9 are B5 to B8 and "Dated ", where A's field is.
      const { core, bytes, mindId, client } = await setUp({
        body: [
          paragraph("Target here."),
          paragraph(`${run("Kept.")}${noteMark("footnote", 1)}`),
          paragraph(`${run("Gone.")}${noteMark("footnote", 2)}`),
          secret,
          dated,
          diagram,
        ].join(""),
        footnotes: [
          note("footnote", 1, ["B's first note."]),
          keptNote(2, "B's deleted note."),
        ].join(""),
        media: { rIdSvg: { name: "media/image1.svg", data: SVG } },
      });
      const keptKinds: unknown[] = [];
      readMind(client).descendants((node) => {
        if (node.type.name === WORD_ATOM_NODE) keptKinds.push(node.attrs.kind);
      });
      expect(keptKinds).toEqual(["footnote", "field", "picture"]);
      // The User deletes B's second note, kept as is.
      editMind(client, (blocks) =>
        blocks.map((block) => ({
          ...block,
          content: block.content?.filter(
            (each) => !(each.type === WORD_ATOM_NODE && each.attrs?.kind === "footnote"),
          ),
        })),
      );
      pasteInto(client, (await keptFromA(core, a, true)).body);
      await client.settled();

      const before = unzip(bytes);
      const { files, part } = await expectWrittenAsA(core, mindId, a);
      const document = part("word/document.xml");
      const footnotes = part("word/footnotes.xml");
      expect(document).not.toContain('<w:footnoteReference w:id="2"/>');
      expect(noteXml(footnotes, "footnote", 2)).toBeNull();
      expect(footnotes).not.toContain("B's deleted note.");
      expect(noteXml(footnotes, "footnote", 1)).toBe(
        noteXml(before.get("word/footnotes.xml")?.toString("utf8") ?? "", "footnote", 1),
      );
      for (const own of ["B5", "B6", "B7", "B8", "Dated "])
        expect(document.split(own)).toHaveLength(2);
      expect(document).toContain(secret);
      expect(document).toContain(dated);
      expect(document).toContain(diagram);
      expect(files.get("word/media/image1.svg")?.equals(SVG)).toBe(true);
    },
  );

  test.each(LANGUAGES)(
    "pasted into a file with none of their places is A's, never left out (%s)",
    async (_, a) => {
      const { core, mindId, client } = await setUp({ body: paragraph("Target here.") });
      pasteInto(client, (await keptFromA(core, a, true)).body);
      await client.settled();
      const { part } = await expectWrittenAsA(core, mindId, a);
      expect(part("word/document.xml").match(/<w:footnoteReference /g)).toHaveLength(1);
    },
  );

  test.each(LANGUAGES)(
    "pasted with no place, as this device's editor leaves a paste from another file, is A's (%s)",
    async (_, a) => {
      const { core, mindId, client } = await setUp({
        body: [
          paragraph("Target here."),
          paragraph(`${run("Kept.")}${noteMark("footnote", 1)}`),
        ].join(""),
        footnotes: note("footnote", 1, ["B's first note."]),
      });
      pasteInto(client, (await keptFromA(core, a, false)).body);
      await client.settled();
      await expectWrittenAsA(core, mindId, a);
    },
  );

  test.each(LANGUAGES)(
    "a field imported before the hash, pasted naming B's plain runs, is A's text; B's own field from before the hash is still B's (%s)",
    async (_, a) => {
      const dated = paragraph(`${run("Dated ")}${field("DATE", "2025-12-31")}`);
      const plainRuns = paragraph(["B1", "B2", "B3", "B4", "B5"].map((each) => run(each)).join(""));
      const { core, bytes, mindId, client } = await setUp({
        body: [paragraph("Target here."), plainRuns, dated].join(""),
      });
      // As an import before the hash recorded B's own field: no hash, its paragraph unedited.
      client.doc.transact(() => {
        for (const block of client.blocks.toArray()) {
          if (!(block instanceof Y.XmlElement)) continue;
          for (const child of block.toArray()) {
            if (!(child instanceof Y.XmlElement) || child.nodeName !== WORD_ATOM_NODE) continue;
            child.removeAttribute("hash");
            const id = block.getAttribute("id");
            const source = typeof id === "string" ? wordSourceOf(client.doc, id) : null;
            if (typeof id === "string" && source) {
              setWordSource(client.doc, id, { ...source, f: wordFingerprint(block) });
            }
          }
        }
      });
      // B's runs 2 to 4 are B2, B3 and B4.
      pasteInto(client, [
        {
          type: WORD_ATOM_NODE,
          attrs: {
            kind: "field",
            label: a.field,
            text: "",
            source: "w:r#2..w:r#4",
            info: { field: "DATE" },
          },
        },
      ]);
      await client.settled();

      const result = await core.exportMind(mindId, { format: "docx" });
      const document = unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "";
      const target = paragraphWith(document, "Target here.");
      expect(target).toContain(a.field);
      expect(target).not.toContain("B3");
      for (const own of ["B2", "B3", "B4"]) expect(document.split(own)).toHaveLength(2);
      expect(document).toContain(plainRuns);
      const was = unzip(bytes).get("word/document.xml")?.toString("utf8") ?? "";
      expect(paragraphWith(document, "Dated ")).toBe(paragraphWith(was, "Dated "));
      expect(paragraphWith(document, "Dated ")).toContain("fldChar");
      expect(result.word?.notKept).toEqual([
        expect.objectContaining({ kind: "copy", text: a.field }),
      ]);
    },
  );

  test.each([
    ["English", "Target here."],
    ["Chinese", "此处粘贴。"],
  ])(
    "a note kept as is with no text the Note knows, pasted with no place, keeps its mark as a new footnote, and is listed (%s)",
    async (_, body) => {
      const { core, mindId, client } = await setUp({ body: paragraph(body) });
      editMind(client, (blocks) => [
        {
          ...(blocks[0] as JSONContent),
          content: [
            ...(blocks[0]?.content ?? []),
            {
              type: WORD_ATOM_NODE,
              attrs: { kind: "footnote", label: "1", text: "", source: null },
            },
          ],
        },
      ]);
      await client.settled();
      const result = await core.exportMind(mindId, { format: "docx" });
      const files = unzip(result.data);
      const document = files.get("word/document.xml")?.toString("utf8") ?? "";
      const id = /<w:footnoteReference w:id="(\d+)"\/>/.exec(paragraphWith(document, body))?.[1];
      expect(
        noteXml(files.get("word/footnotes.xml")?.toString("utf8") ?? "", "footnote", Number(id)),
      ).not.toBeNull();
      expect(result.word?.notKept).toEqual([expect.objectContaining({ kind: "note", text: "" })]);
    },
  );

  test.each(LANGUAGES)(
    "a field pasted into one of B's notes, naming the place of that note's own runs, is A's text there (%s)",
    async (_, a) => {
      // The footnotes part's runs 5 to 9 are B2 to B6 in B, and A's note's field in A.
      const own = ["B1", "B2", "B3", "B4", "B5", "B6", "B7"];
      const { core, bytes, mindId, client } = await setUp({
        body: paragraph(`${run("Kept.")}${noteMark("footnote", 1)}`),
        footnotes: note("footnote", 1, [own.map((each) => run(each)).join("")]),
      });
      const field = (await keptFromA(core, a, true)).inNote;
      expect(field.attrs?.source).toBe("word/footnotes.xml!w:r#5..word/footnotes.xml!w:r#9");
      const withField = (node: JSONContent): JSONContent =>
        node.type === FOOTNOTE_NODE
          ? { ...node, content: [...(node.content ?? []), field] }
          : { ...node, ...(node.content && { content: node.content.map(withField) }) };
      editMind(client, (blocks) => blocks.map(withField));
      await client.settled();

      const result = await core.exportMind(mindId, { format: "docx" });
      const files = unzip(result.data);
      const written = noteXml(
        files.get("word/footnotes.xml")?.toString("utf8") ?? "",
        "footnote",
        1,
      );
      expect(written).toContain(a.field);
      for (const each of own) expect(written?.split(each)).toHaveLength(2);
      expect(written?.match(/<w:footnoteRef\/>/g)).toHaveLength(1);
      expect(
        files
          .get("word/document.xml")
          ?.equals(unzip(bytes).get("word/document.xml") ?? Buffer.alloc(0)),
      ).toBe(true);
      expect(result.word?.notKept).toEqual([
        expect.objectContaining({ kind: "copy", text: a.field }),
      ]);
    },
  );
});

describe("page breaks", () => {
  const breaks = (): WordFileInput => ({
    body: [
      paragraph("Part one."),
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
      paragraph(`${run("Part two.")}<w:r><w:br w:type="column"/></w:r>${run("Column two.")}`),
    ].join(""),
  });

  test("a page break is the Note's own and goes back as it was; a column break is kept as is", async () => {
    const { core, bytes, mindId, client } = await setUp(breaks());
    const shown = readMind(client).toJSON().content ?? [];
    expect(shown[1]?.content).toEqual([{ type: PAGE_BREAK_NODE, attrs: { source: "w:br#0" } }]);
    expect(shown[2]?.content?.[1]).toMatchObject({
      type: WORD_ATOM_NODE,
      attrs: { kind: "columnBreak" },
    });
    expect(wordReportOf(client.doc)).toMatchObject({ pageBreaks: 1, kept: { columnBreak: 1 } });
    const { files } = await exported(core, mindId);
    expect(changed(unzip(bytes), files)).toEqual([]);
  });

  test("a page break deleted is gone from the file; one added is Word's page break where it was put", async () => {
    const { core, mindId, client } = await setUp(breaks());
    editMind(client, (blocks) => [
      blocks[0] as JSONContent,
      { type: "paragraph", content: [{ type: "text", text: "Added." }, { type: PAGE_BREAK_NODE }] },
      blocks[2] as JSONContent,
    ]);
    await client.settled();
    const { part } = await exported(core, mindId);
    const document = part("word/document.xml");
    expect(document.match(/<w:br w:type="page"\/>/g)).toHaveLength(1);
    expect(document).toMatch(/Added\.<\/w:t><\/w:r><w:r><w:br w:type="page"\/><\/w:r><\/w:p>/);
    expect(document).toContain('<w:br w:type="column"/>');
  });

  test("a native Note's page break is Word's page break, and starts a new page in its PDF's HTML", async () => {
    const core = startCore(await createTempDataFolder());
    const mind = await core.createMind({ title: "Memo" });
    const client = await connectToMind(core, mind.id);
    editMind(client, () => [
      { type: "paragraph", content: [{ type: "text", text: "Page one." }] },
      { type: "paragraph", content: [{ type: PAGE_BREAK_NODE }] },
      { type: "paragraph", content: [{ type: "text", text: "Page two." }] },
    ]);
    await client.settled();
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(files.get("word/document.xml")?.toString("utf8")).toContain(
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    );
    const html = new TextDecoder().decode(
      (await core.exportMind(mind.id, { format: "html" })).data,
    );
    expect(html).toMatch(/Page one\.<\/p><div class="page-break"><\/div><p[^>]*>Page two\./);
  });
});

describe("a Note imported before its notes were its own", () => {
  /** Makes the Note as an import before #746 made it: its notes and page breaks read-only atoms. */
  function asImportedBefore(client: MindClient): void {
    client.doc.transact(() => {
      const visit = (element: Y.XmlElement) => {
        element.toArray().forEach((child, index) => {
          if (!(child instanceof Y.XmlElement)) return;
          if (child.nodeName !== FOOTNOTE_NODE && child.nodeName !== PAGE_BREAK_NODE) {
            visit(child);
            return;
          }
          const atom = new Y.XmlElement(WORD_ATOM_NODE);
          const footnote = child.nodeName === FOOTNOTE_NODE;
          const kind = !footnote
            ? "pageBreak"
            : (child.getAttributes() as Record<string, unknown>).endnote === true
              ? "endnote"
              : "footnote";
          atom.setAttribute("kind", kind);
          atom.setAttribute("label", footnote ? "1" : "");
          atom.setAttribute("text", footnote ? "a note" : "");
          atom.setAttribute("source", child.getAttribute("source") as string);
          element.delete(index, 1);
          element.insert(index, [atom]);
        });
        const id = element.getAttribute("id");
        const source = typeof id === "string" ? wordSourceOf(client.doc, id) : null;
        if (typeof id === "string" && source) {
          setWordSource(client.doc, id, { ...source, f: wordFingerprint(element) });
        }
      };
      for (const block of client.blocks.toArray()) if (block instanceof Y.XmlElement) visit(block);
      client.doc.getMap(MIND_WORD_FIELD).delete("notes");
    });
  }

  test("has its notes and page breaks converted when it is opened, and still exports as the file was", async () => {
    const { core, bytes, mindId, client } = await setUp({
      ...brief(),
      body: `${brief().body}<w:p><w:r><w:br w:type="page"/></w:r></w:p>${paragraph("After.")}`,
    });
    asImportedBefore(client);
    await client.settled();
    expect(footnotesOf(client)).toEqual([]);
    await core.closeMind(mindId);

    const opened = await connectToMind(core, mindId);
    const notes = footnotesOf(opened);
    expect(notes.map((each) => plain(each.content))).toEqual([
      "See Hale v Nair, 2019.",
      "Clause 4.2.\nRead with clause 9.",
      "Schedule 3 lists the fittings.",
    ]);
    expect(notes[2]?.attrs?.endnote).toBe(true);
    const shown = readMind(opened).toJSON().content ?? [];
    expect(shown.at(-2)?.content).toEqual([{ type: PAGE_BREAK_NODE, attrs: { source: "w:br#0" } }]);
    expect(wordNoteNumberingOf(opened.doc)?.endnote.format).toBe("lowerRoman");
    expect(wordReportOf(opened.doc)).toMatchObject({ footnotes: 2, endnotes: 1, pageBreaks: 1 });

    const { files } = await exported(core, mindId);
    expect(changed(unzip(bytes), files)).toEqual([]);

    // Its footnotes are its own now: an edit goes into the note.
    editFootnote(opened, "Schedule 3 lists the fittings.", (text) => text.replace("3", "4"));
    await opened.settled();
    const again = await exported(core, mindId);
    expect(changed(unzip(bytes), again.files)).toEqual(["word/endnotes.xml"]);
  });

  test.each([
    ["English", "The lease ends.", "A note with a table."],
    ["Chinese", "租约到期。", "带表格的脚注。"],
  ])(
    "a note kept as is, stored as an import before stored it, with no text and no hash, exports byte for byte (%s)",
    async (_, body, text) => {
      const { core, bytes, mindId, client } = await setUp({
        body: [paragraph(`${run(body)}${noteMark("footnote", 1)}`), paragraph("After.")].join(""),
        footnotes: `<w:footnote w:type="normal" w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:footnoteRef/></w:r>${run(` ${text}`)}</w:p>${table([["In a table"]])}</w:footnote>`,
      });
      // An import before #746 read a note typed "normal" as one with no text, and recorded no hash.
      client.doc.transact(() => {
        for (const block of client.blocks.toArray()) {
          if (!(block instanceof Y.XmlElement)) continue;
          for (const child of block.toArray()) {
            if (!(child instanceof Y.XmlElement) || child.nodeName !== WORD_ATOM_NODE) continue;
            expect(child.getAttribute("text")).toContain(text);
            child.setAttribute("text", "");
            child.removeAttribute("hash");
            const id = block.getAttribute("id");
            const source = typeof id === "string" ? wordSourceOf(client.doc, id) : null;
            if (typeof id === "string" && source) {
              setWordSource(client.doc, id, { ...source, f: wordFingerprint(block) });
            }
          }
        }
        client.doc.getMap(MIND_WORD_FIELD).delete("notes");
      });
      await client.settled();
      await core.closeMind(mindId);
      await connectToMind(core, mindId);

      const result = await core.exportMind(mindId, { format: "docx" });
      expect(changed(unzip(bytes), unzip(result.data))).toEqual([]);
      expect(result.word?.notKept).toEqual([]);
    },
  );
});

describe("note numbers", () => {
  test("are written as the file numbers them", () => {
    expect(
      [1, 2, 3, 4, 5].map((number) => noteLabel(number, { format: "lowerRoman", start: 1 })),
    ).toEqual(["i", "ii", "iii", "iv", "v"]);
    expect(noteLabel(5, { format: "chicago", start: 1 })).toBe("**");
    expect(noteLabel(2, { format: "decimalEnclosedCircleChinese", start: 1 })).toBe("②");
    expect(noteLabel(1, { format: "upperLetter", start: 27 })).toBe("AA");
    expect(noteLabel(3, { format: "decimal", start: 1 })).toBe("3");
    expect(noteLabel(3, { format: "somethingNew", start: 1 })).toBe("3");
    // A damaged file's start is never drawn as an endless label.
    expect(noteLabel(1, { format: "lowerRoman", start: 1e300 })).toBe(String(1e300));
  });

  test("a damaged file's first number is read as 1", async () => {
    const { client } = await setUp({
      ...brief(),
      settings:
        '<w:endnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="1e300"/></w:endnotePr>',
    });
    expect(wordNoteNumberingOf(client.doc)?.endnote).toEqual({ format: "lowerRoman", start: 1 });
  });
});
