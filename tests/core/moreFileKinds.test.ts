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
import { htmlMarkdown, htmlTextToMarkdown, htmlTitle } from "../../src/core/documents/formats/html";
import { rtfMarkdown } from "../../src/core/documents/formats/rtf";
import { PROCESSING_VERSION } from "../../src/core/documents/processing";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { BUILT_IN_TEXT_RECOGNITION_MODEL } from "../../src/core/documents/scan/model";
import { pictureProblem } from "../../src/core/documents/web/pictures";
import { translate } from "../../src/shared/i18n";
import { skippedStep } from "../../src/shared/skippedFiles";
import { unreadFileText } from "../../src/shared/unreadFiles";
import {
  createTempDataFolder,
  filesInTemp,
  NO_MODEL_FILES,
  queryDatabase,
  startCore,
} from "../helpers/core";
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
\pard # not a heading.\par
\pard > not a quote.\par
\pard 1. not a list.\par
\pard ~~~ not code.\par
}
`;

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Harbour notice</title>
<style>.notice { color: red }</style>
<script>var hidden = "never read";</script></head>
<body>
<h1>Harbour notice</h1>
<script>var later = "body script";</script>
<p>The harbour master publishes the tide tables.<br>Every 12 months.
<p>Net&nbsp;income&mdash;&euro;5&nbsp;m &ldquo;quoted&rdquo; &copy;</p>
<h2>Fees</h2>
<ul><li>Berthing &amp; mooring: 42<li>Tonnage: 18</ul>
<table><tr><th>Port<td>Leith<tr><td>Fee<br>note<td>42</table>
<p>Cost *estimate* only, and a [link] that is words.</p>
<p># not a heading.</p>
<p>> not a quote.</p>
<p>1. not a list.</p>
<p>~~~ not code.</p>
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

/** A BMP whose header claims a size: a canvas decodes BMP whatever the file is named. */
function bmpClaiming(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(54);
  bytes.set([0x42, 0x4d], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 8, true);
  return bytes;
}

/** The bytes of a HEIC: its `ftyp` and brand are all the reader looks at before decoding. */
function heifBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x68, 0x65, 0x69, 0x63], 8);
  return bytes;
}

/** A HEIC with an `ispe` box of its own, as a camera file has: width and height in it. */
function heifWithIspe(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x68, 0x65, 0x69, 0x63], 8);
  view.setUint32(16, 20);
  bytes.set([0x69, 0x73, 0x70, 0x65], 20);
  view.setUint32(28, width);
  view.setUint32(32, height);
  return bytes;
}

/** A JPEG whose SOF sits behind legal 0xFF fill bytes. */
function jpegWithFill(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0xff, 0xd8], 0);
  bytes.set([0xff, 0xff, 0xff, 0xe0, 0x00, 0x02], 2);
  bytes.set([0xff, 0xff, 0xc0, 0x00, 0x0b, 0x08], 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(14, height);
  view.setUint16(16, width);
  return bytes;
}

/** A PNG whose header claims a size: the guard reads the header, never the pixels. */
function pngClaiming(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

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

  test("a picture whose header claims more pixels than the cap is refused before it is decoded", async () => {
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: pictureRecognizer(["should never be read"]),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Bomb.png", pngClaiming(30_000, 30_000)),
    ]);
    expect(document).toMatchObject({
      kind: "image",
      status: "failed",
      failure: { reason: "too-large" },
    });
    expect(document?.failure?.message).toContain("too large to open");
  });

  test("a decoder's format that isn't one it reads is refused, whatever its name says", async () => {
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: pictureRecognizer(["should never be read"]),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Bomb.png", bmpClaiming(8192, 8192)),
    ]);
    expect(document).toMatchObject({
      kind: "image",
      status: "failed",
      failure: { reason: "picture-unreadable" },
    });
    expect(document?.failure?.message).toContain("isn’t a picture IncarnaMind reads");
  });

  test("a picture whose size can't be read says so, not that it is too large", async () => {
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: pictureRecognizer(["should never be read"]),
      textRecognitionModelSource: NO_MODEL_FILES,
    });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Cut.png",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ]);
    expect(document).toMatchObject({
      kind: "image",
      status: "failed",
      failure: { reason: "picture-unreadable" },
    });
    expect(document?.failure?.message).toContain("size couldn’t be read");
  });

  test("a HEIC whose ispe box claims too many pixels is refused before it is decoded", async () => {
    let decoded = false;
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: pictureRecognizer(["should never be read"]),
      textRecognitionModelSource: NO_MODEL_FILES,
      decodePicture: async () => {
        decoded = true;
        return pngClaiming(1, 1);
      },
    });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Ispe.heic", heifWithIspe(30_000, 30_000)),
    ]);
    expect(document).toMatchObject({
      kind: "image",
      status: "failed",
      failure: { reason: "too-large" },
    });
    expect(decoded).toBe(false);
  });

  test("a HEIC bomb is refused on the PNG decoded from it, before anything reads it", async () => {
    const core = startCore(await createTempDataFolder(), {
      textRecognizer: pictureRecognizer(["should never be read"]),
      textRecognitionModelSource: NO_MODEL_FILES,
      decodePicture: async () => pngClaiming(30_000, 30_000),
    });
    const sources = await createSourceFolder();
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "Phone.heic", heifBytes()),
    ]);
    expect(document).toMatchObject({
      kind: "image",
      status: "failed",
      failure: { reason: "too-large" },
    });
    expect(document?.failure?.message).toContain("too large to open");
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
    expect(text.pages[0]?.text).toContain("#\tHarbour rules");
    expect(text.pages[0]?.text).toContain("The harbour master keeps the records.");
    expect(text.pages[1]?.text).toContain("##\tScope");
    expect(text.pages[1]?.text).toContain("£100 applies to every berth.");
    // The words as the file holds them: no Markdown escape sits between a quote and the text.
    expect(text.pages[1]?.text).toContain("See [Exhibit A] and a *starred* word.");
    expect(text.pages[1]?.text).toContain("- not a list, just a dash: C#_notes.");
    for (const line of ["# not a heading.", "> not a quote.", "1. not a list.", "~~~ not code."]) {
      expect(text.pages[1]?.text).toContain(line);
    }
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
    expect(all).toContain("#\tHarbour notice");
    expect(all).toContain("##\tFees");
    expect(all).toContain("Berthing & mooring: 42");
    expect(all).toContain("Port | Leith");
    expect(all).toContain("Cost *estimate* only, and a [link] that is words.");
    expect(all).toContain("Fee\nnote | 42");
    expect(all).toContain("Net income—€5 m “quoted” ©");
    for (const line of ["# not a heading.", "> not a quote.", "1. not a list.", "~~~ not code."]) {
      expect(all).toContain(line);
    }
    expect(all).not.toContain("never read");
    expect(all).not.toContain("body script");
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
    expect(markdown).toContain("#\tHarbour notice");
    expect(markdown).toContain("tide tables");
  });

  test("its named references are read, in the body and in its title", () => {
    const markdown = htmlTextToMarkdown(
      "<p>Net&nbsp;income&mdash;&euro;5&nbsp;m &ldquo;q&rdquo; &copy; &hellip; &alpha; &rarr;</p>",
    );
    expect(markdown).toContain("Net income—€5 m “q” © … α →");
    expect(htmlTitle("<title>A &amp; B&nbsp;&mdash;&nbsp;C</title>")).toBe("A & B — C");
  });

  test("the encoding its head declares is the one it is read in", () => {
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
    const page = (...parts: (string | number[])[]) =>
      new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? ascii(part) : part)));
    expect(
      htmlMarkdown(page('<meta charset="big5"><p>', [0xa4, 0xa4, 0xa4, 0xe5], "</p>")),
    ).toContain("中文");
    expect(
      htmlMarkdown(page('<meta charset="shift_jis"><p>', [0x93, 0xfa, 0x96, 0x7b], "</p>")),
    ).toContain("日本");
    const httpEquiv = '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">';
    expect(htmlMarkdown(page(httpEquiv, "<p>caf", [0xe9], " ", [0x80], "</p>"))).toContain(
      "café €",
    );
  });

  test("an HTML Document's title is read in the encoding its page declares", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
    const bytes = new Uint8Array([
      ...ascii('<meta charset="big5"><title>'),
      0xa4,
      0xa4,
      0xa4,
      0xe5,
      ...ascii("</title><p>tide tables</p>"),
    ]);
    const [document] = await addAndProcess(core, [
      await writeSourceFile(sources, "title.html", bytes),
    ]);
    expect(document?.title).toBe("中文");
  });

  test("a stray < is the page's text, and a > inside an attribute ends no tag", () => {
    expect(htmlTextToMarkdown("<p>if a < b and c > d then</p>")).toContain(
      "if a < b and c > d then",
    );
    expect(htmlTextToMarkdown("<p>x <3 y</p>")).toContain("x <3 y");
    expect(htmlTextToMarkdown("<p>tail < no close")).toContain("tail < no close");
    expect(htmlTextToMarkdown('<a title="x>y">link</a>')).toBe("link\n");
  });

  test("a quote starts a value only after =, so an apostrophe in a value keeps the page", () => {
    const page = htmlTextToMarkdown("<p class=it's>Hello <b>there</b></p><p>tail</p>");
    expect(page).toContain("Hello there");
    expect(page).toContain("tail");
    expect(htmlTextToMarkdown("<a href=/people/o'brien>O'Brien here</a>")).toBe("O'Brien here\n");
  });

  test("a meta charset in a comment names nothing, read from the bytes", () => {
    const markdown = htmlMarkdown(
      new TextEncoder().encode('<!-- <meta charset="big5"> --><p>café 中文</p>'),
    );
    expect(markdown).toContain("café 中文");
    expect(markdown).not.toContain("big5");
  });

  test("the full named-reference table and a legacy name without its semicolon are read", () => {
    expect(htmlTextToMarkdown("<p>&check; &star; &bullet; &copy 2026 &nbsp;end</p>")).toContain(
      "✓ ☆ • © 2026 end",
    );
    expect(htmlTextToMarkdown("<p>&notit;</p>")).toContain("¬it;");
    expect(htmlTextToMarkdown("<p>&nope;</p>")).toContain("&nope;");
  });

  test("a numeric reference keeps no semicolon, and an old C1 reference is its windows-1252 character", () => {
    expect(
      htmlTextToMarkdown("<p>don&#8217;t &#8220;quote&#8221; &#x2014; &#x1F600; &#0;</p>"),
    ).toContain("don’t “quote” — 😀 �");
    expect(htmlTextToMarkdown("<p>&#150; &#128; &#146; &#x93;</p>")).toContain("– € ’ “");
  });

  test("a script's or style's body is raw text, never markup, and a title in the head stays out", () => {
    const first = htmlTextToMarkdown(
      "<head><script>if(a<b&&c>d){secret()}</script><title>T</title></head><body><p>body</p>",
    );
    expect(first).toContain("body");
    expect(first).not.toContain("secret");
    expect(first).not.toContain("T");
    const second = htmlTextToMarkdown(
      '<div><script>var s = "</div>"; leaked();</script></div><p>ok</p>',
    );
    expect(second).toContain("ok");
    expect(second).not.toContain("leaked");
    const third = htmlTextToMarkdown('<body><p>Start<style>p:after{content:"</p>"}</style>end</p>');
    expect(third).toContain("Startend");
    expect(third).not.toContain("content");
  });

  test("an old-style escaped script stays one script, so the words after it are the page's", () => {
    const markdown = htmlTextToMarkdown(
      "<script><!--<script>a</script>b()--></script><p>harbour rules</p>",
    );
    expect(markdown).toContain("harbour rules");
    expect(markdown).not.toContain("b()");
    expect(markdown).not.toContain("-->");
    // A script's tags are HTML's, so their case doesn't decide where it ends.
    expect(htmlTextToMarkdown("<SCRIPT><!--x--></SCRIPT><p>upper</p>")).toBe("upper\n");
  });

  test("a title an svg or math never closes does not swallow the rest of the page", () => {
    const svg = htmlTextToMarkdown("<svg><title>Chart</svg><p>harbour rules</p>");
    expect(svg).toContain("harbour rules");
    expect(svg).not.toContain("Chart");
    const math = htmlTextToMarkdown("<math><title>x</math><p>tide tables</p>");
    expect(math).toContain("tide tables");
    expect(math).not.toContain("</p>");
  });

  test("an alt is read, a data-alt is not, and a legacy name in an attribute stays as written", () => {
    expect(htmlTextToMarkdown('<img alt="Harbour map">')).toContain("Harbour map");
    expect(htmlTextToMarkdown('<img data-alt="should not show">')).not.toContain("should not show");
    expect(htmlTextToMarkdown('<img alt="?a=1&copy=2&notit;">')).toContain("?a=1&copy=2&notit;");
    expect(htmlTextToMarkdown('<img alt="?a=1&copy 2">')).toContain("?a=1© 2");
  });

  test("a meta's charset attribute or Content-Type pragma names the encoding, and nothing else", () => {
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
    const page = (...parts: (string | number[])[]) =>
      new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? ascii(part) : part)));
    expect(
      htmlMarkdown(
        page('<meta name="description" content="we use charset=gbk"><p>caf', [0xc3, 0xa9], "</p>"),
      ),
    ).toContain("café");
    for (const label of ["utf-16", "unicode", "ucs-2", "csunicode"]) {
      expect(
        htmlMarkdown(page(`<meta charset="${label}"><p>caf`, [0xc3, 0xa9], "</p>")),
        label,
      ).toContain("café");
    }
    expect(
      htmlMarkdown(
        page(
          '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><p>caf',
          [0xe9],
          "</p>",
        ),
      ),
    ).toContain("café");
  });

  test("a page too large to read is refused with its limit, and stray end tags stay linear", () => {
    expect(() => htmlMarkdown(new Uint8Array(64 * 1024 * 1024 + 1))).toThrow(
      "Too large to open (limit 64 MB).",
    );
    // A million unclosed tags and a million stray end tags read in well under a second when
    // every end tag is a count lookup; a walk of the open stack would not finish in a test's time.
    const markdown = htmlTextToMarkdown(
      `${"<div>".repeat(1_000_000)}x${"</span>".repeat(1_000_000)}`,
    );
    expect(markdown).toContain("x");
  });
});

describe("The RTF reader stands up to broken files (#762)", () => {
  const rtf = (body: string) => rtfMarkdown(new TextEncoder().encode(`{\\rtf1\\ansi ${body}}`));

  test("a code point out of range is the replacement character, not a crash", () => {
    expect(rtf("\\u1114112?")).toContain("\uFFFD");
    expect(rtf("\\u-70000?")).toContain("\uFFFD");
  });

  test("\\bin's bytes are data, so the text behind a picture is still read", () => {
    expect(rtf("{\\pict\\bin4 {{{{}after")).toContain("after");
    const later = rtf("{\\pict\\bin5 ab}cd}tail");
    expect(later).not.toContain("cd");
    expect(later).toContain("tail");
  });

  test("a fallback count ends with its group, so the words after it survive", () => {
    expect(rtf("\\uc2 \\u2032 {X}bc")).toContain("Xbc");
    // The group ends with fallback characters still unspent: they are not the words after it.
    expect(rtf("{\\uc2 \\u8242?}bc")).toContain("′bc");
  });

  test("a code page other than the CJK ones is decoded as it says", () => {
    expect(
      rtfMarkdown(new TextEncoder().encode("{\\rtf1\\ansi\\ansicpg1251 \\'cf\\'f0\\'e8}")),
    ).toContain("При");
    expect(rtfMarkdown(new TextEncoder().encode("{\\rtf1\\ansi\\ansicpg1253 \\'c4}"))).toContain(
      "Δ",
    );
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
    expect(en(skippedStep("Plan.wps").message)).toBe("Save it as .docx in WPS Office, then add it");
    expect(zh(skippedStep("Plan.wps").message)).toBe("在 WPS Office 中另存为 .docx 后再添加");
    expect(en(skippedStep("Sheet.et").message)).toBe("Save it as .xlsx in WPS Office, then add it");
    expect(en(skippedStep("Slides.dps").message)).toBe(
      "Save it as .pptx in WPS Office, then add it",
    );
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
    await expect(core.showSkippedFile(join(sources, "Other.doc"))).rejects.toMatchObject({
      message: "Only a file the last add skipped can be shown.",
      wording: { key: "error.files.notSkipped.show" },
    });
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

  test("a conversion whose copy can't be written leaves no temporary folder", async () => {
    const tempDir = await createTempDataFolder();
    const core = startCore(await createTempDataFolder(), {
      paths: { tempDir },
      officeConverter: {
        available: async () => true,
        convert: async () => ({
          outcome: "converted",
          name: `${"x".repeat(300)}.docx`,
          bytes: new Uint8Array([1]),
        }),
      },
    });
    const sources = await createSourceFolder();
    const legacy = await writeSourceFile(sources, "Long.doc", "the original .doc");
    await expect(core.convertWordFile(legacy)).rejects.toThrow();
    expect(await filesInTemp(tempDir)).toEqual([]);
  });

  test("a JPEG behind 0xFF fill bytes has its size read, and an RTF over the cap is refused", async () => {
    expect(pictureProblem(jpegWithFill(200, 100))).toBeNull();
    expect(() => rtfMarkdown(new Uint8Array(64 * 1024 * 1024 + 1))).toThrow(
      "Too large to open (limit 64 MB).",
    );
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
