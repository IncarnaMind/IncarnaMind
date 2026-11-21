import { type Options, parseAsync, renderDocument } from "docx-preview";
import { HEADER_AND_FOOTER_DISTANCE, MARGIN, PAPER } from "../../../core/pageDefaults";

/** A section's page setup as docx-preview parses it: CSS lengths ("612.00pt"), null where the file gives none. */
interface SectionProps {
  pageSize?: { width?: string | null; height?: string | null };
  pageMargins?: {
    top?: string | null;
    right?: string | null;
    bottom?: string | null;
    left?: string | null;
    header?: string | null;
    footer?: string | null;
  };
}

interface ParsedWord {
  documentPart: {
    /** `props` is the last section's; a paragraph that ends an earlier section carries its own. */
    body: { props: SectionProps; children: { sectionProps?: SectionProps }[] };
  };
}

const points = (twips: number) => `${(twips / 20).toFixed(2)}pt`;

/**
 * docx-preview gives a page a width, a minimum height and padding only from what the file sets, so
 * a file that sets none is drawn as one sheet as wide as the window (#3522): what it leaves unset
 * takes the default paper and margins, and what it sets stays.
 */
function withPageDefaults(props: SectionProps): void {
  const size = props.pageSize ?? {};
  size.width ??= points(PAPER.letter.width);
  size.height ??= points(PAPER.letter.height);
  const margins = props.pageMargins ?? {};
  margins.top ??= points(MARGIN);
  margins.right ??= points(MARGIN);
  margins.bottom ??= points(MARGIN);
  margins.left ??= points(MARGIN);
  margins.header ??= points(HEADER_AND_FOOTER_DISTANCE);
  margins.footer ??= points(HEADER_AND_FOOTER_DISTANCE);
  props.pageSize = size;
  props.pageMargins = margins;
}

/**
 * Draws as docx-preview's `renderAsync` does, with the defaults put on the parsed sections first:
 * the page sizes decide where pages break and where their headers and footers sit (#3522).
 */
export async function renderWord(
  bytes: Uint8Array,
  body: HTMLElement,
  styles: HTMLElement,
  options: Partial<Options>,
): Promise<void> {
  const parsed: ParsedWord = await parseAsync(bytes, options);
  const { props, children } = parsed.documentPart.body;
  withPageDefaults(props);
  for (const child of children) if (child.sectionProps) withPageDefaults(child.sectionProps);
  const nodes = await renderDocument(parsed, options);
  styles.replaceChildren();
  body.replaceChildren();
  for (const node of nodes) (node.nodeName === "STYLE" ? styles : body).appendChild(node);
}
