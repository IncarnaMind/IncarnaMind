/**
 * A Tool call's own markup in one of its text arguments (#3476). A model whose call comes in
 * malformed can run the call's syntax into the text: in the format Claude's calls are written in,
 * an argument closes with `</parameter>` or its own name (`</content>`) and the next opens with
 * `<parameter name="after">`. Written into a Note, that markup reads as words. A Note may quote it
 * on purpose, in a code block or a code span, where it is left alone.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;
const CALL_TAG =
  /<(?:[a-z]+:)?(?:parameter|invoke) name="[^"<>\n]*">|<\/(?:[a-z]+:)?(?:parameter|invoke)>/;

/** The text with its fenced code blocks and code spans left out. */
function outsideCode(text: string): string {
  const kept: string[] = [];
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line)?.[1];
    if (open !== null) {
      if (
        fence !== undefined &&
        fence[0] === open[0] &&
        fence.length >= open.length &&
        line.trim() === fence
      ) {
        open = null;
      }
      continue;
    }
    if (fence) {
      open = fence;
      continue;
    }
    kept.push(line.replace(CODE_SPAN, " "));
  }
  return kept.join("\n");
}

/**
 * The first piece of call markup `text`, given as the argument `argument`, holds outside its code:
 * an argument's opening or closing tag, or this argument's own closing tag. Null for none.
 */
export function callMarkupIn(text: string, argument: string): string | null {
  const plain = outsideCode(text);
  const own = plain.indexOf(`</${argument}>`);
  const call = CALL_TAG.exec(plain);
  if (own < 0) return call?.[0] ?? null;
  if (call && call.index < own) return call[0];
  return `</${argument}>`;
}
