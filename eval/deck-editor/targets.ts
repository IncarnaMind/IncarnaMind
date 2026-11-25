/**
 * What each arm of the bake-off edits in a deck, chosen once from the
 * original with our own reader so every arm makes the same edits: on the
 * first three slides with a text shape of their own, that shape's first
 * paragraph with words gets a few words more at its end, as typed there;
 * on the first three slides with a shape of their own, that shape moves
 * 24 px right and 12 px down and grows a tenth wider.
 */
import {
  drawPptx,
  type ShapeItem,
  type SlideDrawing,
} from "../../src/core/documents/formats/pptxDrawing";
import { Deck } from "../../src/core/exports/pptxPatch/deck";
import type { EditedParagraph, ShapeEdit } from "../../src/core/exports/pptxPatch/shapeEdit";

const EMU_PER_PX = 9525;
const FURNITURE = new Set(["dt", "ftr", "sldNum"]);

export interface TextTarget {
  slide: number;
  slidePart: string;
  shapeId: string;
  /** The paragraph that gets the words, by its place in the shape. */
  paragraph: number;
  added: string;
  /** The paragraph's text before and after, as our reader joins its runs. */
  before: string;
  after: string;
  /** The shape's paragraphs as the editor hands them over (arm A). */
  edited: EditedParagraph[];
}

export interface BoxTarget {
  slide: number;
  slidePart: string;
  shapeId: string;
  kind: string;
  /** EMU, as written. */
  from: { x: number; y: number; w: number; h: number };
  to: { x: number; y: number; w: number; h: number };
}

export interface DeckTargets {
  id: string;
  cjk: boolean;
  slides: number;
  text: TextTarget[];
  box: BoxTarget[];
}

const paragraphText = (shape: ShapeItem, index: number) =>
  (shape.text?.paragraphs[index]?.runs ?? [])
    .map((run) => (run.lineBreak ? "\n" : run.text))
    .join("");

function editedWith(shape: ShapeItem, index: number, added: string): EditedParagraph[] {
  return (shape.text?.paragraphs ?? []).map((paragraph, p) => {
    const runs = paragraph.runs
      .map((run, r) => ({
        source: { paragraph: p, run: r },
        text: run.lineBreak ? "\n" : run.text,
      }))
      .filter((run) => run.text !== "");
    if (p === index) {
      const last = runs.findLast((run) => run.text !== "\n");
      if (last) last.text += added;
    }
    return { source: p, runs };
  });
}

const isDrawn = (slide: SlideDrawing | { failed: string }): slide is SlideDrawing =>
  "items" in slide;

export async function chooseTargets(
  id: string,
  bytes: Uint8Array,
  cjk: boolean,
): Promise<DeckTargets> {
  const deck = Deck.open(bytes);
  const parts = await deck.slides();
  const drawing = await drawPptx(bytes);
  const added = cjk ? "（已核对）" : " (checked)";
  const text: TextTarget[] = [];
  const box: BoxTarget[] = [];
  for (const slide of drawing.slides) {
    if (!isDrawn(slide)) continue;
    const part = parts.find((each) => each.number === slide.number)?.part;
    if (!part) continue;
    const furniture = new Set(
      (await deck.textShapes(part))
        .filter((shape) => FURNITURE.has(shape.placeholder?.type ?? ""))
        .map((shape) => shape.id),
    );
    const own = slide.items.filter((item) => item.origin === "slide" && item.shapeId);
    if (text.length < 3) {
      for (const item of own) {
        if (item.kind !== "shape" || !item.text || !item.shapeId || furniture.has(item.shapeId))
          continue;
        const index = item.text.paragraphs.findIndex(
          (_, p) => paragraphText(item, p).trim() !== "",
        );
        if (index < 0) continue;
        const before = paragraphText(item, index);
        text.push({
          slide: slide.number,
          slidePart: part,
          shapeId: item.shapeId,
          paragraph: index,
          added,
          before,
          after: before + added,
          edited: editedWith(item, index, added),
        });
        break;
      }
    }
    if (box.length < 3) {
      const item = own.find((each) => each.box.w > 0 && each.box.h > 0);
      if (item?.shapeId) {
        const emu = (px: number) => Math.round(px * EMU_PER_PX);
        const from = {
          x: emu(item.box.x),
          y: emu(item.box.y),
          w: emu(item.box.w),
          h: emu(item.box.h),
        };
        box.push({
          slide: slide.number,
          slidePart: part,
          shapeId: item.shapeId,
          kind: item.kind,
          from,
          to: {
            x: from.x + 24 * EMU_PER_PX,
            y: from.y + 12 * EMU_PER_PX,
            w: Math.round(from.w * 1.1),
            h: from.h,
          },
        });
      }
    }
    if (text.length === 3 && box.length === 3) break;
  }
  return { id, cjk, slides: drawing.slides.length, text, box };
}

/** The edits arm A's editor hands over for these targets. */
export function editsOf(targets: DeckTargets, kind: "text" | "box"): ShapeEdit[] {
  if (kind === "text") {
    return targets.text.map((each) => ({
      kind: "text",
      slide: each.slide,
      shape: each.shapeId,
      paragraphs: each.edited,
    }));
  }
  return targets.box.map((each) => ({
    kind: "box",
    slide: each.slide,
    shape: each.shapeId,
    box: {
      x: each.to.x / EMU_PER_PX,
      y: each.to.y / EMU_PER_PX,
      w: each.to.w / EMU_PER_PX,
      h: each.to.h / EMU_PER_PX,
    },
  }));
}
