/**
 * Unified deck patch application for AI-proposed changes (#149 part 2): applies targeted text,
 * table-cell, position/size, speaker-notes, single-series chart, autofit, and Citation tag/cell-note
 * edits through the exact same package-patch layer as hand editing, so every untouched shape,
 * slide, and package part remains byte-identical.
 */
import type { DeckChange, DeckCitationRecord } from "../../decks/proposalTypes";
import { child, elements, local, walk, type XmlElement } from "../../documents/formats/xml";
import { openPackage, type ZipArchive } from "../../documents/formats/zip";
import { PackagePartError } from "../packagePatch/package";
import { chartPartOfShape, setChartSeriesValues, workbookPart } from "./charts";
import { Deck, PRESENTATION_RELATIONSHIPS } from "./deck";
import { setCellRuns, setShapeBox, setShapeRuns } from "./edits";
import { setNotes } from "./notes";
import type { EditedParagraph, EditedRun } from "./shapeEdit";
import { readShapeTags, setShapeTags, shapesById } from "./shapes";

export type { DeckChange, DeckCitationRecord };

/** Tag name under `p:custDataLst/p:tags` storing IncarnaMind Citations on a shape (#149). */
export const CITATION_TAG_NAME = "INCARNAMIND_CITES";

/** Author name on Excel cell notes written into a chart's embedded workbook (#149). */
export const CITATION_NOTE_AUTHOR = "IncarnaMind";

/** Formats one or more Citations as a plain-text cell note for Excel / PowerPoint Edit Data. */
export function formatCellCitationNote(citations: readonly DeckCitationRecord[]): string {
  return citations
    .map((cite) => {
      const place = cite.location ? `${cite.document}, ${cite.location}` : cite.document;
      return `IncarnaMind Citation: ${place} — "${cite.quote}"`;
    })
    .join("\n");
}

/** Parses Citations stored in a shape's `INCARNAMIND_CITES` tag; returns [] if absent or invalid. */
export function parseShapeCitations(tags: Readonly<Record<string, string>>): DeckCitationRecord[] {
  const raw = tags[CITATION_TAG_NAME];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DeckCitationRecord =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).document === "string" &&
        typeof (item as Record<string, unknown>).quote === "string",
    );
  } catch {
    return [];
  }
}

const PIECE_NAMES = new Set(["r", "br", "fld"]);

interface ExistingPiece {
  at: number;
  kind: "r" | "br" | "fld";
  text: string;
}

function piecesOfParagraph(paragraph: XmlElement): ExistingPiece[] {
  const pieces = elements(paragraph).filter((each) => PIECE_NAMES.has(local(each.name)));
  return pieces.map((piece, at) => {
    const kind = local(piece.name) as "r" | "br" | "fld";
    if (kind === "br") return { at, kind, text: "\n" };
    const t = child(piece, "t");
    const text = t ? t.children.filter((each) => typeof each === "string").join("") : "";
    return { at, kind, text };
  });
}

function paragraphsOfTxBody(txBody: XmlElement | undefined): ExistingPiece[][] {
  if (!txBody) return [];
  return elements(txBody)
    .filter((each) => local(each.name) === "p")
    .map(piecesOfParagraph);
}

function splitLinesWithSource(text: string, source: EditedRun["source"]): EditedRun[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const out: EditedRun[] = [];
  for (const [lineIdx, line] of lines.entries()) {
    if (lineIdx > 0) out.push({ source: null, text: "\n" });
    if (line !== "") out.push({ source, text: line });
  }
  return out;
}

/**
 * Maps proposed plain paragraphs onto existing XML runs, fields, and line breaks (#149 M2):
 * - Unchanged paragraphs keep every piece's source verbatim so `writtenInPlace` keeps their XML byte-for-byte.
 * - Changed paragraphs keep untouched prefix/suffix pieces (bold, links, slide-number fields, line breaks)
 *   and place the edited middle inside the run where the change begins.
 */
