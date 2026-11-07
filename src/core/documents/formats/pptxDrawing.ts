/**
 * A PowerPoint deck (.pptx) as drawings, for the viewer's slide renderer
 * (ADR-0011): each slide's background and items (shapes, text, pictures,
 * groups, tables and charts) with every inherited value resolved, so the
 * renderer only places them. Read with the same ZIP and XML reader as the
 * Units, with no dependency.
 *
 * What it resolves, as PowerPoint does:
 * - the slide's layout and master: their background, and their shapes that
 *   aren't placeholders, drawn behind the slide's own unless hidden;
 * - placeholders: position, size, fill, line, body properties and list
 *   styles from the matching layout and master placeholders;
 * - text styles, lowest first: the presentation's default text style, the
 *   master's title, body or other style, the master's and the layout's
 *   placeholder list styles, the shape's font reference, its own list style,
 *   the paragraph and the run;
 * - colours through the theme and the colour map (a dark master maps bg1 to
 *   dk1), with their transforms; style references (fillRef, lnRef, fontRef);
 * - tables with their table style (from tableStyles.xml, or PowerPoint's
 *   default "Medium Style 2 – Accent 1", which files leave out), merged cells
 *   and borders;
 * - charts from their cached values (see ./pptxChart), SmartArt from the
 *   drawing PowerPoint saves beside it, and an embedded object's picture.
 *
 * Lengths are CSS pixels at 96 dpi; colours are CSS. A slide that can't be
 * read comes back as failed, on its own, and the viewer shows its outline.
 */
import {
  type ColourContext,
  type ColourMap,
  colourElement,
  containerColour,
  css,
  DEFAULT_COLOUR_MAP,
  emu,
  type Fill,
  fillElement,
  type Line,
  numberAttr,
  PX_PER_PT,
  readColourMap,
  readFill,
  readLine,
  readShadow,
  readTheme,
  resolveColour,
  type Shadow,
  type Theme,
} from "./drawingml";
import { ExtractionError } from "./errors";
import {
  mainRootOf,
  OfficePackage,
  partOfType,
  type Relationship,
  type Relationships,
  relationshipOfType,
} from "./officePackage";
import { type ChartData, chartLines, readChart } from "./pptxChart";
import { child, descendants, elements, local, parseXml, textOf, type XmlElement } from "./xml";
import { openPackage, type ZipArchive } from "./zip";

export type { Fill, Line, Shadow } from "./drawingml";
export type { ChartData, ChartSeries } from "./pptxChart";

/** Where an item is, in its parent's space: the slide's, or its group's. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
}

export type PathCommand =
  | { op: "M" | "L"; x: number; y: number }
  | { op: "C"; points: [number, number, number, number, number, number] }
  | { op: "Q"; points: [number, number, number, number] }
  | { op: "A"; wR: number; hR: number; start: number; swing: number }
  | { op: "Z" };

/** One path of a custom geometry, in its own w × h space. */
export interface CustomPath {
  w: number;
  h: number;
  fill: boolean;
  stroke: boolean;
  commands: PathCommand[];
}

export type Geometry =
  | { kind: "preset"; name: string; adjust: Record<string, number> }
  | { kind: "custom"; paths: CustomPath[] };

export type Spacing = { percent: number } | { px: number };

export interface Run {
  text: string;
  /** A line break (a:br) rather than text. */
  lineBreak: boolean;
  /** CSS pixels. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** DrawingML's underline style ("sng", "dbl"…), or null. */
  underline: string | null;
  strike: "single" | "double" | null;
  colour: string;
  fontFamily: string;
  /** Raised (positive) or lowered, as a fraction of the size. */
  baseline: number;
  caps: "all" | "small" | null;
  /** Letter spacing, CSS pixels. */
  spacing: number;
  highlight: string | null;
}

export interface Bullet {
  text: string;
  fontFamily: string;
  colour: string;
  size: number;
}

export interface Paragraph {
  align: "left" | "center" | "right" | "justify";
  level: number;
  marginLeft: number;
  indent: number;
  spaceBefore: Spacing | null;
  spaceAfter: Spacing | null;
  lineSpacing: Spacing | null;
  bullet: Bullet | null;
  runs: Run[];
  /** The size of an empty paragraph's line, CSS pixels. */
  endSize: number;
  rtl: boolean;
}

export interface TextBody {
  insets: { left: number; top: number; right: number; bottom: number };
  anchor: "top" | "middle" | "bottom";
  wrap: boolean;
  vertical: "horizontal" | "vertical" | "vertical270";
  paragraphs: Paragraph[];
}

/** Whose item it is: the slide's own, or its layout's or master's (behind the slide's). */
export type Origin = "slide" | "layout" | "master";

interface ItemBase {
  box: Box;
  origin: Origin;
}

export interface ShapeItem extends ItemBase {
  kind: "shape";
  geometry: Geometry;
  fill: Fill;
  line: Line | null;
  text: TextBody | null;
  /** Where the text goes, if not the shape's box (SmartArt's txXfrm), in the same space. */
  textBox: { x: number; y: number; w: number; h: number } | null;
  /** The slide's title placeholder. */
  title: boolean;
  /** An outer shadow, from its effects or its style's. */
  shadow: Shadow | null;
}

export interface PictureItem extends ItemBase {
  kind: "picture";
  /** The image's part in the package; null when it is linked from outside, which is never fetched. */
  part: string | null;
  /** Cropped away on each side, as fractions of the image. */
  crop: { left: number; top: number; right: number; bottom: number };
  geometry: Geometry;
  line: Line | null;
  alt: string;
  shadow: Shadow | null;
}

export interface GroupItem extends ItemBase {
  kind: "group";
  /** Placed in the group's box, from its top-left corner. */
  children: Item[];
}

export interface TableCell {
  text: TextBody;
  fill: Fill;
  borders: { left: Line | null; right: Line | null; top: Line | null; bottom: Line | null };
  columnSpan: number;
  rowSpan: number;
  /** Covered by a merged cell to its left or above: not drawn. */
  merged: boolean;
}

export interface TableItem extends ItemBase {
  kind: "table";
  columns: number[];
  rows: { height: number; cells: TableCell[] }[];
}

export interface ChartItem extends ItemBase {
  kind: "chart";
  /** Null for a chart the renderer doesn't draw: `lines` labels its box instead. */
  chart: ChartData | null;
  lines: string[];
}

export type Item = ShapeItem | PictureItem | GroupItem | TableItem | ChartItem;

export interface SlideDrawing {
  number: number;
  background: Fill;
  items: Item[];
}

export interface FailedSlide {
  number: number;
  failed: string;
}

export interface DeckDrawing {
  /** The slide size, CSS pixels. */
  width: number;
  height: number;
  slides: (SlideDrawing | FailedSlide)[];
  /** Relationships parts that couldn't be read; the deck was drawn without what they name. */
  unreadable: string[];
}

/* ------------------------------------------------------------------ */
/* Text styles                                                         */

interface RunStyle {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  strike?: string;
  fill?: XmlElement;
  latin?: string;
  ea?: string;
  baseline?: number;
  caps?: string;
  spacing?: number;
  highlight?: XmlElement;
  link?: boolean;
}

interface LevelStyle {
  marL?: number;
  indent?: number;
  align?: string;
  rtl?: boolean;
  lineSpacing?: Spacing;
  spaceBefore?: Spacing;
  spaceAfter?: Spacing;
  bullet?:
    | { kind: "none" }
    | { kind: "char"; char: string }
    | { kind: "number"; scheme: string; startAt: number };
  bulletFont?: string | null;
  bulletColour?: XmlElement | null;
  bulletSize?: { percent: number } | { points: number } | null;
  run: RunStyle;
}

