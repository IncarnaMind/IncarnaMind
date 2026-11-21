import { type Options, renderAsync } from "docx-preview";
import { HEADER_AND_FOOTER_DISTANCE, MARGIN, PAPER } from "../../../core/pageDefaults";

const points = (twips: number) => `${(twips / 20).toFixed(2)}pt`;

/**
 * docx-preview gives a page a width, a minimum height and padding only from the section properties
 * the file carries, so a file with none is drawn as one sheet as wide as the window (#3522). The
 * defaults go on the pages as drawn, not on the parsed sections: docx-preview starts a new page
 * where two sections' sizes differ, and a default equal to a size the next section sets would
 * remove that page, and with it that section's own header and margins.
 */
function withPageDefaults(page: HTMLElement): void {
  const { style } = page;
  style.width ||= points(PAPER.letter.width);
  style.minHeight ||= points(PAPER.letter.height);
  style.paddingTop ||= points(MARGIN);
  style.paddingRight ||= points(MARGIN);
  style.paddingBottom ||= points(MARGIN);
  style.paddingLeft ||= points(MARGIN);
  const distance = points(HEADER_AND_FOOTER_DISTANCE);
  for (const header of page.querySelectorAll<HTMLElement>(":scope > header")) {
    header.style.marginTop ||= `calc(${distance} - ${style.paddingTop})`;
    header.style.minHeight ||= `calc(${style.paddingTop} - ${distance})`;
  }
  for (const footer of page.querySelectorAll<HTMLElement>(":scope > footer")) {
    footer.style.marginBottom ||= `calc(${distance} - ${style.paddingBottom})`;
    footer.style.minHeight ||= `calc(${style.paddingBottom} - ${distance})`;
  }
}

/** Draws as docx-preview's `renderAsync` does, then gives each page what its section leaves unset. */
export async function renderWord(
  bytes: Uint8Array,
  body: HTMLElement,
  styles: HTMLElement,
  options: Partial<Options>,
): Promise<void> {
  await renderAsync(bytes, body, styles, options);
  for (const page of body.querySelectorAll<HTMLElement>(`section.${options.className ?? "docx"}`)) {
    withPageDefaults(page);
  }
}
