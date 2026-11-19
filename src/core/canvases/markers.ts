/**
 * The Citations in a Canvas's text (#3406): the `[cite:…]` tokens an agent writes in the page's
 * markup, where a reader reads them, and the markers IncarnaMind puts in their place when it serves
 * the page. The page is parsed as HTML (linkedom, as Web pages are), and only its text nodes count:
 * never a script, a style, an attribute, a comment, a title or an SVG, where a token is code, data
 * or a drawing and stays exactly as written. A page bundled into one script (a React app) has its
 * text in the script, so its tokens stay as written too; the agent is told so. The markers are
 * written here, as the page is served, never by a script in the page.
 */
import { parseHTML } from "linkedom";

const TOKEN = /\[cite:([a-z0-9]{1,32})\]/g;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Elements whose content is no text a reader reads in the page's markup. */
const NOT_TEXT = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "TEXTAREA",
  "TITLE",
  "NOSCRIPT",
  "XMP",
  "IFRAME",
  "NOEMBED",
  "NOFRAMES",
  "SVG",
  "MATH",
]);

/** The text nodes of the page's markup that hold a token, in order. */
function textWithTokens(root: Node): Text[] {
  const found: Text[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === TEXT_NODE) {
      if ((node as Text).data.includes("[cite:")) found.push(node as Text);
      return;
    }
    if (node.nodeType === ELEMENT_NODE && NOT_TEXT.has(node.nodeName.toUpperCase())) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return found;
}

const tokensIn = (text: string) => [...text.matchAll(TOKEN)].flatMap((match) => match[1] ?? []);

/** The tokens the page's markup cites in its text, each once, in the order they first appear. */
export function citedTokens(html: string): string[] {
  return [
    ...new Set(textWithTokens(parseHTML(html).document).flatMap((node) => tokensIn(node.data))),
  ];
}

/** Tokens written anywhere but the markup's text: they stay as written, and open nothing. */
export function tokensOutsideText(html: string): string[] {
  const inText = new Set(citedTokens(html));
  return [...new Set(tokensIn(html))].filter((token) => !inText.has(token));
}

/**
 * How a marker is drawn: small, in the page's own font and colour, so it reads in the page's light
 * or dark.
 */
const MARKER_STYLE = [
  "font: inherit",
  "font-size: 0.75em",
  "line-height: 1",
  "vertical-align: super",
  "color: inherit",
  "white-space: nowrap",
  "cursor: pointer",
  "text-decoration: underline dotted",
  "text-underline-offset: 2px",
].join("; ");

const MISSING_STYLE = [
  "font: inherit",
  "font-size: 0.75em",
  "line-height: 1",
  "vertical-align: super",
  "color: inherit",
  "opacity: 0.7",
  "white-space: nowrap",
].join("; ");

export interface MarkerWords {
  /** What a reader and a screen reader hear of the marker numbered `n`: its Document and place. */
  label(token: string, n: number): string;
  /** A token IncarnaMind didn't mint for the agent, or that reaches no Document now. */
  notFound: string;
}

/**
 * The page with each token of `cited` in its markup's text turned into its marker, numbered in the
 * order the page first cites each, and every other token there into one that says it wasn't found.
 * A marker names its token alone: the app opens it from that Canvas's own Citations, whatever a
 * page's script makes of the marker. A page whose text cites nothing is served exactly as written.
 */
export function withMarkers(html: string, cited: ReadonlySet<string>, words: MarkerWords): string {
  const { document } = parseHTML(html);
  const nodes = textWithTokens(document);
  if (!nodes.some((node) => tokensIn(node.data).length > 0)) return html;
  const numbers = new Map<string, number>();
  const marker = (token: string): Node => {
    const element = document.createElement("incarnamind-cite");
    if (!cited.has(token)) {
      element.setAttribute("data-missing", "");
      element.setAttribute("style", MISSING_STYLE);
      element.setAttribute("title", words.notFound);
      element.textContent = `[${words.notFound}]`;
      return element;
    }
    const n = numbers.get(token) ?? numbers.size + 1;
    numbers.set(token, n);
    const label = words.label(token, n);
    element.setAttribute("data-token", token);
    element.setAttribute("role", "link");
    element.setAttribute("tabindex", "0");
    element.setAttribute("title", label);
    element.setAttribute("aria-label", label);
    element.setAttribute("style", MARKER_STYLE);
    element.textContent = `[${n}]`;
    return element;
  };
  for (const node of nodes) {
    const text = node.data;
    const parts: Node[] = [];
    let at = 0;
    for (const match of text.matchAll(TOKEN)) {
      if (match.index > at) parts.push(document.createTextNode(text.slice(at, match.index)));
      parts.push(marker(match[1] ?? ""));
      at = match.index + match[0].length;
    }
    if (at < text.length) parts.push(document.createTextNode(text.slice(at)));
    node.replaceWith(...parts);
  }
  return document.toString();
}
