import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  type Core,
  type CoreAdapters,
  MIND_CONTENT_FIELD,
  MIND_SETTINGS_FIELD,
  MIND_WORD_LOOK_FIELD,
  PARAGRAPH_FORMAT_ATTRIBUTE,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
  WORD_TAB_MARK,
  type WordLook,
  type WordParagraphLook,
} from "../../src/core";
import { WORD_LOOK_VERSION } from "../../src/core/documents/formats/docxLook";
import { WORD_PACKAGES_FOLDER } from "../../src/core/wordImports";
import { WORD_LOOK_TYPES } from "../../src/renderer/src/editor/wordSchema";
import { pendingProposals } from "../../src/shared/proposals";
import {
  wordFileOf,
  wordFingerprint,
  wordImportProgressOf,
  wordSourceOf,
} from "../../src/shared/wordFiles";
import { wordLookOf } from "../../src/shared/wordLook";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { acceptedParagraphs, unzip } from "../helpers/docx";
import { recordingLog } from "../helpers/log";
import { longContract } from "../helpers/longContract";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, resolveChanges } from "../helpers/minds";
import { paragraph, run, wordFile } from "../helpers/word";
import { contractFile, RESUME_TEXT_WIDTH_TWIPS, resumeFile } from "../helpers/wordLookFiles";
import { withFormat, withMarks } from "../helpers/wordLookResolved";
import { importWordBytes } from "../helpers/wordMinds";

/** Each Block's look as drawn, its format over it; a text with no run mark has its paragraph's `run` look. */
function styled(client: MindClient, look: WordLook) {
  const found: { type: string; text: string; look: unknown; runs: unknown[]; format: unknown }[] =
    [];
  readMind(client).descendants((node) => {
    if (!WORD_LOOK_TYPES.includes(node.type.name)) {
      return true;
    }
    const key = node.attrs[WORD_LOOK_ATTRIBUTE] as string | null;
    const styles =
      node.type.name === "table"
        ? look.tables
        : node.type.name.startsWith("table")
          ? look.cells
          : look.paragraphs;
    const {
      run: paragraphRun,
      next: _next,
      characterSize,
      ...own
    } = (key ? styles[key] : {}) as WordParagraphLook;
    const format = node.attrs[PARAGRAPH_FORMAT_ATTRIBUTE] ?? null;
    const runs: unknown[] = [];
    node.forEach((child) => {
      const run =
        child.marks.find((mark) => mark.type.name === WORD_RUN_MARK)?.attrs.k ?? paragraphRun;
      runs.push(
        withMarks(
          typeof run === "string" ? (look.runs[run] ?? null) : null,
          child.marks.map((mark) => mark.toJSON()),
        ),
      );
    });
    found.push({
      type: node.type.name,
      text: node.textContent,
      look: key || format ? withFormat(own, characterSize, format) : null,
      runs,
      format,
    });
    return true;
  });
  return found;
}

async function imported(bytes: Buffer, adapters: Partial<CoreAdapters> = {}) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, adapters);
  const mind = await importWordBytes(core, dataDir, bytes, { name: "File.docx", origin: "own" });
  const look = wordLookOf(mind.client.doc);
  if (!look) throw new Error("No look.");
  return { dataDir, core, ...mind, look };
}

