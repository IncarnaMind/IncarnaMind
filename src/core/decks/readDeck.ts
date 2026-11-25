/**
 * Structured deck reader for connected AI tools (`read_deck`, #149 part 2): inspects a `.pptx`
 * file as slides and shapes with stable `cNvPr` ids, text paragraphs, autofit kinds, tables,
 * charts (with series names, categories, and values), speaker notes, and IncarnaMind Citation tags.
 */
import { hashBytes } from "../documents/files";
import { extractPptx } from "../documents/formats/pptx";
import {
  type Autofit,
  type DeckDrawing,
  drawPptx,
  type Item,
  type ShapeItem,
  type SlideDrawing,
} from "../documents/formats/pptxDrawing";
import { openPackage } from "../documents/formats/zip";
import { chartPartOfShape, chartSeries } from "../exports/pptxPatch/charts";
import { Deck, nonVisualOf } from "../exports/pptxPatch/deck";
import { type DeckCitationRecord, parseShapeCitations } from "../exports/pptxPatch/deckChanges";
import type { ShapeBox } from "../exports/pptxPatch/shapeEdit";
import { readShapeTags, shapeById } from "../exports/pptxPatch/shapes";
import { protectionOf } from "./protection";

export interface DeckChartSeriesSummary {
  index: number;
  name: string | null;
  categories: string[];
  values: (number | null)[];
}

export interface DeckShapeSummary {
  shapeId: string;
  kind: "text" | "table" | "chart" | "picture" | "group";
  name: string;
  title?: true;
  box: ShapeBox;
  autofit?: Autofit["kind"];
  paragraphs?: string[];
  rows?: string[][];
  series?: DeckChartSeriesSummary[];
  citations?: DeckCitationRecord[];
}

export interface DeckSlideSummary {
  slide: number;
  notes: string[];
  shapes: DeckShapeSummary[];
}

export interface ReadDeckResult {
  version: string;
  slideCount: number;
  slideSize: { width: number; height: number } | null;
  editable: boolean;
  refusal: "signed" | "final" | "protected" | "unrewritable" | null;
  slides: DeckSlideSummary[];
}

function paragraphsOfText(body: ShapeItem["text"]): string[] {
  if (!body) return [];
  return body.paragraphs.map((p) =>
    p.runs.map((run) => (run.lineBreak ? "\n" : run.text)).join(""),
  );
}

/** Finds a drawn `ShapeItem` by its stable `shapeId` on a slide (descending into groups). */
export function findDrawnShape(
  drawing: DeckDrawing | null,
  slideNumber: number,
  shapeId: string,
): { shape: ShapeItem; slideSize: { width: number; height: number } } | null {
  if (!drawing) return null;
  const slide = drawing.slides.find(
    (each): each is SlideDrawing => !("failed" in each) && each.number === slideNumber,
  );
  if (!slide) return null;
  const search = (items: readonly Item[], ox: number, oy: number): ShapeItem | null => {
    for (const item of items) {
      if (item.origin !== "slide") continue;
      if (item.kind === "shape" && item.shapeId === shapeId) {
        return ox === 0 && oy === 0
          ? item
          : {
              ...item,
              box: { ...item.box, x: item.box.x + ox, y: item.box.y + oy },
              textBox: item.textBox
                ? { ...item.textBox, x: item.textBox.x + ox, y: item.textBox.y + oy }
                : null,
            };
      }
      if (item.kind === "group") {
        const hit = search(item.children, ox + item.box.x, oy + item.box.y);
        if (hit) return hit;
      }
    }
    return null;
  };
  const found = search(slide.items, 0, 0);
  return found
    ? { shape: found, slideSize: { width: drawing.width, height: drawing.height } }
    : null;
}

/**
 * Reads a `.pptx` file's slides and shapes with stable `cNvPr` ids for `read_deck` and
 * deck-proposal validation (#149 part 2).
 */
