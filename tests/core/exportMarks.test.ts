/**
 * Export marks (#1258), through the core's public interface: a Note's page numbers and
 * watermark are its own, kept with it, and its Word file carries them as Word's own footer
 * field and watermark, which Word can edit and remove.
 */
import { describe, expect, test } from "vitest";
import { type Core, InvalidInputError, type Mind } from "../../src/core";
import type { ExportMarks } from "../../src/shared/exportMarks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { checkWellFormed, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";
import { field, paragraph, type WordFileInput, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const DRAFT: ExportMarks = { pageNumbers: false, watermark: "draft" };

async function setUp(languages: readonly string[] = ["en-US"]) {
  const dataDir = await createTempDataFolder();
  const { printer, printed, printedOnPrinter } = fakePrinter();
  const core = startCore(dataDir, { printer, systemLanguages: () => [...languages] });
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [note("Spring tides happen at new moon.")]);
  return { dataDir, core, mind, printed, printedOnPrinter };
}

async function exportedWord(core: Core, mind: Mind): Promise<Map<string, Buffer>> {
  const result = await core.exportMind(mind.id, { format: "docx" });
  const files = unzip(result.data);
  for (const name of files.keys()) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      checkWellFormed(files.get(name)?.toString("utf8") ?? "");
    }
  }
  return files;
}

const relationships = (files: Map<string, Buffer>): string =>
  part(files, "word/_rels/document.xml.rels");

