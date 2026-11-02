/**
 * The kinds of file a first add takes beyond PDF, Office and text (#762):
 * pictures read as scanned pages are, RTF and HTML files read as text with
 * their headings, and the old Office, WPS, Pages and Keynote files a skip
 * names the next step for — or converts with the User's own LibreOffice.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, test } from "vitest";
import type { OfficeConverter, TextRecognizer } from "../../src/core/adapters";
import { htmlTextToMarkdown } from "../../src/core/documents/formats/html";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { translate } from "../../src/shared/i18n";
import { skippedStep } from "../../src/shared/skippedFiles";
import { unreadFileText } from "../../src/shared/unreadFiles";
import { createTempDataFolder, NO_MODEL_FILES, queryDatabase, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";

const DOCX = new Uint8Array(
  readFileSync(new URL("../fixtures/formats/Coastal Flood Risk Review.docx", import.meta.url)),
);

const RTF = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\fonttbl{\f0 Helvetica;}{\f1 Arial;}}
{\stylesheet{\s1\outlinelevel0\sbasedon0\snext0 Heading 1;}{\s2\outlinelevel1\sbasedon0\snext1 Heading 2;}}
{\*\generator Riched20 10.0\par}
\pard\s1\b\fs32 Harbour rules\par
\pard\fs24 The harbour master keeps the records.\par
\pard\s2 Scope\par
\pard A fine of \u163?100 applies to every berth.\par
\pard See [Exhibit A] and a *starred* word.\par
\pard - not a list, just a dash: C#_notes.\par
}
`;

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Harbour notice</title>
<style>.notice { color: red }</style>
<script>var hidden = "never read";</script></head>
<body>
<h1>Harbour notice</h1>
<p>The harbour master publishes the tide tables.<br>Every 12 months.
<h2>Fees</h2>
<ul><li>Berthing &amp; mooring: 42<li>Tonnage: 18</ul>
<table><tr><th>Port<td>Leith<tr><td>Fee<td>42</table>
<p>Cost *estimate* only, and a [link] that is words.</p>
</body></html>
`;

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const zh = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, params);

/** A recognizer reading the lines a picture Document is scripted to have, on page 1. */
function pictureRecognizer(lines: string[]): TextRecognizer {
  const fake = createFakeTextRecognizer({ script: { pages: { "1": { lines } } } });
  return {
    load: (files) => fake.load(files),
    read: (picture, page) => fake.read(picture, page),
    readFile: (file, page) => fake.readFile(file, page),
    close: () => fake.close(),
  };
}

const picture = () => createCanvas(640, 360).toBuffer("image/png");

/** A LibreOffice that "converts" to a real .docx, counting what it was asked. */
function fakeConverter(calls: { path: string; target: string }[]): OfficeConverter {
  return {
    available: async () => true,
    async convert(path, target) {
      calls.push({ path, target });
      return { outcome: "converted", name: "Contract.docx", bytes: DOCX };
    },
  };
}