describe("a Mind imported from Word keeps its look", () => {
  test("the résumé: 华文中宋 in its sizes, shaded section titles, dates on a right tab, lists' indents, tables with and without lines", async () => {
    const { client, look } = await imported(resumeFile());

    expect(look.body).toBe(10.5);
    expect(look.width).toBe(RESUME_TEXT_WIDTH_TWIPS / 20);
    const nodes = styled(client, look);
    const name = nodes.find((node) => node.text === "林　晓");
    expect(name?.look).toMatchObject({ align: "center" });
    // Its direct formatting is its own format and marks, over what its style gives.
    expect(name?.format).toEqual({ align: "center" });
    expect(name?.runs[0]).toEqual({
      font: "Times New Roman",
      eastAsia: "华文中宋",
      size: 22,
      color: "1F3864",
      letterSpacing: 2,
    });
    const section = nodes.find((node) => node.text === "教育背景");
    expect(section?.look).toEqual({
      shade: "D9E2F3",
      before: 12,
      after: 6,
      line: { rule: "auto", value: 1.25 },
    });
    expect(section?.runs[0]).toMatchObject({ size: 14, color: "1F3864", eastAsia: "华文中宋" });
    const school = nodes.find((node) => node.text.startsWith("复旦大学"));
    expect(school?.text).toBe("复旦大学\t金融学\t硕士\t2023.09 – 2026.06");
    expect(school?.look).toMatchObject({
      tabs: [
        { at: 120, align: "left", leader: "none" },
        { at: 210, align: "left", leader: "none" },
        { at: RESUME_TEXT_WIDTH_TWIPS / 20, align: "right", leader: "none" },
      ],
    });
    const bullet = nodes.find((node) => node.text.startsWith("跟踪 12 家"));
    expect(bullet?.look).toMatchObject({ left: 21, firstLine: -10.5 });
    const tables = nodes.filter((node) => node.type === "table");
    expect(tables).toHaveLength(3);
    expect(tables[0]?.look).toMatchObject({
      width: { value: 481.9, unit: "pt" },
      columns: [356.9, 125],
    });
    expect(tables[0]?.look).not.toHaveProperty("borders");
    expect(tables[2]?.look).toMatchObject({
      borders: {
        top: { style: "single", width: 0.5, color: "4472C4", space: 0 },
        insideV: { style: "single", width: 0.5, color: "4472C4", space: 0 },
      },
      margins: { left: 5.4, right: 5.4 },
    });
    const cells = nodes.filter((node) => node.type === "tableCell");
    expect(cells.find((node) => node.text === "语言")?.look).toEqual({
      width: { value: 100, unit: "pt" },
      shade: "F2F2F2",
    });
    expect(cells.find((node) => node.text === "2025.06 – 2025.09")?.look).toEqual({
      width: { value: 125, unit: "pt" },
    });
    const keys = (styles: Record<string, unknown>) =>
      new Set(Object.values(styles).map((each) => JSON.stringify(each))).size;
    expect(keys(look.paragraphs)).toBe(Object.keys(look.paragraphs).length);
    expect(keys(look.runs)).toBe(Object.keys(look.runs).length);
  });

  test("the contract: the theme's Book Antiqua, a small-caps title, justified clauses with hanging numbers, a bordered table with a shaded heading row", async () => {
    const { client, look } = await imported(contractFile());

    expect(look.body).toBe(12);
    expect(look.width).toBe(451.3);
    const nodes = styled(client, look);
    const title = nodes.find((node) => node.text === "Supply agreement");
    expect(title?.look).toEqual({ align: "center", line: { rule: "auto", value: 1.079 } });
    expect(title?.runs[0]).toEqual({
      font: "Book Antiqua",
      eastAsia: "宋体",
      size: 16,
      bold: true,
      smallCaps: true,
      letterSpacing: 2,
    });
    expect(nodes.find((node) => node.text.startsWith("Dated"))?.look).toMatchObject({
      align: "right",
    });
    const heading = nodes.find((node) => node.text === "2.\tPrices");
    expect(heading?.type).toBe("heading");
    expect(heading?.look).toMatchObject({ keepNext: true, before: 12, after: 6 });
    expect(heading?.runs[0]).toMatchObject({ bold: true, font: "Book Antiqua" });
    const clause = nodes.find((node) => node.text.startsWith("2.1"));
    expect(clause?.look).toMatchObject({ align: "justify", left: 28.35, firstLine: -28.35 });
    const [definitions, signatures] = nodes.filter((node) => node.type === "table");
    expect(definitions?.look).toMatchObject({
      width: { value: 100, unit: "percent" },
      borders: { top: { style: "single", width: 0.5, color: "000000", space: 0 } },
      margins: { top: 2.85, bottom: 2.85 },
    });
    expect(signatures?.look).toMatchObject({ width: { value: 100, unit: "percent" } });
    const heads = nodes.filter(
      (node) => node.type === "tableCell" && (node.text === "Term" || node.text === "Meaning"),
    );
    expect(heads.map((node) => node.look)).toEqual([{ shade: "F2F2F2" }, { shade: "F2F2F2" }]);
    const term = nodes.find((node) => node.type === "paragraph" && node.text === "“Products”");
    expect(term?.runs[0]).toMatchObject({ bold: true });
    expect(
      nodes.find((node) => node.text.endsWith("clause 9") && node.type === "tableCell")?.look,
    ).toEqual({
      vertical: "center",
    });
    expect(
      nodes.find(
        (node) => node.type === "tableCell" && node.text.startsWith("Signed for Northwind"),
      )?.look,
    ).toEqual({ borders: { bottom: { style: "single", width: 0.75, color: "000000", space: 0 } } });
  });

  test("only text that looks unlike most of its paragraph carries a run mark; an empty paragraph takes its mark's look", async () => {
    const { client, look } = await imported(
      wordFile({
        body: [
          paragraph(run("Mostly bold, ", { b: true }) + run("then plain") + run(".", { b: true })),
          paragraph(run("All of it plain")),
          '<w:p><w:pPr><w:rPr><w:sz w:val="32"/></w:rPr></w:pPr></w:p>',
        ].join(""),
      }),
    );
    const blocks = readMind(client);
    const marked = (index: number) => {
      const marks: (string | null)[] = [];
      blocks.child(index).forEach((text) => {
        const mark = text.marks.find((each) => each.type.name === WORD_RUN_MARK);
        marks.push(mark ? (mark.attrs.k as string) : null);
      });
      return marks;
    };
    const lookOf = (index: number) => {
      const key = blocks.child(index).attrs[WORD_LOOK_ATTRIBUTE] as string | null;
      return key ? look.paragraphs[key] : null;
    };

    const [bold, plain] = marked(0);
    expect(bold).toBeNull();
    expect(look.runs[lookOf(0)?.run ?? ""]).toEqual({ bold: true });
    expect(look.runs[plain ?? ""]).toEqual({});
    expect(marked(1)).toEqual([null]);
    expect(lookOf(1)).toBeNull();
    expect(look.runs[lookOf(2)?.run ?? ""]).toEqual({ size: 16 });
  });

  test("underlined and shaded text keeps its mark, even where most of the paragraph has that look", async () => {
    const shaded = (text: string) =>
      `<w:r><w:rPr><w:shd w:val="clear" w:fill="FFF2CC"/></w:rPr><w:t>${text}</w:t></w:r>`;
    const { client, look } = await imported(
      wordFile({
        body: [
          paragraph(run("Mostly underlined, ", { u: true }) + run("then plain")),
          paragraph(shaded("All of it shaded")),
        ].join(""),
      }),
    );
    const blocks = readMind(client);
    const runsOf = (index: number) => {
      const runs: unknown[] = [];
      blocks.child(index).forEach((text) => {
        const key = text.marks.find((each) => each.type.name === WORD_RUN_MARK)?.attrs.k;
        runs.push(typeof key === "string" ? look.runs[key] : null);
      });
      return runs;
    };
    const paragraphRun = (index: number) => {
      const key = blocks.child(index).attrs[WORD_LOOK_ATTRIBUTE] as string | null;
      return key ? look.paragraphs[key]?.run : undefined;
    };

    expect(runsOf(0)).toEqual([{ underline: "single" }, null]);
    expect(paragraphRun(0)).toBeUndefined();
    expect(runsOf(1)).toEqual([{ shade: "FFF2CC" }]);
    expect(paragraphRun(1)).toBeUndefined();
  });

  test("the theme's East Asian face is the one for the file's language, Simplified Chinese's when it says none", async () => {
    const eastAsiaOf = async (bytes: Buffer) => {
      const { client, look } = await imported(bytes);
      return styled(client, look).find((node) => node.text === "Supply agreement")?.runs[0];
    };
    expect(await eastAsiaOf(contractFile())).toMatchObject({ eastAsia: "宋体" });
    expect(await eastAsiaOf(contractFile({ eastAsia: "ja-JP" }))).toMatchObject({
      eastAsia: "游明朝",
    });
    expect(await eastAsiaOf(contractFile({ eastAsia: "zh-TW" }))).toMatchObject({
      eastAsia: "新細明體",
    });
  });

  test("a broken settings part still imports, with the theme's Simplified Chinese face, and says so once", async () => {
    const { log, entries } = recordingLog();
    const { client, look } = await imported(
      contractFile({ settings: "<w:settings><w:themeFontLang" }),
      {
        log,
      },
    );
    expect(
      styled(client, look).find((node) => node.text === "Supply agreement")?.runs[0],
    ).toMatchObject({ eastAsia: "宋体" });
    expect(entries.filter((entry) => entry.event === "word.look.partsUnreadable")).toEqual([
      expect.objectContaining({ fields: { parts: "settings" } }),
    ]);
  });

  test("two styles that name each other as next still import, each with the other's look as next", async () => {
    const styles =
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Question"><w:name w:val="Question"/><w:next w:val="Reply"/><w:pPr><w:jc w:val="right"/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Reply"><w:name w:val="Reply"/><w:next w:val="Question"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>';
    const { client, look } = await imported(
      wordFile({
        styles,
        body: [
          paragraph("Asked", { style: "Question" }),
          paragraph("Answered", { style: "Reply" }),
        ].join(""),
      }),
    );
    const [asked, answered] = [0, 1].map(
      (index) => look.paragraphs[String(readMind(client).child(index).attrs[WORD_LOOK_ATTRIBUTE])],
    );
    expect(look.paragraphs[String(asked?.next)]).toMatchObject({ align: "center" });
    expect(look.paragraphs[String(answered?.next)]).toMatchObject({ align: "right" });
  });

  test("bold in a character style switches a bold heading's bold off; bold on the run itself stays", async () => {
    const styles =
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:i/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>';
    const strong = (text: string) =>
      `<w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
    const { client, look } = await imported(
      wordFile({
        styles,
        body: [
          paragraph(run("A heading with ") + strong("a strong part"), { style: "Heading1" }),
          paragraph(strong("Strong ") + run("and bold", { b: true }), { style: "Heading1" }),
          paragraph(strong("Strong in body text")),
        ].join(""),
      }),
    );
    const [first, second, body] = styled(client, look);
    expect(first?.runs).toEqual([{ bold: true, italic: true }, { italic: true }]);
    expect(second?.runs).toEqual([{ italic: true }, { bold: true, italic: true }]);
    expect(body?.runs).toEqual([{ bold: true }]);
  });

  test("bold and italic a style gives are the text's own marks, and un-bolding exports an explicit off", async () => {
    const styles =
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>';
    const strong =
      '<w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t xml:space="preserve">bold by its style</w:t></w:r>';
    const bytes = wordFile({
      styles,
      body: [
        paragraph(`${run("Then ")}${strong}${run(" and plain.")}`),
        paragraph("Said in a quote", { style: "Quote" }),
      ].join(""),
    });
    const { core, mindId, client } = await imported(bytes);
    const marksOf = (index: number) => {
      const found: [string, string[]][] = [];
      readMind(client)
        .child(index)
        .forEach((text) => {
          found.push([
            text.text ?? "",
            text.marks.map((mark) => mark.type.name).filter((name) => name !== WORD_RUN_MARK),
          ]);
        });
      return found;
    };
    expect(marksOf(0)).toEqual([
      ["Then ", []],
      ["bold by its style", ["bold"]],
      [" and plain.", []],
    ]);
    expect(marksOf(1)).toEqual([["Said in a quote", ["italic"]]]);

    client.doc.transact(() => {
      const text = findText(client.blocks, "bold by its style");
      text.format(0, text.length, { bold: null });
    });
    await client.settled();
    const result = await core.exportMind(mindId, { format: "docx" });
    const xml = unzip(result.data).get("word/document.xml")?.toString() ?? "";
    expect(xml).toMatch(/<w:rStyle w:val="Strong"\/>.*<w:b w:val="0"\/>/);
  });

  test("a heading names the look Enter gives the paragraph after it, as its style's next says", async () => {
    const { client, look } = await imported(contractFile());
    const heading = readMind(client).content.content.find(
      (node) => node.textContent === "2.\tPrices",
    )?.attrs[WORD_LOOK_ATTRIBUTE];
    const next = look.paragraphs[String(heading)]?.next;
    expect(next).toBeDefined();
    expect(look.paragraphs[String(next)]).toMatchObject({
      after: 8,
      line: { rule: "auto", value: 1.079 },
    });
    expect(look.paragraphs[String(next)]).not.toHaveProperty("keepNext");
  });

  test("a paragraph with someone's removed line break has its look, and accepted or rejected the break goes back resolved", async () => {
    const bytes = await readFile(join(BEFORE, "changes-before.docx"));
    const { core, mindId, client } = await imported(bytes);
    await brokenOffResolved(core, mindId, client, bytes);
  });

  test("an empty Word file imports with nothing to draw", async () => {
    const { client, look } = await imported(wordFile({ body: "" }));
    expect(look.body).toBeNull();
    expect(lookShown(client)).toEqual({ blocks: 0, runs: 0 });
  });

  test("the styles kept grow with the styles the file uses, never with its Blocks", async () => {
    const short = await imported(longContract(8));
    const long = await imported(longContract());
    const sizes = (look: WordLook) =>
      [look.paragraphs, look.runs, look.tables, look.cells].map((each) => Object.keys(each).length);
    expect(sizes(long.look)).toEqual(sizes(short.look));
    const blocks = lookShown(long.client);
    expect(blocks.blocks).toBeGreaterThan(2800);
    expect(Object.keys(long.look.paragraphs).length).toBeLessThan(8);
  });

  test("an import a quit cut short names the same styles in the Blocks written after the restart", async () => {
    const dataDir = await createTempDataFolder();
    const first = startCore(dataDir);
    const path = join(dataDir, "Contract.docx");
    await writeFile(path, longContract());
    const result = await first.importWordFile({ path, origin: "own" });
    if (!result.ok) throw new Error(result.refusal);
    first.close();

    const second = startCore(dataDir);
    const client = await connectToMind(second, result.mind.id);
    await vi.waitFor(
      () => {
        if (wordImportProgressOf(client.doc) !== null) throw new Error("Not done.");
      },
      { timeout: 30_000 },
    );
    const look = wordLookOf(client.doc) as WordLook;
    const keys = new Set([
      ...Object.keys(look.paragraphs),
      ...Object.keys(look.runs),
      ...Object.keys(look.tables),
      ...Object.keys(look.cells),
    ]);
    const used = new Set<string>();
    readMind(client).descendants((node) => {
      const key = node.attrs[WORD_LOOK_ATTRIBUTE];
      if (typeof key === "string") {
        used.add(key);
        const run = look.paragraphs[key]?.run;
        if (run) used.add(run);
      }
      for (const mark of node.marks) {
        if (mark.type.name === WORD_RUN_MARK) used.add(mark.attrs.k as string);
      }
      return true;
    });
    expect(new Set([...used].map((key) => key[0]))).toEqual(new Set(["p", "r"]));
    expect([...used].filter((key) => !keys.has(key))).toEqual([]);
    expect(lookShown(client).blocks).toBeGreaterThan(2800);
  });

  test("the Mind records content schema 23 or later, and export writes the file's own bytes for what wasn't changed", async () => {
    for (const bytes of [resumeFile(), contractFile()]) {
      const { core, mindId, client } = await imported(bytes);
      expect(client.doc.getMap(MIND_SETTINGS_FIELD).get(CONTENT_SCHEMA_VERSION_KEY)).toBe(
        CONTENT_SCHEMA_VERSION,
      );
      expect(CONTENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(23);
      const result = await core.exportMind(mindId, { format: "docx" });
      const before = unzip(bytes);
      const after = unzip(result.data);
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)),
      );
      expect(changed).toEqual([]);
    }
  });
});

const BEFORE = join(__dirname, "../fixtures/word-look");

/**
 * Imports `fixture`.docx, then stores its Mind as an earlier version wrote it:
 * `mind`.yjs, that version's Mind of the same file. changes-before.docx holds
 * someone's removed line breaks in three paragraphs; changes-as-is.yjs is its
 * Mind as written by the version before changes were read, which kept them as they were.
 */
async function importedBefore({
  fixture = "look-before",
  mind = fixture,
  change,
}: {
  fixture?: string;
  mind?: string;
  change?: (doc: Y.Doc) => void;
} = {}) {
  const bytes = await readFile(join(BEFORE, `${fixture}.docx`));
  const { dataDir, core, mindId } = await imported(bytes);
  core.close();
  const before = new Y.Doc();
  Y.applyUpdate(before, await readFile(join(BEFORE, `${mind}.yjs`)));
  change?.(before);
  const at = new Date().toISOString();
  queryDatabase(dataDir, "DELETE FROM mind_updates WHERE mind_id = ?", [mindId]);
  queryDatabase(
    dataDir,
    "INSERT INTO mind_updates (id, mind_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [randomUUID(), mindId, Y.encodeStateAsUpdate(before), at, at],
  );
  queryDatabase(dataDir, "UPDATE word_packages SET look_version = NULL WHERE mind_id = ?", [
    mindId,
  ]);
  return { dataDir, mindId, before, bytes };
}

/**
 * changes-before.docx's three paragraphs have their look, and with someone's removed line
 * break accepted in the first and rejected in the second, export writes both resolved and
 * the third, still waiting, as it was (#858).
 */
async function brokenOffResolved(core: Core, mindId: string, client: MindClient, bytes: Buffer) {
  const look = wordLookOf(client.doc) as WordLook;
  expect(styled(client, look).filter((node) => node.type === "paragraph")).toMatchObject([
    { text: "First linesecond line", look: { align: "justify" } },
    { text: "Keptapart", look: { align: "justify" } },
    { text: "Leftwaiting", look: { align: "justify" } },
    { text: "Plain words." },
  ]);
  const [first, kept, left] = pendingProposals(client.blocks).map((change) => change.id);
  expect(left).toBeDefined();
  await resolveChanges(client, "accept", (id) => id === first);
  await resolveChanges(client, "reject", (id) => id === kept);

  const result = await core.exportMind(mindId, { format: "docx", trackChanges: true });
  const document = unzip(result.data).get("word/document.xml")?.toString("utf8") ?? "";
  expect(acceptedParagraphs(document)).toEqual([
    "First linesecond line",
    "Kept\napart",
    "Leftwaiting",
    "Plain words.",
  ]);
  const original = unzip(bytes).get("word/document.xml")?.toString("utf8") ?? "";
  const waiting = /<w:p>(?:(?!<\/w:p>).)*>Left<(?:(?!<\/w:p>).)*<\/w:p>/.exec(original)?.[0];
  expect(waiting).toContain("<w:del ");
  expect(document).toContain(waiting);
  expect(document.match(/<w:del /g)).toHaveLength(1);
}

function findText(blocks: Y.XmlFragment, text: string): Y.XmlText {
  for (const element of blocks.createTreeWalker(() => true)) {
    if (element instanceof Y.XmlText && element.toString().includes(text)) return element;
  }
  throw new Error(`No "${text}".`);
}

/** Makes the Mind look like an import from before the look was kept. */
function withoutLook(client: MindClient, dataDir: string, mindId: string): void {
  client.doc.transact(() => {
    const strip = (element: Y.XmlElement) => {
      if (element.getAttribute(WORD_LOOK_ATTRIBUTE) !== undefined) {
        element.removeAttribute(WORD_LOOK_ATTRIBUTE);
      }
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlElement) strip(child);
        else if (child instanceof Y.XmlText)
          child.format(0, child.length, { [WORD_RUN_MARK]: null, [WORD_TAB_MARK]: null });
      }
    };
    for (const child of client.blocks.toArray()) {
      if (child instanceof Y.XmlElement) strip(child);
    }
    client.doc.getMap(MIND_WORD_LOOK_FIELD).clear();
  });
  queryDatabase(dataDir, "UPDATE word_packages SET look_version = NULL WHERE mind_id = ?", [
    mindId,
  ]);
}

function lookShown(client: MindClient): { blocks: number; runs: number } {
  let blocks = 0;
  let runs = 0;
  readMind(client).descendants((node) => {
    if (node.attrs[WORD_LOOK_ATTRIBUTE]) blocks++;
    if (node.marks.some((mark) => mark.type.name === WORD_RUN_MARK)) runs++;
    return true;
  });
  return { blocks, runs };
}

describe("a Mind imported before gets its look once", () => {
  test("at the next start, on the Blocks as imported: a Block the User changed stays plain, and it runs once", async () => {
    const { dataDir, core, mindId, client } = await imported(contractFile());
    const full = lookShown(client);
    withoutLook(client, dataDir, mindId);
    client.doc.transact(() => {
      const clause = client.blocks
        .toArray()
        .find(
          (child): child is Y.XmlElement =>
            child instanceof Y.XmlElement && child.toString().includes("Prices are fixed"),
        );
      const text = clause?.toArray().find((child) => child instanceof Y.XmlText) as Y.XmlText;
      text.insert(text.length, " Edited.");
    });
    await client.settled();
    expect(lookShown(client)).toEqual({ blocks: 0, runs: 0 });
    core.close();

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() => expect(wordLookOf(after.doc)).not.toBeNull(), { timeout: 10_000 });
    const shown = lookShown(after);
    expect(shown.blocks).toBeGreaterThan(0);
    expect(shown.blocks).toBeLessThan(full.blocks);
    const edited = styled(after, wordLookOf(after.doc) as WordLook).find((node) =>
      node.text.includes("Edited."),
    );
    // Plain, but for its tab, which the look marks wherever it is.
    expect(edited?.look).toBeNull();
    expect(edited?.runs).toEqual([null, null, null]);
    expect(
      styled(after, wordLookOf(after.doc) as WordLook).find((node) => node.text.startsWith("3.1"))
        ?.look,
    ).toMatchObject({ align: "justify" });
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "word.look.added",
        fields: expect.objectContaining({ mindId, editedSinceImport: 1 }),
      }),
    );
    expect(
      queryDatabase<{ look_version: number }>(dataDir, "SELECT look_version FROM word_packages"),
    ).toEqual([{ look_version: WORD_LOOK_VERSION }]);
    const state = Y.encodeStateVector(after.doc);
    restarted.close();

    const { log: thirdLog, entries: thirdEntries } = recordingLog();
    const again = startCore(dataDir, { log: thirdLog });
    const third = await connectToMind(again, mindId);
    await vi.waitFor(() =>
      expect(thirdEntries).toContainEqual(
        expect.objectContaining({ event: "word.look.done", fields: { minds: 0 } }),
      ),
    );
    expect(Buffer.from(Y.encodeStateVector(third.doc))).toEqual(Buffer.from(state));
  });

  test("a look an earlier version read is cleared and read again; keys it named are gone, and a paragraph edited since has the look again", async () => {
    const { dataDir, core, mindId, client } = await imported(contractFile());
    const clause = client.blocks
      .toArray()
      .find(
        (child): child is Y.XmlElement =>
          child instanceof Y.XmlElement && child.toString().includes("Prices are fixed"),
      );
    if (!clause) throw new Error("No clause.");
    client.doc.transact(() => {
      clause.setAttribute(WORD_LOOK_ATTRIBUTE, "pstale");
      findText(client.blocks, "Prices are fixed").insert(0, "Edited. ");
      client.doc.getMap(MIND_WORD_LOOK_FIELD).set("version", 0);
    });
    await client.settled();
    core.close();
    queryDatabase(dataDir, "UPDATE word_packages SET look_version = 0 WHERE mind_id = ?", [mindId]);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    const look = wordLookOf(after.doc) as WordLook;
    expect(look.version).toBe(WORD_LOOK_VERSION);
    const nodes = styled(after, look);
    expect(nodes.find((node) => node.text.startsWith("Edited."))?.look).toMatchObject({
      align: "justify",
    });
    expect(nodes.find((node) => node.text.startsWith("3.1"))?.look).toMatchObject({
      align: "justify",
    });
    expect(
      queryDatabase<{ look_version: number }>(dataDir, "SELECT look_version FROM word_packages"),
    ).toEqual([{ look_version: WORD_LOOK_VERSION }]);
  });

  test("a Block edited since import keeps the looks a newer version still reads the same", async () => {
    const { dataDir, core, mindId, client } = await imported(contractFile());
    const clause = client.blocks
      .toArray()
      .find(
        (child): child is Y.XmlElement =>
          child instanceof Y.XmlElement && child.toString().includes("Prices are fixed"),
      );
    const key = clause?.getAttribute(WORD_LOOK_ATTRIBUTE);
    if (!clause || typeof key !== "string") throw new Error("No clause with a look.");
    client.doc.transact(() => {
      findText(client.blocks, "Prices are fixed").insert(0, "Edited. ");
      client.doc.getMap(MIND_WORD_LOOK_FIELD).set("version", WORD_LOOK_VERSION - 1);
    });
    await client.settled();
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
    const edited = styled(after, wordLookOf(after.doc) as WordLook).find((node) =>
      node.text.startsWith("Edited."),
    );
    expect(edited?.look).toMatchObject({ align: "justify" });
  });

  test("a Mind as the version before the look wrote it gets the look on every Block, and export still writes the file's own bytes", async () => {
    const { dataDir, mindId, before, bytes } = await importedBefore();
    // The version before recorded fingerprints of text it hadn't rejoined.
    const bold = before
      .getXmlFragment(MIND_CONTENT_FIELD)
      .toArray()
      .find(
        (child): child is Y.XmlElement =>
          child instanceof Y.XmlElement && child.toString().includes("Bold one"),
      );
    const id = bold?.getAttribute("id");
    if (!bold || typeof id !== "string") throw new Error("No bold paragraph.");
    expect(wordFingerprint(bold)).not.toBe(wordSourceOf(before, id)?.f);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "word.look.added",
        fields: { mindId, given: 4, editedSinceImport: 0 },
      }),
    );
    const look = wordLookOf(after.doc) as WordLook;
    const nodes = styled(after, look);
    expect(nodes.find((node) => node.text === "Bold one. Bold two.")?.runs).toEqual([
      { font: "Calibri", size: 11, bold: true },
    ]);
    expect(nodes.find((node) => node.text === "2.\tPrices")?.runs[0]).toMatchObject({
      bold: true,
      size: 14,
    });
    const result = await restarted.exportMind(mindId, { format: "docx" });
    const original = unzip(bytes);
    const exported = unzip(result.data);
    expect(
      [...original.keys()].filter(
        (name) => !original.get(name)?.equals(exported.get(name) ?? Buffer.alloc(0)),
      ),
    ).toEqual([]);
  });

  test("a Mind from before, with someone's removed line breaks, gets the look on their paragraphs, and accepted or rejected each goes back resolved", async () => {
    const { dataDir, mindId, before, bytes } = await importedBefore({ fixture: "changes-before" });
    expect(wordLookOf(before)).toBeNull();
    expect(pendingProposals(before.getXmlFragment(MIND_CONTENT_FIELD))).toHaveLength(3);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "word.look.added",
        fields: { mindId, given: 4, editedSinceImport: 0 },
      }),
    );
    await brokenOffResolved(restarted, mindId, after, bytes);
  });

  test("a Mind from before someone's changes were read exports them as they were, with no edit of the User's tracked", async () => {
    const { dataDir, mindId, before, bytes } = await importedBefore({
      fixture: "changes-before",
      mind: "changes-as-is",
    });
    expect(pendingProposals(before.getXmlFragment(MIND_CONTENT_FIELD))).toEqual([]);

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    const result = await restarted.exportMind(mindId, { format: "docx", trackChanges: true });
    expect(unzip(result.data).get("word/document.xml")?.toString("utf8")).toBe(
      unzip(bytes).get("word/document.xml")?.toString("utf8"),
    );
  });

  test("a table edited before the look gets its table and cell looks while its rows and cells are as imported; the paragraph the User changed stays plain", async () => {
    const { dataDir, mindId } = await importedBefore({
      change: (doc) => {
        const cell = findText(doc.getXmlFragment(MIND_CONTENT_FIELD), "Flour and fats");
        cell.insert(cell.length, ", edited");
      },
    });

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    const look = wordLookOf(after.doc) as WordLook;
    const nodes = styled(after, look);
    expect(nodes.find((node) => node.type === "table")?.look).toEqual({ columns: [100, 100] });
    expect(nodes.find((node) => node.text === "Flour and fats, edited")?.look).toBeNull();
    expect(
      nodes.find((node) => node.type === "paragraph" && node.text === "Products")?.runs,
    ).toEqual([{ font: "Calibri", size: 11 }]);
  });

  test("a table whose rows the User changed before the look keeps the plain look", async () => {
    const { dataDir, mindId } = await importedBefore({
      change: (doc) => {
        const table = doc
          .getXmlFragment(MIND_CONTENT_FIELD)
          .toArray()
          .find(
            (child): child is Y.XmlElement =>
              child instanceof Y.XmlElement && child.nodeName === "table",
          );
        const row = table?.toArray().findIndex((each) => !each.toString().includes("Products"));
        if (table && row !== undefined && row >= 0) table.delete(row, 1);
      },
    });

    const { log, entries } = recordingLog();
    const restarted = startCore(dataDir, { log });
    const after = await connectToMind(restarted, mindId);
    await vi.waitFor(() =>
      expect(entries).toContainEqual(expect.objectContaining({ event: "word.look.done" })),
    );
    const nodes = styled(after, wordLookOf(after.doc) as WordLook);
    expect(nodes.find((node) => node.type === "table")?.look).toBeNull();
    expect(
      nodes.find((node) => node.type === "paragraph" && node.text === "Products")?.runs,
    ).toEqual([{ font: "Calibri", size: 11 }]);
  });

  test("a Mind whose package is gone, or can't be read, is left as it was and the failure logged", async () => {
    const { dataDir, core, mindId, client } = await imported(resumeFile());
    withoutLook(client, dataDir, mindId);
    await client.settled();
    const sha256 = wordFileOf(client.doc)?.sha256;
    core.close();
    const kept = join(dataDir, WORD_PACKAGES_FOLDER, `${sha256}.docx`);

    await writeFile(kept, "not a Word file");
    const broken = recordingLog();
    const first = startCore(dataDir, { log: broken.log });
    const unread = await connectToMind(first, mindId);
    await vi.waitFor(() =>
      expect(broken.entries).toContainEqual(
        expect.objectContaining({
          event: "word.look.failed",
          fields: expect.objectContaining({ mindId }),
        }),
      ),
    );
    expect(lookShown(unread)).toEqual({ blocks: 0, runs: 0 });
    expect(wordLookOf(unread.doc)).toBeNull();
    first.close();

    await rm(kept);
    const gone = recordingLog();
    const second = startCore(dataDir, { log: gone.log });
    const missing = await connectToMind(second, mindId);
    await vi.waitFor(() =>
      expect(gone.entries).toContainEqual(
        expect.objectContaining({ event: "word.look.packageMissing", fields: { mindId } }),
      ),
    );
    expect(lookShown(missing)).toEqual({ blocks: 0, runs: 0 });
    expect(queryDatabase(dataDir, "SELECT look_version FROM word_packages")).toEqual([
      { look_version: null },
    ]);
  });
});
