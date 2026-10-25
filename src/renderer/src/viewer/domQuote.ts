/**
 * Finding a quote in DOM a library drew (docx-preview's pages), and marking
 * it there, the way the text view marks it in its own text: the matched text
 * is wrapped in `<mark class="quote-highlight">`. The quote is found with the
 * Citation check's own matcher (`findQuoteInPieces`) over the DOM's text
 * nodes, a line break between blocks, so the badge and the highlight agree.
 */
import { findQuoteInPieces, type TextPiece } from "../../../shared/quoteMatch";

const BLOCKS = new Set([
  "P",
  "DIV",
  "LI",
  "TD",
  "TH",
  "TR",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "SECTION",
  "ARTICLE",
  "TABLE",
  "UL",
  "OL",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "FIGURE",
  "BLOCKQUOTE",
]);
const SKIPPED = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);

/**
 * The text nodes under `root`, in order; only those `within` touches, if
 * given. Text under an element marked `data-quote-skip` inside `root` is
 * left out; `root` may itself be inside one, as a Word comment's note in the
 * margin is, to look in it alone.
 */
export function textNodes(root: Node, within?: Range): Text[] {
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      const skipped = parent?.closest("[data-quote-skip]");
      if (
        !parent ||
        SKIPPED.has(parent.tagName) ||
        (skipped && skipped !== root && root.contains(skipped))
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      if (within && !within.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let node = walker?.nextNode(); node; node = walker?.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** The nearest block element around a node: text in different blocks reads with a line break between. */
function blockOf(node: Node): Element | null {
  let current = node.parentElement;
  while (current && !BLOCKS.has(current.tagName)) current = current.parentElement;
  return current;
}

/** The text nodes as the pieces of one text, a line break between blocks. */
export const piecesOf = (nodes: readonly Text[]): TextPiece[] =>
  nodes.map((node, index) => ({
    text: node.data,
    breakAfter: index + 1 < nodes.length && blockOf(node) !== blockOf(nodes[index + 1] as Node),
  }));

/**
 * Finds `quote` in `nodes` and wraps what it covers in marks; returns them in
 * order, or null if the quote isn't there.
 */
export function markQuote(nodes: readonly Text[], quote: string): HTMLElement[] | null {
  const pieces = piecesOf(nodes);
  const found = findQuoteInPieces(pieces, quote);
  if (!found || found.length === 0) return null;
  const marks: HTMLElement[] = [];
  // From the last part back, so earlier offsets in the same text node still hold.
  for (let index = found.length - 1; index >= 0; index--) {
    const part = found[index] as (typeof found)[number];
    const node = nodes[part.piece] as Text;
    const range = node.ownerDocument.createRange();
    range.setStart(node, part.start);
    range.setEnd(node, part.end);
    const mark = node.ownerDocument.createElement("mark");
    const previous = found[index - 1];
    const next = found[index + 1];
    const joins = `${previous && part.start === 0 && previous.end === (nodes[previous.piece] as Text).data.length ? " quote-highlight--joins-before" : ""}${
      next && next.start === 0 && part.end === node.data.length
        ? " quote-highlight--joins-after"
        : ""
    }`;
    mark.className = `quote-highlight${joins}`;
    mark.dataset.quoteHighlight = "";
    range.surroundContents(mark);
    marks.unshift(mark);
  }
  return marks;
}

/** Takes the marks `markQuote` made out again, leaving the text as it was. */
export function unmarkQuote(root: Element): void {
  for (const mark of root.querySelectorAll("mark[data-quote-highlight]")) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}
