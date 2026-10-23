import type { PrintDocument } from "../../shared/printDocument";
import type { Printer } from "../adapters";
import { PdfLayoutError } from "../errors";
import { unifyIdeographs } from "./pdfUnicode";

/**
 * A document printed as a PDF by the host's printer, its ideographs unified. A printer that fails
 * left the PDF unmade, not the file unsaved: nothing is written before it prints.
 */
export async function printedPdf(printer: Printer, document: PrintDocument): Promise<Uint8Array> {
  let printed: Uint8Array;
  try {
    printed = await printer.print(document);
  } catch (error) {
    throw new PdfLayoutError({ cause: error });
  }
  return unifyIdeographs(printed);
}
