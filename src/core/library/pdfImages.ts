import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import type { DrawnPage, PageText } from "../../shared/citedPage";
import { readPdfPageText } from "../../shared/pdfFormText";

export interface DocumentPageImage {
  page: number;
  /** Bare base64, as Ollama's System One endpoint requires. */
  data: string;
}

export const PDF_IMAGE_LIMITS = {
  pages: 3,
  scanPages: 12,
  edge: 1600,
  fileBytes: 100 * 1024 * 1024,
  // Accommodates a 300 dpi A3 scan (~17.4 MP), with a bounded raster allocation.
  imagePixels: 20_000_000,
};

/** The most a cited page's picture may take (#133): its pages, one under the other. */
const CITED_PAGE_BYTES = 16 * 1024 * 1024;
/** The gap between a cited page's two pages, in its pixels, in the viewer's backdrop colour. */
const CITED_PAGE_GAP = 16;

type Canvas = NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvas"]> & {
  toBuffer(mime: "image/jpeg", quality: number): Buffer;
};
type Surface = { canvas: Canvas };
interface CanvasFactory {
  create(width: number, height: number): Surface;
  destroy(surface: Surface): void;
}

/** What a PDF's file must be to be drawn, and what is said when it isn't. */
interface PdfChecks {
  tooLarge: string;
  changed: string;
}

/**
 * Opens a PDF's file, if it is the version `contentHash` names, in a PDF.js
 * worker of its own, with the password that opens it when it is locked
 * (#763), and hands it to `use`; `checkWorker` throws the worker's error, if
 * it had one. Everything is let go afterwards.
 */
async function withPdf<T>(
  file: string,
  contentHash: string,
  checks: PdfChecks,
  password: string | undefined,
  use: (document: PDFDocumentProxy, factory: CanvasFactory, checkWorker: () => void) => Promise<T>,
): Promise<T> {
  if ((await stat(file)).size > PDF_IMAGE_LIMITS.fileBytes) throw new Error(checks.tooLarge);
  const bytes = await readFile(file);
  if (bytes.length > PDF_IMAGE_LIMITS.fileBytes) throw new Error(checks.tooLarge);
  if (createHash("sha256").update(bytes).digest("hex") !== contentHash)
    throw new Error(checks.changed);
  const { getDocument, PDFWorker } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const worker = new PDFWorker({ verbosity: 0 });
  let task: ReturnType<typeof getDocument> | undefined;
  let workerError: Error | undefined;
  // PDF.js 6.4 can resolve a partial operator list before rejecting its stream error.
  // Observe the dedicated worker's error envelope so a dropped scan cannot be sent
  // as a blank preview. Keep the oversized first/second-page regressions on upgrades.
  const onMessage = (event: { data: { reason?: { message?: unknown } } }) => {
    if (typeof event.data.reason?.message === "string")
      workerError ??= new Error(event.data.reason.message);
  };
  const checkWorker = () => {
    if (workerError) throw workerError;
  };
  try {
    await worker.promise;
    worker.port.addEventListener("message", onMessage);
    task = getDocument({
      worker,
      data: new Uint8Array(bytes),
      ...(password !== undefined && { password }),
      cMapUrl: `${join(packageDir, "cmaps")}/`,
      cMapPacked: true,
      standardFontDataUrl: `${join(packageDir, "standard_fonts")}/`,
      wasmUrl: `${join(packageDir, "wasm")}/`,
      useSystemFonts: false,
      maxImageSize: PDF_IMAGE_LIMITS.imagePixels,
      // PDF.js otherwise silently drops oversized images, turning scans into blank previews.
      stopAtErrors: true,
      verbosity: 0,
    });
    const document = await task.promise;
    checkWorker();
    return await use(document, document.canvasFactory as CanvasFactory, checkWorker);
  } finally {
    worker.port?.removeEventListener("message", onMessage);
    try {
      await task?.destroy();
    } finally {
      worker.destroy();
    }
  }
}