/** A list style's nine levels. */
type ListStyle = LevelStyle[];

const defined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined)) as Partial<T>;

function mergeLevels(base: LevelStyle, over: LevelStyle | undefined): LevelStyle {
  if (!over) return base;
  return {
    ...base,
    ...defined({ ...over, run: undefined }),
    run: { ...base.run, ...defined(over.run) },
  };
}

function spacing(element: XmlElement | undefined): Spacing | undefined {
  if (!element) return undefined;
  const pct = child(element, "a:spcPct");
  if (pct) return { percent: numberAttr(pct, "val", 100000) / 100000 };
  const pts = child(element, "a:spcPts");
  if (pts) return { px: (numberAttr(pts, "val", 0) / 100) * PX_PER_PT };
  return undefined;
}

function readRunStyle(rPr: XmlElement | undefined): RunStyle {
  if (!rPr) return {};
  const attr = (name: string) => rPr.attrs[name];
  const flag = (name: string) => {
    const value = attr(name);
    return value === undefined ? undefined : value === "1" || value === "true";
  };
  const fill = elements(rPr).find((each) =>
    ["solidFill", "gradFill", "noFill", "pattFill"].includes(local(each.name)),
  );
  return defined({
    size: attr("sz") !== undefined ? Number(attr("sz")) : undefined,
    bold: flag("b"),
    italic: flag("i"),
    underline: attr("u"),
    strike: attr("strike"),
    fill,
    latin: child(rPr, "a:latin")?.attrs.typeface,
    ea: child(rPr, "a:ea")?.attrs.typeface,
    baseline: attr("baseline") !== undefined ? Number(attr("baseline")) / 100000 : undefined,
    caps: attr("cap"),
    spacing: attr("spc") !== undefined ? (Number(attr("spc")) / 100) * PX_PER_PT : undefined,
    highlight: child(rPr, "a:highlight"),
    link: child(rPr, "a:hlinkClick") ? true : undefined,
  }) as RunStyle;
}

function readLevelStyle(pPr: XmlElement | undefined): LevelStyle {
  if (!pPr) return { run: {} };
  const style: LevelStyle = {
    ...defined({
      marL: pPr.attrs.marL !== undefined ? emu(pPr.attrs.marL) : undefined,
      indent: pPr.attrs.indent !== undefined ? emu(pPr.attrs.indent) : undefined,
      align: pPr.attrs.algn,
      rtl: pPr.attrs.rtl !== undefined ? pPr.attrs.rtl === "1" : undefined,
      lineSpacing: spacing(child(pPr, "a:lnSpc")),
      spaceBefore: spacing(child(pPr, "a:spcBef")),
      spaceAfter: spacing(child(pPr, "a:spcAft")),
    }),
    run: readRunStyle(child(pPr, "a:defRPr")),
  };
  for (const each of elements(pPr)) {
    switch (local(each.name)) {
      case "buNone":
        style.bullet = { kind: "none" };
        break;
      case "buChar":
        style.bullet = { kind: "char", char: each.attrs.char ?? "•" };
        break;
      case "buAutoNum":
        style.bullet = {
          kind: "number",
          scheme: each.attrs.type ?? "arabicPeriod",
          startAt: numberAttr(each, "startAt", 1),
        };
        break;
      case "buFontTx":
        style.bulletFont = null;
        break;
      case "buFont":
        style.bulletFont = each.attrs.typeface ?? null;
        break;
      case "buClrTx":
        style.bulletColour = null;
        break;
      case "buClr":
        style.bulletColour = each;
        break;
      case "buSzTx":
        style.bulletSize = null;
        break;
      case "buSzPct":
        style.bulletSize = { percent: numberAttr(each, "val", 100000) / 100000 };
        break;
      case "buSzPts":
        style.bulletSize = { points: numberAttr(each, "val", 1800) / 100 };
        break;
    }
  }
  return style;
}

/** A list style element's nine levels (a:lstStyle, p:titleStyle…), each over its a:defPPr. */
function readListStyle(element: XmlElement | undefined): ListStyle {
  const base = readLevelStyle(element && child(element, "a:defPPr"));
  return Array.from({ length: 9 }, (_, level) =>
    mergeLevels(base, readLevelStyle(element && child(element, `a:lvl${level + 1}pPr`))),
  );
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */

const SERIF =
  /(times|georgia|garamond|cambria|caladea|palatino|book antiqua|baskerville|bodoni|didot|century|constantia|serif|minion|songti|simsun|宋|mincho|明朝|batang|nsimsun|fangsong|仿宋|kaiti|楷)/i;
const SANS_STACK =
  "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
const SERIF_STACK =
  "'Times New Roman', Times, Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', serif";
/** Free fonts with the same metrics as Office's, so lines break where PowerPoint breaks them. */
const ALIASES: Record<string, string> = {
  calibri: "Carlito",
  "calibri light": "Carlito",
};

const quoteFont = (name: string) => `'${name.replaceAll("\\", "").replaceAll("'", "")}'`;

/** A run's CSS font family, from its Latin and East Asian typefaces. */
export function fontFamily(latin: string | undefined, ea: string | undefined): string {
  const names: string[] = [];
  for (const name of [latin, ea]) {
    if (!name) continue;
    names.push(quoteFont(name));
    const alias = ALIASES[name.toLowerCase()];
    if (alias) names.push(quoteFont(alias));
  }
  const serif = latin ? SERIF.test(latin) : ea ? SERIF.test(ea) : false;
  return [...new Set(names), serif ? SERIF_STACK : SANS_STACK].join(", ");
}

function themeFont(name: string | undefined, theme: Theme): string | undefined {
  if (!name) return undefined;
  if (!name.startsWith("+")) return name;
  const set = name.startsWith("+mj") ? theme.major : theme.minor;
  const resolved = name.endsWith("-ea") ? set.ea : name.endsWith("-cs") ? set.cs : set.latin;
  return resolved || undefined;
}

/** Bullet characters set in symbol fonts, as the Unicode characters they show. */
const SYMBOL_BULLETS: Record<string, string> = {
  "§": "▪",
  Ø: "➢",
  ü: "✓",
  q: "❑",
  v: "❖",
  n: "■",
  l: "●",
  o: "□",
  w: "⬥",
  Ÿ: "•",
  è: "➔",
  à: "➔",
  Ü: "➢",
  ð: "➨",
  "·": "•",
};

function bulletChar(char: string, font: string | null | undefined): string {
  const code = char.codePointAt(0) ?? 0;
  // Symbol fonts' private-use range (U+F020–U+F0FF) mirrors their 8-bit codes.
  const plain = code >= 0xf020 && code <= 0xf0ff ? String.fromCharCode(code - 0xf000) : char;
  if (font && /wingdings|symbol|webdings/i.test(font)) return SYMBOL_BULLETS[plain] ?? "•";
  return plain === "·" && font && /symbol/i.test(font) ? "•" : plain;
}

const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

function roman(n: number): string {
  let rest = n;
  let out = "";
  for (const [value, letters] of ROMAN) {
    while (rest >= value) {
      out += letters;
      rest -= value;
    }
  }
  return out;
}

const alpha = (n: number): string => {
  let out = "";
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    out = String.fromCharCode(97 + ((rest - 1) % 26)) + out;
  }
  return out;
};

/** An automatic number in a scheme ("arabicPeriod" → "3.", "romanUcParenR" → "III)"). */
export function autoNumber(scheme: string, n: number): string {
  const body = scheme.startsWith("alphaLc")
    ? alpha(n)
    : scheme.startsWith("alphaUc")
      ? alpha(n).toUpperCase()
      : scheme.startsWith("romanLc")
        ? roman(n)
        : scheme.startsWith("romanUc")
          ? roman(n).toUpperCase()
          : String(n);
  if (scheme.endsWith("ParenBoth")) return `(${body})`;
  if (scheme.endsWith("ParenR")) return `${body})`;
  if (scheme.endsWith("Plain")) return body;
  if (scheme.endsWith("Minus")) return `- ${body} -`;
  return `${body}.`;
}

