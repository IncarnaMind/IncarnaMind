/**
 * Text a model writes where it should have called a Tool: a `<cite>` block of
 * records, a `<tool_call>` of JSON, as tags or escaped ("&lt;cite&gt;"), or the
 * call itself (`cite([…])`). The Answer never shows it. The records of a
 * `cite` block go back to be recorded as `cite` would have, so the Citations
 * they name are not lost; any other block just goes, and the sentences it was
 * for read as uncited.
 *
 * A block is only what is shaped like a call: a Tool's tag, or its name and a
 * bracket, then JSON. The same words without JSON ("the <cite> element",
 * "cite (2024)"), or inside code or maths, are the text's own.
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

/**
 * Where a block starts: a Tool's tag (group 1), its name and an opening bracket (group 2), or,
 * at the start of a line, its name and a colon ("cite: [...]", group 3).
 */
const openerPattern = (names: readonly string[], json: string) =>
  new RegExp(
    `(?:${OPEN}(${alternatives(names)})${ATTRIBUTES}${CLOSE}|(?<![\\w-])(${alternatives(names)})\\(|(?<![^\\n])[ \\t]*(${alternatives(names)})[ \\t]*:)\\s*(?=${json})`,
    "gi",
  );

/** What closes a block: the closing bracket right after its JSON, or the tag's closing tag. */
const closerPattern = (tag: string, call: boolean) =>
  call ? /^\s*\)/ : new RegExp(`\\s*${OPEN}/${escapeRegExp(tag)}\\s*${CLOSE}`, "i");

interface Block {
  from: number;
  to: number;
  tag: string;
  /** What is between its tags, as written. */
  content: string;
  escaped: boolean;
}

/**
 * The blocks that show: an opener, JSON, and its closer. A block whose JSON
 * is cut off is the rest of its paragraph: the words after it are the Answer's.
 */
function blocksIn(text: string, names: readonly string[]): Block[] {
  const apart: Block[] = [];
  for (const each of text.matchAll(openerPattern(names, JSON_START))) {
    if (each.index < (apart.at(-1)?.to ?? 0)) continue;
    const call = each[1] === undefined;
    const tag = (each[1] ?? each[2] ?? each[3] ?? "").toLowerCase();
    const start = each.index + each[0].length;
    const json = jsonEnd(text, start);
    const paragraph = text.indexOf("\n\n", start);
    // A tag's block runs to its closing tag; a call's to the bracket right after its JSON, and
    // a name with a colon's to the end of its JSON.
    const closer =
      each[3] !== undefined || (call && json === undefined)
        ? null
        : call && json !== undefined
          ? closerPattern(tag, true).exec(text.slice(json))
          : closerPattern(tag, false).exec(text.slice(start));
    const end =
      !call && closer
        ? start + closer.index
        : (json ?? (paragraph === -1 ? text.length : paragraph));
    apart.push({
      from: each.index,
      to: end + (closer?.[0].length ?? 0),
      tag,
      content: text.slice(start, end),
      escaped: each[0].startsWith("&"),
    });
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
 * never shows even for a moment: from the first opener that has JSON after it
 * or nothing yet, or from an opener still being typed.
 */
export function heldBackFrom(text: string, names: readonly string[] = TOOL_TEXT_TAGS): number {
  const inFence = (at: number) =>
    (text.slice(0, at).match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0) % 2 === 1;
  const opened = [
    ...text.matchAll(openerPattern(names, '$|\\[\\s*(?:[{\\]]|$)|\\{\\s*(?:"|&quot;|\\}|$)')),
  ].find((each) => !inFence(each.index))?.index;
  const typing = /(?:<|&(?:l(?:t;?)?)?|(?<![\w-]))([a-z_]*)$/i.exec(text);
  const partial =
    typing &&
    names.some((name) => name.startsWith((typing[1] ?? "").toLowerCase())) &&
    !inFence(typing.index)
      ? typing.index
      : undefined;
  return Math.min(opened ?? text.length, partial ?? text.length);
}
