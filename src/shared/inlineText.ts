import { CALCULATED_FIGURE_NODE, CITATION_NODE } from "../core/api";
import type { NodeJSON } from "./blockJson";
import { readCalculatedFigureEvidence } from "./calculatedFigures";
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

// A projection is never changed once made, so where each raw offset first is in it is worked out
// once, and a paragraph of many sentences costs no more than its length (#2512).
const firstPlaces = new WeakMap<
  InlineTextProjection,
  { starts: Map<number, number>; ends: Map<number, number> }
>();

function placesOf(projection: InlineTextProjection) {
  let places = firstPlaces.get(projection);
  if (places) return places;
  const firstOf = (offsets: readonly (number | null)[]) => {
    const first = new Map<number, number>();
    offsets.forEach((offset, index) => {
      if (offset !== null && !first.has(offset)) first.set(offset, index);
    });
    return first;
  };
  places = { starts: firstOf(projection.rawStarts), ends: firstOf(projection.rawEnds) };
  firstPlaces.set(projection, places);
  return places;
}

export function inlineSpan(
  projection: InlineTextProjection,
  from: number,
  to: number,
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from)
    return null;
  const places = placesOf(projection);
  const start = places.starts.get(from) ?? -1;
  const end = (places.ends.get(to) ?? -1) + 1;
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

/** Each inline node of a Block's content, where it starts: a text node takes its length, any other one. */
export function inlineLayout(content: readonly NodeJSON[]): { node: NodeJSON; start: number }[] {
  let at = 0;
  return content.map((node) => {
    const start = at;
    at += node.type === "text" ? (node.text ?? "").length : 1;
    return { node, start };
  });
}

/** A Block's inline content as checks read it: the pieces, and their text with the Citations left out. */
export function projectedContent(content: readonly NodeJSON[]) {
  const pieces = inlineLayout(content).map(({ node, start }): InlineTextPiece => {
    const place = {
      from: start,
      to: start + (node.type === "text" ? (node.text ?? "").length : 1),
    };
    if (node.type === "text") return { kind: "text", text: node.text ?? "", ...place };
    if (node.type === CITATION_NODE) return { kind: "citation", ...place };
    if (node.type === "hardBreak") return { kind: "break", ...place };
    const figure =
      node.type === CALCULATED_FIGURE_NODE ? readCalculatedFigureEvidence(node.attrs ?? {}) : null;
    return { kind: "atom", ...place, ...(figure && { shown: figure.figure.shown }) };
  });
  return { pieces, projection: projectInlineText(pieces) };
}