export async function readDeckStructure(
  bytes: Uint8Array,
  options?: { slides?: readonly number[] },
): Promise<{ structure: ReadDeckResult; drawing: DeckDrawing | null }> {
  const version = hashBytes(bytes);
  const refusal = await protectionOf(openPackage(bytes));
  const deck = Deck.open(bytes);
  const deckSlides = await deck.slides();
  const extracted = await extractPptx(bytes);
  let drawing: DeckDrawing | null = null;
  try {
    drawing = await drawPptx(bytes);
  } catch {
    drawing = null;
  }

  const wanted = options?.slides ? new Set(options.slides) : null;
  const slides: DeckSlideSummary[] = [];

  for (const deckSlide of deckSlides) {
    if (wanted && !wanted.has(deckSlide.number)) continue;
    const outline = extracted.slides.find((each) => each.number === deckSlide.number);
    const drawnSlide = drawing?.slides.find(
      (each): each is SlideDrawing => !("failed" in each) && each.number === deckSlide.number,
    );
    const slidePart = await deck.pkg.part(deckSlide.part);
    const shapes: DeckShapeSummary[] = [];

    const collect = async (items: readonly Item[], ox: number, oy: number): Promise<void> => {
      for (const item of items) {
        if (item.origin !== "slide" || !item.shapeId) continue;
        const xmlShape = slidePart ? shapeById(slidePart.root, item.shapeId) : undefined;
        const name = (xmlShape && nonVisualOf(xmlShape)?.attrs.name) || "";
        const box: ShapeBox = {
          x: Math.round(item.box.x + ox),
          y: Math.round(item.box.y + oy),
          w: Math.round(item.box.w),
          h: Math.round(item.box.h),
        };
        const tags = await readShapeTags(deck, deckSlide.part, item.shapeId);
        const citations = parseShapeCitations(tags);

        if (item.kind === "shape") {
          shapes.push({
            shapeId: item.shapeId,
            kind: "text",
            name,
            ...(item.title && { title: true }),
            box,
            autofit: item.text?.autofit.kind ?? "none",
            paragraphs: paragraphsOfText(item.text),
            ...(citations.length > 0 && { citations }),
          });
        } else if (item.kind === "table") {
          shapes.push({
            shapeId: item.shapeId,
            kind: "table",
            name,
            box,
            rows: item.rows.map((row) =>
              row.cells.map((cell) => (cell.merged ? "" : paragraphsOfText(cell.text).join("\n"))),
            ),
            ...(citations.length > 0 && { citations }),
          });
        } else if (item.kind === "chart") {
          const chartPart = await chartPartOfShape(deck, deckSlide.part, item.shapeId);
          const series = chartPart
            ? (await chartSeries(deck, chartPart)).map((each) => ({
                index: each.index,
                name: each.name,
                categories: each.categories,
                values: each.points.sort((a, b) => a.idx - b.idx).map((pt) => pt.value),
              }))
            : [];
          shapes.push({
            shapeId: item.shapeId,
            kind: "chart",
            name,
            box,
            series,
            ...(citations.length > 0 && { citations }),
          });
        } else if (item.kind === "picture") {
          shapes.push({
            shapeId: item.shapeId,
            kind: "picture",
            name,
            box,
          });
        } else if (item.kind === "group") {
          await collect(item.children, ox + item.box.x, oy + item.box.y);
        }
      }
    };

    if (drawnSlide) {
      await collect(drawnSlide.items, 0, 0);
    } else {
      for (const textShape of await deck.textShapes(deckSlide.part)) {
        const tags = await readShapeTags(deck, deckSlide.part, textShape.id);
        const citations = parseShapeCitations(tags);
        shapes.push({
          shapeId: textShape.id,
          kind: "text",
          name: textShape.name,
          box: { x: 0, y: 0, w: 0, h: 0 },
          autofit: "none",
          paragraphs: textShape.paragraphs,
          ...(citations.length > 0 && { citations }),
        });
      }
    }

    slides.push({
      slide: deckSlide.number,
      notes: outline?.notes ?? [],
      shapes,
    });
  }

  return {
    structure: {
      version,
      slideCount: deckSlides.length,
      slideSize: drawing ? { width: drawing.width, height: drawing.height } : null,
      editable: refusal === null,
      refusal,
      slides,
    },
    drawing,
  };
}
