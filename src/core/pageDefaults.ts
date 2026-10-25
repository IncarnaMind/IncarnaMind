/** Page sizes in twips (twentieths of a point, 1,440 to the inch): what the Word export writes and a native Mind's pages are. */
export const PAPER = {
  letter: { width: 12240, height: 15840 },
  a4: { width: 11906, height: 16838 },
} as const;
export const MARGIN = 1440;
/** From a page's edge to its header and to its footer. */
export const HEADER_AND_FOOTER_DISTANCE = 720;
