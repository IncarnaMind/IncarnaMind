import { dirname, join } from "node:path";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CJK } from "../src/shared/text";

/** pdf.js's data files, which reading CJK text needs. */
function dataUrls() {
  const packageDir = dirname(require.resolve("pdfjs-dist/package.json"));
  return {
    cMapUrl: `${join(packageDir, "cmaps")}/`,
    standardFontDataUrl: `${join(packageDir, "standard_fonts")}/`,
  };
}

/** A line broken between two CJK characters isn't a space. */
const CJK_LINE_WRAP = new RegExp(`([${CJK}])\\s*\\n\\s*(?=[${CJK}])`, "gu");

/**
 * Reads each page of a PDF with pdf.js (the library the app reads PDFs with), without opening
 * the file in an app.
 */
async function eachPage<T>(bytes: Uint8Array, read: (page: PDFPageProxy) => Promise<T>) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    ...dataUrls(),
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const pages: T[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      pages.push(await read(page));
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** What a PDF says, page by page: each page's text in drawing order, a line to each line. */
export function pdfText(bytes: Uint8Array): Promise<string[]> {
  return eachPage(bytes, async (page) => {
    let text = "";
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    return text.replaceAll("\u0000", "").replace(CJK_LINE_WRAP, "$1").trim();
  });
}

/** The pictures on each page of a PDF, by their size in pixels. */
export async function pdfPictures(bytes: Uint8Array) {
  const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return eachPage(bytes, async (page) => {
    const { fnArray, argsArray } = await page.getOperatorList();
    return fnArray.flatMap((fn, index) => {
      if (fn !== OPS.paintImageXObject) return [];
      // pdf.js gives a picture's id, then its width and height.
      const [, width, height] = argsArray[index] as [string, number, number];
      return [{ width, height }];
    });
  });
}
