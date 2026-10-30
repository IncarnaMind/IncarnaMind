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
  note,
  noteMark,
  paragraph,
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
