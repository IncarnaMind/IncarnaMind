/**
 * Resolves formatting in Word's order. Runs: document defaults, table style,
 * paragraph style chain, character style chain, direct formatting.
 * Paragraphs: defaults, table style, style chain, list level, direct.
 */

import type { MarkJSON } from "../../../shared/blockJson";
import { targetHash } from "../../../shared/proposals";
import { sorted } from "../../../shared/wordFiles";
import { defined } from "../../../shared/wordLook";
import {
  type ParagraphFormat,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  type WordBorder,
  type WordBorders,
  type WordCellLook,
  type WordLook,
  type WordParagraphLook,
  type WordRunLook,
  type WordTableLook,
  type WordTabStop,
  type WordWidth,
} from "../../api";
import { child, descendants, elements, local, onOff, parseXml, type XmlElement } from "./xml";

/**
 * How the look was read. A Mind whose look an earlier version read has it
 * cleared (attributes, marks and map) and given again at the next start.
 * From 6 the look keeps only what styles and lists give (`splitDirect`).
 */
export const WORD_LOOK_VERSION = 6;

/** The first version that read table styles' conditional formatting. */
export const CONDITIONAL_FORMATTING_VERSION = 3;

const MAX_STYLE_DEPTH = 20;

/** Twips (or 1/`per` points) to points, to a hundredth. */
function points(value: string | undefined, per = 20): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number / per) * 100) / 100 : undefined;
}

function count(value: string | undefined): number | undefined {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) ? number : undefined;
}

function hex(value: string | undefined): string | undefined {
  if (!value || value === "auto" || !/^[0-9a-fA-F]{6}$/.test(value)) return undefined;
  return value.toUpperCase();
}

interface FontRef {
  name?: string;
  theme?: string;
}

interface RunProps {
  latin?: FontRef;
  eastAsia?: FontRef;
  size?: number;
  color?: string | null;
  highlight?: string | null;
  shade?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  strike?: boolean;
  doubleStrike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  vertical?: string;
  letterSpacing?: number;
  widthPercent?: number;
  hidden?: boolean;
}

interface Indents {
  left?: number;
  right?: number;
  firstLine?: number;
  hanging?: number;
  /** In hundredths of a character; when not 0, they win over the lengths. */
  leftChars?: number;
  rightChars?: number;
  firstLineChars?: number;
  hangingChars?: number;
}

interface Spacing {
  before?: number;
  after?: number;
  line?: number;
  lineRule?: string;
}

interface RawTab {
  val: string;
  pos: number;
  leader: string;
}

interface ParagraphProps {
  align?: WordParagraphLook["align"];
  indents?: Indents;
  spacing?: Spacing;
  contextual?: boolean;
  tabs?: RawTab[];
  shade?: string | null;
  borders?: Record<string, WordBorder | null>;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  numId?: string;
  ilvl?: number;
}

interface TableProps {
  width?: WordWidth | null;
  align?: WordTableLook["align"];
  indent?: number;
  borders?: Record<string, WordBorder | null>;
  margins?: Record<string, number>;
  fixed?: boolean;
  rowBand?: number;
  columnBand?: number;
}

interface CellProps {
  width?: WordWidth | null;
  shade?: string | null;
  borders?: Record<string, WordBorder | null>;
  vertical?: WordCellLook["vertical"];
  margins?: Record<string, number>;
  noWrap?: boolean;
}

interface StyleParts {
  pPr?: XmlElement;
  rPr?: XmlElement;
  tcPr?: XmlElement;
}

interface StyleDefinition extends StyleParts {
  type: string;
  basedOn: string | null;
  next: string | null;
  tblPr?: XmlElement;
  /** A table style's formatting for parts of the table (`w:tblStylePr`), by `w:type`. */
  conditional: Map<string, StyleParts>;
}

const ALIGN: Record<string, WordParagraphLook["align"]> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  both: "justify",
  distribute: "distribute",
  lowKashida: "justify",
  mediumKashida: "justify",
  highKashida: "justify",
  thaiDistribute: "distribute",
};

const TAB_ALIGN: Record<string, WordTabStop["align"]> = {
  left: "left",
  start: "left",
  center: "center",
  right: "right",
  end: "right",
  decimal: "decimal",
  bar: "bar",
  num: "left",
};

const LEADERS: readonly WordTabStop["leader"][] = [
  "none",
  "dot",
  "hyphen",
  "underscore",
  "heavy",
  "middleDot",
];
const isLeader = (value: string): value is WordTabStop["leader"] =>
  LEADERS.some((leader) => leader === value);

/** Null for "none", which takes away a side a style gave. */
function readBorder(side: XmlElement): WordBorder | null {
  const style = side.attrs["w:val"] ?? "none";
  if (style === "none" || style === "nil") return null;
  return {
    style,
    // w:sz is in eighths of a point.
    width: points(side.attrs["w:sz"], 8) ?? 0.5,
    color: hex(side.attrs["w:color"]) ?? null,
    space: Number(side.attrs["w:space"] ?? 0) || 0,
  };
}

function readBorders(
  element: XmlElement | undefined,
): Record<string, WordBorder | null> | undefined {
  if (!element) return undefined;
  const sides: Record<string, WordBorder | null> = {};
  for (const side of elements(element)) {
    const name = local(side.name);
    const key = name === "start" ? "left" : name === "end" ? "right" : name;
    sides[key] = readBorder(side);
  }
  return sides;
}

function readShade(shd: XmlElement | undefined): string | null | undefined {
  if (!shd) return undefined;
  const pattern = shd.attrs["w:val"] ?? "clear";
  if (pattern === "nil") return null;
  if (pattern === "solid") return hex(shd.attrs["w:color"]) ?? null;
  return hex(shd.attrs["w:fill"]) ?? null;
}

