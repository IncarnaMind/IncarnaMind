/**
 * What a Word Note's look reads for its lines to fall where Word puts them (#746): the document
 * grid of Chinese and Japanese files, whether the text is East Asian, and the lines of a table of
 * contents kept as is; and the fonts Get info says aren't installed.
 */
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { MIND_WORD_LOOK_FIELD, WORD_BLOCK_NODE, WORD_LOOK_ATTRIBUTE } from "../../src/core";
import { WORD_LOOK_VERSION } from "../../src/core/documents/formats/docxLook";
import { readWordAtom } from "../../src/shared/wordFiles";
import { wordLookOf } from "../../src/shared/wordLook";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { unzip } from "../helpers/docx";
import { recordingLog } from "../helpers/log";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { paragraph, STYLES, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const CHINESE_STYLES = `${STYLES}<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8296"/></w:tabs><w:spacing w:after="100"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8296"/></w:tabs><w:spacing w:after="100"/><w:ind w:left="420"/></w:pPr></w:style><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>`;

const text = (value: string) => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
const tab = "<w:r><w:tab/></w:r>";

/** A table of contents of two lines, as Word writes one into a content control. */
const TOC_CONTROL = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>${paragraph(
  `${text("一、总则")}${tab}${text("1")}`,
  { style: "TOC1" },
)}${paragraph(`${text("（一）适用范围")}${tab}${text("2")}`, { style: "TOC2" })}</w:sdtContent></w:sdt>`;

/** A table of contents as a field over two paragraphs, outside any control. */
const TOC_FIELD = `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${text("一、总则")}${tab}${text("1")}</w:p><w:p><w:pPr><w:pStyle w:val="TOC2"/></w:pPr>${text("（一）适用范围")}${tab}${text("2")}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

function chineseNotice(toc: string): Buffer {
  return wordFile({
    styles: CHINESE_STYLES,
    body: `${toc}${paragraph("第一条　为规范管理，制定本办法。")}<w:p><w:pPr><w:snapToGrid w:val="0"/></w:pPr>${text("附表不按网格排列。")}</w:p>`,
    sectPr:
      '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/><w:docGrid w:type="lines" w:linePitch="312"/>',
  });
}

async function imported(bytes: Buffer) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const mind = await importWordBytes(core, dataDir, bytes, { name: "通知.docx", origin: "own" });
  const look = wordLookOf(mind.client.doc);
  if (!look) throw new Error("No look.");
  return { dataDir, core, ...mind, look };
}

function keptBlocks(client: MindClient) {
  return client.blocks
    .toArray()
    .filter(
      (each): each is Y.XmlElement =>
        each instanceof Y.XmlElement && each.nodeName === WORD_BLOCK_NODE,
    );
}

const looksOf = (element: Y.XmlElement) => readWordAtom(element.getAttributes()).info?.looks;