describe("A picture is read as a scanned page is (#762)", { timeout: 60_000 }, () => {
  test("its one page is read on this computer, found by search, cited by region and read from a picture", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      textRecognizer: pictureRecognizer(["Revenue by quarter", "Q2 2026 44.9"]),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const sources = await createSourceFolder();
    const file = await writeSourceFile(sources, "Whiteboard.png", picture());

    const [document] = await addAndProcess(core, [file]);

    expect(document?.kind).toBe("image");
    expect(document?.status).toBe("ready");
    const [found] = await core.searchPassages("Revenue quarter", { mode: "keyword" });
    expect(found).toMatchObject({ documentId: document?.id, pageFrom: 1 });
    const scanned = await core.readScannedText(document?.id ?? "");
    expect(scanned.pages).toHaveLength(1);
    expect(scanned.pages[0]?.text).toBe("Revenue by quarter\nQ2 2026 44.9");
    expect(scanned.pages[0]?.label?.scan).toMatchObject({
      reader: BUILT_IN_TEXT_RECOGNITION_MODEL.reader,
      picture: true,
    });
    // Each line is anchored to its box on the picture: where a quote is washed.
    expect(scanned.pages[0]?.anchors.map((anchor) => anchor.target)).toEqual(["line1", "line2"]);
    expect(scanned.pages[0]?.anchors.every((anchor) => anchor.quad?.length === 8)).toBe(true);
    // Its card says it was read from a picture, and where its quote is.
    const quoted = await core.readScannedQuote({
      documentId: document?.id ?? "",
      contentHash: null,
      pageFrom: 1,
      pageTo: 1,
      quote: "Q2 2026 44.9",
    });
    expect(quoted).toEqual({ unsure: [], from: "picture" });
    expect(en("citation.picture")).toBe("Read from a picture");
    expect(zh("citation.picture")).toBe("从图片中识别");
    // Its text was read by this build's pipeline, so a later change can read it again.
    const [stored] = queryDatabase<{ processing_version: number }>(
      dataDir,
      "SELECT processing_version FROM documents WHERE id = ?",
      [document?.id ?? ""],
    );
    expect(stored?.processing_version).toBe(PROCESSING_VERSION);
  });

  test("a picture with no text recognition model is retryable, and its failure says the picture, not a scan", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Photo.jpg", picture()),
    ]);
    expect(document).toMatchObject({
      kind: "image",
      status: "failed",
      failure: { reason: "pages-unread" },
    });
    expect(document?.failure?.message).toContain("The picture couldn't be read");
    expect(document?.failure?.message).not.toContain("Scanned page");
  });

  test("a picture with no text found says a picture in the unread list, not a scan", async () => {
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: pictureRecognizer([]),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Blank photo.png", picture()),
    ]);
    expect(document?.status).toBe("no-text");
    const unread = await core.listUnreadFiles(null);
    const file = unread.find((each) => each.documentId === document?.id);
    expect(file).toMatchObject({ reason: "picture", extension: null });
    const worded = unreadFileText(file ?? { name: "", reason: "picture", extension: null }, en);
    expect(worded).toContain("A picture whose text couldn’t be recognized");
    expect(worded).not.toContain("A scan");
    expect(unreadFileText(file ?? { name: "", reason: "picture", extension: null }, zh)).toContain(
      "图片中的文字未能识别",
    );
  });
});

describe("RTF and HTML are read as text with their headings (#762)", () => {
  test("an RTF file is read by heading section, its text decoded, and its sections are cited", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Harbour rules.rtf", RTF),
    ]);

    expect(document?.kind).toBe("rtf");
    expect(document?.status).toBe("ready");
    const text = await core.readDocumentText(document?.id ?? "");
    expect(text.pages.map((unit) => unit.label?.path)).toEqual([
      ["Harbour rules"],
      ["Harbour rules", "Scope"],
    ]);
    expect(text.pages.map((unit) => unit.kind)).toEqual(["section", "section"]);
    expect(text.pages[0]?.text).toContain("# Harbour rules");
    expect(text.pages[0]?.text).toContain("The harbour master keeps the records.");
    expect(text.pages[1]?.text).toContain("## Scope");
    expect(text.pages[1]?.text).toContain("£100 applies to every berth.");
    // The words as the file holds them: no Markdown escape sits between a quote and the text.
    expect(text.pages[1]?.text).toContain("See [Exhibit A] and a *starred* word.");
    expect(text.pages[1]?.text).toContain("- not a list, just a dash: C#_notes.");
    const quoted = await core.readableQuote({
      documentId: document?.id ?? "",
      contentHash: null,
      pageFrom: 2,
      pageTo: 2,
      quote: "See [Exhibit A]",
    });
    expect(quoted).toContain("See [Exhibit A]");
    const [found] = await core.searchPassages("harbour master records", { mode: "keyword" });
    expect(found).toMatchObject({ documentId: document?.id, pageFrom: 1 });
  });

  test("an HTML file is read as a browser reads it: headings, lists, a table, and none of its script", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "notice.html", HTML),
    ]);

    expect(document?.kind).toBe("html");
    expect(document?.status).toBe("ready");
    // Its title comes from its head, not its file name.
    expect(document?.title).toBe("Harbour notice");
    const text = await core.readDocumentText(document?.id ?? "");
    expect(text.pages.map((unit) => unit.label?.path)).toEqual([
      ["Harbour notice"],
      ["Harbour notice", "Fees"],
    ]);
    const all = text.pages.map((unit) => unit.text).join("\n");
    expect(all).toContain("# Harbour notice");
    expect(all).toContain("## Fees");
    expect(all).toContain("Berthing & mooring: 42");
    expect(all).toContain("Port | Leith");
    expect(all).toContain("Cost *estimate* only, and a [link] that is words.");
    expect(all).not.toContain("never read");
    expect(all).not.toContain("color: red");
    const [found] = await core.searchPassages("tide tables", { mode: "keyword" });
    expect(found).toMatchObject({ documentId: document?.id, pageFrom: 1 });
    const quoted = await core.readableQuote({
      documentId: document?.id ?? "",
      contentHash: null,
      pageFrom: 2,
      pageTo: 2,
      quote: "Cost *estimate* only",
    });
    expect(quoted).toContain("Cost *estimate* only");
  });

  test("a page whose head is never closed is still read, as a browser closes it", () => {
    const markdown = htmlTextToMarkdown(
      "<head><title>Harbour notice</title><body><h1>Harbour notice</h1><p>tide tables",
    );
    expect(markdown).toContain("# Harbour notice");
    expect(markdown).toContain("tide tables");
  });
});