/* ------------------------------------------------------------------ */
/* Masters, layouts and placeholders                                   */

interface Placeholder {
  type: string;
  idx: string | undefined;
  shape: XmlElement;
}

/** A shape's placeholder type and index; undefined when it isn't a placeholder. */
function placeholderOf(shape: XmlElement): { type: string; idx: string | undefined } | undefined {
  const nv = elements(shape).find((each) => local(each.name).startsWith("nv"));
  const nvPr = nv && child(nv, "nvPr");
  const ph = nvPr && child(nvPr, "ph");
  if (!ph) return undefined;
  return { type: ph.attrs.type ?? "obj", idx: ph.attrs.idx };
}

/** A placeholder type, as masters have them: title, body, dt, ftr, sldNum… */
function normalType(type: string): string {
  if (type === "ctrTitle" || type === "title") return "title";
  if (
    ["body", "subTitle", "obj", "chart", "tbl", "clipArt", "dgm", "media", "pic"].includes(type)
  ) {
    return "body";
  }
  return type;
}

function findPlaceholder(
  list: readonly Placeholder[],
  wanted: { type: string; idx: string | undefined },
  byIndex: boolean,
): Placeholder | undefined {
  if (byIndex && wanted.idx !== undefined) {
    const found = list.find((each) => each.idx === wanted.idx);
    if (found) return found;
  }
  return (
    list.find((each) => each.type === wanted.type) ??
    list.find((each) => normalType(each.type) === normalType(wanted.type))
  );
}

function placeholdersIn(tree: XmlElement | undefined): Placeholder[] {
  const found: Placeholder[] = [];
  for (const shape of tree ? elements(tree) : []) {
    const ph = placeholderOf(shape);
    if (ph) found.push({ ...ph, shape });
  }
  return found;
}

interface Master {
  part: string;
  rels: Relationships;
  tree: XmlElement | undefined;
  background: XmlElement | undefined;
  colourMap: ColourMap;
  theme: Theme;
  styles: { title: ListStyle; body: ListStyle; other: ListStyle };
  placeholders: Placeholder[];
}

interface Layout {
  part: string;
  rels: Relationships;
  tree: XmlElement | undefined;
  background: XmlElement | undefined;
  colourOverride: XmlElement | undefined;
  showMasterShapes: boolean;
  placeholders: Placeholder[];
  master: Master;
}

const spTreeOf = (root: XmlElement | undefined) => {
  const cSld = root && child(root, "p:cSld");
  return cSld && child(cSld, "p:spTree");
};
const backgroundOf = (root: XmlElement | undefined) => {
  const cSld = root && child(root, "p:cSld");
  return cSld && child(cSld, "p:bg");
};
const colourOverrideOf = (root: XmlElement | undefined) => {
  const ovr = root && child(root, "p:clrMapOvr");
  return ovr && child(ovr, "a:overrideClrMapping");
};

/* ------------------------------------------------------------------ */
/* Table styles                                                        */

/** PowerPoint's default table style, which it doesn't write into files that use it. */
const MEDIUM_STYLE_2_ACCENT_1 = `<a:tblStyleLst xmlns:a="a"><a:tblStyle styleId="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}" styleName="Medium Style 2 - Accent 1"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:left><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:left><a:right><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:right><a:top><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:top><a:bottom><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:bottom><a:insideH><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideV></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="20000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1H><a:band2H><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2H><a:band1V><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="40000"/></a:schemeClr></a:solidFill></a:fill></a:tcStyle></a:band1V><a:band2V><a:tcStyle><a:tcBdr/></a:tcStyle></a:band2V><a:lastCol><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastCol><a:firstCol><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstCol><a:lastRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:top><a:ln w="38100"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:top></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:lastRow><a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr><a:bottom><a:ln w="38100"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:bottom></a:tcBdr><a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:firstRow></a:tblStyle></a:tblStyleLst>`;

function tableStylesFrom(xml: string | undefined, into: Map<string, XmlElement>): void {
  if (!xml) return;
  for (const style of descendants(parseXml(xml), "a:tblStyle")) {
    const id = style.attrs.styleId;
    if (id) into.set(id, style);
  }
}

/* ------------------------------------------------------------------ */
/* The deck                                                            */

interface Deck {
  pkg: OfficePackage;
  zip: ZipArchive;
  defaultStyle: ListStyle;
  tableStyles: Map<string, XmlElement>;
  masters: Map<string, Promise<Master>>;
  layouts: Map<string, Promise<Layout>>;
}

/** What reading a part's shapes needs. */
interface Scope {
  deck: Deck;
  colours: ColourContext;
  part: string;
  rels: Relationships;
  layout: Layout | undefined;
  master: Master;
  origin: Origin;
  slideNumber: number;
  /** The fill a shape set to `grpFill` takes: its group's. */
  groupFill: Fill | undefined;
}

async function readMaster(deck: Deck, part: string): Promise<Master> {
  const xml = await deck.zip.readText(part);
  const root = xml ? parseXml(xml) : undefined;
  const rels = await deck.pkg.internalRelationships(part);
  const themeRel = relationshipOfType(rels, "/theme");
  const theme = readTheme(themeRel ? await deck.zip.readText(themeRel.target) : undefined);
  const txStyles = root && child(root, "p:txStyles");
  const tree = spTreeOf(root);
  return {
    part,
    rels,
    tree,
    background: backgroundOf(root),
    colourMap: readColourMap(root && child(root, "p:clrMap"), DEFAULT_COLOUR_MAP),
    theme,
    styles: {
      title: readListStyle(txStyles && child(txStyles, "p:titleStyle")),
      body: readListStyle(txStyles && child(txStyles, "p:bodyStyle")),
      other: readListStyle(txStyles && child(txStyles, "p:otherStyle")),
    },
    placeholders: placeholdersIn(tree),
  };
}

async function readLayout(deck: Deck, part: string): Promise<Layout> {
  const xml = await deck.zip.readText(part);
  const root = xml ? parseXml(xml) : undefined;
  const rels = await deck.pkg.internalRelationships(part);
  const masterRel = relationshipOfType(rels, "/slideMaster");
  if (!masterRel) throw new ExtractionError("unreadable", `The layout ${part} has no master.`);
  let master = deck.masters.get(masterRel.target);
  if (!master) {
    master = readMaster(deck, masterRel.target);
    deck.masters.set(masterRel.target, master);
  }
  const tree = spTreeOf(root);
  return {
    part,
    rels,
    tree,
    background: backgroundOf(root),
    colourOverride: colourOverrideOf(root),
    showMasterShapes: root?.attrs.showMasterSp !== "0",
    placeholders: placeholdersIn(tree),
    master: await master,
  };
}