function editedParagraphsFor(
  existing: readonly ExistingPiece[][],
  paragraphs: readonly string[],
): EditedParagraph[] {
  const list = paragraphs.length > 0 ? paragraphs : [""];
  const fallbackParagraphIndex = existing.length > 0 ? existing.length - 1 : null;
  const fallbackRun =
    fallbackParagraphIndex !== null
      ? (existing[fallbackParagraphIndex]?.find((piece) => piece.kind === "r") ??
        existing[fallbackParagraphIndex]?.[0] ??
        null)
      : null;
  const fallbackSource: EditedRun["source"] =
    fallbackParagraphIndex !== null && fallbackRun
      ? { paragraph: fallbackParagraphIndex, run: fallbackRun.at }
      : null;
  return list.map((newText, index) => {
    const existingPieces = index < existing.length ? (existing[index] ?? []) : null;
    if (!existingPieces) {
      return {
        source: fallbackParagraphIndex,
        runs: splitLinesWithSource(newText, fallbackSource),
      };
    }

    const shown = existingPieces.filter((piece) => piece.text !== "");
    const oldText = shown.map((piece) => piece.text).join("");
    if (newText === oldText) {
      return {
        source: index,
        runs:
          shown.length > 0
            ? shown.map((piece) => ({
                source: { paragraph: index, run: piece.at },
                text: piece.text,
              }))
            : [
                {
                  source: existingPieces[0]
                    ? { paragraph: index, run: existingPieces[0].at }
                    : null,
                  text: "",
                },
              ],
      };
    }

    // Locate longest common prefix and non-overlapping longest common suffix.
    let prefixLen = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) prefixLen += 1;

    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen += 1;
    }

    const oldMidStart = prefixLen;
    const oldMidEnd = oldText.length - suffixLen;
    const newMid = newText.slice(prefixLen, newText.length - suffixLen);

    // Compute piece spans in oldText.
    const spans: Array<{ piece: ExistingPiece; start: number; end: number }> = [];
    let offset = 0;
    for (const piece of shown) {
      spans.push({ piece, start: offset, end: offset + piece.text.length });
      offset += piece.text.length;
    }

    // Fast path: edit falls strictly inside a single regular run (no newlines added) -> keep in-place!
    if (!newMid.includes("\n")) {
      const targetSpan = spans.find(
        (span) => span.piece.kind === "r" && oldMidStart >= span.start && oldMidEnd <= span.end,
      );
      if (targetSpan) {
        const updatedText =
          targetSpan.piece.text.slice(0, oldMidStart - targetSpan.start) +
          newMid +
          targetSpan.piece.text.slice(oldMidEnd - targetSpan.start);
        if (updatedText !== "") {
          return {
            source: index,
            runs: spans.map((span) => ({
              source: { paragraph: index, run: span.piece.at },
              text: span === targetSpan ? updatedText : span.piece.text,
            })),
          };
        }
      }
    }

    // General path: emit untouched prefix pieces, edited middle on nearest regular run, then untouched suffix pieces.
    const runs: EditedRun[] = [];
    let midRunSource: EditedRun["source"] = null;
    for (const span of spans) {
      if (span.end <= oldMidStart) {
        runs.push({ source: { paragraph: index, run: span.piece.at }, text: span.piece.text });
        if (span.piece.kind === "r") midRunSource = { paragraph: index, run: span.piece.at };
      } else if (span.start < oldMidStart) {
        const keep = span.piece.text.slice(0, oldMidStart - span.start);
        if (keep !== "") {
          runs.push({ source: { paragraph: index, run: span.piece.at }, text: keep });
        }
        if (span.piece.kind === "r") midRunSource = { paragraph: index, run: span.piece.at };
      }
    }
    if (!midRunSource) {
      const overlapping = spans.find(
        (span) => span.piece.kind === "r" && span.end > oldMidStart && span.start <= oldMidEnd,
      );
      const fallback = existingPieces.find((piece) => piece.kind === "r");
      const chosen = overlapping?.piece ?? fallback;
      midRunSource = chosen ? { paragraph: index, run: chosen.at } : null;
    }
    if (newMid !== "") {
      runs.push(...splitLinesWithSource(newMid, midRunSource));
    }
    for (const span of spans) {
      if (span.start >= oldMidEnd) {
        runs.push({ source: { paragraph: index, run: span.piece.at }, text: span.piece.text });
      } else if (span.end > oldMidEnd) {
        const keep = span.piece.text.slice(oldMidEnd - span.start);
        if (keep !== "") {
          runs.push({ source: { paragraph: index, run: span.piece.at }, text: keep });
        }
      }
    }
    return {
      source: index,
      runs: runs.length > 0 ? runs : [{ source: midRunSource, text: "" }],
    };
  });
}

async function existingShapeParagraphs(
  deck: Deck,
  slidePart: string,
  shapeId: string,
): Promise<ExistingPiece[][]> {
  const part = await deck.pkg.part(slidePart);
  if (!part) return [];
  const shape = shapesById(part.root, shapeId).find((each) => local(each.name) === "sp");
  return paragraphsOfTxBody(shape && child(shape, "txBody"));
}

async function existingCellParagraphs(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  row: number,
  column: number,
): Promise<ExistingPiece[][]> {
  const part = await deck.pkg.part(slidePart);
  if (!part) return [];
  const frame = shapesById(part.root, shapeId).find((each) => local(each.name) === "graphicFrame");
  const table = frame && [...walk(frame)].find((each) => local(each.name) === "tbl");
  const tr = table && elements(table).filter((each) => local(each.name) === "tr")[row];
  const tc = tr && elements(tr).filter((each) => local(each.name) === "tc")[column];
  return paragraphsOfTxBody(tc && child(tc, "txBody"));
}

const sameStored = (a: ZipArchive, b: ZipArchive, name: string) => {
  const x = a.raw(name);
  const y = b.raw(name);
  return (
    x !== undefined &&
    y !== undefined &&
    x.crc32 === y.crc32 &&
    x.size === y.size &&
    Buffer.from(x.data).equals(Buffer.from(y.data))
  );
};

