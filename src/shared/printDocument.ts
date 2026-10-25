/**
 * A document to print as a PDF (#100): what the core makes of a Mind, which the desktop app's
 * hidden print page lays out in pages, each footnote at the foot of the page its marker is on,
 * and prints.
 */
export interface PrintDocument {
  /** The `lang` of the page: line breaking, and which faces Chinese text takes. */
  language: "en" | "zh-CN";
  /** By the system's region (`paperFor`). */
  paper: PrintPaper;
  /** The PDF's title. */
  title: string;
  /** The CSS `font-family` of the text, the Mind's font; absent, the print page's own serif. */
  fontFamily?: string;
  /**
   * The body, as HTML the core escaped. Each footnote's marker is
   * `<sup class="note-ref" data-note="N">N</sup>`, N counting from 1 in reading order; a marker
   * right after another is `<sup class="note-ref" data-note="N">,N</sup>`.
   */
  body: string;
  /** Each footnote's text, as HTML: footnote N is `notes[N - 1]`. */
  notes: string[];
  /** Plain text for the foot of every page, above its number. */
  footer?: string;
}

export type PrintPaper = "a4" | "letter";

/** The countries that print on Letter, as the Unicode CLDR lists them; the rest use A4. */
const LETTER_COUNTRIES: ReadonlySet<string> = new Set([
  "BZ",
  "CA",
  "CL",
  "CO",
  "CR",
  "GT",
  "MX",
  "NI",
  "PA",
  "PH",
  "PR",
  "SV",
  "US",
  "VE",
]);

/** The paper a country prints on, from its ISO 3166 code: A4 where it isn't known. */
export const paperFor = (region: string): PrintPaper =>
  LETTER_COUNTRIES.has(region.trim().toUpperCase()) ? "letter" : "a4";

/** A page's size and margins in CSS pixels (96 to the inch), the same in the core and the print page. */
export const PAPER: Readonly<
  Record<PrintPaper, { width: number; height: number; margin: number; css: string }>
> = {
  // 210 × 297 mm, with 20 mm margins.
  a4: { width: 793.7, height: 1122.5, margin: 75.6, css: "A4" },
  // 8.5 × 11 in, with 0.8 in margins.
  letter: { width: 816, height: 1056, margin: 76.8, css: "letter" },
};

/** What the print page names its entry point: the main process calls it with the document. */
export const PRINT_ENTRY = "incarnamindPrint";
