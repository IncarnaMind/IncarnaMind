/**
 * The README's feature stills: what each picture is, the size every one is cut to, and where it
 * goes. A picture is a crop of the app's own screen from the take that makes the film, laid on
 * the app's card, so a new take refreshes it with the film. The module has no browser or
 * recording import, so the table, the recorder and the tests that check the written files share
 * these numbers.
 */
/** In the order the README's cards show them: Sort, Ask, Write, Analyse, Check, Compare, Export, Meet. */
export const FEATURES = [
  "sort",
  "ask",
  "write",
  "analyse",
  "check",
  "compare",
  "export",
  "meet",
] as const;

export type Feature = (typeof FEATURES)[number];

/** What each picture shows, in one sentence: the alt text of its card. */
export const FEATURE_ALT: Readonly<Record<Feature, string>> = {
  sort: "The workbook and the interview guide in their Folder in the Library, after Organize.",
  ask: "A Citation's card: Quote found on p. 1, with the quote lit up where the Document holds it.",
  write: "An Answer added to a Note: its grey AI text, and the Undo line under it.",
  analyse: "A bar's card on a chart of the workbook: its value, its source cell, its Document.",
  check: "A Contradicted figure's card: the quote the Document holds and the page it is on.",
  compare: "Cells of the table comparing Documents, each with the Citation it rests on.",
  export: "The Export menu's Word item, which saves the Note with footnotes and sources.",
  meet: "Not covered yet after an expert interview: the guide's topics the call missed, each cited.",
};

/** A picture is 16:10, drawn at 1200 × 750: the README shows it at 410 px wide. */
export const FEATURE_SIZE = { width: 1200, height: 750 } as const;
/** The app's card sits this far inside the picture, on every one of them. */
export const FEATURE_INSET = 56;
/** The crop of the app's screen, in the picture's pixels: 16:10 less the inset on each side. */
export const FEATURE_CROP = {
  width: FEATURE_SIZE.width - FEATURE_INSET * 2,
  height: FEATURE_SIZE.height - FEATURE_INSET * 2,
} as const;

/** How many pixels the app draws for each of its own in the filmed window: the crop's source. */
export const FEATURE_SCREEN_PIXELS = 2 as const;
/** How many pixels each of the app's own takes in the picture: the crop is sharp and readable there. */
export const FEATURE_PIXELS = 2.5 as const;

/** The most a picture may take on disk: past it, the crop is cut again, never shrunk. */
export const FEATURE_MAX_BYTES = 250_000;