describe("a Word file's lines, as its look reads them", () => {
  test("a Chinese file's document grid and East Asian text are read; a paragraph off the grid says so", async () => {
    const { look, client, core } = await imported(chineseNotice(""));
    expect(look.linePitch).toBe(15.6);
    expect(look.eastAsian).toBe(true);
    const keys = client.blocks
      .toArray()
      .map((each) =>
        each instanceof Y.XmlElement ? each.getAttribute(WORD_LOOK_ATTRIBUTE) : null,
      );
    const last = keys.at(-1);
    expect(typeof last === "string" && look.paragraphs[last]?.snapToGrid).toBe(false);
    const first = keys[0];
    expect(typeof first === "string" && look.paragraphs[first]?.snapToGrid).toBeUndefined();
    core.close();
  });

  test("the first section's grid is read where its break sits in a content control", async () => {
    const { look, core } = await imported(
      wordFile({
        body: `<w:sdt><w:sdtContent><w:p><w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1800" w:right="1800"/><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr></w:pPr>${text("第一节。")}</w:p></w:sdtContent></w:sdt>${paragraph("第二节。")}`,
        sectPr: '<w:pgSz w:w="11906" w:h="16838"/><w:docGrid w:linePitch="360"/>',
      }),
    );
    expect(look.linePitch).toBe(15.6);
    expect(look.width).toBe(415.3);
    core.close();
  });

  test("an English file with Word's default grid snaps nothing and has no East Asian text", async () => {
    const { look, core } = await imported(
      wordFile({
        body: paragraph("Prices are fixed for the first twelve months."),
        sectPr: '<w:pgSz w:w="11906" w:h="16838"/><w:docGrid w:linePitch="360"/>',
      }),
    );
    expect(look.linePitch).toBeUndefined();
    expect(look.eastAsian).toBeUndefined();
    core.close();
  });

  test("each line of a table of contents kept as is has its paragraph's look, in a control or as a field", async () => {
    for (const toc of [TOC_CONTROL, TOC_FIELD]) {
      const { look, client, core } = await imported(chineseNotice(toc));
      const lines = keptBlocks(client).flatMap((block) => looksOf(block) ?? []);
      expect(lines).toHaveLength(2);
      const [first, second] = lines.map((key) => look.paragraphs[key]);
      expect(first?.after).toBe(5);
      expect(second?.left).toBe(21);
      expect(first?.tabs).toEqual([{ at: 414.8, align: "right", leader: "dot" }]);
      core.close();
    }
  });

  test("a Note imported before gets its table of contents' looks at the next start, and exports the file's own bytes", async () => {
    const bytes = chineseNotice(TOC_CONTROL);
    const { dataDir, core, mindId, client } = await imported(bytes);
    client.doc.transact(() => {
      for (const block of keptBlocks(client)) {
        const info = readWordAtom(block.getAttributes()).info;
        // An atom's info is an object, as the import writes it.
        (block as Y.XmlElement<Record<string, string | object>>).setAttribute("info", {
          field: info?.field ?? "TOC",
        });
      }
      client.doc.getMap(MIND_WORD_LOOK_FIELD).set("version", WORD_LOOK_VERSION - 1);
    });
    await client.settled();
    expect(keptBlocks(client).map(looksOf)).toEqual([undefined]);
    core.close();
    queryDatabase(dataDir, "UPDATE word_packages SET look_version = ? WHERE mind_id = ?", [
      WORD_LOOK_VERSION - 1,
      mindId,
    ]);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    const look = wordLookOf(after.doc);
    const lines = keptBlocks(after).flatMap((block) => looksOf(block) ?? []);
    expect(lines).toHaveLength(2);
    for (const key of lines) expect(look?.paragraphs[key]).toBeDefined();
    const exported = unzip((await restarted.exportMind(mindId, { format: "docx" })).data);
    const original = unzip(bytes);
    expect(
      exported
        .get("word/document.xml")
        ?.equals(original.get("word/document.xml") ?? Buffer.alloc(0)),
    ).toBe(true);
    restarted.close();
  });
});

describe("the fonts a Word Note draws in, for Get info", () => {
  test("its runs' fonts, and their East Asian fonts only when the text is East Asian", async () => {
    const chinese = await imported(chineseNotice(""));
    expect(await chinese.core.wordFonts(chinese.mindId)).toEqual(
      expect.arrayContaining(["Times New Roman", "宋体"]),
    );
    chinese.core.close();
    const english = await imported(
      wordFile({
        styles: CHINESE_STYLES,
        body: paragraph("Prices are fixed for the first twelve months."),
      }),
    );
    const fonts = await english.core.wordFonts(english.mindId);
    expect(fonts).toContain("Times New Roman");
    expect(fonts).not.toContain("宋体");
    const plain = await english.core.createMind({ title: "Mine" });
    expect(await english.core.wordFonts(plain.id)).toEqual([]);
    english.core.close();
  });
});
