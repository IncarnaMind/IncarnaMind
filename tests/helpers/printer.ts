import type { Printer } from "../../src/core";
import type { PrintDocument } from "../../src/shared/printDocument";

/** A printer that keeps what it was asked to print, and gives back a stand-in for the PDF. */
export function fakePrinter() {
  const printed: PrintDocument[] = [];
  const printedOnPrinter: PrintDocument[] = [];
  const printer: Printer = {
    print: async (document) => {
      printed.push(document);
      return new TextEncoder().encode("%PDF-stand-in");
    },
    printToPrinter: async (document) => {
      printedOnPrinter.push(document);
    },
  };
  return { printed, printedOnPrinter, printer };
}
