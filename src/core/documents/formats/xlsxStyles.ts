/**
 * An Excel workbook's cell styles, for the sheet preview (ADR-0011): each
 * cell format (`cellXfs`) resolved to its font, fill, borders, alignment and
 * number format, with theme and indexed colours turned into #RRGGBB. Read
 * from styles.xml and the theme with our own XML reader. Pure.
 */
import { INDEXED_COLORS } from "./numberDisplay";
import { builtInFormat } from "./numbers";
import { child, descendants, elements, is, type XmlElement } from "./xml";

export interface FontStyle {
  name?: string;
  /** In points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: "single" | "double";
  strike?: boolean;
  /** #RRGGBB; undefined is automatic (black). */
  color?: string;
  vertAlign?: "superscript" | "subscript";
}

export interface BorderEdge {
  /** Excel's line style: thin, medium, thick, dashed, dotted, double, hair, … */
  style: string;
  color: string;
}

export interface CellStyle {
  font: FontStyle;
  /** A CSS background: a colour, or a gradient. */
  fill?: string;
  border: { left?: BorderEdge; right?: BorderEdge; top?: BorderEdge; bottom?: BorderEdge };
  /** general, left, center, right, fill, justify, centerContinuous, distributed. */
  horizontal?: string;
  /** top, center, bottom (Excel's default), justify, distributed. */
  vertical?: string;
  wrap?: boolean;
  /** Indent levels. */
  indent?: number;
  /** Excel's textRotation: 0–90 up, 91–180 down, 255 stacked. */
  rotation?: number;
  numberFormat?: { code: string; builtIn?: number };
}

export interface WorkbookStyles {
  /** By cell format index, as cells' `s` attributes give it. */
  cells: CellStyle[];
  /** The workbook's default font: its Normal style's (fonts[0]). */
  defaultFont: FontStyle;
  /** Resolves a colour element (fonts, fills, borders, tab colours, drawings' own colours aside). */
  color(element: XmlElement | undefined): string | undefined;
}

/** The theme's colours in Excel's index order: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink. */
export function themeColors(theme: XmlElement | undefined): string[] {
  const scheme = theme ? descendants(theme, "clrScheme")[0] : undefined;
  if (!scheme) return [];
  const value = (name: string) => {
    const slot = child(scheme, name);
    const color = slot ? elements(slot)[0] : undefined;
    if (!color) return "000000";
    return (is(color, "sysClr") ? color.attrs.lastClr : color.attrs.val) ?? "000000";
  };
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4"];
  return [...order, "accent5", "accent6", "hlink", "folHlink"].map(value);
}

/** The theme's fonts: its major (headings) and minor (body) Latin typefaces. */
export function themeFonts(theme: XmlElement | undefined): { major?: string; minor?: string } {
  const scheme = theme ? descendants(theme, "fontScheme")[0] : undefined;
  const typeface = (name: string) => {
    const font = scheme ? child(scheme, name) : undefined;
    return (font && child(font, "latin")?.attrs.typeface) || undefined;
  };
  return { major: typeface("majorFont"), minor: typeface("minorFont") };
}

/** Lightens (tint > 0) or darkens (tint < 0) a colour, as Excel tints theme colours. */
export function tint(hex: string, amount: number): string {
  if (!amount) return hex;
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = amount < 0 ? l * (1 + amount) : l * (1 - amount) + amount;
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let channels: number[];
  if (s === 0) channels = [l, l, l];
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    channels = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  return channels
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}

/** Resolves colours against a workbook's theme and palette. */
export function colorResolver(
  theme: readonly string[],
  palette: readonly string[],
): (element: XmlElement | undefined) => string | undefined {
  return (element) => {
    if (!element || element.attrs.auto === "1" || element.attrs.auto === "true") return undefined;
    let hex: string | undefined;
    const { rgb, theme: themeIndex, indexed } = element.attrs;
    if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) hex = rgb.slice(-6);
    else if (themeIndex !== undefined) hex = theme[Number(themeIndex)];
    else if (indexed !== undefined) {
      const index = Number(indexed);
      // 64 and 65 are the system's foreground and background: automatic.
      if (index >= 64) return undefined;
      hex = palette[index];
    }
    if (!hex) return undefined;
    const amount = Number(element.attrs.tint ?? 0);
    return `#${tint(hex.toUpperCase(), Number.isFinite(amount) ? amount : 0)}`;
  };
}

const flag = (element: XmlElement | undefined) =>
  element !== undefined && !["0", "false"].includes(element.attrs.val ?? "1");

/** A `<font>` or a rich-text run's `<rPr>`. */
export function readFont(
  font: XmlElement,
  color: (element: XmlElement | undefined) => string | undefined,
): FontStyle {
  const style: FontStyle = {};
  const name = (child(font, "name") ?? child(font, "rFont"))?.attrs.val;
  if (name) style.name = name;
  const size = Number(child(font, "sz")?.attrs.val);
  if (Number.isFinite(size) && size > 0) style.size = size;
  if (flag(child(font, "b"))) style.bold = true;
  if (flag(child(font, "i"))) style.italic = true;
  if (flag(child(font, "strike"))) style.strike = true;
  const underline = child(font, "u");
  if (underline && underline.attrs.val !== "none") {
    style.underline = (underline.attrs.val ?? "single").startsWith("double") ? "double" : "single";
  }
  const fontColor = color(child(font, "color"));
  if (fontColor) style.color = fontColor;
  const vertical = child(font, "vertAlign")?.attrs.val;
  if (vertical === "superscript" || vertical === "subscript") style.vertAlign = vertical;
  return style;
}