function readWidth(element: XmlElement | undefined): WordWidth | null | undefined {
  if (!element) return undefined;
  const type = element.attrs["w:type"] ?? "dxa";
  const value = element.attrs["w:w"];
  if (type === "nil" || type === "auto" || value === undefined) return null;
  if (type === "pct") {
    // Fiftieths of a percent, or "50%" written as such.
    const percent = value.endsWith("%") ? Number(value.slice(0, -1)) : Number(value) / 50;
    return Number.isFinite(percent) ? { value: percent, unit: "percent" } : null;
  }
  const pt = points(value);
  return pt === undefined ? null : { value: pt, unit: "pt" };
}

function readMargins(element: XmlElement | undefined): Record<string, number> | undefined {
  if (!element) return undefined;
  const margins: Record<string, number> = {};
  for (const side of elements(element)) {
    const name = local(side.name);
    const key = name === "start" ? "left" : name === "end" ? "right" : name;
    const value =
      side.attrs["w:type"] === "dxa" || !side.attrs["w:type"]
        ? points(side.attrs["w:w"])
        : undefined;
    if (value !== undefined) margins[key] = value;
  }
  return margins;
}

function readFont(rFonts: XmlElement, nameKey: string, themeKey: string): FontRef | undefined {
  const theme = rFonts.attrs[themeKey];
  if (theme) return { theme };
  const name = rFonts.attrs[nameKey];
  return name ? { name } : undefined;
}

function readRun(rPr: XmlElement | undefined): RunProps {
  if (!rPr) return {};
  const props: RunProps = {};
  for (const element of elements(rPr)) {
    const value = element.attrs["w:val"];
    switch (element.name) {
      case "w:rFonts": {
        const latin =
          readFont(element, "w:ascii", "w:asciiTheme") ??
          readFont(element, "w:hAnsi", "w:hAnsiTheme");
        const eastAsia = readFont(element, "w:eastAsia", "w:eastAsiaTheme");
        if (latin) props.latin = latin;
        if (eastAsia) props.eastAsia = eastAsia;
        break;
      }
      case "w:sz":
        props.size = points(value, 2);
        break;
      case "w:color":
        props.color = hex(value) ?? null;
        break;
      case "w:highlight":
        props.highlight = value && value !== "none" ? value : null;
        break;
      case "w:shd":
        props.shade = readShade(element);
        break;
      case "w:b":
        props.bold = onOff(element);
        break;
      case "w:i":
        props.italic = onOff(element);
        break;
      case "w:u":
        props.underline = value ?? "single";
        break;
      case "w:strike":
        props.strike = onOff(element);
        break;
      case "w:dstrike":
        props.doubleStrike = onOff(element);
        break;
      case "w:caps":
        props.caps = onOff(element);
        break;
      case "w:smallCaps":
        props.smallCaps = onOff(element);
        break;
      case "w:vanish":
        props.hidden = onOff(element);
        break;
      case "w:vertAlign":
        if (value) props.vertical = value;
        break;
      case "w:spacing":
        props.letterSpacing = points(value);
        break;
      case "w:w": {
        const percent = Number(value);
        if (Number.isFinite(percent)) props.widthPercent = percent;
        break;
      }
    }
  }
  return props;
}

function readParagraph(pPr: XmlElement | undefined): ParagraphProps {
  if (!pPr) return {};
  const props: ParagraphProps = {};
  for (const element of elements(pPr)) {
    const attrs = element.attrs;
    switch (element.name) {
      case "w:jc": {
        const align = ALIGN[attrs["w:val"] ?? ""];
        if (align) props.align = align;
        break;
      }
      case "w:ind":
        props.indents = defined({
          left: points(attrs["w:left"] ?? attrs["w:start"]),
          right: points(attrs["w:right"] ?? attrs["w:end"]),
          firstLine: points(attrs["w:firstLine"]),
          hanging: points(attrs["w:hanging"]),
          leftChars: count(attrs["w:leftChars"] ?? attrs["w:startChars"]),
          rightChars: count(attrs["w:rightChars"] ?? attrs["w:endChars"]),
          firstLineChars: count(attrs["w:firstLineChars"]),
          hangingChars: count(attrs["w:hangingChars"]),
        });
        break;
      case "w:spacing":
        props.spacing = defined({
          before: points(attrs["w:before"]),
          after: points(attrs["w:after"]),
          line: attrs["w:line"] === undefined ? undefined : Number(attrs["w:line"]),
          lineRule: attrs["w:lineRule"],
        });
        break;
      case "w:contextualSpacing":
        props.contextual = onOff(element);
        break;
      case "w:tabs":
        props.tabs = elements(element).flatMap((tab) => {
          const pos = Number(tab.attrs["w:pos"]);
          if (!Number.isFinite(pos)) return [];
          return [
            { val: tab.attrs["w:val"] ?? "left", pos, leader: tab.attrs["w:leader"] ?? "none" },
          ];
        });
        break;
      case "w:shd":
        props.shade = readShade(element);
        break;
      case "w:pBdr":
        props.borders = readBorders(element);
        break;
      case "w:keepNext":
        props.keepNext = onOff(element);
        break;
      case "w:keepLines":
        props.keepLines = onOff(element);
        break;
      case "w:pageBreakBefore":
        props.pageBreakBefore = onOff(element);
        break;
      case "w:widowControl":
        props.widowControl = onOff(element);
        break;
      case "w:numPr": {
        const numId = child(element, "w:numId")?.attrs["w:val"];
        const ilvl = child(element, "w:ilvl")?.attrs["w:val"];
        if (numId !== undefined) props.numId = numId;
        if (ilvl !== undefined && Number.isFinite(Number(ilvl))) props.ilvl = Number(ilvl);
        break;
      }
    }
  }
  return props;
}

