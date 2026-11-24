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

/** A shape's box on its slide, CSS pixels at 96 dpi, as the slide shows it: a group's shape's too. */
export interface ShapeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * How a text box follows its text after an edit, as its autofit kind asks: one that grows to fit
 * (`spAutoFit`) takes this box; one that shrinks its text on overflow (`normAutofit`) takes this
 * scale of its fonts and reduction of its line spacing, fractions of 1.
 */
export type TextFit =
  | { kind: "grow"; box: ShapeBox }
  | { kind: "shrink"; fontScale: number; lineReduction: number };

export type ShapeEdit =
  | { kind: "text"; slide: number; shape: string; paragraphs: EditedParagraph[]; fit?: TextFit }
  | {
      kind: "cell";
      slide: number;
      shape: string;
      /** The cell's row and its place in the row, merged cells counted, as the file lists them. */
      row: number;
      column: number;
      paragraphs: EditedParagraph[];
    }
  | { kind: "box"; slide: number; shape: string; box: ShapeBox };