/**
 * Counts slides whose stored bytes (slide XML, notes slide, or charts it references) changed
 * versus slides kept byte-for-byte identical.
 */
export async function countChangedSlides(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): Promise<{ totalSlides: number; changedSlides: number; unchangedSlides: number }> {
  const before = openPackage(beforeBytes);
  const after = openPackage(afterBytes);
  const deck = Deck.open(afterBytes);
  const slides = await deck.slides();
  let changed = 0;
  for (const slide of slides) {
    let differs = !sameStored(before, after, slide.part);
    if (!differs && slide.notes) {
      differs = !sameStored(before, after, slide.notes);
    }
    if (!differs) {
      const rels = await deck.pkg.relationshipsOf(slide.part);
      for (const rel of rels.existing) {
        if (rel.external) continue;
        if (
          rel.type === PRESENTATION_RELATIONSHIPS.chart ||
          rel.type === PRESENTATION_RELATIONSHIPS.tags
        ) {
          if (!sameStored(before, after, rel.target)) {
            differs = true;
            break;
          }
          if (rel.type === PRESENTATION_RELATIONSHIPS.chart) {
            const embedded = await workbookPart(deck, rel.target);
            if (embedded && !sameStored(before, after, embedded)) {
              differs = true;
              break;
            }
          }
        }
      }
    }
    if (differs) changed += 1;
  }
  return {
    totalSlides: slides.length,
    changedSlides: changed,
    unchangedSlides: slides.length - changed,
  };
}

export interface AppliedDeckChanges {
  bytes: Uint8Array;
  totalSlides: number;
  changedSlides: number;
  unchangedSlides: number;
}

/**
 * Applies targeted AI changes to a deck's bytes through the package-patch layer, keeping every
 * untouched part byte-identical and returning the slide change receipt counts (#149 part 2).
 */
export async function applyDeckChanges(
  bytes: Uint8Array,
  changes: readonly DeckChange[],
): Promise<AppliedDeckChanges> {
  const deck = Deck.open(bytes);
  const slides = await deck.slides();
  for (const change of changes) {
    const slide = slides.find((each) => each.number === change.slide);
    if (!slide) {
      throw new PackagePartError(await deck.presentationPart(), `has no slide ${change.slide}.`);
    }
    if (change.kind === "text") {
      const existing = await existingShapeParagraphs(deck, slide.part, change.shape);
      await setShapeRuns(
        deck,
        slide.part,
        change.shape,
        editedParagraphsFor(existing, change.paragraphs),
        change.fit,
      );
      const nextCitations = change.citations ?? [];
      const currentTags = await readShapeTags(deck, slide.part, change.shape);
      const hadCitations = parseShapeCitations(currentTags).length > 0;
      if (nextCitations.length > 0 || hadCitations) {
        await setShapeTags(deck, slide.part, change.shape, {
          [CITATION_TAG_NAME]: JSON.stringify(nextCitations),
        });
      }
    } else if (change.kind === "cell") {
      const existing = await existingCellParagraphs(
        deck,
        slide.part,
        change.shape,
        change.row,
        change.column,
      );
      await setCellRuns(
        deck,
        slide.part,
        change.shape,
        change.row,
        change.column,
        editedParagraphsFor(existing, change.paragraphs),
      );
      const existingCitations = parseShapeCitations(
        await readShapeTags(deck, slide.part, change.shape),
      );
      const otherCells = existingCitations.filter(
        (each) => each.row !== change.row || each.column !== change.column,
      );
      const stamped = (change.citations ?? []).map((each) => ({
        ...each,
        row: change.row,
        column: change.column,
      }));
      const merged = [...otherCells, ...stamped];
      if (merged.length > 0 || existingCitations.length > 0) {
        await setShapeTags(deck, slide.part, change.shape, {
          [CITATION_TAG_NAME]: JSON.stringify(merged),
        });
      }
    } else if (change.kind === "box") {
      await setShapeBox(deck, slide.part, change.shape, change.box);
    } else if (change.kind === "notes") {
      await setNotes(deck, slide.part, change.paragraphs);
    } else {
      const chartPart = await chartPartOfShape(deck, slide.part, change.shape);
      if (!chartPart) {
        throw new PackagePartError(slide.part, `has no chart on shape ${change.shape}.`);
      }
      const notes = change.pointCitations
        ?.filter((entry) => entry.citations.length > 0)
        .map((entry) => ({
          pointIndex: entry.pointIndex,
          author: CITATION_NOTE_AUTHOR,
          text: formatCellCitationNote(entry.citations),
        }));
      await setChartSeriesValues(deck, chartPart, change.series, change.values, { notes });
    }
  }
  const out = await deck.save();
  const counts = await countChangedSlides(bytes, out);
  return { bytes: out, ...counts };
}
