import { lazy } from "react";
import type { Document } from "../../../core/api";
import type { ViewerTarget } from "../store";

// Each kind's view loads the first time a Document of that kind opens, with its libraries
// (pdf.js, docx-preview, JSZip, the Office formats), rather than with the app.
const PdfView = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfView })));
const TextView = lazy(() => import("./TextView").then((m) => ({ default: m.TextView })));
const ImageView = lazy(() => import("./ImageView").then((m) => ({ default: m.ImageView })));
const DocxView = lazy(() => import("./DocxView").then((m) => ({ default: m.DocxView })));
const SlidesView = lazy(() => import("./SlidesView").then((m) => ({ default: m.SlidesView })));
const SheetView = lazy(() => import("./SheetView").then((m) => ({ default: m.SheetView })));
const WebView = lazy(() => import("./WebView").then((m) => ({ default: m.WebView })));
const TranscriptView = lazy(() =>
  import("./TranscriptView").then((m) => ({ default: m.TranscriptView })),
);

/** The view for a kind of Document (ADR-0011). */
export function DocumentView({ document, target }: { document: Document; target: ViewerTarget }) {
  switch (document.kind) {
    case "pdf":
      return <PdfView document={document} target={target} />;
    case "text":
    case "markdown":
    case "rtf":
    case "html":
      return <TextView document={document} target={target} />;
    case "image":
      return <ImageView document={document} target={target} />;
    case "docx":
      return <DocxView document={document} target={target} />;
    case "pptx":
      return <SlidesView document={document} target={target} />;
    case "xlsx":
    case "csv":
      return <SheetView document={document} target={target} />;
    case "web":
      return <WebView document={document} target={target} />;
    case "transcript":
      return <TranscriptView document={document} target={target} />;
  }
}
