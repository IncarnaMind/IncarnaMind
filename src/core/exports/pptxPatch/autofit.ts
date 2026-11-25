/**
 * Core-side text-fit check for proposed deck shape text (#149 part 2): mirrors the slide editor's
 * PowerPoint autofit steps (`normAutofit`, `spAutoFit`, or `none`) so a Proposal knows before
 * anything is written whether proposed text will overflow its box, and what shrink/grow fit
 * keeps every line inside the shape.
 */
import type { Autofit, ShapeItem, Spacing } from "../../documents/formats/pptxDrawing";
import type { ShapeBox, TextFit } from "./shapeEdit";

/** PowerPoint's discrete shrink steps (`a:normAutofit`), largest first. */
export const AUTOFIT_STEPS: readonly { fontScale: number; lineReduction: number }[] = [
  { fontScale: 1, lineReduction: 0 },
  { fontScale: 0.925, lineReduction: 0 },
  { fontScale: 0.85, lineReduction: 0.1 },
  { fontScale: 0.775, lineReduction: 0.1 },
  { fontScale: 0.7, lineReduction: 0.2 },
  { fontScale: 0.625, lineReduction: 0.2 },
  { fontScale: 0.55, lineReduction: 0.2 },
  { fontScale: 0.475, lineReduction: 0.2 },
  { fontScale: 0.4, lineReduction: 0.2 },
  { fontScale: 0.325, lineReduction: 0.2 },
  { fontScale: 0.25, lineReduction: 0.2 },
];

