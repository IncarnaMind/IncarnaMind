/**
 * Reading every format but PDF into Units (ADR-0011), with our own small ZIP
 * and XML reader and no dependency. Pure, with no Node imports: the
 * processing worker extracts with it, and the Document viewer reads files
 * with the very same code, so what it shows and highlights is what was
 * indexed. PDFs are read with pdf.js (../extract).
 */

import type { TextUnit } from "../../../shared/units";
import type { DocumentKind } from "../../api";
import { decodeText } from "../decode";
import { extractCsv } from "./csv";
import { extractDocx } from "./docx";
import { ExtractionError } from "./errors";
import { htmlMarkdown } from "./html";
import { extractPptx } from "./pptx";
import { rtfMarkdown } from "./rtf";
import { lineUnits, markdownUnits } from "./text";
import { readVtt, transcriptUnits } from "./vtt";
import { webUnits } from "./web";
import { extractXlsx } from "./xlsx";

export { ExtractionError } from "./errors";

/** The Units of a file of any kind but PDF (whose pages need pdf.js) and a picture (whose text is read from it). */
export async function extractUnits(
  kind: Exclude<DocumentKind, "pdf" | "image">,
  bytes: Uint8Array,
): Promise<TextUnit[]> {
  switch (kind) {
    case "text":
    case "markdown":
    case "rtf":
    case "html": {
      const text =
        kind === "rtf"
          ? rtfMarkdown(bytes)
          : kind === "html"
            ? htmlMarkdown(bytes)
            : decodeText(bytes);
      if (text === null) {
        throw new ExtractionError("unreadable", "The file holds binary data, not text.");
      }
      // The Units' offsets in the file are for the viewer; what is stored is the Unit itself.
      // A converted RTF or HTML file's own lines are words, not Markdown structure (#762).
      const units =
        kind === "text"
          ? lineUnits(text)
          : markdownUnits(text, { literal: kind === "rtf" || kind === "html" });
      return units.map(({ start: _start, end: _end, ...unit }) => unit);
    }
    case "docx":
      return (await extractDocx(bytes)).units;
    case "pptx":
      return (await extractPptx(bytes)).units;
    case "xlsx":
      return (await extractXlsx(bytes)).units;
    case "csv":
      return extractCsv(bytes).units;
    case "web":
      return webUnits(new TextDecoder().decode(bytes));
    case "transcript": {
      const text = decodeText(bytes);
      if (text === null) {
        throw new ExtractionError("unreadable", "The file holds binary data, not text.");
      }
      return transcriptUnits(readVtt(text));
    }
  }
}
