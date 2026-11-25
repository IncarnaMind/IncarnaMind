/**
 * Unified deck patch application for AI-proposed changes (#149 part 2): applies targeted text,
 * table-cell, position/size, speaker-notes, single-series chart, autofit, and Citation tag/cell-note
 * edits through the exact same package-patch layer as hand editing, so every untouched shape,
 * slide, and package part remains byte-identical.
 */
import type { DeckChange, DeckCitationRecord } from "../../decks/proposalTypes";
import { child, elements, local, walk } from "../../documents/formats/xml";
import { openPackage, type ZipArchive } from "../../documents/formats/zip";
import { PackagePartError } from "../packagePatch/package";
import { chartPartOfShape, setChartSeriesValues } from "./charts";
import { Deck, PRESENTATION_RELATIONSHIPS } from "./deck";
import { setCellRuns, setShapeBox, setShapeRuns } from "./edits";
import { setNotes } from "./notes";
import type { EditedParagraph } from "./shapeEdit";
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

/** Builds `EditedParagraph[]` that preserve the target text body's paragraph & first-run formatting. */
function editedParagraphsFor(
  existingParagraphCount: number,
  paragraphs: readonly string[],
): EditedParagraph[] {
  const list = paragraphs.length > 0 ? paragraphs : [""];
  return list.map((text, index) => {
    const sourceParagraph = index < existingParagraphCount ? index : null;
    const lines = text.split("\n");
    const runs: EditedParagraph["runs"] = [];
    for (const [lineIdx, line] of lines.entries()) {
      if (lineIdx > 0) runs.push({ source: null, text: "\n" });
      if (line !== "" || lines.length === 1) {
        runs.push({
          source:
            lineIdx === 0 && sourceParagraph !== null
              ? { paragraph: sourceParagraph, run: 0 }
              : null,
          text: line,
        });
      }
    }
    return { source: sourceParagraph, runs };
  });
}

async function existingShapeParagraphCount(
  deck: Deck,
  slidePart: string,
  shapeId: string,
): Promise<number> {
  const part = await deck.pkg.part(slidePart);
  if (!part) return 0;
  const shape = shapesById(part.root, shapeId).find((each) => local(each.name) === "sp");
  const txBody = shape && child(shape, "txBody");
  return txBody ? elements(txBody).filter((each) => local(each.name) === "p").length : 0;
}

async function existingCellParagraphCount(
  deck: Deck,
  slidePart: string,
  shapeId: string,
  row: number,
  column: number,
): Promise<number> {
  const part = await deck.pkg.part(slidePart);
  if (!part) return 0;
  const frame = shapesById(part.root, shapeId).find((each) => local(each.name) === "graphicFrame");
  const table = frame && [...walk(frame)].find((each) => local(each.name) === "tbl");
  const tr = table && elements(table).filter((each) => local(each.name) === "tr")[row];
  const tc = tr && elements(tr).filter((each) => local(each.name) === "tc")[column];
  const txBody = tc && child(tc, "txBody");
  return txBody ? elements(txBody).filter((each) => local(each.name) === "p").length : 0;
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
      const count = await existingShapeParagraphCount(deck, slide.part, change.shape);
      await setShapeRuns(
        deck,
        slide.part,
        change.shape,
        editedParagraphsFor(count, change.paragraphs),
        change.fit,
      );
      if (change.citations && change.citations.length > 0) {
        const existing = parseShapeCitations(await readShapeTags(deck, slide.part, change.shape));
        const merged = [...existing, ...change.citations];
        await setShapeTags(deck, slide.part, change.shape, {
          [CITATION_TAG_NAME]: JSON.stringify(merged),
        });
      }
    } else if (change.kind === "cell") {
      const count = await existingCellParagraphCount(
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
        editedParagraphsFor(count, change.paragraphs),
      );
      if (change.citations && change.citations.length > 0) {
        const existing = parseShapeCitations(await readShapeTags(deck, slide.part, change.shape));
        const merged = [...existing, ...change.citations];
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