function readTable(tblPr: XmlElement | undefined): TableProps {
  if (!tblPr) return {};
  const props: TableProps = {};
  for (const element of elements(tblPr)) {
    switch (element.name) {
      case "w:tblW":
        props.width = readWidth(element);
        break;
      case "w:jc": {
        const value = element.attrs["w:val"];
        props.align =
          value === "center" ? "center" : value === "right" || value === "end" ? "right" : "left";
        break;
      }
      case "w:tblInd":
        props.indent = points(element.attrs["w:w"]);
        break;
      case "w:tblBorders":
        props.borders = readBorders(element);
        break;
      case "w:tblCellMar":
        props.margins = readMargins(element);
        break;
      case "w:tblLayout":
        props.fixed = element.attrs["w:type"] === "fixed";
        break;
      case "w:tblStyleRowBandSize":
        props.rowBand = count(element.attrs["w:val"]);
        break;
      case "w:tblStyleColBandSize":
        props.columnBand = count(element.attrs["w:val"]);
        break;
    }
  }
  return props;
}

function readCell(tcPr: XmlElement | undefined): CellProps {
  if (!tcPr) return {};
  const props: CellProps = {};
  for (const element of elements(tcPr)) {
    switch (element.name) {
      case "w:tcW":
        props.width = readWidth(element);
        break;
      case "w:shd":
        props.shade = readShade(element);
        break;
      case "w:tcBorders":
        props.borders = readBorders(element);
        break;
      case "w:vAlign": {
        const value = element.attrs["w:val"];
        if (value === "top" || value === "center" || value === "bottom") props.vertical = value;
        break;
      }
      case "w:tcMar":
        props.margins = readMargins(element);
        break;
      case "w:noWrap":
        props.noWrap = onOff(element);
        break;
    }
  }
  return props;
}

function mergeRun(base: RunProps, over: RunProps): RunProps {
  return { ...base, ...over };
}

const TOGGLES = [
  "bold",
  "italic",
  "caps",
  "smallCaps",
  "strike",
  "doubleStrike",
  "hidden",
] as const satisfies readonly (keyof RunProps)[];

/**
 * Toggle properties set in a style switch the value the levels before gave,
 * so bold in a bold heading's character style is not bold (ECMA-376
 * §17.7.3); direct formatting sets them outright.
 */
function resolveRun(defaults: RunProps, styles: readonly RunProps[], direct: RunProps): RunProps {
  const resolved = [...styles, direct].reduce(mergeRun, defaults);
  for (const name of TOGGLES) {
    if (direct[name] !== undefined) continue;
    let on = defaults[name] === true;
    for (const level of styles) if (level[name] === true) on = !on;
    resolved[name] = on;
  }
  return resolved;
}

function mergeParagraph(base: ParagraphProps, over: ParagraphProps): ParagraphProps {
  const merged: ParagraphProps = { ...base, ...over };
  if (base.indents || over.indents) {
    const indents = { ...base.indents, ...over.indents };
    // A first line and a hanging indent replace each other.
    const firstLine =
      over.indents?.firstLine !== undefined || over.indents?.firstLineChars !== undefined;
    const hanging = over.indents?.hanging !== undefined || over.indents?.hangingChars !== undefined;
    if (firstLine && !hanging) {
      delete indents.hanging;
      delete indents.hangingChars;
    }
    if (hanging && !firstLine) {
      delete indents.firstLine;
      delete indents.firstLineChars;
    }
    merged.indents = indents;
  }
  if (base.spacing || over.spacing) merged.spacing = { ...base.spacing, ...over.spacing };
  if (base.borders || over.borders) merged.borders = { ...base.borders, ...over.borders };
  if (base.tabs || over.tabs) {
    // Tabs add up across levels; a "clear" tab removes the stop at its position.
    const stops = new Map<number, RawTab>();
    for (const tab of [...(base.tabs ?? []), ...(over.tabs ?? [])]) {
      if (tab.val === "clear") stops.delete(tab.pos);
      else stops.set(tab.pos, tab);
    }
    merged.tabs = [...stops.values()].sort((a, b) => a.pos - b.pos);
  }
  return merged;
}

function mergeTable(base: TableProps, over: TableProps): TableProps {
  const merged: TableProps = { ...base, ...over };
  if (base.borders || over.borders) merged.borders = { ...base.borders, ...over.borders };
  if (base.margins || over.margins) merged.margins = { ...base.margins, ...over.margins };
  return merged;
}

function mergeCell(base: CellProps, over: CellProps): CellProps {
  const merged: CellProps = { ...base, ...over };
  if (base.borders || over.borders) merged.borders = { ...base.borders, ...over.borders };
  if (base.margins || over.margins) merged.margins = { ...base.margins, ...over.margins };
  return merged;
}

const BOX = ["top", "bottom", "left", "right"] as const;
type Side = (typeof BOX)[number];
const INSIDE = { top: "insideH", bottom: "insideH", left: "insideV", right: "insideV" } as const;

/** A cell's "none" hides the table's line on that side, as in Word: "nil" on the table's edge, "none" between cells. */
const noLine = (style: "nil" | "none"): WordBorder => ({ style, width: 0, color: null, space: 0 });

const edgesOf = (place: CellPlace): Record<Side, boolean> => ({
  top: place.row === 0,
  bottom: place.row + place.rowSpan === place.rows,
  left: place.column === 0,
  right: place.column + place.span === place.columns,
});