describe("Export marks kept with the Note", () => {
  test("a Note with no choice has page numbers and no watermark", async () => {
    const { core, mind } = await setUp();
    expect(await core.getExportMarks(mind.id)).toEqual({ pageNumbers: true, watermark: "none" });
  });

  test("the choices are the Note's own: another Note keeps the defaults", async () => {
    const { core, mind } = await setUp();
    const other = await core.createMind({ title: "Neap tides" });
    await core.setExportMarks(mind.id, DRAFT);
    expect(await core.getExportMarks(mind.id)).toEqual(DRAFT);
    expect(await core.getExportMarks(other.id)).toEqual({ pageNumbers: true, watermark: "none" });
  });

  test("the choices are kept when the app quits and starts again", async () => {
    const { dataDir, core, mind } = await setUp();
    const chosen: ExportMarks = { pageNumbers: false, watermark: "words", words: "Internal" };
    await core.setExportMarks(mind.id, chosen);
    core.close();
    const restarted = startCore(dataDir);
    expect(await restarted.getExportMarks(mind.id)).toEqual(chosen);
  });

  test("a choice the app can't read is refused", async () => {
    const { core, mind } = await setUp();
    await expect(
      core.setExportMarks(mind.id, { watermark: "draft" } as unknown as ExportMarks),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      core.setExportMarks(mind.id, { pageNumbers: true, watermark: "words" }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      core.setExportMarks(mind.id, { pageNumbers: true, watermark: "words", words: "  " }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("Page numbers and the watermark in Word", () => {
  test("the page numbers are Word's own footer field, which Word updates", async () => {
    const { core, mind } = await setUp();
    const files = await exportedWord(core, mind);
    const footer = part(files, "word/footer1.xml");
    expect(footer).toContain('<w:fldChar w:fldCharType="begin"/>');
    expect(footer).toContain('<w:instrText xml:space="preserve"> PAGE </w:instrText>');
    expect(footer).toContain('<w:fldChar w:fldCharType="end"/>');
    expect(part(files, "word/document.xml")).toContain(
      '<w:footerReference w:type="default" r:id="rIdFooter"/>',
    );
    expect(relationships(files)).toContain(
      'Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"',
    );
    expect(part(files, "[Content_Types].xml")).toContain(
      'PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"',
    );
    expect(files.has("word/header1.xml")).toBe(false);
  });

  test("the watermark is Word's own shape, which its Remove Watermark command finds", async () => {
    const { core, mind } = await setUp();
    await core.setExportMarks(mind.id, DRAFT);
    const files = await exportedWord(core, mind);
    const header = part(files, "word/header1.xml");
    expect(header).toContain('id="PowerPlusWaterMarkObject357477219"');
    expect(header).toContain('type="#_x0000_t136"');
    expect(header).toContain('<v:fill opacity=".5"/>');
    expect(header).toContain('string="DRAFT"');
    expect(header).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(part(files, "word/document.xml")).toContain(
      '<w:headerReference w:type="default" r:id="rIdHeader"/>',
    );
    expect(relationships(files)).toContain(
      'Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"',
    );
    expect(part(files, "word/settings.xml")).toContain("<w:displayBackgroundShape/>");
    expect(part(files, "[Content_Types].xml")).toContain(
      'PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"',
    );
    expect(files.has("word/footer1.xml")).toBe(false);
  });

  test("a Chinese Note gets 草稿 and 机密, and its own word goes in as typed", async () => {
    const { core, mind } = await setUp(["zh-CN"]);
    await core.setExportMarks(mind.id, { pageNumbers: true, watermark: "confidential" });
    const confidential = part(await exportedWord(core, mind), "word/header1.xml");
    expect(confidential).toContain('string="机密"');
    await core.setExportMarks(mind.id, { pageNumbers: true, watermark: "words", words: "内部" });
    const own = part(await exportedWord(core, mind), "word/header1.xml");
    expect(own).toContain('string="内部"');
  });

  test("turning both off writes neither part", async () => {
    const { core, mind } = await setUp();
    await core.setExportMarks(mind.id, { pageNumbers: false, watermark: "none" });
    const files = await exportedWord(core, mind);
    expect(files.has("word/footer1.xml")).toBe(false);
    expect(files.has("word/header1.xml")).toBe(false);
    expect(part(files, "word/document.xml")).not.toContain("w:footerReference");
    expect(part(files, "word/document.xml")).not.toContain("w:headerReference");
  });
});

describe("Page numbers and the watermark in PDF", () => {
  test("the PDF prints the Note's marks, and the printer's own copy has them too", async () => {
    const { core, mind, printed, printedOnPrinter } = await setUp();
    await core.setExportMarks(mind.id, { pageNumbers: false, watermark: "confidential" });
    await core.exportMind(mind.id, { format: "pdf" });
    expect(printed.at(-1)).toMatchObject({ pageNumbers: false, watermark: "CONFIDENTIAL" });
    await core.printMind(mind.id);
    expect(printedOnPrinter.at(-1)).toMatchObject({
      pageNumbers: false,
      watermark: "CONFIDENTIAL",
    });
  });

  test("a PDF starts with page numbers and no watermark", async () => {
    const { core, mind, printed } = await setUp();
    await core.exportMind(mind.id, { format: "pdf" });
    expect(printed.at(-1)).toMatchObject({ pageNumbers: true });
    expect(printed.at(-1)?.watermark).toBeUndefined();
  });
});

describe("A Note made from a Word file adds nothing to the User's file until asked", () => {
  async function fromWord(input: WordFileInput) {
    const dataDir = await createTempDataFolder();
    const { printer, printed } = fakePrinter();
    const core = startCore(dataDir, { printer });
    const bytes = wordFile(input);
    const { mindId } = await importWordBytes(core, await createTempDataFolder(), bytes, {
      origin: "own",
    });
    return { dataDir, core, bytes, mindId, printed };
  }

  /** The entries an export changed, added or left out. */
  function changed(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
    const names = new Set([...before.keys(), ...after.keys()]);
    return [...names]
      .filter((name) => !before.get(name)?.equals(after.get(name) ?? Buffer.alloc(0)))
      .sort();
  }

  /** Two sections, the first ending at its heading; `first` goes inside its w:sectPr. */
  const twoSections = (first: string): WordFileInput => ({
    body: [
      paragraph("Heads of terms", { sectPr: `<w:sectPr>${first}</w:sectPr>` }),
      paragraph("Schedule of fittings"),
    ].join(""),
  });

  test("it starts with page numbers off, and a Note written here still starts with them on", async () => {
    const { core, mindId } = await fromWord({ body: paragraph("Lease brief") });
    const written = await core.createMind({ title: "Tides" });
    expect(await core.getExportMarks(mindId)).toEqual({ pageNumbers: false, watermark: "none" });
    expect(await core.getExportMarks(written.id)).toEqual({ pageNumbers: true, watermark: "none" });
  });

  test("its PDF follows the same choice: no number until the User turns them on", async () => {
    const { core, mindId, printed } = await fromWord({ body: paragraph("Lease brief") });
    await core.exportMind(mindId, { format: "pdf" });
    expect(printed.at(-1)).toMatchObject({ pageNumbers: false });
    await core.setExportMarks(mindId, { pageNumbers: true, watermark: "none" });
    await core.exportMind(mindId, { format: "pdf" });
    expect(printed.at(-1)).toMatchObject({ pageNumbers: true });
  });

  test("a choice it saved stays as it is when the app starts again", async () => {
    const { dataDir, core, mindId } = await fromWord({ body: paragraph("Lease brief") });
    await core.setExportMarks(mindId, { pageNumbers: true, watermark: "none" });
    core.close();
    const restarted = startCore(dataDir);
    expect(await restarted.getExportMarks(mindId)).toEqual({
      pageNumbers: true,
      watermark: "none",
    });
    await restarted.setExportMarks(mindId, { pageNumbers: false, watermark: "draft" });
    expect(await restarted.getExportMarks(mindId)).toEqual({
      pageNumbers: false,
      watermark: "draft",
    });
  });

  test("turned on, a file whose sections have no footer gets Word's own page number in each, and nothing else of it changes", async () => {
    const { core, bytes, mindId } = await fromWord(twoSections('<w:type w:val="nextPage"/>'));
    await core.setExportMarks(mindId, { pageNumbers: true, watermark: "none" });
    const files = unzip((await core.exportMind(mindId, { format: "docx" })).data);
    expect(changed(unzip(bytes), files)).toEqual([
      "[Content_Types].xml",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/footer1.xml",
    ]);
    expect(part(files, "word/footer1.xml")).toContain(
      '<w:instrText xml:space="preserve"> PAGE </w:instrText>',
    );
    expect([...part(files, "word/document.xml").matchAll(/<w:footerReference\b/g)]).toHaveLength(2);
  });

  test("turned on, a file with a footer of its own comes back byte for byte: its footer, its page-number field, and no number added", async () => {
    const { core, bytes, mindId } = await fromWord({
      // The second section has no footer of its own: Word shows it the first's.
      ...twoSections(
        '<w:footerReference w:type="default" r:id="rIdF1"/><w:type w:val="nextPage"/>',
      ),
      footers: { rIdF1: paragraph(field("PAGE", "1")) },
    });
    await core.setExportMarks(mindId, { pageNumbers: true, watermark: "none" });
    const files = unzip((await core.exportMind(mindId, { format: "docx" })).data);
    expect(changed(unzip(bytes), files)).toEqual([]);
    expect(files.has("word/footer2.xml")).toBe(false);
  });
});