/** The deck as drawings. Throws `ExtractionError` when it isn't a PowerPoint file at all. */
export async function drawPptx(bytes: Uint8Array): Promise<DeckDrawing> {
  const zip = openPackage(bytes);
  const pkg = new OfficePackage(zip);
  const presentationPart = await pkg.mainPart("ppt/presentation.xml");
  const presentation = mainRootOf(
    await zip.readText(presentationPart),
    presentationPart,
    "presentation",
    "Not a PowerPoint file",
  );
  const size = child(presentation, "p:sldSz");
  const presentationRels = await pkg.internalRelationships(presentationPart);
  const tableStyles = new Map<string, XmlElement>();
  tableStylesFrom(MEDIUM_STYLE_2_ACCENT_1, tableStyles);
  tableStylesFrom(
    await zip.readText(partOfType(presentationRels, "/tableStyles", "ppt/tableStyles.xml")),
    tableStyles,
  );
  const deck: Deck = {
    pkg,
    zip,
    defaultStyle: readListStyle(child(presentation, "p:defaultTextStyle")),
    tableStyles,
    masters: new Map(),
    layouts: new Map(),
  };
  const list = child(presentation, "p:sldIdLst");
  const slideParts = (list ? elements(list) : [])
    .map((id) => presentationRels.get(id.attrs["r:id"] ?? ""))
    .filter((rel): rel is Relationship => rel?.type.endsWith("/slide") ?? false)
    .map((rel) => rel.target);

  const slides: (SlideDrawing | FailedSlide)[] = [];
  for (const [index, part] of slideParts.entries()) {
    const number = index + 1;
    try {
      slides.push(await drawSlide(deck, part, number));
    } catch (error) {
      slides.push({ number, failed: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    width: emu(size?.attrs.cx, 960),
    height: emu(size?.attrs.cy, 540),
    slides,
    unreadable: pkg.unreadable,
  };
}

async function drawSlide(deck: Deck, part: string, number: number): Promise<SlideDrawing> {
  const xml = await deck.zip.readText(part);
  if (!xml) throw new ExtractionError("unreadable", `The slide ${part} is missing.`);
  const root = parseXml(xml);
  const rels = await deck.pkg.internalRelationships(part);
  const layoutRel = relationshipOfType(rels, "/slideLayout");
  let layout: Layout | undefined;
  if (layoutRel) {
    let pending = deck.layouts.get(layoutRel.target);
    if (!pending) {
      pending = readLayout(deck, layoutRel.target);
      deck.layouts.set(layoutRel.target, pending);
    }
    layout = await pending;
  }
  const master =
    layout?.master ??
    (await readMaster(deck, [...deck.masters.keys()][0] ?? "ppt/slideMasters/slideMaster1.xml"));
  let map = master.colourMap;
  map = readColourMap(layout?.colourOverride, map);
  map = readColourMap(colourOverrideOf(root), map);
  const colours: ColourContext = { theme: master.theme, map };

  const scope = (origin: Origin, partName: string, partRels: Relationships): Scope => ({
    deck,
    colours,
    part: partName,
    rels: partRels,
    layout,
    master,
    origin,
    slideNumber: number,
    groupFill: undefined,
  });

  // The background: the slide's own, else its layout's, else its master's.
  const background = readBackground(backgroundOf(root), scope("slide", part, rels)) ??
    (layout && readBackground(layout.background, scope("layout", layout.part, layout.rels))) ??
    readBackground(master.background, scope("master", master.part, master.rels)) ?? {
      kind: "solid" as const,
      colour: css(
        resolveColour({ name: "a:schemeClr", attrs: { val: "bg1" }, children: [] }, colours) ?? {
          r: 255,
          g: 255,
          b: 255,
          a: 1,
        },
      ),
    };

  const showMaster = root.attrs.showMasterSp !== "0";
  const items: Item[] = [];
  if (showMaster && (layout?.showMasterShapes ?? true)) {
    items.push(...(await readTree(master.tree, scope("master", master.part, master.rels))));
  }
  if (showMaster && layout) {
    items.push(...(await readTree(layout.tree, scope("layout", layout.part, layout.rels))));
  }
  items.push(...(await readTree(spTreeOf(root), scope("slide", part, rels))));
  return { number, background, items };
}

function readBackground(bg: XmlElement | undefined, scope: Scope): Fill | undefined {
  if (!bg) return undefined;
  const bgPr = child(bg, "p:bgPr");
  if (bgPr) return readFill(fillElement(bgPr), scope.colours, imagePart(scope));
  const ref = child(bg, "p:bgRef");
  if (!ref) return undefined;
  const index = numberAttr(ref, "idx", 0);
  const style =
    index >= 1001
      ? scope.colours.theme.backgrounds[index - 1001]
      : scope.colours.theme.fills[index - 1];
  const placeholder = resolveColour(colourElement(ref), scope.colours);
  if (!style) {
    return placeholder ? { kind: "solid", colour: css(placeholder) } : undefined;
  }
  return readFill(style, { ...scope.colours, placeholder });
}

const imagePart = (scope: Scope) => (id: string) => {
  const rel = scope.rels.get(id);
  return rel?.type.endsWith("/image") ? rel.target : undefined;
};

/* ------------------------------------------------------------------ */
/* Shapes                                                              */

function readBox(xfrm: XmlElement | undefined): Box | undefined {
  if (!xfrm) return undefined;
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  if (!off || !ext) return undefined;
  return {
    x: emu(off.attrs.x),
    y: emu(off.attrs.y),
    w: emu(ext.attrs.cx),
    h: emu(ext.attrs.cy),
    rotation: numberAttr(xfrm, "rot", 0) / 60000,
    flipH: xfrm.attrs.flipH === "1",
    flipV: xfrm.attrs.flipV === "1",
  };
}

/** Number literals and the few guide names a custom path uses. */
function pathValue(value: string | undefined, guides: Record<string, number>): number {
  if (value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : (guides[value] ?? 0);
}

function readGeometry(spPr: XmlElement | undefined): Geometry | undefined {
  if (!spPr) return undefined;
  const preset = child(spPr, "a:prstGeom");
  if (preset) {
    const adjust: Record<string, number> = {};
    const list = child(preset, "a:avLst");
    for (const guide of list ? elements(list) : []) {
      const match = /^val\s+(-?\d+)/.exec(guide.attrs.fmla ?? "");
      if (guide.attrs.name && match) adjust[guide.attrs.name] = Number(match[1]);
    }
    return { kind: "preset", name: preset.attrs.prst ?? "rect", adjust };
  }
  const custom = child(spPr, "a:custGeom");
  const pathList = custom && child(custom, "a:pathLst");
  if (!pathList) return undefined;
  const paths: CustomPath[] = [];
  for (const path of elements(pathList)) {
    const w = numberAttr(path, "w", 0);
    const h = numberAttr(path, "h", 0);
    const guides: Record<string, number> = { l: 0, t: 0, r: w, b: h, w, h, hc: w / 2, vc: h / 2 };
    const point = (element: XmlElement | undefined) => [
      pathValue(element?.attrs.x, guides),
      pathValue(element?.attrs.y, guides),
    ];
    const commands: PathCommand[] = [];
    for (const command of elements(path)) {
      const points = elements(command).filter((each) => local(each.name) === "pt");
      switch (local(command.name)) {
        case "moveTo":
        case "lnTo": {
          const [x, y] = point(points[0]);
          commands.push({ op: local(command.name) === "moveTo" ? "M" : "L", x: x ?? 0, y: y ?? 0 });
          break;
        }
        case "cubicBezTo":
          commands.push({
            op: "C",
            points: points.flatMap(point).slice(0, 6) as [
              number,
              number,
              number,
              number,
              number,
              number,
            ],
          });
          break;
        case "quadBezTo":
          commands.push({
            op: "Q",
            points: points.flatMap(point).slice(0, 4) as [number, number, number, number],
          });
          break;
        case "arcTo":
          commands.push({
            op: "A",
            wR: pathValue(command.attrs.wR, guides),
            hR: pathValue(command.attrs.hR, guides),
            start: pathValue(command.attrs.stAng, guides) / 60000,
            swing: pathValue(command.attrs.swAng, guides) / 60000,
          });
          break;
        case "close":
          commands.push({ op: "Z" });
          break;
      }
    }
    paths.push({
      w,
      h,
      fill: path.attrs.fill !== "none",
      stroke: path.attrs.stroke !== "0" && path.attrs.stroke !== "false",
      commands,
    });
  }
  return { kind: "custom", paths };
}

const RECT: Geometry = { kind: "preset", name: "rect", adjust: {} };

/** A style reference's fill (fillRef) or line (lnRef) from the theme, in the reference's colour. */
function styleFill(style: XmlElement | undefined, scope: Scope): Fill | undefined {
  const ref = style && child(style, "a:fillRef");
  if (!ref) return undefined;
  const index = numberAttr(ref, "idx", 0);
  if (index === 0) return { kind: "none" };
  const theme = scope.colours.theme;
  const fill = index >= 1001 ? theme.backgrounds[index - 1001] : theme.fills[index - 1];
  const placeholder = resolveColour(colourElement(ref), scope.colours);
  if (!fill) return placeholder ? { kind: "solid", colour: css(placeholder) } : undefined;
  return readFill(fill, { ...scope.colours, placeholder });
}

function styleLine(style: XmlElement | undefined, scope: Scope): Line | null | undefined {
  const ref = style && child(style, "a:lnRef");
  if (!ref) return undefined;
  const index = numberAttr(ref, "idx", 0);
  if (index === 0) return null;
  const ln = scope.colours.theme.lines[index - 1];
  const placeholder = resolveColour(colourElement(ref), scope.colours);
  if (!ln) {
    return placeholder
      ? { width: 1, colour: css(placeholder), dash: null, head: null, tail: null }
      : undefined;
  }
  return readLine(ln, { ...scope.colours, placeholder });
}

/** A shape's outer shadow: its own effect list's, else its style's effect reference's from the theme. */
function shadowOf(
  spPr: XmlElement | undefined,
  style: XmlElement | undefined,
  scope: Scope,
): Shadow | null {
  const own = spPr && child(spPr, "a:effectLst");
  if (own) return readShadow(own, scope.colours);
  const ref = style && child(style, "a:effectRef");
  const index = numberAttr(ref, "idx", 0);
  if (!ref || index === 0) return null;
  const placeholder = resolveColour(colourElement(ref), scope.colours);
  return readShadow(scope.colours.theme.effects[index - 1], { ...scope.colours, placeholder });
}

/** The fill a properties element gives, with `grpFill` taken from the group. */
function ownFill(spPr: XmlElement | undefined, scope: Scope): Fill | undefined {
  const element = fillElement(spPr);
  if (element && local(element.name) === "grpFill") return scope.groupFill;
  return readFill(element, scope.colours, imagePart(scope));
}

/** A shape's matching layout and master placeholders, for what it inherits. */
function inherited(shape: XmlElement, scope: Scope): { layout?: XmlElement; master?: XmlElement } {
  const ph = placeholderOf(shape);
  if (!ph || scope.origin !== "slide") return {};
  const fromLayout = scope.layout && findPlaceholder(scope.layout.placeholders, ph, true);
  const fromMaster = findPlaceholder(scope.master.placeholders, fromLayout ?? ph, false);
  return { layout: fromLayout?.shape, master: fromMaster?.shape };
}

const spPrOf = (shape: XmlElement | undefined) => shape && child(shape, "spPr");

async function readTree(tree: XmlElement | undefined, scope: Scope): Promise<Item[]> {
  const items: Item[] = [];
  for (const element of tree ? elements(tree) : []) {
    const read = await readElement(element, scope);
    if (read) items.push(...read);
  }
  return items;
}

const isHidden = (element: XmlElement) => {
  const nv = elements(element).find((each) => local(each.name).startsWith("nv"));
  const cNvPr = nv && child(nv, "cNvPr");
  return cNvPr?.attrs.hidden === "1" || cNvPr?.attrs.hidden === "true";
};

async function readElement(element: XmlElement, scope: Scope): Promise<Item[] | undefined> {
  const name = local(element.name);
  if (name === "AlternateContent") {
    // What a reader that knows none of the alternatives sees: the fallback.
    const choice = child(element, "mc:Fallback") ?? child(element, "mc:Choice");
    return choice ? readTree(choice, scope) : undefined;
  }
  if (isHidden(element)) return undefined;
  // A layout's or master's placeholders are prompts, not drawn on its slides.
  if (scope.origin !== "slide" && placeholderOf(element) && name !== "grpSp") return undefined;
  switch (name) {
    case "sp":
    case "cxnSp": {
      const shape = readShape(element, scope);
      return shape ? [shape] : undefined;
    }
    case "pic": {
      const picture = readPicture(element, scope);
      return picture ? [picture] : undefined;
    }
    case "grpSp": {
      const group = await readGroup(element, scope);
      return group ? [group] : undefined;
    }
    case "graphicFrame":
      return readFrame(element, scope);
  }
  return undefined;
}

function readShape(shape: XmlElement, scope: Scope): ShapeItem | undefined {
  const from = inherited(shape, scope);
  const spPr = spPrOf(shape);
  const box =
    readBox(spPr && child(spPr, "a:xfrm")) ??
    readBox(child(spPrOf(from.layout) ?? shape, "a:xfrm")) ??
    readBox(child(spPrOf(from.master) ?? shape, "a:xfrm"));
  if (!box) return undefined;
  const style = child(shape, "style");
  const layoutScope = scope.layout
    ? { ...scope, part: scope.layout.part, rels: scope.layout.rels }
    : scope;
  const masterScope = { ...scope, part: scope.master.part, rels: scope.master.rels };
  const fill = ownFill(spPr, scope) ??
    styleFill(style, scope) ??
    (from.layout &&
      (ownFill(spPrOf(from.layout), layoutScope) ??
        styleFill(child(from.layout, "style"), scope))) ??
    (from.master &&
      (ownFill(spPrOf(from.master), masterScope) ??
        styleFill(child(from.master, "style"), scope))) ?? {
      kind: "none" as const,
    };
  const line =
    readLine(spPr && child(spPr, "a:ln"), scope.colours, styleLine(style, scope)) ??
    (from.layout
      ? readLine(child(spPrOf(from.layout) ?? from.layout, "a:ln"), scope.colours)
      : undefined) ??
    (from.master
      ? readLine(child(spPrOf(from.master) ?? from.master, "a:ln"), scope.colours)
      : undefined) ??
    null;
  const geometry =
    readGeometry(spPr) ??
    readGeometry(spPrOf(from.layout)) ??
    readGeometry(spPrOf(from.master)) ??
    RECT;
  const ph = placeholderOf(shape);
  const txBody = child(shape, "txBody");
  const text = txBody ? readShapeText(shape, txBody, from, scope) : null;
  const txXfrm = child(shape, "txXfrm");
  const textBox = readBox(txXfrm);
  return {
    kind: "shape",
    box,
    origin: scope.origin,
    geometry,
    fill,
    line,
    text,
    textBox: textBox ? { x: textBox.x, y: textBox.y, w: textBox.w, h: textBox.h } : null,
    shadow: shadowOf(spPr, style, scope),
    title: ph !== undefined && normalType(ph.type) === "title" && scope.origin === "slide",
  };
}

/** The master text style a shape's text starts from. */
function masterStyle(shape: XmlElement, scope: Scope): ListStyle {
  const ph = placeholderOf(shape);
  if (!ph) return scope.master.styles.other;
  const type = normalType(ph.type);
  return type === "title"
    ? scope.master.styles.title
    : type === "body"
      ? scope.master.styles.body
      : scope.master.styles.other;
}

function readShapeText(
  shape: XmlElement,
  txBody: XmlElement,
  from: { layout?: XmlElement; master?: XmlElement },
  scope: Scope,
): TextBody {
  const layers: ListStyle[] = [scope.deck.defaultStyle, masterStyle(shape, scope)];
  const bodies: XmlElement[] = [];
  for (const each of [from.master, from.layout]) {
    const body = each && child(each, "txBody");
    if (!body) continue;
    layers.push(readListStyle(child(body, "a:lstStyle")));
    const bodyPr = child(body, "a:bodyPr");
    if (bodyPr) bodies.push(bodyPr);
  }
  // The shape's font reference: its theme font and colour, under its own styles.
  const fontRef = child(child(shape, "style") ?? shape, "a:fontRef");
  if (fontRef) {
    const latin =
      fontRef.attrs.idx === "major"
        ? "+mj-lt"
        : fontRef.attrs.idx === "minor"
          ? "+mn-lt"
          : undefined;
    const colour = colourElement(fontRef);
    const level: LevelStyle = {
      run: defined({
        latin,
        fill: colour ? { name: "a:solidFill", attrs: {}, children: [colour] } : undefined,
      }) as RunStyle,
    };
    layers.push(Array.from({ length: 9 }, () => level));
  }
  layers.push(readListStyle(child(txBody, "a:lstStyle")));
  const own = child(txBody, "a:bodyPr");
  if (own) bodies.push(own);
  return readTextBody(txBody, layers, bodies, scope);
}

/* ------------------------------------------------------------------ */
/* Text                                                                */

function readTextBody(
  txBody: XmlElement,
  layers: readonly ListStyle[],
  bodies: readonly XmlElement[],
  scope: Scope,
  defaults: { insets?: [number, number, number, number]; anchor?: string } = {},
): TextBody {
  // Body properties: each layer's attributes over the last; the autofit of the nearest that has one.
  const attrs: Record<string, string> = {};
  let fontScale = 1;
  let lineReduction = 0;
  for (const bodyPr of bodies) {
    Object.assign(attrs, bodyPr.attrs);
    const normal = child(bodyPr, "a:normAutofit");
    if (normal) {
      fontScale = numberAttr(normal, "fontScale", 100000) / 100000;
      lineReduction = numberAttr(normal, "lnSpcReduction", 0) / 100000;
    } else if (child(bodyPr, "a:spAutoFit") || child(bodyPr, "a:noAutofit")) {
      fontScale = 1;
      lineReduction = 0;
    }
  }
  const [left, top, right, bottom] = defaults.insets ?? [91440, 45720, 91440, 45720];
  const anchor = attrs.anchor ?? defaults.anchor ?? "t";
  const vert = attrs.vert ?? "horz";

  const paragraphs: Paragraph[] = [];
  const counters: (number | undefined)[] = [];
  const schemes: (string | undefined)[] = [];
  for (const p of elements(txBody).filter((each) => each.name === "a:p")) {
    const pPr = child(p, "a:pPr");
    const level = Math.min(8, Math.max(0, numberAttr(pPr, "lvl", 0)));
    let style: LevelStyle = { run: {} };
    for (const layer of layers) style = mergeLevels(style, layer[level]);
    style = mergeLevels(style, readLevelStyle(pPr));

    const runs: Run[] = [];
    for (const piece of elements(p)) {
      const kind = local(piece.name);
      if (kind !== "r" && kind !== "br" && kind !== "fld") continue;
      const own = readRunStyle(child(piece, "a:rPr"));
      const runStyle = { ...style.run, ...own };
      let text =
        kind === "br" ? "\n" : textOf(child(piece, "a:t") ?? { name: "", attrs: {}, children: [] });
      if (kind === "fld" && piece.attrs.type === "slidenum") text = String(scope.slideNumber);
      runs.push(resolveRun(text, kind === "br", runStyle, own, fontScale, scope));
    }
    const end = resolveRun(
      "",
      false,
      { ...style.run, ...readRunStyle(child(p, "a:endParaRPr")) },
      {},
      fontScale,
      scope,
    );
    const visible = runs.some((run) => !run.lineBreak && run.text.trim() !== "");

    // Automatic numbers count on at their level; a shallower paragraph starts them again.
    let bullet: Bullet | null = null;
    const kind = style.bullet?.kind ?? "none";
    if (kind === "number" && visible && style.bullet?.kind === "number") {
      const scheme = style.bullet.scheme;
      const next =
        counters[level] !== undefined && schemes[level] === scheme
          ? (counters[level] as number) + 1
          : style.bullet.startAt;
      counters[level] = next;
      schemes[level] = scheme;
      bullet = bulletOf(autoNumber(scheme, next), style, runs, end, scope);
    } else if (visible) {
      counters[level] = undefined;
      if (kind === "char" && style.bullet?.kind === "char") {
        bullet = bulletOf(bulletChar(style.bullet.char, style.bulletFont), style, runs, end, scope);
      }
    }
    if (visible) counters.length = level + 1;

    const align =
      style.align === "ctr"
        ? "center"
        : style.align === "r"
          ? "right"
          : style.align === "just" || style.align === "dist"
            ? "justify"
            : "left";
    const lineSpacing = style.lineSpacing
      ? "percent" in style.lineSpacing
        ? { percent: style.lineSpacing.percent * (1 - lineReduction) }
        : style.lineSpacing
      : lineReduction > 0
        ? { percent: 1 - lineReduction }
        : null;
    paragraphs.push({
      align,
      level,
      marginLeft: style.marL ?? 0,
      indent: style.indent ?? 0,
      spaceBefore: style.spaceBefore ?? null,
      spaceAfter: style.spaceAfter ?? null,
      lineSpacing,
      bullet,
      runs,
      endSize: end.size,
      rtl: style.rtl ?? false,
    });
  }
  return {
    insets: {
      left: emu(attrs.lIns, left / 9525),
      top: emu(attrs.tIns, top / 9525),
      right: emu(attrs.rIns, right / 9525),
      bottom: emu(attrs.bIns, bottom / 9525),
    },
    anchor: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top",
    wrap: attrs.wrap !== "none",
    vertical:
      vert === "vert" || vert === "eaVert" || vert === "wordArtVertRtl"
        ? "vertical"
        : vert === "vert270"
          ? "vertical270"
          : "horizontal",
    paragraphs,
  };
}

function runColour(fill: XmlElement | undefined, colours: ColourContext): string | undefined {
  if (!fill) return undefined;
  const read = readFill(fill, colours);
  if (!read) return undefined;
  if (read.kind === "none") return "transparent";
  if (read.kind === "solid") return read.colour;
  if (read.kind === "gradient") return read.stops[0]?.colour;
  return undefined;
}

function resolveRun(
  text: string,
  lineBreak: boolean,
  style: RunStyle,
  own: RunStyle,
  fontScale: number,
  scope: Scope,
): Run {
  const theme = scope.colours.theme;
  const textColour = () =>
    css(
      resolveColour(
        { name: "a:schemeClr", attrs: { val: "tx1" }, children: [] },
        scope.colours,
      ) ?? { r: 0, g: 0, b: 0, a: 1 },
    );
  // A link takes the theme's link colour, unless its run sets its own.
  const linkColour =
    style.link && !own.fill
      ? containerColour(
          {
            name: "a:solidFill",
            attrs: {},
            children: [{ name: "a:schemeClr", attrs: { val: "hlink" }, children: [] }],
          },
          scope.colours,
        )
      : null;
  const strike =
    style.strike === "sngStrike" ? "single" : style.strike === "dblStrike" ? "double" : null;
  const underline =
    style.underline && style.underline !== "none" ? style.underline : style.link ? "sng" : null;
  const highlight = style.highlight ? containerColour(style.highlight, scope.colours) : null;
  return {
    text,
    lineBreak,
    size: ((style.size ?? 1800) / 100) * PX_PER_PT * fontScale,
    bold: style.bold ?? false,
    italic: style.italic ?? false,
    underline,
    strike,
    colour: linkColour ?? runColour(style.fill, scope.colours) ?? textColour(),
    fontFamily: fontFamily(themeFont(style.latin ?? "+mn-lt", theme), themeFont(style.ea, theme)),
    baseline: style.baseline ?? 0,
    caps: style.caps === "all" ? "all" : style.caps === "small" ? "small" : null,
    spacing: style.spacing ?? 0,
    highlight,
  };
}

function bulletOf(text: string, style: LevelStyle, runs: Run[], end: Run, scope: Scope): Bullet {
  const first = runs.find((run) => !run.lineBreak) ?? end;
  const size = style.bulletSize
    ? "percent" in style.bulletSize
      ? first.size * style.bulletSize.percent
      : style.bulletSize.points * PX_PER_PT
    : first.size;
  const colour = style.bulletColour
    ? (containerColour(style.bulletColour, scope.colours) ?? first.colour)
    : first.colour;
  const font =
    style.bulletFont && !/wingdings|symbol|webdings/i.test(style.bulletFont)
      ? fontFamily(themeFont(style.bulletFont, scope.colours.theme), undefined)
      : first.fontFamily;
  return { text, fontFamily: font, colour, size };
}

/* ------------------------------------------------------------------ */
/* Pictures, groups and graphic frames                                 */

function readPicture(pic: XmlElement, scope: Scope, frame?: Box): PictureItem | undefined {
  const from = inherited(pic, scope);
  const spPr = spPrOf(pic);
  const box =
    frame ??
    readBox(spPr && child(spPr, "a:xfrm")) ??
    readBox(child(spPrOf(from.layout) ?? pic, "a:xfrm")) ??
    readBox(child(spPrOf(from.master) ?? pic, "a:xfrm"));
  if (!box) return undefined;
  const blipFill = child(pic, "blipFill");
  const blip = blipFill && child(blipFill, "a:blip");
  const rel = blip?.attrs["r:embed"] ? scope.rels.get(blip.attrs["r:embed"]) : undefined;
  const crop = blipFill && child(blipFill, "a:srcRect");
  const fraction = (name: string) => numberAttr(crop, name, 0) / 100000;
  const nv = elements(pic).find((each) => local(each.name).startsWith("nv"));
  return {
    kind: "picture",
    box,
    origin: scope.origin,
    part: rel?.type.endsWith("/image") ? rel.target : null,
    crop: { left: fraction("l"), top: fraction("t"), right: fraction("r"), bottom: fraction("b") },
    geometry: readGeometry(spPr) ?? RECT,
    line:
      readLine(spPr && child(spPr, "a:ln"), scope.colours, styleLine(child(pic, "style"), scope)) ??
      null,
    alt: (nv && child(nv, "cNvPr")?.attrs.descr) ?? "",
    shadow: shadowOf(spPr, child(pic, "style"), scope),
  };
}

/** A child's box, from its group's child space into the group's own box. */
function intoGroup(
  box: Box,
  offset: { x: number; y: number },
  scale: { x: number; y: number },
): Box {
  return {
    ...box,
    x: (box.x - offset.x) * scale.x,
    y: (box.y - offset.y) * scale.y,
    w: box.w * scale.x,
    h: box.h * scale.y,
  };
}

function placeChildren(
  items: Item[],
  offset: { x: number; y: number },
  scale: { x: number; y: number },
): Item[] {
  return items.map((item) => {
    const placed = { ...item, box: intoGroup(item.box, offset, scale) } as Item;
    if (placed.kind === "shape" && placed.textBox) {
      placed.textBox = {
        x: (placed.textBox.x - offset.x) * scale.x,
        y: (placed.textBox.y - offset.y) * scale.y,
        w: placed.textBox.w * scale.x,
        h: placed.textBox.h * scale.y,
      };
    }
    return placed;
  });
}

async function readGroup(group: XmlElement, scope: Scope): Promise<GroupItem | undefined> {
  const grpSpPr = child(group, "grpSpPr");
  const xfrm = grpSpPr && child(grpSpPr, "a:xfrm");
  const box = readBox(xfrm);
  const groupFill = ownFill(grpSpPr, scope) ?? scope.groupFill;
  const children = await readTree(group, { ...scope, groupFill });
  if (!box) {
    // A group with no transform (some writers): its children are where they say.
    if (children.length === 0) return undefined;
    return {
      kind: "group",
      box: { x: 0, y: 0, w: 0, h: 0, rotation: 0, flipH: false, flipV: false },
      origin: scope.origin,
      children,
    };
  }
  const chOff = xfrm && child(xfrm, "a:chOff");
  const chExt = xfrm && child(xfrm, "a:chExt");
  const childWidth = emu(chExt?.attrs.cx, box.w);
  const childHeight = emu(chExt?.attrs.cy, box.h);
  const offset = { x: emu(chOff?.attrs.x, box.x), y: emu(chOff?.attrs.y, box.y) };
  const scale = {
    x: childWidth > 0 ? box.w / childWidth : 1,
    y: childHeight > 0 ? box.h / childHeight : 1,
  };
  return {
    kind: "group",
    box,
    origin: scope.origin,
    children: placeChildren(children, offset, scale),
  };
}

async function readFrame(frame: XmlElement, scope: Scope): Promise<Item[] | undefined> {
  const box = readBox(child(frame, "xfrm"));
  if (!box) return undefined;
  const graphic = child(frame, "a:graphic");
  const data = graphic && child(graphic, "a:graphicData");
  if (!data) return undefined;
  const table = child(data, "a:tbl");
  if (table) return [readTable(table, box, scope)];
  const chart = descendants(data, "c:chart")[0];
  if (chart) {
    const rel = scope.rels.get(chart.attrs["r:id"] ?? "");
    const xml = rel ? await scope.deck.zip.readText(rel.target) : undefined;
    return [
      {
        kind: "chart",
        box,
        origin: scope.origin,
        chart: xml ? readChart(xml, scope.colours) : null,
        lines: xml ? chartLines(xml) : [],
      },
    ];
  }
  const diagram = descendants(data, "dgm:relIds")[0];
  if (diagram) {
    const drawn = await readDiagram(diagram, box, scope);
    return drawn ? [drawn] : undefined;
  }
  // An embedded object (a worksheet, an equation…): the picture of it the file keeps.
  const picture = descendants(data, "p:pic")[0];
  if (picture) {
    const item = readPicture(picture, scope, box);
    return item ? [item] : undefined;
  }
  return undefined;
}

/** SmartArt, from the drawing PowerPoint saves beside its data: shapes placed in the frame. */
async function readDiagram(
  relIds: XmlElement,
  box: Box,
  scope: Scope,
): Promise<GroupItem | undefined> {
  const dataRel = scope.rels.get(relIds.attrs["r:dm"] ?? "");
  const dataXml = dataRel && (await scope.deck.zip.readText(dataRel.target));
  const ext = dataXml ? descendants(parseXml(dataXml), "dsp:dataModelExt")[0] : undefined;
  const drawingRel =
    (ext?.attrs.relId && scope.rels.get(ext.attrs.relId)) ||
    [...scope.rels.values()].filter((rel) => rel.type.endsWith("/diagramDrawing"))[0];
  if (!drawingRel) return undefined;
  const xml = await scope.deck.zip.readText(drawingRel.target);
  if (!xml) return undefined;
  const tree = descendants(parseXml(xml), "spTree")[0];
  const drawingRels = await scope.deck.pkg.internalRelationships(drawingRel.target);
  const children = await readTree(tree, { ...scope, part: drawingRel.target, rels: drawingRels });
  if (children.length === 0) return undefined;
  return { kind: "group", box, origin: scope.origin, children };
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */

interface CellStylePart {
  fill?: Fill;
  borders: Partial<
    Record<"left" | "right" | "top" | "bottom" | "insideH" | "insideV", Line | null>
  >;
  bold?: boolean;
  italic?: boolean;
  colour?: XmlElement;
}

function readStylePart(part: XmlElement | undefined, scope: Scope): CellStylePart | undefined {
  if (!part) return undefined;
  const result: CellStylePart = { borders: {} };
  const text = child(part, "a:tcTxStyle");
  if (text) {
    if (text.attrs.b) result.bold = text.attrs.b === "on";
    if (text.attrs.i) result.italic = text.attrs.i === "on";
    const colour = colourElement(text);
    if (colour) result.colour = { name: "a:solidFill", attrs: {}, children: [colour] };
  }
  const style = child(part, "a:tcStyle");
  if (style) {
    const fillHolder = child(style, "a:fill");
    const fillRef = child(style, "a:fillRef");
    if (fillHolder) result.fill = readFill(fillElement(fillHolder), scope.colours);
    else if (fillRef)
      result.fill = styleFill({ name: "p:style", attrs: {}, children: [fillRef] }, scope);
    const borders = child(style, "a:tcBdr");
    for (const side of ["left", "right", "top", "bottom", "insideH", "insideV"] as const) {
      const holder = borders && child(borders, `a:${side}`);
      if (!holder) continue;
      const ln = child(holder, "a:ln");
      const lnRef = child(holder, "a:lnRef");
      result.borders[side] = ln
        ? (readLine(ln, scope.colours) ?? null)
        : lnRef
          ? (styleLine({ name: "p:style", attrs: {}, children: [lnRef] }, scope) ?? null)
          : null;
    }
  }
  return result;
}

function readTable(table: XmlElement, box: Box, scope: Scope): TableItem {
  const tblPr = child(table, "a:tblPr");
  const flag = (name: string) => tblPr?.attrs[name] === "1" || tblPr?.attrs[name] === "true";
  const styleId = tblPr && child(tblPr, "a:tableStyleId");
  const style = styleId ? scope.deck.tableStyles.get(textOf(styleId).trim()) : undefined;
  const part = (name: string) => readStylePart(style && child(style, `a:${name}`), scope);
  const parts = {
    whole: part("wholeTbl"),
    band1H: part("band1H"),
    band2H: part("band2H"),
    band1V: part("band1V"),
    band2V: part("band2V"),
    firstRow: part("firstRow"),
    lastRow: part("lastRow"),
    firstCol: part("firstCol"),
    lastCol: part("lastCol"),
  };
  const tableFill = ownFill(tblPr, scope);
  const grid = child(table, "a:tblGrid");
  const columns = (grid ? elements(grid) : []).map((column) => emu(column.attrs.w));
  const rowElements = elements(table).filter((each) => each.name === "a:tr");
  const lastRow = rowElements.length - 1;
  const lastColumn = columns.length - 1;
  const headerRows = flag("firstRow") ? 1 : 0;
  const headerColumns = flag("firstCol") ? 1 : 0;

  const rows = rowElements.map((tr, r) => {
    let column = 0;
    const cells = elements(tr)
      .filter((each) => each.name === "a:tc")
      .map((tc) => {
        const c = column;
        const columnSpan = Math.max(1, numberAttr(tc, "gridSpan", 1));
        column += tc.attrs.hMerge === "1" ? 1 : columnSpan;
        // The style's parts that apply to this cell, lowest first, each over its region of
        // the table: its outer borders are the region's edges, its inside ones between cells.
        const lastSpanned = c + columnSpan - 1;
        const applied: {
          part: CellStylePart;
          rows: [number, number];
          columns: [number, number];
        }[] = [];
        const add = (
          each: CellStylePart | undefined,
          rows: [number, number],
          columns: [number, number],
        ) => {
          if (each) applied.push({ part: each, rows, columns });
        };
        const allRows: [number, number] = [0, lastRow];
        const allColumns: [number, number] = [0, lastColumn];
        add(parts.whole, allRows, allColumns);
        if (
          flag("bandCol") &&
          !(headerColumns && c === 0) &&
          !(flag("lastCol") && lastSpanned === lastColumn)
        ) {
          add((c - headerColumns) % 2 === 0 ? parts.band1V : parts.band2V, allRows, [
            c,
            lastSpanned,
          ]);
        }
        if (flag("bandRow") && !(headerRows && r === 0) && !(flag("lastRow") && r === lastRow)) {
          add((r - headerRows) % 2 === 0 ? parts.band1H : parts.band2H, [r, r], allColumns);
        }
        if (flag("lastCol") && lastSpanned === lastColumn)
          add(parts.lastCol, allRows, [lastColumn, lastColumn]);
        if (flag("firstCol") && c === 0) add(parts.firstCol, allRows, [0, 0]);
        if (flag("lastRow") && r === lastRow) add(parts.lastRow, [lastRow, lastRow], allColumns);
        if (flag("firstRow") && r === 0) add(parts.firstRow, [0, 0], allColumns);

        let fill: Fill = tableFill ?? { kind: "none" };
        const borders: TableCell["borders"] = { left: null, right: null, top: null, bottom: null };
        let bold: boolean | undefined;
        let italic: boolean | undefined;
        let colour: XmlElement | undefined;
        for (const {
          part: each,
          rows: [top, bottom],
          columns: [left, right],
        } of applied) {
          if (each.fill) fill = each.fill;
          const side = (
            outer: "left" | "right" | "top" | "bottom",
            inner: "insideH" | "insideV",
            isOuter: boolean,
          ) => {
            const value = isOuter ? each.borders[outer] : each.borders[inner];
            if (value !== undefined) borders[outer] = value;
          };
          side("left", "insideV", c <= left);
          side("right", "insideV", lastSpanned >= right);
          side("top", "insideH", r <= top);
          side("bottom", "insideH", r >= bottom);
          if (each.bold !== undefined) bold = each.bold;
          if (each.italic !== undefined) italic = each.italic;
          if (each.colour) colour = each.colour;
        }
        const tcPr = child(tc, "a:tcPr");
        fill = ownFill(tcPr, scope) ?? fill;
        for (const [side, name] of [
          ["left", "a:lnL"],
          ["right", "a:lnR"],
          ["top", "a:lnT"],
          ["bottom", "a:lnB"],
        ] as const) {
          const ln = tcPr && child(tcPr, name);
          if (ln) borders[side] = readLine(ln, scope.colours, borders[side]) ?? null;
        }
        const textLayer: LevelStyle = {
          run: defined({ bold, italic, fill: colour }) as RunStyle,
        };
        const txBody = child(tc, "a:txBody") ?? { name: "a:txBody", attrs: {}, children: [] };
        const text = readTextBody(
          txBody,
          [
            scope.deck.defaultStyle,
            scope.master.styles.other,
            Array.from({ length: 9 }, () => textLayer),
            readListStyle(child(txBody, "a:lstStyle")),
          ],
          [],
          scope,
          {
            insets: [
              numberAttr(tcPr, "marL", 91440),
              numberAttr(tcPr, "marT", 45720),
              numberAttr(tcPr, "marR", 91440),
              numberAttr(tcPr, "marB", 45720),
            ],
            anchor: tcPr?.attrs.anchor,
          },
        );
        return {
          text,
          fill,
          borders,
          columnSpan,
          rowSpan: Math.max(1, numberAttr(tc, "rowSpan", 1)),
          merged: tc.attrs.hMerge === "1" || tc.attrs.vMerge === "1",
        };
      });
    return { height: emu(tr.attrs.h), cells };
  });
  return { kind: "table", box, origin: scope.origin, columns, rows };
}