export interface FitAssessment {
  /** Whether the proposed paragraphs overflow the shape's current box at unshrunk scale. */
  overflows: boolean;
  autofitKind: Autofit["kind"];
  /** The fit that keeps every line inside the shape (shrink step, or grown box for spAutoFit). */
  suggestedFit: TextFit | null;
  /** Shrink step that fits the text inside the current box (always available as an option). */
  shrinkFit: Extract<TextFit, { kind: "shrink" }> | null;
  /** Grown box for `spAutoFit` shapes, when growing fits on the slide. */
  growFit: Extract<TextFit, { kind: "grow" }> | null;
}

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
const NARROW = /[il1.,;:'"|!()[\]{}]/;
const WIDE = /[MW@#%&]/;

/** Conservative character advance in em units, slightly padded so estimation never under-counts. */
function charEm(ch: string): number {
  if (ch === " " || ch === "\t") return 0.3;
  if (CJK.test(ch)) return 1.04;
  if (NARROW.test(ch)) return 0.34;
  if (WIDE.test(ch)) return 0.9;
  if (ch >= "A" && ch <= "Z") return 0.72;
  return 0.58;
}

/** Counts wrapped lines for a paragraph inside `widthPx` at `fontSizePx`. */
function wrappedLines(text: string, widthPx: number, fontSizePx: number): number {
  if (widthPx <= 0 || fontSizePx <= 0) return 1;
  let total = 0;
  for (const segment of text.split("\n")) {
    if (segment.length === 0) {
      total += 1;
      continue;
    }
    let lines = 1;
    let cursor = 0;
    const tokens = segment.match(/\S+\s*|\s+/g) ?? [segment];
    for (const token of tokens) {
      let tokenWidth = 0;
      for (const ch of token) tokenWidth += charEm(ch) * fontSizePx;
      if (cursor > 0 && cursor + tokenWidth > widthPx) {
        lines += 1;
        cursor = 0;
      }
      if (tokenWidth <= widthPx) {
        cursor += tokenWidth;
      } else {
        for (const ch of token) {
          const w = charEm(ch) * fontSizePx;
          if (cursor > 0 && cursor + w > widthPx) {
            lines += 1;
            cursor = w;
          } else {
            cursor += w;
          }
        }
      }
    }
    total += lines;
  }
  return Math.max(1, total);
}

function spacingPx(spacing: Spacing | null | undefined, fontSize: number): number {
  if (!spacing) return 0;
  return "px" in spacing ? spacing.px : spacing.percent * fontSize;
}

function lineHeightPx(
  spacing: Spacing | null | undefined,
  fontSize: number,
  lineReduction: number,
  appliedReduction: number,
): number {
  if (!spacing) return fontSize * Math.max(0.85, 1.2 - lineReduction);
  if ("px" in spacing) return Math.max(fontSize * 0.85, spacing.px);
  const unreduced = spacing.percent + appliedReduction;
  return fontSize * Math.max(0.85, unreduced - lineReduction);
}

/**
 * Estimates total vertical height (px) required by `paragraphs` inside a shape's text body
 * at a given `(fontScale, lineReduction)` pair.
 */
function neededHeightPx(
  shape: ShapeItem,
  paragraphs: readonly string[],
  widthPx: number,
  fontScale: number,
  lineReduction: number,
): number {
  const body = shape.text;
  const autofit = body?.autofit ?? { kind: "none", fontScale: 1, lineReduction: 0 };
  const appliedScale = autofit.fontScale > 0 ? autofit.fontScale : 1;
  const existing = body?.paragraphs ?? [];
  const fallbackScaled =
    existing.find((p) => p.runs.length > 0)?.runs[0]?.size ?? existing[0]?.endSize ?? 18;
  let height = 0;
  paragraphs.forEach((text, index) => {
    const template = existing[index] ?? existing.at(-1);
    const scaledSize =
      template?.runs.reduce((max, run) => Math.max(max, run.size), 0) ||
      template?.endSize ||
      fallbackScaled;
    const unshrunkSize = scaledSize / appliedScale;
    const fontSize = unshrunkSize * fontScale;
    const indentPx = (template?.marginLeft ?? 0) + Math.max(0, template?.indent ?? 0);
    const availableWidth = Math.max(fontSize, widthPx - Math.max(0, indentPx));
    const lines = wrappedLines(text, availableWidth, fontSize);
    const lineH = lineHeightPx(
      template?.lineSpacing,
      fontSize,
      lineReduction,
      autofit.lineReduction,
    );
    const spaceBefore = index > 0 ? spacingPx(template?.spaceBefore, fontSize) : 0;
    const spaceAfter =
      index < paragraphs.length - 1 ? spacingPx(template?.spaceAfter, fontSize) : 0;
    height += spaceBefore + lines * lineH + spaceAfter;
  });
  return height;
}

/**
 * Evaluates whether `paragraphs` fit inside `shape`'s box under its autofit kind (`grow`, `shrink`,
 * or `none`), returning the shrink step (and grown box for `spAutoFit`) when it would overflow.
 */
export function assessTextFit(
  shape: ShapeItem,
  paragraphs: readonly string[],
  slideSize?: { width: number; height: number },
): FitAssessment {
  const body = shape.text;
  const autofit = body?.autofit ?? { kind: "none", fontScale: 1, lineReduction: 0 };
  const rect = shape.textBox ?? shape.box;
  const insets = body?.insets ?? { left: 9.6, right: 9.6, top: 4.8, bottom: 4.8 };
  const innerWidth = Math.max(16, rect.w - insets.left - insets.right);
  const innerHeight = Math.max(12, rect.h - insets.top - insets.bottom);

  const naturalHeight = neededHeightPx(shape, paragraphs, innerWidth, 1, 0);
  const overflows = naturalHeight > innerHeight + 0.5;
  if (!overflows) {
    return {
      overflows: false,
      autofitKind: autofit.kind,
      suggestedFit: null,
      shrinkFit: null,
      growFit: null,
    };
  }

  let chosen = AUTOFIT_STEPS.at(-1) ?? { fontScale: 0.25, lineReduction: 0.2 };
  for (const step of AUTOFIT_STEPS) {
    if (
      neededHeightPx(shape, paragraphs, innerWidth, step.fontScale, step.lineReduction) <=
      innerHeight + 0.5
    ) {
      chosen = step;
      break;
    }
  }
  const shrinkFit: Extract<TextFit, { kind: "shrink" }> = {
    kind: "shrink",
    fontScale: chosen.fontScale,
    lineReduction: chosen.lineReduction,
  };
  const grownHeight = Math.ceil(naturalHeight + insets.top + insets.bottom + 2);
  const box: ShapeBox = { x: shape.box.x, y: shape.box.y, w: shape.box.w, h: grownHeight };
  const maxBoxHeight = slideSize
    ? Math.max(shape.box.h, slideSize.height - shape.box.y)
    : grownHeight;
  const growFit: Extract<TextFit, { kind: "grow" }> | null =
    autofit.kind === "grow" && grownHeight <= maxBoxHeight ? { kind: "grow", box } : null;

  return {
    overflows: true,
    autofitKind: autofit.kind,
    suggestedFit: autofit.kind === "grow" && growFit ? growFit : shrinkFit,
    shrinkFit,
    growFit,
  };
}
