/**
 * The font and text size a Mind is written in. Like its model (`mindModel.ts`) and its
 * citation style (`mindCitationStyle.ts`), they live in the Mind's Yjs settings
 * (`MIND_SETTINGS_FIELD`), so they go wherever the Mind goes and its content schema stays as it
 * is. A Mind with no choice is in the default style (`DEFAULT_MIND_STYLE`).
 */
import type * as Y from "yjs";
import { isRecord } from "../core/errors";
import { fontKind } from "./fontKinds";

/** Word's single line spacing for common fonts: a line is this many times the text's size. */
export const SINGLE_LINE = 1.15;

export const FONT_PRESETS = ["default", "serif", "mono"] as const;
export type FontPreset = (typeof FONT_PRESETS)[number];

/** A preset, or a font installed on the computer, by the family name the system gives it. */
export type MindFont = FontPreset | { family: string };

export const TEXT_SIZES = ["small", "default", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/**
 * A Mind's line spacing: its text size's own leading ("default"), or a multiple of a single
 * line, as a paragraph's line spacing is (`SINGLE_LINE`).
 */
export type LineSpacing = "default" | number;

export const LEAST_LINE_SPACING = 0.5;
export const MOST_LINE_SPACING = 5;

export interface MindStyle {
  font: MindFont;
  size: TextSize;
  /** Left out: "default", as a style kept before Minds had a line spacing. */
  lineSpacing?: LineSpacing;
}

export const DEFAULT_MIND_STYLE: MindStyle = { font: "default", size: "default" };

const FONT_KEY = "font";
const SIZE_KEY = "textSize";
const LINE_SPACING_KEY = "lineSpacing";
const MAX_FAMILY_LENGTH = 200;

const hasControlCharacter = (text: string) =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

export const isFontFamily = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= MAX_FAMILY_LENGTH &&
  !hasControlCharacter(value);

export const isFontPreset = (value: unknown): value is FontPreset =>
  FONT_PRESETS.some((preset) => preset === value);

export const isTextSize = (value: unknown): value is TextSize =>
  TEXT_SIZES.some((size) => size === value);

export const isLineSpacing = (value: unknown): value is LineSpacing =>
  value === "default" ||
  (typeof value === "number" && value >= LEAST_LINE_SPACING && value <= MOST_LINE_SPACING);

export const lineSpacingOf = (style: MindStyle): LineSpacing => style.lineSpacing ?? "default";

export function isMindFont(value: unknown): value is MindFont {
  if (isFontPreset(value)) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "family" && isFontFamily(value.family);
}

export function isMindStyle(value: unknown): value is MindStyle {
  if (!isRecord(value)) return false;
  const { font, size, lineSpacing, ...rest } = value;
  return (
    Object.keys(rest).length === 0 &&
    isMindFont(font) &&
    isTextSize(size) &&
    (lineSpacing === undefined || isLineSpacing(lineSpacing))
  );
}

export const familyOf = (font: MindFont): string | null =>
  typeof font === "string" ? null : font.family;

export const sameFont = (a: MindFont, b: MindFont): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : a.family === b.family;

export const sameStyle = (a: MindStyle, b: MindStyle): boolean =>
  a.size === b.size && sameFont(a.font, b.font) && lineSpacingOf(a) === lineSpacingOf(b);

/** The style a Mind is in; anything malformed counts as no choice. */
export function mindStyleOf(settings: Y.Map<unknown>): MindStyle {
  const font = settings.get(FONT_KEY);
  const size = settings.get(SIZE_KEY);
  const lineSpacing = settings.get(LINE_SPACING_KEY);
  return {
    font: isMindFont(font) ? font : DEFAULT_MIND_STYLE.font,
    size: isTextSize(size) ? size : DEFAULT_MIND_STYLE.size,
    ...(typeof lineSpacing === "number" && isLineSpacing(lineSpacing) && { lineSpacing }),
  };
}

/** Sets the Mind's style; what is the default is forgotten, so the Mind follows it again. */
export function writeMindStyle(settings: Y.Map<unknown>, style: MindStyle): void {
  if (sameFont(style.font, DEFAULT_MIND_STYLE.font)) {
    if (settings.has(FONT_KEY)) settings.delete(FONT_KEY);
  } else if (!sameFont(mindStyleOf(settings).font, style.font)) {
    settings.set(FONT_KEY, style.font);
  }
  if (style.size === DEFAULT_MIND_STYLE.size) {
    if (settings.has(SIZE_KEY)) settings.delete(SIZE_KEY);
  } else if (settings.get(SIZE_KEY) !== style.size) {
    settings.set(SIZE_KEY, style.size);
  }
  const lineSpacing = lineSpacingOf(style);
  if (lineSpacing === "default") {
    if (settings.has(LINE_SPACING_KEY)) settings.delete(LINE_SPACING_KEY);
  } else if (settings.get(LINE_SPACING_KEY) !== lineSpacing) {
    settings.set(LINE_SPACING_KEY, lineSpacing);
  }
}

/** A name as a CSS string, safe inside a style sheet or a `<style>` element. */
export function cssString(text: string): string {
  const escaped = text.replace(
    /[\\"<>&]/g,
    (character) => `\\${character.charCodeAt(0).toString(16)} `,
  );
  return `"${escaped}"`;
}

/** What Word and HTML exports write for a font: the family's name, or null where the Mind is in the default. */
export function exportedFamily(font: MindFont): string | null {
  if (font === "serif") return "Source Serif 4";
  if (font === "mono") return "JetBrains Mono";
  return familyOf(font);
}

export interface TypeSize {
  size: number;
  leading: number;
}

export interface WritingType {
  /** A CSS `font-family` list. */
  family: string;
  body: TypeSize;
  heading: TypeSize;
  display: TypeSize;
  /** Footnotes, References and table text: a step below the writing, at every size. */
  note: TypeSize;
}

// DESIGN.md › Typography: the writing is 16/26 and a step up in the Serif style, which reads
// smaller (17/28); Small and Large are a step down and up from the default.
const BODY: Record<"serif" | "other", Record<TextSize, TypeSize>> = {
  other: {
    small: { size: 14, leading: 23 },
    default: { size: 16, leading: 26 },
    large: { size: 18, leading: 29 },
  },
  serif: {
    small: { size: 15, leading: 24 },
    default: { size: 17, leading: 28 },
    large: { size: 19, leading: 31 },
  },
};
const HEADING: TypeSize = { size: 22, leading: 30 };
const DISPLAY: TypeSize = { size: 34, leading: 42 };
/** The headings and the title grow with the writing, by the default body size's share. */
const SCALE: Record<TextSize, number> = { small: 14 / 16, default: 1, large: 18 / 16 };

const NOTE_STEP: TypeSize = { size: 1, leading: 2 };

const scaled = (type: TypeSize, factor: number): TypeSize => ({
  size: Math.round(type.size * factor),
  leading: Math.round(type.leading * factor),
});

/**
 * Chinese takes the system face of the same kind as the font (DESIGN.md › Typography): the
 * theme's `--font-system` and `--font-serif` already end in theirs, `--font-mono-writing` in the
 * sans one, and a font installed on the computer is given the one its name says.
 */
export function fontFamilyList(font: MindFont, installed: boolean): string {
  if (font === "default") return "var(--font-system)";
  if (font === "serif") return "var(--font-serif)";
  if (font === "mono") return "var(--font-mono-writing)";
  if (!installed) return "var(--font-system)";
  const chinese =
    fontKind(font.family) === "serif" ? "var(--font-cjk-serif)" : "var(--font-cjk-sans)";
  return `${cssString(font.family)}, ${chinese}, var(--font-system)`;
}

/**
 * The type a Mind is written in. `installed` is whether the Mind's font is on this computer: when
 * it isn't, the Mind is written in the default font.
 */
export function writingType(style: MindStyle, installed: boolean): WritingType {
  const factor = SCALE[style.size];
  const body = BODY[style.font === "serif" ? "serif" : "other"][style.size];
  const lineSpacing = lineSpacingOf(style);
  return {
    family: fontFamilyList(style.font, installed),
    body:
      lineSpacing === "default"
        ? body
        : { size: body.size, leading: Math.round(body.size * SINGLE_LINE * lineSpacing) },
    heading: scaled(HEADING, factor),
    display: scaled(DISPLAY, factor),
    note: { size: body.size - NOTE_STEP.size, leading: body.leading - NOTE_STEP.leading },
  };
}

/**
 * The type scale as the custom properties the Mind's page sets (styles.css): the theme's own
 * sizes for writing, set for this Mind, and the font the writing takes.
 */
export function writingProperties(type: WritingType): Record<`--${string}`, string> {
  return {
    "--writing-font": type.family,
    // A point of the User's formatting, in proportion to the writing: Word export writes its body text at 11 pt.
    "--word-pt": `${type.body.size / 11}px`,
    "--text-body": `${type.body.size}px`,
    "--text-body--line-height": `${type.body.leading}px`,
    "--text-heading": `${type.heading.size}px`,
    "--text-heading--line-height": `${type.heading.leading}px`,
    "--text-display": `${type.display.size}px`,
    "--text-display--line-height": `${type.display.leading}px`,
    "--text-note": `${type.note.size}px`,
    "--text-note--line-height": `${type.note.leading}px`,
  };
}
