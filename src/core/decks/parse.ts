/** A gesture's edits as the window sends them, checked before any is made. */
import { InvalidInputError, isRecord } from "../errors";
import type {
  EditedParagraph,
  EditedRun,
  RunSource,
  ShapeBox,
  ShapeEdit,
  TextFit,
} from "../exports/pptxPatch/shapeEdit";

/** The most edits one gesture makes: a text box and how it follows its text, or a few moves. */
const MAX_EDITS = 64;
const MAX_PARAGRAPHS = 2_000;
const MAX_RUNS = 4_000;
const MAX_TEXT = 200_000;

const invalid = () => new InvalidInputError({ key: "error.deck.badEdit" });

const index = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid();
  return value;
};

const finite = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
  return value;
};

const shapeId = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) throw invalid();
  return value;
};

function box(value: unknown): ShapeBox {
  if (!isRecord(value)) throw invalid();
  const parsed = { x: finite(value.x), y: finite(value.y), w: finite(value.w), h: finite(value.h) };
  if (parsed.w < 0 || parsed.h < 0) throw invalid();
  return parsed;
}

function source(value: unknown): RunSource | null {
  if (value === null) return null;
  if (!isRecord(value)) throw invalid();
  return { paragraph: index(value.paragraph), run: index(value.run) };
}

function run(value: unknown): EditedRun {
  if (!isRecord(value) || typeof value.text !== "string" || value.text.length > MAX_TEXT) {
    throw invalid();
  }
  return { source: source(value.source), text: value.text };
}

function paragraphs(value: unknown): EditedParagraph[] {
  if (!Array.isArray(value) || value.length > MAX_PARAGRAPHS) throw invalid();
  let runs = 0;
  return value.map((each) => {
    if (!isRecord(each) || !Array.isArray(each.runs)) throw invalid();
    runs += each.runs.length;
    if (runs > MAX_RUNS) throw invalid();
    return { source: each.source === null ? null : index(each.source), runs: each.runs.map(run) };
  });
}

function fitOf(value: unknown): TextFit | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalid();
  if (value.kind === "grow") return { kind: "grow", box: box(value.box) };
  if (value.kind === "shrink") {
    const fontScale = finite(value.fontScale);
    const lineReduction = finite(value.lineReduction);
    if (fontScale <= 0 || fontScale > 1 || lineReduction < 0 || lineReduction >= 1) throw invalid();
    return { kind: "shrink", fontScale, lineReduction };
  }
  throw invalid();
}

function edit(value: unknown): ShapeEdit {
  if (!isRecord(value)) throw invalid();
  const slide = index(value.slide);
  const shape = shapeId(value.shape);
  switch (value.kind) {
    case "text": {
      const fitted = fitOf(value.fit);
      return {
        kind: "text",
        slide,
        shape,
        paragraphs: paragraphs(value.paragraphs),
        ...(fitted && { fit: fitted }),
      };
    }
    case "cell":
      return {
        kind: "cell",
        slide,
        shape,
        row: index(value.row),
        column: index(value.column),
        paragraphs: paragraphs(value.paragraphs),
      };
    case "box":
      return { kind: "box", slide, shape, box: box(value.box) };
    default:
      throw invalid();
  }
}

export function parseShapeEdits(value: unknown): ShapeEdit[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITS) throw invalid();
  return value.map(edit);
}
