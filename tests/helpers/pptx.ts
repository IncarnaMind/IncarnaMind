/**
 * Small PowerPoint decks built in the tests, for the slide renderer's reader
 * (src/core/documents/formats/pptxDrawing.ts): a theme, one master, its
 * layouts and slides, each given as the XML inside its shape tree. Written
 * with the test zip helper; nothing here is a real Office library.
 */
import { buildZip, type ZipInput } from "./zip";

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

/** A theme with Office's colours (accent 1 #4472C4), Calibri, and its format scheme's styles. */
export function themeXml(colours: Record<string, string> = {}): string {
  const palette: Record<string, string> = {
    dk1: "000000",
    lt1: "FFFFFF",
    dk2: "44546A",
    lt2: "E7E6E6",
    accent1: "4472C4",
    accent2: "ED7D31",
    accent3: "A5A5A5",
    accent4: "FFC000",
    accent5: "5B9BD5",
    accent6: "70AD47",
    hlink: "0563C1",
    folHlink: "954F72",
    ...colours,
  };
  const scheme = Object.entries(palette)
    .map(([name, hex]) => `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`)
    .join("");
  return `${HEAD}<a:theme ${NS} name="Test"><a:themeElements><a:clrScheme name="Test">${scheme}</a:clrScheme><a:fontScheme name="Test"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Test"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst/><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

/** A shape tree around these shapes. */
const tree = (shapes: string) =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree>`;

/** An EMU box as an a:xfrm. */
export const xfrm = (x: number, y: number, cx: number, cy: number, attrs = "") =>
  `<a:xfrm${attrs ? ` ${attrs}` : ""}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;

/** A shape (p:sp): its placeholder, properties and text body, as XML. */
export function sp({
  id = 2,
  name = "Shape",
  ph,
  spPr = "",
  style = "",
  body,
  hidden = false,
  txBox = false,
}: {
  id?: number;
  name?: string;
  ph?: string;
  spPr?: string;
  style?: string;
  body?: string;
  hidden?: boolean;
  txBox?: boolean;
}): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"${hidden ? ` hidden="1"` : ""}/><p:cNvSpPr${txBox ? ` txBox="1"` : ""}/><p:nvPr>${ph ?? ""}</p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr>${style}${body === undefined ? "" : `<p:txBody>${body}</p:txBody>`}</p:sp>`;
}

/** A text body's XML: its body properties, list style and paragraphs. */
export const txBody = (paragraphs: string, bodyPr = "<a:bodyPr/>", lstStyle = "<a:lstStyle/>") =>
  `${bodyPr}${lstStyle}${paragraphs}`;

/** A paragraph of plain runs. */
export const para = (runs: string[] | string, pPr = "") =>
  `<a:p>${pPr}${(Array.isArray(runs) ? runs : [runs]).map((run) => (run.startsWith("<") ? run : `<a:r><a:rPr lang="en-GB"/><a:t>${run}</a:t></a:r>`)).join("")}</a:p>`;

export interface SlideInput {
  /** The shapes in its tree. */
  shapes: string;
  /** Its p:bg, if any. */
  background?: string;
  /** Attributes of p:sld, e.g. `showMasterSp="0"`. */
  attrs?: string;
  /** Its colour map override, e.g. `<a:overrideClrMapping bg1="dk1" …/>`. */
  colourMap?: string;
  /** More relationships, as XML, and the parts they name. */
  rels?: string;
  /** The raw XML of the slide, instead of building one (a broken slide). */
  raw?: string;
}

export interface DeckInput {
  /** The slide size in EMUs; 16:9 at 10 inches by default. */
  size?: [number, number];
  theme?: string;
  master?: {
    clrMap?: string;
    txStyles?: string;
    shapes?: string;
    background?: string;
  };
  layout?: {
    shapes?: string;
    background?: string;
    attrs?: string;
  };
  slides: SlideInput[];
  /** More parts: media, charts, table styles. */
  parts?: ZipInput[];
  /** p:defaultTextStyle's contents. */
  defaultTextStyle?: string;
}

const DEFAULT_CLR_MAP = `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"`;