/** How much of the foreground colour each pattern shows, to draw it as one blended colour. */
const PATTERN_DENSITY: Readonly<Record<string, number>> = {
  darkGray: 0.75,
  mediumGray: 0.5,
  lightGray: 0.25,
  gray125: 0.125,
  gray0625: 0.0625,
};

function blend(foreground: string, background: string, amount: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5]
    .map((at) =>
      Math.round(channel(foreground, at) * amount + channel(background, at) * (1 - amount))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

function readFill(
  fill: XmlElement,
  color: (element: XmlElement | undefined) => string | undefined,
): string | undefined {
  const pattern = child(fill, "patternFill");
  if (pattern) {
    const type = pattern.attrs.patternType ?? (child(pattern, "fgColor") ? "solid" : "none");
    if (type === "none") return undefined;
    const foreground = color(child(pattern, "fgColor")) ?? "#000000";
    if (type === "solid") return foreground;
    const background = color(child(pattern, "bgColor")) ?? "#FFFFFF";
    return blend(foreground, background, PATTERN_DENSITY[type] ?? 0.5);
  }
  const gradient = child(fill, "gradientFill");
  if (gradient) {
    const stops = elements(gradient)
      .filter((each) => is(each, "stop"))
      .map((stop) => ({
        at: Number(stop.attrs.position ?? 0) * 100,
        color: color(child(stop, "color")) ?? "#FFFFFF",
      }));
    if (stops.length === 0) return undefined;
    if (gradient.attrs.type === "path") return stops[0]?.color;
    // Excel's degree turns from left to right; CSS's from bottom to top.
    const degree = Number(gradient.attrs.degree ?? 0) + 90;
    return `linear-gradient(${degree}deg, ${stops.map((stop) => `${stop.color} ${stop.at}%`).join(", ")})`;
  }
  return undefined;
}

function readBorder(
  border: XmlElement,
  color: (element: XmlElement | undefined) => string | undefined,
): CellStyle["border"] {
  const edges: CellStyle["border"] = {};
  for (const side of ["left", "right", "top", "bottom"] as const) {
    // Right-to-left writers say start and end.
    const edge = child(border, side) ?? child(border, side === "left" ? "start" : "end");
    const style = edge?.attrs.style;
    if (!edge || !style || style === "none") continue;
    edges[side] = { style, color: color(child(edge, "color")) ?? "#000000" };
  }
  return edges;
}

/** The cell styles (by their index in `cellXfs`) whose font strikes text through. */
export function struckStyles(styles: XmlElement | undefined): Set<number> {
  const fonts = styles ? child(styles, "fonts") : undefined;
  const xfs = styles ? child(styles, "cellXfs") : undefined;
  const struck = (fonts ? elements(fonts) : []).map((font) => flag(child(font, "strike")));
  const ids = new Set<number>();
  (xfs ? elements(xfs) : []).forEach((xf, index) => {
    if (struck[Number(xf.attrs.fontId ?? 0)]) ids.add(index);
  });
  return ids;
}

/** A workbook's cell styles, from styles.xml and its theme (either may be missing). */
export function readStyles(
  styles: XmlElement | undefined,
  theme: XmlElement | undefined,
): WorkbookStyles {
  const palette = [...INDEXED_COLORS];
  const indexed = styles ? descendants(styles, "indexedColors")[0] : undefined;
  if (indexed) {
    elements(indexed).forEach((each, index) => {
      const rgb = each.attrs.rgb;
      if (rgb && index < palette.length) palette[index] = rgb.slice(-6);
    });
  }
  const color = colorResolver(themeColors(theme), palette);
  const fonts = theme ? themeFonts(theme) : {};
  const list = (name: string) => {
    const container = styles ? child(styles, name) : undefined;
    return container ? elements(container) : [];
  };
  const fontList = list("fonts").map((font) => {
    const read = readFont(font, color);
    // A scheme font follows the theme's typeface.
    const scheme = child(font, "scheme")?.attrs.val;
    const themed = scheme === "major" ? fonts.major : scheme === "minor" ? fonts.minor : undefined;
    return themed ? { ...read, name: themed } : read;
  });
  const fillList = list("fills").map((fill) => readFill(fill, color));
  const borderList = list("borders").map((border) => readBorder(border, color));
  const custom = new Map<number, string>();
  for (const format of styles ? descendants(styles, "numFmt") : []) {
    custom.set(Number(format.attrs.numFmtId), format.attrs.formatCode ?? "");
  }
  const defaultFont: FontStyle = fontList[0] ?? { name: "Calibri", size: 11 };
  const cells = list("cellXfs").map((xf): CellStyle => {
    const style: CellStyle = {
      font: fontList[Number(xf.attrs.fontId ?? 0)] ?? defaultFont,
      border: borderList[Number(xf.attrs.borderId ?? 0)] ?? {},
    };
    const fill = fillList[Number(xf.attrs.fillId ?? 0)];
    if (fill) style.fill = fill;
    const id = Number(xf.attrs.numFmtId ?? 0);
    const code = custom.get(id) ?? builtInFormat(id);
    if (code && id !== 0) {
      style.numberFormat = { code, ...(custom.has(id) ? {} : { builtIn: id }) };
    }
    const alignment = child(xf, "alignment");
    if (alignment) {
      const { horizontal, vertical, wrapText, indent, textRotation } = alignment.attrs;
      if (horizontal) style.horizontal = horizontal;
      if (vertical) style.vertical = vertical;
      if (wrapText === "1" || wrapText === "true") style.wrap = true;
      if (Number(indent) > 0) style.indent = Number(indent);
      if (Number(textRotation) > 0) style.rotation = Number(textRotation);
    }
    return style;
  });
  return { cells, defaultFont, color };
}