describe("Old Office, WPS, Pages and Keynote files say the plain next step (#762)", () => {
  test("each kind says what to do with it, in English and Chinese", () => {
    expect(en(skippedStep("Letter.doc").message)).toBe("Save it as .docx in Word, then add it");
    expect(zh(skippedStep("Letter.doc").message)).toBe("请在 Word 中另存为 .docx，然后再添加");
    expect(en(skippedStep("Ledger.xls").message)).toBe("Save it as .xlsx in Excel, then add it");
    expect(en(skippedStep("Deck.ppt").message)).toBe("Save it as .pptx in PowerPoint, then add it");
    expect(skippedStep("Plan.wps").convert).toBe("docx");
    expect(skippedStep("Sheet.et").convert).toBe("xlsx");
    expect(skippedStep("Slides.dps").convert).toBe("pptx");
    expect(en(skippedStep("Report.pages").message)).toBe(
      "Export it as PDF from Pages, then add it",
    );
    expect(zh(skippedStep("Report.pages").message)).toBe("请从 Pages 导出为 PDF，然后再添加");
    expect(en(skippedStep("Talk.key").message)).toBe("Export it as PDF from Keynote, then add it");
    expect(zh(skippedStep("Talk.key").message)).toBe("请从 Keynote 导出为 PDF，然后再添加");
    expect(en(skippedStep("Archive.zip").message)).toBe(
      "IncarnaMind reads PDF, Word, Excel, PowerPoint, CSV, Markdown, pictures, RTF, HTML and text files",
    );
    expect(zh(skippedStep("Archive.zip").message)).toBe(
      "IncarnaMind 可读取 PDF、Word、Excel、PowerPoint、CSV、Markdown、图片、RTF、HTML 和文本文件",
    );
  });

  test("adding them skips them, and only a file an add skipped can be shown in the file manager", async () => {
    const shown: string[] = [];
    const core = startCore(await createTempDataFolder(), {
      shell: {
        openPath: async () => undefined,
        showItemInFolder: (path) => shown.push(path),
      },
    });
    const sources = await createSourceFolder();
    const files = await Promise.all(
      [
        "Letter.doc",
        "Ledger.xls",
        "Deck.ppt",
        "Plan.wps",
        "Sheet.et",
        "Slides.dps",
        "Report.pages",
        "Talk.key",
      ].map((name) => writeSourceFile(sources, name, "not read")),
    );
    const result = await core.addDocuments(files);
    expect(result.documents).toEqual([]);
    expect(result.skipped.map((each) => each.reason)).toEqual(files.map(() => "unsupported-type"));

    await core.showSkippedFile(files[0] ?? "");
    expect(shown).toEqual([files[0]]);
    await expect(core.showSkippedFile(join(sources, "Other.doc"))).rejects.toThrow(
      "Only a file an add skipped",
    );
  });
});