/** A .pptx of these slides, all on one layout of one master. */
export function pptxOf(deck: DeckInput): Buffer {
  const [cx, cy] = deck.size ?? [9144000, 5143500];
  const slides = deck.slides;
  const entries: ZipInput[] = [
    {
      name: "[Content_Types].xml",
      data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    },
    {
      name: "ppt/presentation.xml",
      data: `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 10}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="${cy}" cy="${cx}"/><p:defaultTextStyle>${deck.defaultTextStyle ?? `<a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`}</p:defaultTextStyle></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL}/tableStyles" Target="tableStyles.xml"/>${slides.map((_, index) => `<Relationship Id="rId${index + 10}" Type="${REL}/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}</Relationships>`,
    },
    { name: "ppt/theme/theme1.xml", data: deck.theme ?? themeXml() },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      data: `${HEAD}<p:sldMaster ${NS}><p:cSld>${deck.master?.background ?? `<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>`}${tree(deck.master?.shapes ?? "")}</p:cSld><p:clrMap ${deck.master?.clrMap ?? DEFAULT_CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles>${deck.master?.txStyles ?? ""}</p:txStyles></p:sldMaster>`,
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      data: `${HEAD}<p:sldLayout ${NS}${deck.layout?.attrs ? ` ${deck.layout.attrs}` : ""}><p:cSld>${deck.layout?.background ?? ""}${tree(deck.layout?.shapes ?? "")}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    },
    ...slides.flatMap((slide, index) => [
      {
        name: `ppt/slides/slide${index + 1}.xml`,
        data:
          slide.raw ??
          `${HEAD}<p:sld ${NS}${slide.attrs ? ` ${slide.attrs}` : ""}><p:cSld>${slide.background ?? ""}${tree(slide.shapes)}</p:cSld><p:clrMapOvr>${slide.colourMap ?? "<a:masterClrMapping/>"}</p:clrMapOvr></p:sld>`,
      },
      {
        name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rLayout" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${slide.rels ?? ""}</Relationships>`,
      },
    ]),
    ...(deck.parts ?? []),
  ];
  return buildZip(entries);
}

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A slide in words: its title, the lines of its text box, a table as rows of cells, its speaker notes. */
export interface PlainSlide {
  title?: string;
  lines?: readonly string[];
  table?: readonly (readonly string[])[];
  notes?: readonly string[];
}

/** A deck of plain slides, as someone sends one for review: titles, bullets, a table, speaker notes. */
export function plainDeck(slides: readonly PlainSlide[]): Buffer {
  const paragraphs = (lines: readonly string[]) =>
    lines.map((line) => para(escaped(line))).join("");
  const cell = (text: string) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(escaped(text))}</a:txBody><a:tcPr/></a:tc>`;
  const frame = (rows: readonly (readonly string[])[]) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="2400000"/><a:ext cx="8000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${'<a:gridCol w="2000000"/>'.repeat(rows[0]?.length ?? 1)}</a:tblGrid>${rows
      .map((row) => `<a:tr h="360000">${row.map(cell).join("")}</a:tr>`)
      .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const parts: ZipInput[] = [];
  return pptxOf({
    slides: slides.map((slide, index) => {
      const shapes = [
        slide.title === undefined
          ? ""
          : sp({
              id: 2,
              name: "Title",
              ph: `<p:ph type="title"/>`,
              spPr: xfrm(457200, 300000, 8000000, 700000),
              body: txBody(paragraphs([slide.title])),
            }),
        slide.lines?.length
          ? sp({
              id: 3,
              name: "Content",
              ph: `<p:ph type="body" idx="1"/>`,
              spPr: xfrm(457200, 1100000, 8000000, 1200000),
              body: txBody(paragraphs(slide.lines)),
            })
          : "",
        slide.table?.length ? frame(slide.table) : "",
      ].join("");
      if (!slide.notes?.length) return { shapes };
      const number = index + 1;
      parts.push({
        name: `ppt/notesSlides/notesSlide${number}.xml`,
        data: `${HEAD}<p:notes ${NS}><p:cSld>${tree(
          sp({
            id: 2,
            name: "Notes",
            ph: `<p:ph type="body" idx="1"/>`,
            body: txBody(paragraphs(slide.notes)),
          }),
        )}</p:cSld></p:notes>`,
      });
      return {
        shapes,
        rels: rel("rNotes", "notesSlide", `../notesSlides/notesSlide${number}.xml`),
      };
    }),
    parts,
  });
}

/** A relationship, for `SlideInput.rels`. */
export const rel = (id: string, type: string, target: string, external = false) =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ` TargetMode="External"` : ""}/>`;
