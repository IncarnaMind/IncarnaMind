/**
 * The files of #2216's pairs, made as a person makes them: a Word file, the
 * same saved again by an editor or with a part added, a PDF printed from it
 * (wrapped, hyphenated, with a running header and page numbers), a Word file
 * saved from that PDF, drafts, a reply, a bundle and the code it quotes.
 * Built by the tests' own Word and PDF writers, so they stay readable.
 */

import { buildPdf, type PdfPage, widthOf } from "./pdf";
import {
  type Agreement,
  agreement,
  bundleParts,
  draft,
  type Language,
  quotedCode,
  reply,
  sameTemplate,
} from "./sameTextAgreements";
import { escapeXml, field, paragraph, run, wordFile } from "./word";

export interface FixtureFile {
  name: string;
  bytes: Uint8Array;
}

export interface CopyPair {
  pair: string;
  /** Whether the other file is a copy of the checked one, as #2216's ruling has it. */
  copy: boolean;
  checked: FixtureFile;
  other: FixtureFile;
}

const HEADER_RELS =
  '<w:headerReference w:type="default" r:id="rIdH1"/><w:footerReference w:type="default" r:id="rIdF1"/>';
const PAGE = '<w:pgSz w:w="11906" w:h="16838"/>';

function footer(language: Language): string {
  return language === "zh"
    ? paragraph(
        `${run("第 ")}${field("PAGE", "1")}${run(" 页 共 ")}${field("NUMPAGES", "4")}${run(" 页")}`,
      )
    : paragraph(`${run("Page ")}${field("PAGE", "1")}${run(" of ")}${field("NUMPAGES", "4")}`);
}

/** The body as Word first saves it: a run for each paragraph. */
const plainBody = (document: Agreement) =>
  document.paragraphs
    .map((each) => paragraph(each.text, each.heading ? { style: "Heading1" } : {}))
    .join("");

/**
 * The body as Word writes it after more editing sessions: the same text in
 * runs split where it was typed, with revision ids, proofing marks and a bookmark.
 */
function resavedBody(document: Agreement): string {
  return document.paragraphs
    .map((each, index) => {
      const words = each.text.split(/(?<= )/u);
      const cut = Math.max(1, Math.floor(words.length / 3));
      const runs = [words.slice(0, cut), words.slice(cut, cut * 2), words.slice(cut * 2)]
        .map((part) => part.join(""))
        .filter((part) => part !== "")
        .map(
          (part, at) =>
            `<w:r w:rsidR="00${(index * 7 + at).toString(16).padStart(6, "0").toUpperCase()}"><w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`,
        );
      const marked =
        index === 3
          ? `<w:proofErr w:type="spellStart"/>${runs[0] ?? ""}<w:proofErr w:type="spellEnd"/>${runs.slice(1).join("")}`
          : runs.join("");
      const bookmark =
        index === 5 ? '<w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/>' : "";
      const style = each.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : "";
      return `<w:p w:rsidR="00B${index.toString(16).padStart(5, "0").toUpperCase()}" w:rsidRDefault="00C41D2E">${style}${bookmark}${marked}</w:p>`;
    })
    .join("");
}