describe("Convert with LibreOffice adds a copy and leaves the original untouched (#762)", () => {
  test("the copy is a Document that says which file it came from, and the original is the same bytes", async () => {
    const dataDir = await createTempDataFolder();
    const calls: { path: string; target: string }[] = [];
    const core = startCore(dataDir, { officeConverter: fakeConverter(calls) });
    const sources = await createSourceFolder();
    const original = await writeSourceFile(sources, "Contract.doc", "the original .doc");
    const before = readFileSync(original);

    const [skipped] = (await core.addDocuments([original])).skipped;
    expect(skipped).toMatchObject({ path: original, reason: "unsupported-type" });
    expect(await core.officeConverter()).toEqual({ available: true });
    const result = await core.convertWithOffice(original);

    if (result.outcome !== "added") throw new Error(JSON.stringify(result));
    expect(calls).toEqual([{ path: original, target: "docx" }]);
    expect(readFileSync(original)).toEqual(before);
    expect(result.document).toMatchObject({
      kind: "docx",
      name: "Contract",
      convertedFrom: "Contract.doc",
    });
    expect(result.document.path).toContain(join(dataDir, "converted"));
    expect(result.document.path).not.toBe(original);
    const [ready] = await waitForProcessing(core, [result.document.id]);
    expect(ready?.status).toBe("ready");
    const [found] = await core.searchPassages("flood risk", { mode: "keyword" });
    expect(found?.documentId).toBe(result.document.id);
    expect(en("info.convertedFrom")).toBe("Converted from");
    expect(zh("info.convertedFrom")).toBe("转换自");

    // Deleted permanently, its kept copy goes with it.
    const kept = dirname(result.document.path);
    await core.deleteDocument(result.document.id);
    await core.deletePermanently([{ kind: "document", id: result.document.id }]);
    expect(existsSync(kept)).toBe(false);
  });

  test("with no LibreOffice the offer is absent and nothing is converted", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const file = await writeSourceFile(sources, "Letter.doc", "not read");
    await core.addDocuments([file]);
    expect(await core.officeConverter()).toEqual({ available: false });
    expect(await core.convertWithOffice(file)).toEqual({
      outcome: "problem",
      problem: "unavailable",
    });
    expect(await core.convertWithOffice(await writeSourceFile(sources, "x.zip", "x"))).toEqual({
      outcome: "problem",
      problem: "unsupported",
    });
  });

  test("a .doc the import screen picks converts to a .docx copy it can read (#104)", async () => {
    const calls: { path: string; target: string }[] = [];
    const core = startCore(await createTempDataFolder(), {
      officeConverter: fakeConverter(calls),
    });
    const sources = await createSourceFolder();
    const legacy = await writeSourceFile(sources, "Lease.doc", "the original .doc");

    const check = await core.checkWordFile(legacy);
    expect(check).toMatchObject({ fileName: "Lease.doc", refusal: "legacy", canConvert: true });
    const converted = await core.convertWordFile(legacy);
    if (converted.outcome !== "converted") throw new Error(JSON.stringify(converted));
    expect(converted.name).toBe("Contract.docx");
    expect(calls).toEqual([{ path: legacy, target: "docx" }]);
    // The converted copy is a Word file the import screen reads as usual.
    const after = await core.checkWordFile(converted.path);
    expect(after.refusal).toBeNull();
    expect(en("wordImport.convert")).toBe("Convert with LibreOffice");
    expect(zh("wordImport.convert")).toBe("用 LibreOffice 转换");

    // Importing it removes the temporary copy, and never adds it as the User's original.
    const folder = dirname(converted.path);
    const imported = await core.importWordFile({
      path: converted.path,
      origin: "own",
      addOriginal: true,
    });
    expect(imported).toMatchObject({ ok: true });
    expect(existsSync(folder)).toBe(false);

    // Cancelling does too.
    const cancelled = await core.convertWordFile(legacy);
    if (cancelled.outcome !== "converted") throw new Error(JSON.stringify(cancelled));
    expect(existsSync(dirname(cancelled.path))).toBe(true);
    await core.discardWordFile(cancelled.path);
    expect(existsSync(dirname(cancelled.path))).toBe(false);
  });

  test("with no LibreOffice, a .doc's check offers no conversion", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const legacy = await writeSourceFile(sources, "Lease.doc", "the original .doc");
    const check = await core.checkWordFile(legacy);
    expect(check).toMatchObject({ refusal: "legacy", canConvert: false });
    expect(await core.convertWordFile(legacy)).toEqual({
      outcome: "problem",
      problem: "unavailable",
    });
  });
});

describe("The processing version (#762)", () => {
  test("this change's processing version is 22", () => {
    // Main's highest was 21 when this branch was cut; it is renumbered at the final push if
    // another change came first.
    expect(PROCESSING_VERSION).toBe(22);
  });
});
