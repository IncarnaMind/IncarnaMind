/**
 * What every printed page carries (#1258): its number at the foot, and a watermark across it.
 * Drawn here so a test can read the page without Chromium, which lays the pages out.
 */
export interface PageMarks {
  /** Absent: numbered, as a PDF always has been. */
  pageNumbers?: boolean;
  watermark?: string;
}

export function markPage(page: HTMLElement, index: number, marks: PageMarks): void {
  const doc = page.ownerDocument;
  if (marks.pageNumbers ?? true) {
    const number = doc.createElement("div");
    number.className = "page-number";
    number.textContent = String(index + 1);
    page.append(number);
  }
  if (marks.watermark) {
    const watermark = doc.createElement("div");
    watermark.className = "page-watermark";
    watermark.setAttribute("aria-hidden", "true");
    watermark.textContent = marks.watermark;
    page.append(watermark);
  }
}