/** Runs in a disposable worker; no previews are written to disk. */
export async function renderPdfImages(
  file: string,
  contentHash: string,
  password?: string,
): Promise<DocumentPageImage[]> {
  const checks = {
    tooLarge:
      "PDF page previews support files up to 100 MB. Turn off page images to classify its text.",
    changed: "The Document changed. Wait for it to finish processing, then classify it again.",
  };
  return withPdf(file, contentHash, checks, password, async (document, factory, checkWorker) => {
    const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // Always include the opening page; favour illustrations/charts in the next eleven.
    const candidates: { page: number; score: number }[] = [];
    for (
      let number = 2;
      number <= Math.min(document.numPages, PDF_IMAGE_LIMITS.scanPages);
      number++
    ) {
      const page = await document.getPage(number);
      try {
        const operators = await page.getOperatorList();
        checkWorker();
        const score = operators.fnArray.reduce(
          (sum, op) =>
            sum +
            (op === OPS.paintImageXObject ||
            op === OPS.paintInlineImageXObject ||
            op === OPS.paintImageMaskXObject
              ? 10
              : op === OPS.constructPath
                ? 1
                : 0),
          0,
        );
        candidates.push({ page: number, score });
      } finally {
        page.cleanup();
      }
    }
    const selected = [
      1,
      ...candidates
        .sort((a, b) => b.score - a.score || a.page - b.page)
        .slice(0, PDF_IMAGE_LIMITS.pages - 1)
        .map(({ page }) => page),
    ].sort((a, b) => a - b);
    const images: DocumentPageImage[] = [];
    for (const number of selected) {
      const page = await document.getPage(number);
      const original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: PDF_IMAGE_LIMITS.edge / Math.max(original.width, original.height),
      });
      const surface = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvas: surface.canvas, viewport, background: "white" }).promise;
        checkWorker();
        const jpeg = surface.canvas.toBuffer("image/jpeg", 80);
        if (jpeg.length > 2 * 1024 * 1024)
          throw new Error(
            "A PDF page preview is too large. Turn off page images to classify its text.",
          );
        images.push({ page: number, data: jpeg.toString("base64") });
      } finally {
        factory.destroy(surface);
        page.cleanup();
      }
    }
    checkWorker();
    return images;
  });
}

/**
 * A Citation's cited pages (#133), drawn as previews are, one under the
 * other, with the text runs on them where they are drawn, as the viewer's
 * text layer counts them. Runs in a disposable worker.
 */
export async function drawPdfPages(
  file: string,
  contentHash: string,
  pages: readonly number[],
  password?: string,
): Promise<DrawnPage> {
  const checks = {
    tooLarge: "Cited pages are saved for PDFs up to 100 MB.",
    changed: "The Document changed since it was cited.",
  };
  return withPdf(file, contentHash, checks, password, async (document, factory, checkWorker) => {
    const { Util } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const drawn: { surface: Surface; top: number }[] = [];
    const text: PageText[] = [];
    let width = 0;
    let height = 0;
    try {
      for (const number of pages) {
        if (number < 1 || number > document.numPages) {
          throw new Error(`The PDF has no page ${number}.`);
        }
        const page = await document.getPage(number);
        try {
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({
            scale: PDF_IMAGE_LIMITS.edge / Math.max(original.width, original.height),
          });
          const surface = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const top = height === 0 ? 0 : height + CITED_PAGE_GAP;
          drawn.push({ surface, top });
          await page.render({ canvas: surface.canvas, viewport, background: "white" }).promise;
          checkWorker();
          const { content } = await readPdfPageText(page);
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const [, , c, d, e, f] = Util.transform(viewport.transform, item.transform);
            const size = Math.hypot(c, d);
            text.push({
              text: item.str,
              breakAfter: item.hasEOL,
              box: { x: e, y: top + f - size, width: item.width * viewport.scale, height: size },
            });
          }
          const last = text.at(-1);
          if (last) last.breakAfter = true;
          width = Math.max(width, surface.canvas.width);
          height = top + surface.canvas.height;
        } finally {
          page.cleanup();
        }
      }
      if (drawn.length === 0) throw new Error("No cited pages to draw.");
      const sheet = factory.create(width, height);
      try {
        const context = sheet.canvas.getContext("2d");
        if (!context) throw new Error("The cited pages couldn't be drawn.");
        context.fillStyle = "#f4f5f7";
        context.fillRect(0, 0, width, height);
        for (const { surface, top } of drawn) context.drawImage(surface.canvas, 0, top);
        const jpeg = sheet.canvas.toBuffer("image/jpeg", 80);
        if (jpeg.length > CITED_PAGE_BYTES) throw new Error("The cited pages are too large.");
        checkWorker();
        return { data: new Uint8Array(jpeg), type: "image/jpeg", width, height, text };
      } finally {
        factory.destroy(sheet);
      }
    } finally {
      for (const { surface } of drawn) factory.destroy(surface);
    }
  });
}
