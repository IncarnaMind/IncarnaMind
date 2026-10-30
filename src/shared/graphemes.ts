/**
 * Where one character as a reader sees it ends, for cutting text without splitting one (#2220):
 * a surrogate pair (an emoji), a mark from its base (an accent) and a joined sequence (a family
 * emoji) each stay whole. The runtime's grapheme segmenter when it has one, and those three cases
 * otherwise.
 */

/** The part of `Intl.Segmenter` a cut needs. */
export interface GraphemeSegmenter {
  segment(text: string): Iterable<{ index: number }>;
}

let cached: GraphemeSegmenter | null | undefined;

function segmenter(): GraphemeSegmenter | null {
  if (cached === undefined) {
    cached =
      typeof Intl === "undefined" || !("Segmenter" in Intl)
        ? null
        : new Intl.Segmenter(undefined, { granularity: "grapheme" });
  }
  return cached;
}

/** Characters read past the cut, so a cluster that crosses it is seen whole. */
const LOOKAHEAD = 256;

const JOINER = "‍";
const MARK = /^\p{M}$/u;

const splitsSurrogatePair = (text: string, at: number): boolean => {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
};

/**
 * `end` moved back to the nearest boundary between characters as a reader sees them: a cut there
 * keeps the text before it whole. `segmenter` is for a test of the fallback.
 */
export function graphemeBoundary(
  text: string,
  end: number,
  segmenterUsed: GraphemeSegmenter | null = segmenter(),
): number {
  const at = Math.max(0, Math.min(end, text.length));
  if (at === 0 || at === text.length) return at;
  if (segmenterUsed) {
    // Some context past the cut, so a cluster that crosses it is seen whole.
    const seen = Math.min(text.length, at + 1 + LOOKAHEAD);
    let boundary = 0;
    for (const { index } of segmenterUsed.segment(text.slice(0, seen))) {
      if (index > at) break;
      boundary = index;
    }
    return boundary;
  }
  let cut = at;
  while (cut > 0) {
    const joined =
      splitsSurrogatePair(text, cut) ||
      text[cut] === JOINER ||
      text[cut - 1] === JOINER ||
      MARK.test(text[cut] ?? "");
    if (!joined) return cut;
    cut -= 1;
  }
  return cut;
}
