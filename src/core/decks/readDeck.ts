/**
 * Structured deck reader for connected AI tools (`read_deck`, #149 part 2): inspects a `.pptx`
 * file as slides and shapes with stable `cNvPr` ids, human-readable place kinds, text paragraphs,
 * autofit kinds, tables, charts (with index-aligned series values, categories, and number formats),
 * speaker notes, and IncarnaMind Citation tags.
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
import { descendants, textOf, type XmlElement } from "../documents/formats/xml";
import { openPackage } from "../documents/formats/zip";
import { chartPartOfShape, chartSeries } from "../exports/pptxPatch/charts";
import { Deck, nonVisualOf } from "../exports/pptxPatch/deck";
import { type DeckCitationRecord, parseShapeCitations } from "../exports/pptxPatch/deckChanges";
import type { ShapeBox } from "../exports/pptxPatch/shapeEdit";
import { readShapeTags, shapeById } from "../exports/pptxPatch/shapes";
import type { DeckPlaceKind } from "./proposalTypes";
import { protectionOf } from "./protection";

export interface DeckChartSeriesSummary {
  index: number;
  name: string | null;
  categories: string[];
  formatCode: string | null;
  /** Indexed by `c:pt/@idx` (length `ptCount`, null for blank/missing points). */
  values: (number | null)[];
}

export interface DeckShapeSummary {
  shapeId: string;
  kind: "text" | "table" | "chart" | "picture" | "group";
  /** Raw OOXML `cNvPr/@name`. */
  name: string;
  /** Semantic placeholder or element kind for plain-words UI labels (#149 #3). */
  placeKind: Exclude<DeckPlaceKind, "notes">;
  /** Human-readable label (chart/table title, meaningful name, or first words; never "Text 0"). */
  displayLabel: string;
  title?: true;
  box: ShapeBox;
  autofit?: Autofit["kind"];
  fontScale?: number;
  lineReduction?: number;
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
  /** False if `drawPptx` failed so layout geometry / text fit could not be measured. */
  fitChecked: boolean;
  slides: DeckSlideSummary[];
}

const GENERIC_SHAPE_NAME =
  /^(?:text|text\s*box|textbox|shape|rectangle|oval|rounded\s*rectangle|content\s*placeholder|text\s*placeholder|title|subtitle|footer|slide\s*number|date\s*placeholder|picture|chart|table|graphic\s*frame|object|freeform|google\s*shape|文本框|标题|副标题|内容占位符|图片|图表|表格)[\s#;_-]*\d*$/i;

function snippetOf(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 42) return clean;
  return `${clean.slice(0, 41).trimEnd()}…`;
}

function placeholderKindOf(
  xmlShape: XmlElement | undefined,
): Exclude<DeckPlaceKind, "notes"> | null {
  if (!xmlShape) return null;
  const ph = descendants(xmlShape, "p:ph")[0];
  if (!ph) return null;
  const type = (ph.attrs.type ?? "").toLowerCase();
  if (type === "title" || type === "ctrtitle") return "title";
  if (type === "subtitle") return "subtitle";
  if (type === "ftr" || type === "sldnum" || type === "dt") return "footer";
  if (type === "body" || type === "obj" || type === "") return "body";
  return null;
}

async function chartTitleOf(deck: Deck, chartPart: string): Promise<string | null> {
  const part = await deck.pkg.part(chartPart);
  if (!part) return null;
  const titleEl = descendants(part.root, "c:title")[0];
  if (!titleEl) return null;
  const tNodes = [...descendants(titleEl, "a:t"), ...descendants(titleEl, "c:v")];
  const joined = tNodes
    .map((node) => textOf(node))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return joined || null;
}

function humanLabel(
  rawName: string,
  placeKind: Exclude<DeckPlaceKind, "notes">,
  fallbackText: string,
): string {
  const trimmed = rawName.trim();
  if (trimmed !== "" && !GENERIC_SHAPE_NAME.test(trimmed)) return trimmed;
  if (placeKind === "text" || placeKind === "shape" || placeKind === "table") {
    const snippet = snippetOf(fallbackText);
    if (snippet !== "") return snippet;
  }
  return "";
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
  } catch (error) {
    console.warn("Couldn't draw deck for structure/fit check:", error);
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
          const paragraphs = paragraphsOfText(item.text);
          const phKind = placeholderKindOf(xmlShape);
          const placeKind: Exclude<DeckPlaceKind, "notes"> =
            phKind ?? (item.title ? "title" : "text");
          shapes.push({
            shapeId: item.shapeId,
            kind: "text",
            name,
            placeKind,
            displayLabel: humanLabel(name, placeKind, paragraphs.join(" ")),
            ...(item.title && { title: true }),
            box,
            autofit: item.text?.autofit.kind ?? "none",
            fontScale: item.text?.autofit.fontScale ?? 1,
            lineReduction: item.text?.autofit.lineReduction ?? 0,
            paragraphs,
            ...(citations.length > 0 && { citations }),
          });
        } else if (item.kind === "table") {
          const rows = item.rows.map((row) =>
            row.cells.map((cell) => (cell.merged ? "" : paragraphsOfText(cell.text).join("\n"))),
          );
          const headerText = rows[0]?.filter(Boolean).join(" · ") ?? "";
          shapes.push({
            shapeId: item.shapeId,
            kind: "table",
            name,
            placeKind: "table",
            displayLabel: humanLabel(name, "table", headerText),
            box,
            rows,
            ...(citations.length > 0 && { citations }),
          });
        } else if (item.kind === "chart") {
          const chartPart = await chartPartOfShape(deck, deckSlide.part, item.shapeId);
          const title = chartPart ? await chartTitleOf(deck, chartPart) : null;
          const series = chartPart
            ? (await chartSeries(deck, chartPart)).map((each) => {
                let maxIdx = each.count - 1;
                for (const pt of each.points) {
                  if (Number.isInteger(pt.idx) && pt.idx > maxIdx) maxIdx = pt.idx;
                }
                const values = maxIdx >= 0 ? Array<number | null>(maxIdx + 1).fill(null) : [];
                for (const pt of each.points) {
                  if (Number.isInteger(pt.idx) && pt.idx >= 0) values[pt.idx] = pt.value;
                }
                return {
                  index: each.index,
                  name: each.name,
                  categories: each.categories,
                  formatCode: each.formatCode,
                  values,
                };
              })
            : [];
          shapes.push({
            shapeId: item.shapeId,
            kind: "chart",
            name,
            placeKind: "chart",
            displayLabel: title ?? humanLabel(name, "chart", ""),
            box,
            series,
            ...(citations.length > 0 && { citations }),
          });
        } else if (item.kind === "picture") {
          shapes.push({
            shapeId: item.shapeId,
            kind: "picture",
            name,
            placeKind: "shape",
            displayLabel: humanLabel(name, "shape", ""),
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
        const xmlShape = slidePart ? shapeById(slidePart.root, textShape.id) : undefined;
        const phKind = placeholderKindOf(xmlShape);
        const placeKind: Exclude<DeckPlaceKind, "notes"> = phKind ?? "text";
        const tags = await readShapeTags(deck, deckSlide.part, textShape.id);
        const citations = parseShapeCitations(tags);
        shapes.push({
          shapeId: textShape.id,
          kind: "text",
          name: textShape.name,
          placeKind,
          displayLabel: humanLabel(textShape.name, placeKind, textShape.paragraphs.join(" ")),
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
      fitChecked: drawing !== null,
      slides,
    },
    drawing,
  };
}
