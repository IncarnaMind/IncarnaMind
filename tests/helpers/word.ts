/**
 * Word files (.docx) put together from WordprocessingML written in the tests,
 * for importing as Minds (#104): any body, styles, numbering, comments,
 * notes, headers, footers and pictures. Written with the test zip helper;
 * nothing here is a real Office library.
 */
import { buildZip, type ZipInput } from "./zip";

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const NAMESPACES = [
  `xmlns:w="${W_NS}"`,
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
].join(" ");

const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

export const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A run of text, with Word's direct formatting. */
export function run(
  text: string,
  format: {
    b?: boolean;
    i?: boolean;
    u?: boolean;
    strike?: boolean;
    highlight?: boolean;
    font?: string;
  } = {},
): string {
  const rPr = [
    format.font ? `<w:rFonts w:ascii="${format.font}" w:hAnsi="${format.font}"/>` : "",
    format.b ? "<w:b/>" : "",
    format.i ? "<w:i/>" : "",
    format.strike ? "<w:strike/>" : "",
    format.highlight ? '<w:highlight w:val="yellow"/>' : "",
    format.u ? '<w:u w:val="single"/>' : "",
  ].join("");
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** A paragraph: runs (or plain text), with its style, list numbering and w14:paraId if given. */
export function paragraph(
  content: string,
  options: { style?: string; numId?: number; ilvl?: number; paraId?: string; sectPr?: string } = {},
): string {
  const runs = content.startsWith("<") ? content : content ? run(content) : "";
  const pPr = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
    options.numId !== undefined
      ? `<w:numPr><w:ilvl w:val="${options.ilvl ?? 0}"/><w:numId w:val="${options.numId}"/></w:numPr>`
      : "",
    options.sectPr ?? "",
  ].join("");
  const id = options.paraId ? ` w14:paraId="${options.paraId}"` : "";
  return `<w:p${id}>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
}

/** A table of cells' XML (each a cell's inner XML, or text for one paragraph). */
export function table(rows: readonly (readonly string[])[], grid?: number): string {
  const columns = grid ?? Math.max(...rows.map((row) => row.length));
  const cell = (inner: string) =>
    inner.startsWith("<w:tcPr") || inner.startsWith("<w:p")
      ? `<w:tc>${inner}${inner.includes("<w:p") ? "" : "<w:p/>"}</w:tc>`
      : `<w:tc>${paragraph(inner)}</w:tc>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(columns)}</w:tblGrid>${rows
    .map((row) => `<w:tr>${row.map(cell).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
}

/** Built-in heading styles 1–3 and Title, named as Word names them, and a default Normal. */
export const STYLES = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>${[
  1, 2, 3,
]
  .map(
    (level) =>
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`,
  )
  .join("")}`;

/** A bulleted list (numId 1) and a numbered one (numId 2), two levels each. */
export const NUMBERING = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`;

export interface WordFileInput {
  /** The inside of w:body. */
  body: string;
  /** The inside of w:styles; the default is `STYLES`. */
  styles?: string;
  /** The inside of w:numbering. */
  numbering?: string;
  /** The inside of w:comments. */
  comments?: string;
  /** The inside of w:footnotes, after the two separators. */
  footnotes?: string;
  /** The inside of w:endnotes, after the two separators. */
  endnotes?: string;
  /** The inside of w:settings. */
  settings?: string;
  /** Header and footer parts, by their relationship id ("rIdH1"): the inside of w:hdr or w:ftr. */
  headers?: Record<string, string>;
  footers?: Record<string, string>;
  /** Pictures, by their relationship id: a part name under word/ ("media/image1.png") and its bytes. */
  media?: Record<string, { name: string; data: Buffer }>;
  /** More of the document's relationships, as <Relationship> elements. */
  rels?: string;
  /** The main part's content type, if not a .docx's. */
  contentType?: string;
  /** More entries in the package. */
  parts?: ZipInput[];
  /** The inside of the body's last w:sectPr, the last section's layout: its header and footer references. */
  sectPr?: string;
}