function cellBorders(
  borders: Record<string, WordBorder | null> | undefined,
  place: CellPlace | undefined,
): WordBorders<Side> | undefined {
  if (!borders) return undefined;
  const edge = place ? edgesOf(place) : null;
  const kept: WordBorders<Side> = {};
  for (const side of BOX) {
    const border = borders[side];
    if (border !== undefined) kept[side] = border ?? noLine(!edge || edge[side] ? "nil" : "none");
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Where a cell is: the row and grid column it starts in, what it spans, and the table's size. */
export interface CellPlace {
  row: number;
  rows: number;
  rowSpan: number;
  column: number;
  span: number;
  columns: number;
}

type Region = "table" | "row" | "column" | "cell";

/** In the order Office applies them, each over those before (MS-OI29500, 17.7.6.6). */
const CONDITIONS: readonly (readonly [string, Region])[] = [
  ["wholeTable", "table"],
  ["band1Horz", "row"],
  ["band2Horz", "row"],
  ["band1Vert", "column"],
  ["band2Vert", "column"],
  ["firstCol", "column"],
  ["lastCol", "column"],
  ["firstRow", "row"],
  ["lastRow", "row"],
  ["nwCell", "cell"],
  ["neCell", "cell"],
  ["swCell", "cell"],
  ["seCell", "cell"],
];

interface TableOptions {
  firstRow: boolean;
  lastRow: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
  rowBands: boolean;
  columnBands: boolean;
}

const LOOK_BITS = {
  firstRow: 0x20,
  lastRow: 0x40,
  firstColumn: 0x80,
  lastColumn: 0x100,
  noHBand: 0x200,
  noVBand: 0x400,
} as const;

function readOptions(tblLook: XmlElement | undefined): TableOptions {
  // Word takes a missing tblLook as 04A0 (MS-OI29500, 17.4.55).
  const bits = tblLook ? Number.parseInt(tblLook.attrs["w:val"] ?? "0", 16) || 0 : 0x04a0;
  const on = (name: keyof typeof LOOK_BITS) => {
    const value = tblLook?.attrs[`w:${name}`];
    return value === undefined
      ? (bits & LOOK_BITS[name]) !== 0
      : !["false", "0", "off"].includes(value);
  };
  return {
    firstRow: on("firstRow"),
    lastRow: on("lastRow"),
    firstColumn: on("firstColumn"),
    lastColumn: on("lastColumn"),
    rowBands: !on("noHBand"),
    columnBands: !on("noVBand"),
  };
}

function conditionsAt(
  options: TableOptions,
  bands: { rows: number; columns: number },
  place: CellPlace,
): Set<string> {
  const firstRow = options.firstRow && place.row === 0;
  const lastRow = options.lastRow && place.row === place.rows - 1;
  const firstCol = options.firstColumn && place.column === 0;
  const lastCol = options.lastColumn && place.column + place.span === place.columns;
  const on = new Set(["wholeTable"]);
  if (options.rowBands && bands.rows > 0 && !firstRow && !lastRow) {
    const band = Math.floor((place.row - (options.firstRow ? 1 : 0)) / bands.rows);
    on.add(band % 2 === 0 ? "band1Horz" : "band2Horz");
  }
  if (options.columnBands && bands.columns > 0 && !firstCol && !lastCol) {
    const band = Math.floor((place.column - (options.firstColumn ? 1 : 0)) / bands.columns);
    on.add(band % 2 === 0 ? "band1Vert" : "band2Vert");
  }
  const flags: [string, boolean][] = [
    ["firstCol", firstCol],
    ["lastCol", lastCol],
    ["firstRow", firstRow],
    ["lastRow", lastRow],
    ["nwCell", firstRow && firstCol],
    ["neCell", firstRow && lastCol],
    ["swCell", lastRow && firstCol],
    ["seCell", lastRow && lastCol],
  ];
  for (const [name, applies] of flags) if (applies) on.add(name);
  return on;
}

/** A conditional format's borders frame its region: a row's left side is only its first cell's, and insideV is between. */
function regionBorders(props: CellProps, region: Region, place: CellPlace): CellProps {
  const sides = props.borders;
  if (!sides || region === "cell") return props;
  const edge = edgesOf(place);
  const across = (side: Side) =>
    region === "table" ||
    (region === "row" ? side === "left" || side === "right" : side === "top" || side === "bottom");
  const borders: Record<string, WordBorder | null> = {};
  for (const side of BOX) {
    const value = across(side) && !edge[side] ? sides[INSIDE[side]] : sides[side];
    if (value !== undefined) borders[side] = value;
  }
  return { ...props, borders };
}

function keptBorders<Side extends string>(
  borders: Record<string, WordBorder | null> | undefined,
  sides: readonly Side[],
): WordBorders<Side> | undefined {
  if (!borders) return undefined;
  const kept: WordBorders<Side> = {};
  for (const side of sides) {
    const border = borders[side];
    if (border) kept[side] = border;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

interface ThemeFonts {
  major: { latin?: string; eastAsia?: string };
  minor: { latin?: string; eastAsia?: string };
}

const EAST_ASIAN_SCRIPTS = ["Hans", "Hant", "Jpan", "Hang"];

function scriptOf(language: string | undefined): string | undefined {
  const code = language?.toLowerCase() ?? "";
  if (code.startsWith("zh")) return /-(tw|hk|mo|hant)/.test(code) ? "Hant" : "Hans";
  if (code.startsWith("ja")) return "Jpan";
  if (code.startsWith("ko")) return "Hang";
  return undefined;
}

function readTheme(root: XmlElement, language: string | undefined): ThemeFonts {
  const fonts: ThemeFonts = { major: {}, minor: {} };
  const wanted = scriptOf(language);
  const scripts = wanted
    ? [wanted, ...EAST_ASIAN_SCRIPTS.filter((each) => each !== wanted)]
    : EAST_ASIAN_SCRIPTS;
  const scheme = descendants(root, "a:fontScheme")[0];
  if (!scheme) return fonts;
  for (const kind of ["major", "minor"] as const) {
    const set = child(scheme, `a:${kind}Font`);
    if (!set) continue;
    const latin = child(set, "a:latin")?.attrs.typeface;
    const ea = child(set, "a:ea")?.attrs.typeface;
    // Office's themes leave a:ea empty and list a face per script, Japanese first.
    const byScript = new Map(
      elements(set)
        .filter((font) => font.name === "a:font")
        .map((font) => [font.attrs.script ?? "", font.attrs.typeface]),
    );
    const script = scripts.map((each) => byScript.get(each)).find(Boolean);
    fonts[kind] = defined({ latin: latin || undefined, eastAsia: ea || script || undefined });
  }
  return fonts;
}

function themeFont(theme: ThemeFonts, ref: FontRef | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.name) return ref.name;
  const name = ref.theme ?? "";
  const set = name.startsWith("major") ? theme.major : theme.minor;
  return name.endsWith("EastAsia") ? set.eastAsia : set.latin;
}

export interface LookParts {
  styles?: string;
  theme?: string;
  numbering?: string;
  settings?: string;
  document: XmlElement;
}

export interface ParagraphLookContext {
  look: WordParagraphLook;
  /** The paragraph's direct formatting that the look leaves out. */
  format: ParagraphFormat;
  /** The table style's run formatting, then the paragraph style's. */
  runs: RunProps[];
}

export interface TableLookContext {
  key: string;
  /** Names the levels, for the look Enter gives (`next`). */
  id: string;
  /** What the table's paragraphs and runs take: its style's levels, then a cell's conditional ones. */
  levels: StyleParts[];
  cellBase: CellProps;
  chain: StyleDefinition[];
  options: TableOptions;
  bands: { rows: number; columns: number };
  /** A cell's place, in its context. */
  place?: CellPlace;
}

/** Each look under a key made from the look itself, so a key names the same look in every Mind. */
class KeyedStyles<T> {
  readonly entries: Record<string, T> = {};

  constructor(private readonly prefix: string) {}

  key(look: T): string | null {
    const json = JSON.stringify(sorted(look));
    return json === "{}" ? null : this.keyOf(json, look);
  }

  empty(look: T): string {
    return this.keyOf("{}", look);
  }

  private keyOf(json: string, look: T): string {
    const key = `${this.prefix}${targetHash(json)}`;
    this.entries[key] ??= look;
    return key;
  }
}

export class LookReader {
  private readonly paragraphs = new KeyedStyles<WordParagraphLook>("p");
  private readonly runs = new KeyedStyles<WordRunLook>("r");
  private readonly tables = new KeyedStyles<WordTableLook>("t");
  private readonly cells = new KeyedStyles<WordCellLook>("c");
  private readonly charactersBySize = new Map<number, number>();
  private readonly styles = new Map<string, StyleDefinition>();
  private defaultParagraph: string | null = null;
  private defaultTable: string | null = null;
  private readonly runDefaults: RunProps;
  private readonly paragraphDefaults: ParagraphProps;
  private readonly theme: ThemeFonts;
  private readonly levels = new Map<string, Map<number, { pPr?: XmlElement; rPr?: XmlElement }>>();
  private readonly width: number | null;
  private readonly defaultTab: number | null;
  private readonly tablesHang: boolean;
  /** Parts the look would read but couldn't parse; the look goes on without them. */
  readonly unreadable: string[] = [];

  constructor(parts: LookParts) {
    const settings = this.readable("settings", parts.settings, (root) => ({
      language: child(root, "w:themeFontLang")?.attrs["w:eastAsia"],
      defaultTab: points(child(root, "w:defaultTabStop")?.attrs["w:val"]),
      mode: Number(
        elements(child(root, "w:compat") ?? EMPTY).find(
          (setting) =>
            setting.name === "w:compatSetting" && setting.attrs["w:name"] === "compatibilityMode",
        )?.attrs["w:val"],
      ),
    }));
    this.defaultTab = settings?.defaultTab ?? null;
    // A file that names no mode is opened in an earlier one: only Word 2013's mode 15 and later stop the hang.
    this.tablesHang = !(Number.isFinite(settings?.mode) && (settings?.mode ?? 0) >= 15);
    this.theme = this.readable("theme", parts.theme, (root) =>
      readTheme(root, settings?.language),
    ) ?? {
      major: {},
      minor: {},
    };
    const root = parts.styles ? parseXml(parts.styles) : undefined;
    const defaults = root && child(root, "w:docDefaults");
    this.runDefaults = readRun(child(child(defaults ?? EMPTY, "w:rPrDefault") ?? EMPTY, "w:rPr"));
    this.paragraphDefaults = readParagraph(
      child(child(defaults ?? EMPTY, "w:pPrDefault") ?? EMPTY, "w:pPr"),
    );
    for (const style of root ? elements(root) : []) {
      if (style.name !== "w:style") continue;
      const id = style.attrs["w:styleId"];
      const type = style.attrs["w:type"];
      if (!id || !type) continue;
      const isDefault = style.attrs["w:default"] === "1" || style.attrs["w:default"] === "true";
      if (isDefault && type === "paragraph") this.defaultParagraph = id;
      if (isDefault && type === "table") this.defaultTable = id;
      const conditional = new Map<string, StyleParts>();
      for (const part of elements(style)) {
        const condition = part.name === "w:tblStylePr" ? part.attrs["w:type"] : undefined;
        if (!condition) continue;
        conditional.set(condition, {
          pPr: child(part, "w:pPr"),
          rPr: child(part, "w:rPr"),
          tcPr: child(part, "w:tcPr"),
        });
      }
      this.styles.set(`${type}:${id}`, {
        type,
        basedOn: child(style, "w:basedOn")?.attrs["w:val"] ?? null,
        next: child(style, "w:next")?.attrs["w:val"] ?? null,
        pPr: child(style, "w:pPr"),
        rPr: child(style, "w:rPr"),
        tblPr: child(style, "w:tblPr"),
        tcPr: child(style, "w:tcPr"),
        conditional,
      });
    }
    this.readNumbering(parts.numbering);
    this.width = textWidth(parts.document);
  }

  private readable<T>(
    part: string,
    xml: string | undefined,
    read: (root: XmlElement) => T,
  ): T | undefined {
    if (xml === undefined) return undefined;
    try {
      return read(parseXml(xml));
    } catch {
      this.unreadable.push(part);
      return undefined;
    }
  }

  private readNumbering(xml: string | undefined): void {
    if (!xml) return;
    const abstracts = new Map<string, Map<number, { pPr?: XmlElement; rPr?: XmlElement }>>();
    const nums: { id: string; abstract: string; overrides: XmlElement[] }[] = [];
    for (const element of elements(parseXml(xml))) {
      if (element.name === "w:abstractNum") {
        const id = element.attrs["w:abstractNumId"];
        if (id === undefined) continue;
        const levels = new Map<number, { pPr?: XmlElement; rPr?: XmlElement }>();
        for (const lvl of elements(element)) {
          if (lvl.name !== "w:lvl") continue;
          levels.set(Number(lvl.attrs["w:ilvl"] ?? 0), {
            pPr: child(lvl, "w:pPr"),
            rPr: child(lvl, "w:rPr"),
          });
        }
        abstracts.set(id, levels);
      } else if (element.name === "w:num") {
        const id = element.attrs["w:numId"];
        const abstract = child(element, "w:abstractNumId")?.attrs["w:val"];
        if (id === undefined || abstract === undefined) continue;
        nums.push({
          id,
          abstract,
          overrides: elements(element).filter((each) => each.name === "w:lvlOverride"),
        });
      }
    }
    for (const { id, abstract, overrides } of nums) {
      const levels = new Map(abstracts.get(abstract) ?? []);
      for (const override of overrides) {
        const lvl = child(override, "w:lvl");
        if (!lvl) continue;
        levels.set(Number(override.attrs["w:ilvl"] ?? 0), {
          pPr: child(lvl, "w:pPr"),
          rPr: child(lvl, "w:rPr"),
        });
      }
      this.levels.set(id, levels);
    }
  }

  private chain(type: string, id: string | null): StyleDefinition[] {
    const chain: StyleDefinition[] = [];
    const seen = new Set<string>();
    for (let at = id; at && !seen.has(at) && chain.length < MAX_STYLE_DEPTH; ) {
      seen.add(at);
      const style = this.styles.get(`${type}:${at}`);
      if (!style) break;
      chain.unshift(style);
      at = style.basedOn;
    }
    return chain;
  }

  table(tbl: XmlElement): TableLookContext {
    const tblPr = child(tbl, "w:tblPr");
    const styleId = (tblPr && child(tblPr, "w:tblStyle")?.attrs["w:val"]) ?? this.defaultTable;
    const style = this.chain("table", styleId);
    let props: TableProps = {};
    let cellBase: CellProps = {};
    for (const level of style) {
      props = mergeTable(props, readTable(level.tblPr));
      cellBase = mergeCell(cellBase, readCell(level.tcPr));
    }
    props = mergeTable(props, readTable(tblPr));
    const columns = elements(child(tbl, "w:tblGrid") ?? EMPTY)
      .filter((column) => column.name === "w:gridCol")
      .map((column) => points(column.attrs["w:w"]) ?? 0);
    const look: WordTableLook = defined({
      width: props.width ?? undefined,
      align: props.align && props.align !== "left" ? props.align : undefined,
      indent: props.indent || undefined,
      borders: keptBorders(props.borders, [
        "top",
        "bottom",
        "left",
        "right",
        "insideH",
        "insideV",
      ] as const),
      margins: props.margins && Object.keys(props.margins).length > 0 ? props.margins : undefined,
      fixed: props.fixed ? (true as const) : undefined,
      columns: columns.length > 0 ? columns : undefined,
    });
    return {
      // Every table gets a key, so the look draws it, not the app's table.
      key: this.tables.key(look) ?? this.tables.empty(look),
      id: `table:${styleId ?? ""}`,
      levels: style,
      cellBase,
      chain: style,
      options: readOptions(tblPr && child(tblPr, "w:tblLook")),
      bands: { rows: props.rowBand ?? 1, columns: props.columnBand ?? 1 },
    };
  }

  cellAt(table: TableLookContext, place: CellPlace): TableLookContext {
    if (!table.chain.some((style) => style.conditional.size > 0)) return { ...table, place };
    const on = conditionsAt(table.options, table.bands, place);
    const levels = [...table.levels];
    const taken: string[] = [];
    let cellBase = table.cellBase;
    for (const [condition, region] of CONDITIONS) {
      if (!on.has(condition)) continue;
      for (const style of table.chain) {
        const parts = style.conditional.get(condition);
        if (!parts) continue;
        levels.push(parts);
        cellBase = mergeCell(cellBase, regionBorders(readCell(parts.tcPr), region, place));
        if (taken.at(-1) !== condition) taken.push(condition);
      }
    }
    if (taken.length === 0) return { ...table, place };
    return { ...table, id: `${table.id}|${taken.join(",")}`, levels, cellBase, place };
  }

  cell(tc: XmlElement, table: TableLookContext): string | null {
    const props = mergeCell(table.cellBase, readCell(child(tc, "w:tcPr")));
    const look: WordCellLook = defined({
      width: props.width ?? undefined,
      shade: props.shade ?? undefined,
      borders: cellBorders(props.borders, table.place),
      vertical: props.vertical && props.vertical !== "top" ? props.vertical : undefined,
      margins: props.margins && Object.keys(props.margins).length > 0 ? props.margins : undefined,
      noWrap: props.noWrap ? (true as const) : undefined,
    });
    return this.cells.key(look);
  }

  paragraph(p: XmlElement, table: TableLookContext | null): ParagraphLookContext {
    const pPr = child(p, "w:pPr");
    const styleId = (pPr && child(pPr, "w:pStyle")?.attrs["w:val"]) ?? this.defaultParagraph;
    const style = this.chain("paragraph", styleId);
    let props = this.paragraphDefaults;
    let tableRuns: RunProps = {};
    let paragraphRuns: RunProps = {};
    for (const level of table?.levels ?? []) {
      props = mergeParagraph(props, readParagraph(level.pPr));
      tableRuns = mergeRun(tableRuns, readRun(level.rPr));
    }
    for (const level of style) {
      props = mergeParagraph(props, readParagraph(level.pPr));
      paragraphRuns = mergeRun(paragraphRuns, readRun(level.rPr));
    }
    const own = readParagraph(pPr);
    // Word applies the list level between the style and direct formatting.
    const numId = own.numId ?? props.numId;
    const ilvl = own.ilvl ?? props.ilvl ?? 0;
    const level =
      numId !== undefined && numId !== "0" ? this.levels.get(numId)?.get(ilvl) : undefined;
    if (level) props = mergeParagraph(props, readParagraph(level.pPr));
    const merged = mergeParagraph(props, own);
    const next = style.at(-1)?.next;
    // Character indents are in the paragraph's size, as Word draws them.
    const size = paragraphRuns.size ?? tableRuns.size ?? this.runDefaults.size ?? WORD_DEFAULT_SIZE;
    const { look, direct } = splitDirect(
      paragraphLook(merged, size),
      paragraphLook(props, size),
      PARAGRAPH_DIRECT,
    );
    const format: ParagraphFormat = direct;
    const chars = direct.firstLine !== undefined ? characterIndent(merged.indents) : undefined;
    if (chars !== undefined) {
      delete format.firstLine;
      format.firstLineChars = chars;
      look.characterSize = size;
    }
    if (next && styleId && next !== styleId) {
      const nextKey = this.nextLook(next, table);
      if (nextKey) look.next = nextKey;
    }
    return { look, format, runs: [tableRuns, paragraphRuns] };
  }

  private readonly nextLooks = new Map<string, string | null>();

  private nextLook(styleId: string, table: TableLookContext | null): string | null {
    const id = `${table?.id ?? "body"}|${styleId}`;
    const known = this.nextLooks.get(id);
    if (known !== undefined) return known;
    // Two styles can name each other as next.
    this.nextLooks.set(id, null);
    const paragraph: XmlElement = {
      name: "w:p",
      attrs: {},
      children: [
        {
          name: "w:pPr",
          attrs: {},
          children: [{ name: "w:pStyle", attrs: { "w:val": styleId }, children: [] }],
        },
      ],
    };
    const context = this.paragraph(paragraph, table);
    const run = this.run(undefined, context, 0).key;
    const key = this.paragraphKey(context, run && this.canBeParagraphRun(run) ? run : null);
    this.nextLooks.set(id, key);
    return key;
  }

  paragraphKey(paragraph: ParagraphLookContext, run: string | null): string | null {
    const look = run ? { ...paragraph.look, run } : paragraph.look;
    const key = this.paragraphs.key(look);
    if (key || Object.keys(paragraph.format).length === 0) return key;
    // With no key, a paragraph draws in the Mind's style rather than as Word draws its format.
    return this.paragraphs.empty(look);
  }

  /** Drawn on a paragraph, these would cover all its text, not only the text that has them. */
  canBeParagraphRun(key: string): boolean {
    const look = this.runs.entries[key];
    return !(
      look?.underline ||
      look?.strike ||
      look?.doubleStrike ||
      look?.highlight ||
      look?.shade ||
      look?.vertical
    );
  }

  /** For text with no look in a paragraph whose `run` has one. */
  plainRun(): string {
    return this.runs.empty({});
  }

  /** Also counts `characters` toward the body size. `marks`: the run's direct formatting the look leaves out. */
  run(
    rPr: XmlElement | undefined,
    paragraph: ParagraphLookContext,
    characters: number,
  ): { key: string | null; look: WordRunLook; marks: MarkJSON[] } {
    const styleId = rPr && child(rPr, "w:rStyle")?.attrs["w:val"];
    let characterRuns: RunProps = {};
    for (const level of this.chain("character", styleId ?? null)) {
      characterRuns = mergeRun(characterRuns, readRun(level.rPr));
    }
    const styles = [...paragraph.runs, characterRuns];
    const own = readRun(rPr);
    const props = resolveRun(this.runDefaults, styles, own);
    if (props.size !== undefined && characters > 0) {
      this.charactersBySize.set(
        props.size,
        (this.charactersBySize.get(props.size) ?? 0) + characters,
      );
    }
    const { color: _color, vertical: _vertical, ...styled } = own;
    const { look, direct } = splitDirect(
      this.runLook(props),
      this.runLook(resolveRun(this.runDefaults, styles, styled)),
      RUN_DIRECT,
    );
    return { key: this.runs.key(look), look, marks: runFormatMarks(direct) };
  }

  private runLook(props: RunProps): WordRunLook {
    return defined({
      font: themeFont(this.theme, props.latin),
      eastAsia: themeFont(this.theme, props.eastAsia),
      size: props.size,
      color: props.color ?? undefined,
      highlight: props.highlight ?? undefined,
      shade: props.shade ?? undefined,
      bold: props.bold ? (true as const) : undefined,
      italic: props.italic ? (true as const) : undefined,
      underline: props.underline && props.underline !== "none" ? props.underline : undefined,
      strike: props.strike ? (true as const) : undefined,
      doubleStrike: props.doubleStrike ? (true as const) : undefined,
      caps: props.caps ? (true as const) : undefined,
      smallCaps: props.smallCaps ? (true as const) : undefined,
      vertical:
        props.vertical === "superscript" || props.vertical === "subscript"
          ? props.vertical
          : undefined,
      letterSpacing: props.letterSpacing || undefined,
      widthPercent:
        props.widthPercent !== undefined && props.widthPercent !== 100
          ? props.widthPercent
          : undefined,
      hidden: props.hidden ? (true as const) : undefined,
    });
  }

  look(): WordLook {
    let body: number | null = null;
    let most = 0;
    for (const [size, count] of this.charactersBySize) {
      if (count > most) {
        most = count;
        body = size;
      }
    }
    return {
      version: WORD_LOOK_VERSION,
      body,
      width: this.width,
      defaultTab: this.defaultTab,
      ...(this.tablesHang && { tablesHang: true as const }),
      paragraphs: this.paragraphs.entries,
      runs: this.runs.entries,
      tables: this.tables.entries,
      cells: this.cells.entries,
    };
  }
}

const EMPTY: XmlElement = { name: "", attrs: {}, children: [] };

const WORD_DEFAULT_SIZE = 10;

/** For each property direct formatting can set apart from the look, what says "none" where a style gave one; null where nothing can. */
type Direct<T, K extends keyof T> = readonly { [P in K]: readonly [P, T[P] | null] }[K][];

const PARAGRAPH_DIRECT: Direct<
  WordParagraphLook,
  "align" | "left" | "right" | "firstLine" | "before" | "after" | "line"
> = [
  ["align", "left"],
  ["left", 0],
  ["right", 0],
  ["firstLine", 0],
  ["before", 0],
  ["after", 0],
  ["line", null],
];

/** Word's "auto" colour or "baseline" over a style's can't be said as a mark. */
const RUN_DIRECT: Direct<WordRunLook, "color" | "vertical"> = [
  ["color", null],
  ["vertical", null],
];

/**
 * Decides what of a paragraph's or run's direct formatting the Mind keeps
 * as its own formatting rather than in the look: each property of `kinds`
 * the direct formatting changed (`full`, with it, against `base`, as the
 * styles and lists give it) that a format or mark can say. The rest stays
 * in the look, as `full` has it, so the look and the formatting together
 * draw what `full` does.
 */
export function splitDirect<T extends object, K extends keyof T>(
  full: T,
  base: T,
  kinds: Direct<T, K>,
): { look: T; direct: Partial<Pick<T, K>> } {
  const look: T = { ...full };
  const direct: Partial<Pick<T, K>> = {};
  for (const [name, unset] of kinds) {
    if (JSON.stringify(full[name]) === JSON.stringify(base[name])) continue;
    const value = full[name] ?? unset;
    if (value === null || value === undefined) continue;
    direct[name] = value;
    if (base[name] === undefined) delete look[name];
    else look[name] = base[name];
  }
  return { look, direct };
}

/** As `paragraphLook` resolves the first line: its indent in characters, signed, when characters gave it. */
function characterIndent(indents: Indents | undefined): number | undefined {
  if (indents?.hangingChars) return -indents.hangingChars / 100;
  if (indents?.hanging) return undefined;
  return indents?.firstLineChars ? indents.firstLineChars / 100 : undefined;
}

function runFormatMarks(direct: Partial<WordRunLook>): MarkJSON[] {
  const marks: MarkJSON[] = [];
  if (direct.color) marks.push({ type: TEXT_COLOR_MARK, attrs: { color: direct.color } });
  if (direct.vertical === "superscript") marks.push({ type: SUPERSCRIPT_MARK });
  if (direct.vertical === "subscript") marks.push({ type: SUBSCRIPT_MARK });
  return marks;
}

function paragraphLook(props: ParagraphProps, size: number): WordParagraphLook {
  const given = props.indents ?? {};
  const chars = (hundredths: number | undefined) =>
    hundredths ? Math.round((hundredths / 100) * size * 100) / 100 : undefined;
  const indents = {
    left: chars(given.leftChars) ?? given.left,
    right: chars(given.rightChars) ?? given.right,
    firstLine: chars(given.firstLineChars) ?? given.firstLine,
    hanging: chars(given.hangingChars) ?? given.hanging,
  };
  const firstLine =
    indents.hanging !== undefined && indents.hanging !== 0
      ? -indents.hanging
      : indents.firstLine || undefined;
  const spacing = props.spacing ?? {};
  let line: WordParagraphLook["line"];
  if (spacing.line !== undefined && Number.isFinite(spacing.line)) {
    const rule =
      spacing.lineRule === "exact" || spacing.lineRule === "atLeast" ? spacing.lineRule : "auto";
    // "auto" is in 240ths of a line; the others in twips.
    line =
      rule === "auto"
        ? { rule, value: Math.round((spacing.line / 240) * 1000) / 1000 }
        : { rule, value: Math.round((spacing.line / 20) * 100) / 100 };
  }
  const tabs = props.tabs?.flatMap((tab): WordTabStop[] => {
    const align = TAB_ALIGN[tab.val];
    if (!align) return [];
    return [
      {
        at: Math.round((tab.pos / 20) * 100) / 100,
        align,
        leader: isLeader(tab.leader) ? tab.leader : "none",
      },
    ];
  });
  return defined({
    align: props.align && props.align !== "left" ? props.align : undefined,
    left: indents.left || undefined,
    right: indents.right || undefined,
    firstLine,
    before: spacing.before || undefined,
    after: spacing.after || undefined,
    line,
    contextual: props.contextual ? (true as const) : undefined,
    tabs: tabs && tabs.length > 0 ? tabs : undefined,
    shade: props.shade ?? undefined,
    borders: keptBorders(props.borders, ["top", "bottom", "left", "right", "between"] as const),
    keepNext: props.keepNext ? (true as const) : undefined,
    keepLines: props.keepLines ? (true as const) : undefined,
    pageBreakBefore: props.pageBreakBefore ? (true as const) : undefined,
    widowControl: props.widowControl === false ? false : undefined,
  });
}

function textWidth(document: XmlElement): number | null {
  const body = child(document, "w:body");
  if (!body) return null;
  // A section's properties sit in the pPr of its last paragraph; the last section's in the body.
  const ending = elements(body).find(
    (element) => element.name === "w:p" && child(child(element, "w:pPr") ?? EMPTY, "w:sectPr"),
  );
  const sectPr =
    (ending && child(child(ending, "w:pPr") ?? EMPTY, "w:sectPr")) ?? child(body, "w:sectPr");
  if (!sectPr) return null;
  const width = Number(child(sectPr, "w:pgSz")?.attrs["w:w"]);
  const margins = child(sectPr, "w:pgMar")?.attrs ?? {};
  const left = Number(margins["w:left"] ?? 0) || 0;
  const right = Number(margins["w:right"] ?? 0) || 0;
  const gutter = Number(margins["w:gutter"] ?? 0) || 0;
  if (!Number.isFinite(width) || width <= 0) return null;
  const text = width - left - right - gutter;
  return text > 0 ? Math.round((text / 20) * 100) / 100 : null;
}
