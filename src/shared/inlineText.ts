import { INLINE_NODE } from "./sentences";

export type InlineTextPiece =
  | { kind: "text"; text: string; from: number; to: number }
  | { kind: "citation" | "break"; from: number; to: number }
  | { kind: "atom"; shown?: string; from: number; to: number };

export interface InlineTextProjection {
  text: string;
  rawText: string;
  starts: (number | null)[];
  ends: (number | null)[];
  rawStarts: (number | null)[];
  rawEnds: (number | null)[];
}

export function projectInlineText(pieces: readonly InlineTextPiece[]): InlineTextProjection {
  const projection: InlineTextProjection = {
    text: "",
    rawText: "",
    starts: [],
    ends: [],
    rawStarts: [],
    rawEnds: [],
  };
  for (const piece of pieces) {
    const raw = projection.rawText.length;
    projection.rawText +=
      piece.kind === "text" ? piece.text : piece.kind === "break" ? "\n" : INLINE_NODE;
    if (piece.kind === "citation") continue;
    const words =
      piece.kind === "text"
        ? piece.text
        : piece.kind === "atom"
          ? (piece.shown ?? INLINE_NODE)
          : "\n";
    if (piece.kind === "text") {
      for (let index = 0; index < words.length; index++) {
        projection.starts.push(piece.from + index);
        projection.ends.push(piece.from + index + 1);
        projection.rawStarts.push(raw + index);
        projection.rawEnds.push(raw + index + 1);
      }
    } else {
      for (let index = 0; index < words.length; index++) {
        projection.starts.push(index === 0 ? piece.from : null);
        projection.ends.push(index === words.length - 1 ? piece.to : null);
        projection.rawStarts.push(index === 0 ? raw : null);
        projection.rawEnds.push(index === words.length - 1 ? raw + 1 : null);
      }
    }
    projection.text += words;
  }
  let at = 0;
  for (const character of projection.text) {
    if (character.length === 2) {
      projection.ends[at] = null;
      projection.rawEnds[at] = null;
      projection.starts[at + 1] = null;
      projection.rawStarts[at + 1] = null;
    }
    at += character.length;
  }
  return projection;
}

export function inlineRange(
  projection: InlineTextProjection,
  start: number,
  end: number,
): { from: number; to: number } | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
    return null;
  const from = projection.starts[start];
  const to = projection.ends[end - 1];
  return typeof from === "number" && typeof to === "number" ? { from, to } : null;
}

export function inlineSpan(
  projection: InlineTextProjection,
  from: number,
  to: number,
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from)
    return null;
  const start = projection.rawStarts.indexOf(from);
  const end = projection.rawEnds.indexOf(to) + 1;
  return start >= 0 && end > start && inlineRange(projection, start, end) ? { start, end } : null;
}

/** Keeps raw coordinates relative to the original Block when selecting a sentence's checked text. */
export function sliceInlineText(
  projection: InlineTextProjection,
  start: number,
  end: number,
): InlineTextProjection | null {
  if (!inlineRange(projection, start, end)) return null;
  return {
    text: projection.text.slice(start, end),
    rawText: projection.rawText,
    starts: projection.starts.slice(start, end),
    ends: projection.ends.slice(start, end),
    rawStarts: projection.rawStarts.slice(start, end),
    rawEnds: projection.rawEnds.slice(start, end),
  };
}
