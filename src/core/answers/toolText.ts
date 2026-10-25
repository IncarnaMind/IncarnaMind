/**
 * Text a model writes where it should have called a Tool: a `<cite>` block of
 * records, a `<tool_call>` of JSON, as tags or escaped ("&lt;cite&gt;"). The
 * Answer never shows it. The records of a `<cite>` block go back to be
 * recorded as `cite` would have, so the Citations they name are not lost;
 * any other block just goes, and the sentences it was for read as uncited.
 *
 * A block is only what is shaped like a call: a tag of a Tool, then JSON. The
 * same tag around words ("the <cite> element"), or inside code or maths, is
 * the text's own.
 */
import { shownRanges } from "../../shared/answerBlocks";

const CITE = "cite";

/** The tags that are tool-call text whether or not the Answer was offered such a Tool. */
export const TOOL_TEXT_TAGS: readonly string[] = [
  CITE,
  "calculate",
  "search_documents",
  "tool_call",
  "tool_calls",
  "tool_use",
  "function_call",
  "function_calls",
  "invoke",
];

const OPEN = "(?:<|&lt;)";
const CLOSE = "(?:>|&gt;)";
const ATTRIBUTES = "(?:[ \\t][^<>\\n]*)?";
/** What JSON of a call starts with: an array of objects, or an object. */
const JSON_START = '(?:\\[\\s*[{\\]]|\\{\\s*(?:"|&quot;|\\}))';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (names: readonly string[]) => names.map(escapeRegExp).join("|");

const closedPattern = (names: readonly string[]) =>
  new RegExp(
    `${OPEN}(${alternatives(names)})${ATTRIBUTES}${CLOSE}\\s*(${JSON_START}[\\s\\S]*?)\\s*${OPEN}/\\1\\s*${CLOSE}`,
    "gi",
  );

const openingPattern = (names: readonly string[]) =>
  new RegExp(`${OPEN}(${alternatives(names)})${ATTRIBUTES}${CLOSE}\\s*(?=${JSON_START})`, "gi");

interface Block {
  from: number;
  to: number;
  tag: string;
  /** What is between its tags, as written. */
  content: string;
  escaped: boolean;
}

/**
 * The blocks that show: a tag, JSON, and a closing tag. A block never closed
 * is its tag and the JSON after it, or, when that is cut off, the rest of its
 * paragraph: the words after it are the Answer's.
 */
function blocksIn(text: string, names: readonly string[]): Block[] {
  const closed = [...text.matchAll(closedPattern(names))].map((each) => ({
    from: each.index,
    to: each.index + each[0].length,
    tag: (each[1] ?? "").toLowerCase(),
    content: each[2] ?? "",
    escaped: each[0].startsWith("&"),
  }));
  const cutOff = [...text.matchAll(openingPattern(names))]
    .filter((each) => !closed.some((block) => each.index >= block.from && each.index < block.to))
    .map((each) => {
      const start = each.index + each[0].length;
      const paragraph = text.indexOf("\n\n", start);
      const to = jsonEnd(text, start) ?? (paragraph === -1 ? text.length : paragraph);
      return {
        from: each.index,
        to,
        tag: (each[1] ?? "").toLowerCase(),
        content: text.slice(start, to),
        escaped: each[0].startsWith("&"),
      };
    });
  const apart: Block[] = [];
  for (const block of [...closed, ...cutOff].sort((a, b) => a.from - b.from)) {
    if (block.from >= (apart.at(-1)?.to ?? 0)) apart.push(block);
  }
  const shown = shownRanges(
    text,
    apart.map((each) => ({ start: each.from, end: each.to })),
  );
  return apart.filter((_, index) => shown[index]);
}

const decoded = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Where the JSON value that starts at `from` ends, when it is whole; a marker or words may follow it. */
function jsonEnd(text: string, from: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let at = from; at < text.length; at++) {
    const quote = text.startsWith("&quot;", at) ? 6 : text[at] === '"' ? 1 : 0;
    if (inString) {
      if (text[at] === "\\") at++;
      else if (quote > 0) {
        inString = false;
        at += quote - 1;
      }
    } else if (quote > 0) {
      inString = true;
      at += quote - 1;
    } else if (text[at] === "[" || text[at] === "{") depth++;
    else if ((text[at] === "]" || text[at] === "}") && --depth === 0) return at + 1;
  }
  return undefined;
}

/** The records a `<cite>` block gives: its first JSON value, one record or a list of them. */
function recordsIn(block: Block): unknown[] {
  const end = jsonEnd(block.content, 0);
  if (end === undefined) return [];
  try {
    const written = block.content.slice(0, end);
    const value: unknown = JSON.parse(block.escaped ? decoded(written) : written);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

/** The tool-call text in `text`, each block as written. */
export const toolTextIn = (text: string, names: readonly string[] = TOOL_TEXT_TAGS): string[] =>
  blocksIn(text, names).map((block) => text.slice(block.from, block.to));

/**
 * `text` without its tool-call text, and the records a `<cite>` block gave, as
 * the model wrote them. A block alone on its lines takes them with it.
 */
export function takeToolText(
  text: string,
  names: readonly string[] = TOOL_TEXT_TAGS,
): { text: string; records: unknown[] } {
  const blocks = blocksIn(text, names);
  if (blocks.length === 0) return { text, records: [] };
  const records: unknown[] = [];
  let out = "";
  let at = 0;
  for (const block of blocks) {
    if (block.tag === CITE) records.push(...recordsIn(block));
    const before = text.slice(at, block.from).replace(/[ \t]+$/, "");
    const startsLine = out + before === "" || (out + before).endsWith("\n");
    const alone = startsLine && /^[ \t]*(?:\n|$)/.test(text.slice(block.to));
    out += before;
    at = block.to;
    if (alone) at += /^[ \t]*\n?/.exec(text.slice(block.to))?.[0].length ?? 0;
  }
  const rest = text.slice(at);
  out += out.endsWith("\n\n") ? rest.replace(/^\n+/, "") : rest;
  return { text: at >= text.length ? out.trimEnd() : out, records };
}

/**
 * Where the Answer's text is held back while it streams, so tool-call text
 * never shows even for a moment: from the first opening tag that has JSON
 * after it or nothing yet, or from an opening tag still being typed.
 */
export function heldBackFrom(text: string, names: readonly string[] = TOOL_TEXT_TAGS): number {
  const inFence = (at: number) =>
    (text.slice(0, at).match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0) % 2 === 1;
  const opened = [
    ...text.matchAll(
      new RegExp(
        `${OPEN}(?:${alternatives(names)})${ATTRIBUTES}${CLOSE}\\s*(?=$|\\[\\s*(?:[{\\]]|$)|\\{\\s*(?:"|&quot;|\\}|$))`,
        "gi",
      ),
    ),
  ].find((each) => !inFence(each.index))?.index;
  const typing = /(?:<|&(?:l(?:t;?)?)?)([a-z_]*)$/i.exec(text);
  const partial =
    typing &&
    names.some((name) => name.startsWith((typing[1] ?? "").toLowerCase())) &&
    !inFence(typing.index)
      ? typing.index
      : undefined;
  return Math.min(opened ?? text.length, partial ?? text.length);
}
