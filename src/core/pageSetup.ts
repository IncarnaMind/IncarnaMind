import type { PrintPaper } from "../shared/printDocument";
import type { PageSetup } from "./api";
import { HEADER_AND_FOOTER_DISTANCE, MARGIN, PAPER } from "./pageDefaults";

/** The pages of a Mind that wasn't imported from Word: the native Word export's paper and margins, in one section. */
export function nativePageSetup(paper: PrintPaper): PageSetup {
  const { width, height } = PAPER[paper];
  const none = { default: null, first: null, even: null };
  return {
    source: "native",
    oddAndEven: false,
    sections: [
      {
        breakPlace: null,
        start: "nextPage",
        width,
        height,
        orientation: "portrait",
        margins: {
          top: MARGIN,
          right: MARGIN,
          bottom: MARGIN,
          left: MARGIN,
          gutter: 0,
          header: HEADER_AND_FOOTER_DISTANCE,
          footer: HEADER_AND_FOOTER_DISTANCE,
        },
        differentFirstPage: false,
        pageNumbers: { start: null, format: "decimal" },
        headers: none,
        footers: none,
      },
    ],
  };
}
