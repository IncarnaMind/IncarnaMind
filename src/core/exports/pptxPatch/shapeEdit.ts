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

/** Runs next to each other from the same source, joined: the DOM may split one into several nodes. */
export function joinedRuns(runs: readonly EditedRun[]): EditedRun[] {
  const out: EditedRun[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = out.at(-1);
    const same =
      last &&
      last.text !== "\n" &&
      run.text !== "\n" &&
      last.source?.paragraph === run.source?.paragraph &&
      last.source?.run === run.source?.run;
    if (last && same) last.text += run.text;
    else out.push({ source: run.source, text: run.text });
  }
  return out;
}

/**
 * Whether a paragraph's edited runs (joined) are its own pieces that show, in their order, so the
 * paragraph keeps every piece, a run with no text where it was, and only their text changes;
 * otherwise it is written anew, a piece for each run. `pieces`: its runs, breaks and fields as
 * the file holds them, a break's text "\n". The deck's patch and the window's stand-in for typed
 * words both go by it, so they number a paragraph's runs alike.
 */
export function writtenInPlace(
  pieces: readonly string[],
  index: number,
  runs: readonly EditedRun[],
): boolean {
  const shown = pieces.map((text, at) => ({ text, at })).filter(({ text }) => text !== "");
  return (
    runs.length === shown.length &&
    shown.every(({ text, at }, place) => {
      const run = runs[place];
      return (
        run?.source?.paragraph === index &&
        run.source.run === at &&
        (text === "\n") === (run.text === "\n")
      );
    })
  );
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
 * (`spAutoFit`) takes this box's height, keeping its place and width (the box gives them only to a
 * placeholder placed by its layout); one that shrinks its text on overflow (`normAutofit`) takes
 * this scale of its fonts and reduction of its line spacing, fractions of 1.
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
