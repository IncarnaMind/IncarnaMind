/**
 * A person's edit on a drawn slide, as the slide editor hands it over and
 * the deck's patches (./edits) write it: plain data, with no Node in it, so
 * the renderer and another host share it.
 */

/** A run of a text body: its paragraph, and its place among the paragraph's runs, breaks and fields. */
export interface RunSource {
  paragraph: number;
  run: number;
}

/** Text as edited, and the run it was typed into; a line break is "\n" on its own. */
export interface EditedRun {
  source: RunSource | null;
  text: string;
}

/** A paragraph as edited, and the one it was: one split in two names it twice, a new one none. */
export interface EditedParagraph {
  source: number | null;
  runs: EditedRun[];
}

/** A shape's box, CSS pixels at 96 dpi, as the drawing (pptxDrawing) gives it. */
export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShapeEdit =
  | { kind: "text"; slide: number; shape: string; paragraphs: EditedParagraph[] }
  | { kind: "box"; slide: number; shape: string; box: ShapeBox };
