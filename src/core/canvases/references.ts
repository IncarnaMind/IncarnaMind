/**
 * What a Canvas's HTML tries to load from the network (#3406), so the agent hears it at once: a
 * Canvas reaches no network, so each of these stays empty on the page. A link the User clicks is
 * not one: it is offered to them to open in their browser.
 */

/** The most addresses one publish lists. */
const LISTED = 10;

const REMOTE = String.raw`(?:https?:|wss?:|ftp:)?\/\/[^\s"'()<>]+`;

const PATTERNS = [
  // An element's address, of any element but a link the User follows.
  new RegExp(
    String.raw`<(?!a[\s>]|area[\s>])[a-z][\w-]*\b[^>]*?\b(?:src|href|srcset|poster|data|action|formaction)\s*=\s*["']?\s*(${REMOTE})`,
    "gi",
  ),
  new RegExp(String.raw`url\(\s*["']?\s*(${REMOTE})`, "gi"),
  new RegExp(String.raw`@import\s+["']\s*(${REMOTE})`, "gi"),
];

/** The network addresses the HTML loads from, each once, in order, at most `LISTED`. */
export function networkReferences(html: string): string[] {
  const found: { at: number; address: string }[] = [];
  for (const pattern of PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      const address = match[1];
      if (address) found.push({ at: match.index, address });
    }
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((each) => each.address))].slice(
    0,
    LISTED,
  );
}