/** A .docx of the given parts, as Word lays one out. */
export function wordFile(input: WordFileInput): Buffer {
  const rels: string[] = [
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
  ];
  const entries: ZipInput[] = [];
  const add = (name: string, data: string | Buffer) => entries.push({ name, data });
  add(
    "word/styles.xml",
    `${DECLARATION}<w:styles ${NAMESPACES}>${input.styles ?? STYLES}</w:styles>`,
  );
  if (input.numbering !== undefined) {
    rels.push(`<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`);
    add(
      "word/numbering.xml",
      `${DECLARATION}<w:numbering ${NAMESPACES}>${input.numbering}</w:numbering>`,
    );
  }
  if (input.comments !== undefined) {
    rels.push(`<Relationship Id="rIdComments" Type="${REL}/comments" Target="comments.xml"/>`);
    add(
      "word/comments.xml",
      `${DECLARATION}<w:comments ${NAMESPACES}>${input.comments}</w:comments>`,
    );
  }
  if (input.footnotes !== undefined) {
    rels.push(`<Relationship Id="rIdFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>`);
    add(
      "word/footnotes.xml",
      `${DECLARATION}<w:footnotes ${NAMESPACES}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${input.footnotes}</w:footnotes>`,
    );
  }
  if (input.endnotes !== undefined) {
    rels.push(`<Relationship Id="rIdEndnotes" Type="${REL}/endnotes" Target="endnotes.xml"/>`);
    add(
      "word/endnotes.xml",
      `${DECLARATION}<w:endnotes ${NAMESPACES}><w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>${input.endnotes}</w:endnotes>`,
    );
  }
  if (input.settings !== undefined) {
    rels.push(`<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`);
    add(
      "word/settings.xml",
      `${DECLARATION}<w:settings ${NAMESPACES}>${input.settings}</w:settings>`,
    );
  }
  for (const [kind, parts] of [
    ["header", input.headers],
    ["footer", input.footers],
  ] as const) {
    let index = 1;
    for (const [id, xml] of Object.entries(parts ?? {})) {
      const name = `${kind}${index++}.xml`;
      rels.push(`<Relationship Id="${id}" Type="${REL}/${kind}" Target="${name}"/>`);
      const root = kind === "header" ? "w:hdr" : "w:ftr";
      add(`word/${name}`, `${DECLARATION}<${root} ${NAMESPACES}>${xml}</${root}>`);
    }
  }
  for (const [id, { name, data }] of Object.entries(input.media ?? {})) {
    rels.push(`<Relationship Id="${id}" Type="${REL}/image" Target="${name}"/>`);
    entries.push({ name: `word/${name}`, data });
  }
  if (input.rels) rels.push(input.rels);
  const override = `<Override PartName="/word/document.xml" ContentType="${input.contentType ?? MAIN_TYPE}"/>`;
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${override}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/document.xml",
      data: `${DECLARATION}<w:document ${NAMESPACES}><w:body>${input.body}<w:sectPr>${input.sectPr ?? '<w:pgSz w:w="11906" w:h="16838"/>'}</w:sectPr></w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: `${DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
    },
    ...entries,
    ...(input.parts ?? []),
  ]);
}

/** A 1×1 transparent PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** An inline picture, in a run, of the media with relationship id `id`. */
export function picture(id: string, alt: string, { floating = false } = {}): string {
  const frame = floating ? "wp:anchor" : "wp:inline";
  return `<w:r><w:drawing><${frame}><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Picture 1" descr="${escapeXml(alt)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></${frame}></w:drawing></w:r>`;
}

/** A text box, in a run, written as Word writes one: DrawingML first, a VML fallback after. */
export function textBox(lines: readonly string[]): string {
  const content = `<w:txbxContent>${lines.map((line) => paragraph(line)).join("")}</w:txbxContent>`;
  return `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/><wp:docPr id="2" name="Text Box 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:txbx>${content}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>${content}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
}

/** A complex field: its instruction, and the result Word last showed. */
export function field(instruction: string, result: string): string {
  return `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${escapeXml(instruction)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(result)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
}

/** A note's mark in the text, as Word writes it: its own run, in the reference style. */
export function noteMark(kind: "footnote" | "endnote", id: number): string {
  const style = kind === "footnote" ? "FootnoteReference" : "EndnoteReference";
  return `<w:r><w:rPr><w:rStyle w:val="${style}"/></w:rPr><w:${kind}Reference w:id="${id}"/></w:r>`;
}

/** A note, as Word writes one: each paragraph in the note text style, the first with the note's own number and a space. */
export function note(
  kind: "footnote" | "endnote",
  id: number,
  paragraphs: readonly string[],
): string {
  const style = kind === "footnote" ? "Footnote" : "Endnote";
  const body = paragraphs
    .map(
      (content, index) =>
        `<w:p><w:pPr><w:pStyle w:val="${style}Text"/></w:pPr>${
          index === 0
            ? `<w:r><w:rPr><w:rStyle w:val="${style}Reference"/></w:rPr><w:${kind}Ref/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`
            : ""
        }${content.startsWith("<") ? content : run(content)}</w:p>`,
    )
    .join("");
  return `<w:${kind} w:id="${id}">${body}</w:${kind}>`;
}

/** A tracked insertion or deletion by `author`. */
export function tracked(kind: "ins" | "del", id: number, author: string, text: string): string {
  const inner =
    kind === "ins"
      ? run(text)
      : `<w:r><w:delText xml:space="preserve">${escapeXml(text)}</w:delText></w:r>`;
  return `<w:${kind} w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-10-02T09:00:00Z">${inner}</w:${kind}>`;
}

/** A comment's range over `content`, its mark after it, and its entry for `WordFileInput.comments`. */
export function commented(
  id: number,
  author: string,
  text: string,
  content: string,
): { inline: string; comment: string } {
  return {
    inline: `<w:commentRangeStart w:id="${id}"/>${content}<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`,
    comment: `<w:comment w:id="${id}" w:author="${escapeXml(author)}" w:date="2026-10-02T09:00:00Z"><w:p><w:r><w:annotationRef/></w:r>${run(text)}</w:p></w:comment>`,
  };
}