const CORE_PROPERTIES = (modified: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Contracts team</dc:creator><cp:lastModifiedBy>Reviewer</cp:lastModifiedBy><cp:revision>7</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-03-10T09:12:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified></cp:coreProperties>`;

/** A Word file of the agreement; `saved again` as an editor rewrites it, or with a part added. */
export function wordOf(
  document: Agreement,
  language: Language,
  as: "first saved" | "saved again" | "entry added" = "first saved",
): Buffer {
  const headers = { rIdH1: paragraph(document.header) };
  const footers = { rIdF1: footer(language) };
  if (as === "saved again") {
    return wordFile({
      body: resavedBody(document),
      headers,
      footers,
      sectPr: `${HEADER_RELS}${PAGE}`,
      settings:
        '<w:zoom w:percent="110"/><w:defaultTabStop w:val="720"/><w:rsids><w:rsidRoot w:val="00C41D2E"/><w:rsid w:val="00A0B1C2"/><w:rsid w:val="00B00003"/></w:rsids>',
      parts: [
        { name: "docProps/core.xml", data: CORE_PROPERTIES("2026-03-14T16:40:00Z") },
        {
          name: "docProps/app.xml",
          data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office Word</Application><TotalTime>94</TotalTime><Pages>4</Pages></Properties>',
          store: true,
        },
        { name: "docProps/thumbnail.jpeg", data: Buffer.alloc(512, 0xd8), store: true },
      ],
    });
  }
  return wordFile({
    body: plainBody(document),
    headers,
    footers,
    sectPr: `${HEADER_RELS}${PAGE}`,
    ...(as === "entry added" && {
      rels: '<Relationship Id="rIdCustom1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>',
      parts: [
        {
          name: "customXml/item1.xml",
          data: '<?xml version="1.0" encoding="UTF-8" standalone="no"?><b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" SelectedStyle="/APA.XSL" StyleName="APA"/>',
        },
        {
          name: "customXml/itemProps1.xml",
          data: '<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{4F1C2A7E-9B3D-4E21-8C55-0A6B2D9E1F37}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/></ds:schemaRefs></ds:datastoreItem>',
        },
      ],
    }),
  });
}

const TEXT_WIDTH = 468;
const LINES_PER_PAGE = 48;
const CHINESE_PER_LINE = 40;

/** English wrapped as a word processor sets it at 11 pt, splitting a long word with a hyphen where it can. */
function wrapEnglish(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (widthOf(joined, 11) <= TEXT_WIDTH) {
      line = joined;
      continue;
    }
    const letters = /^[A-Za-z]+/u.exec(word)?.[0] ?? "";
    let split = false;
    for (let cut = letters.length - 3; letters.length >= 7 && cut >= 3; cut--) {
      const head = `${line === "" ? "" : `${line} `}${word.slice(0, cut)}-`;
      if (widthOf(head, 11) <= TEXT_WIDTH) {
        lines.push(head);
        line = word.slice(cut);
        split = true;
        break;
      }
    }
    if (split) continue;
    if (line !== "") lines.push(line);
    line = word;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Chinese wrapped by characters, a run of Latin letters, digits or an address kept whole. */
function wrapChinese(text: string): string[] {
  const chars = [...text];
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + CHINESE_PER_LINE);
    const latin = /[A-Za-z0-9@.,_-]/u;
    while (
      end < chars.length &&
      end > start + 1 &&
      latin.test(chars[end] ?? "") &&
      latin.test(chars[end - 1] ?? "")
    ) {
      end--;
    }
    if (end === start + 1) end = Math.min(chars.length, start + CHINESE_PER_LINE);
    lines.push(chars.slice(start, end).join(""));
    start = end;
  }
  return lines;
}

/** A PDF printed from documents, each starting on a new page, and the lines of each page as printed. */
export function printedPdf(
  documents: readonly Agreement[],
  language: Language,
  header?: string,
): { bytes: Uint8Array; pages: { header: string; lines: string[]; footer: string }[] } {
  const pages: { header: string; lines: string[] }[] = [];
  for (const document of documents) {
    const lines = document.paragraphs.flatMap((each) => [
      ...(language === "zh" ? wrapChinese(each.text) : wrapEnglish(each.text)),
      "",
    ]);
    for (let at = 0; at < lines.length; at += LINES_PER_PAGE) {
      pages.push({
        header: header ?? document.header,
        lines: lines.slice(at, at + LINES_PER_PAGE),
      });
    }
  }
  const printed = pages.map((page, index) => ({
    ...page,
    footer:
      language === "zh"
        ? `第 ${index + 1} 页 共 ${pages.length} 页`
        : `Page ${index + 1} of ${pages.length}`,
  }));
  const pdfPages: PdfPage[] = printed.map((page) => ({
    ...(language === "zh" ? { chineseLines: page.lines } : { lines: page.lines }),
    placed: [
      { text: page.header, x: 72, y: 776, size: 9 },
      { text: page.footer, x: 270, y: 36, size: 9 },
    ],
  }));
  return { bytes: buildPdf(pdfPages), pages: printed };
}

/**
 * A Word file a converter saved from a PDF: each printed line its own
 * paragraph, its line-end hyphens kept, and each page's running header and
 * page number in the body where the page had them.
 */
export function wordFromPdf(printed: ReturnType<typeof printedPdf>): Buffer {
  const body = printed.pages
    .flatMap((page) => [page.header, ...page.lines.filter((line) => line !== ""), page.footer])
    .map((line) => paragraph(line))
    .join("");
  return wordFile({ body, sectPr: PAGE });
}

const NAMES = {
  en: {
    original: "Services Agreement",
    reply: "Comments on the draft",
    template: "Services Agreement (Marlow Street)",
    code: "Housing Data Sharing Code",
    bundle: "Completion bundle",
  },
  zh: {
    original: "技术服务合同",
    reply: "关于合同草案的意见函",
    template: "技术服务合同（白鹭洲）",
    code: "住房数据共享规范",
    bundle: "交割文件汇编",
  },
} as const;

/** Every pair of #2216's ruling, in one language: the checked file and the other Document. */
export function copyPairs(language: Language): CopyPair[] {
  const names = NAMES[language];
  const original = agreement(language);
  const word: FixtureFile = { name: `${names.original}.docx`, bytes: wordOf(original, language) };
  const printed = printedPdf([original], language);
  const pdf: FixtureFile = { name: `${names.original}.pdf`, bytes: printed.bytes };
  const parts = bundleParts(language);
  const file = (name: string, bytes: Uint8Array): FixtureFile => ({ name, bytes });
  const suffix =
    language === "zh"
      ? {
          again: "（另存）",
          entry: "（含自定义部件）",
          fromPdf: "（由 PDF 转换）",
          one: "（修改一条）",
          third: "（修改三分之一）",
        }
      : {
          again: " (saved again)",
          entry: " (with a part added)",
          fromPdf: " (from the PDF)",
          one: " (one clause changed)",
          third: " (a third changed)",
        };
  return [
    {
      pair: "a Word file saved again",
      copy: true,
      checked: word,
      other: file(
        `${names.original}${suffix.again}.docx`,
        wordOf(original, language, "saved again"),
      ),
    },
    {
      pair: "one with a zip entry added",
      copy: true,
      checked: word,
      other: file(
        `${names.original}${suffix.entry}.docx`,
        wordOf(original, language, "entry added"),
      ),
    },
    { pair: "a PDF printed from Word", copy: true, checked: word, other: pdf },
    {
      pair: "a Word file saved from a PDF",
      copy: true,
      checked: pdf,
      other: file(`${names.original}${suffix.fromPdf}.docx`, wordFromPdf(printed)),
    },
    {
      pair: "a draft with one clause changed",
      copy: true,
      checked: word,
      other: file(
        `${names.original}${suffix.one}.docx`,
        wordOf(draft(language, "one clause"), language),
      ),
    },
    {
      pair: "a bundle holding the whole file",
      copy: true,
      checked: word,
      other: file(
        `${names.bundle}.pdf`,
        printedPdf([parts.before, original, parts.after], language, names.bundle).bytes,
      ),
    },
    {
      pair: "a draft with a third of its clauses changed",
      copy: false,
      checked: word,
      other: file(
        `${names.original}${suffix.third}.docx`,
        wordOf(draft(language, "a third"), language),
      ),
    },
    {
      pair: "two files from one template",
      copy: false,
      checked: word,
      other: file(`${names.template}.docx`, wordOf(sameTemplate(language), language)),
    },
    {
      pair: "a reply quoting two paragraphs",
      copy: false,
      checked: word,
      other: file(`${names.reply}.docx`, wordOf(reply(language), language)),
    },
    {
      pair: "a source the checked file quotes",
      copy: false,
      checked: word,
      other: file(`${names.code}.pdf`, printedPdf([quotedCode(language)], language).bytes),
    },
  ];
}
