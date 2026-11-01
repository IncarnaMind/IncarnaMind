/**
 * Writing Proposals into a Mind's Yjs document (see `PROPOSAL_INSERT_MARK` in
 * ../api), in the shape the editor's binding reads (see ../answers/blocks):
 *
 * - `readSelection` reads a stretch of a Mind's text, from one paragraph or
 *   heading to another (`TextPlace`), as the model will read it: Citations
 *   and the User's footnotes as numbered markers ("[1]", "[^1]"), formulas as
 *   $…$, paragraphs apart.
 * - `proposeRewrite` compares that stretch with the model's new text, word by
 *   word (./diff), and marks each place that changed as a Proposal of its
 *   own: the words it removes stay, under `proposalDelete`, and the words it
 *   adds go after them, under `proposalInsert`. Paragraphs the new text adds
 *   or drops are Proposals on whole Blocks.
 *   A Markdown table in the new text is a new table Block (#961), its cells'
 *   markers the stretch's Citations; pipe lines that make no table are
 *   written nowhere (`Written.unmadeTable`).
 * - `proposeAfter` adds new paragraphs under the stretch, each a Proposal.
 * - `proposeBlocks` writes new content for a whole element (an Answer
 *   written again) over what it holds, and `proposeOver` over Blocks of a
 *   Mind (the assistant's own text written anew): Blocks kept as they are,
 *   each paragraph paired with the one it is most like and compared word by
 *   word, lists item by item, and other Blocks added or removed whole.
 * - `takeBackForRegenerate` rejects a Proposal and says where the text it
 *   covered is now, to make it again from that text.
 *
 * Nothing in the Mind is changed but by marks, attributes and the new words,
 * which are AI text (`GENERATED_MARK`) and stay so once accepted: the User's
 * text stays where and what it was until they accept. Each Proposal records
 * the text it changes (`ProposalRef.target`), so that it goes out of date
 * once that text changes.
 */
import * as Y from "yjs";
import { INLINE_CODE_MARK } from "../../shared/aiText";
import { looksLikeTable, rowCells, type TableAlign, tableStart } from "../../shared/markdownTables";
import { citesSource, linkSources, type NamedSource } from "../../shared/namedSources";
import {
  INLINE_NODES,
  NODE_CHARACTER,
  readProposalAttribute,
  readProposalRef,
  resolveProposals,
  targetHash,
  targetText,
} from "../../shared/proposals";
import { citationElementId } from "../../shared/signOffs";
import { createElement, formattingOf, type NodeJSON } from "../answers/blocks";
import {
  emphasisOf,
  escapeEmphasis,
  escapeRemovedMark,
  type Look,
  withoutEmphasisEscapes,
} from "../answers/markdown";
import {
  BLOCK_ID_ATTRIBUTE,
  type BlockKind,
  CHART_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  GENERATED_MARK,
  type LeftOutPart,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type ProposalAttribute,
  type ProposalRef,
  type TextPlace,
} from "../api";
import { MOST_OF_IT, mapsOnto } from "../edits/applies";
import {
  escapeNames,
  NAME_AT_LINE,
  NAME_LINE,
  type ParagraphName,
  paragraphName,
  readName,
  readRemovals,
  unescapeNames,
  unnameRemovals,
} from "../edits/prompt";
import { diffSteps, hunksOf, type Step, splitWords } from "./diff";

/** The Blocks whose text can be edited: Notes' and Answers' paragraphs and headings. */
const TEXT_BLOCKS: ReadonlySet<string> = new Set(["paragraph", "heading"]);
/** Elements whose text isn't edited, and whose Blocks aren't looked into. */
const NOT_EDITED: ReadonlySet<string> = new Set(["question", "codeBlock", "blockMath"]);
/** Containers a removed paragraph takes with it when it is all they hold. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "listItem",
  "bulletList",
  "orderedList",
  "blockquote",
]);

/** What a table holds, which a new table climbs out of to go beside: tables don't go in tables. */
const TABLE_PARTS: ReadonlySet<string> = new Set(["table", "tableRow", "tableCell", "tableHeader"]);

const MATH = "inlineMath";
const BREAK = "hardBreak";

type Attributes = Record<string, unknown>;

interface Run {
  insert: unknown;
  attributes?: Attributes;
}

/** A token of the selected text: where it is in its Block (in `TextPlace` offsets) and what it is. */
interface OldToken {
  /** What the diff compares (see `keyOf`). */
  key: string;
  from: number;
  to: number;
  /** How a Proposal that removes it records it (`targetText`). */
  target: string;
  /** Its text, or for an inline node its name and attributes. */
  text?: string;
  /** An inline node as the model reads it: "[1]", "$x^2$". */
  shown?: string;
  attributes?: Attributes;
  node?: InlineNode;
}

/** An inline node of the selection, or one the new text adds. */
interface InlineNode {
  name: string;
  attributes: Attributes;
  /** What it holds, copied where it moves to: a footnote's text. */
  source?: Y.XmlElement;
  /** For a Citation the new text cites again: the id of the selection's Citation it is (#1933). */
  cites?: string;
}

/** The part of one paragraph or heading the selection covers. */
interface Segment {
  element: Y.XmlElement;
  from: number;
  to: number;
  /** The selection covers all of its text. */
  whole: boolean;
  /**
   * Its text is a paragraph of `Selection.text`. An empty one isn't: the
   * model's paragraphs pair with only those it was shown.
   */
  shown: boolean;
  /** Its tokens in [from, to), leading and trailing spaces left out: they stay as they are. */
  tokens: OldToken[];
  /** Where those tokens start and end (`from`..`to` with the spaces left out). */
  start: number;
  end: number;
  /**
   * The kind of Block the model was shown it as (`blockMarker`): its own,
   * when the selection starts at the Block's start; a plain paragraph's
   * otherwise, as a part of a Block has no marker.
   */
  kind: BlockKind;
}

/** A paragraph's or heading's kind of Block, from where it is. */
function kindOf(element: Y.XmlElement): BlockKind {
  if (element.nodeName === "heading") {
    return `heading:${Math.min(6, Math.max(1, Number(element.getAttribute("level")) || 1))}`;
  }
  const parent = element.parent;
  if (parent instanceof Y.XmlElement && parent.nodeName === "listItem") {
    const list = parent.parent;
    return list instanceof Y.XmlElement && list.nodeName === "orderedList" ? "numbered" : "bullet";
  }
  if (parent instanceof Y.XmlElement && parent.nodeName === "blockquote") return "quote";
  return "paragraph";
}

/** How the model reads a paragraph's kind: a Markdown-like marker at its start; none for a plain one. */
function blockMarker(kind: BlockKind): string {
  if (kind.startsWith("heading:")) return `${"#".repeat(Number(kind.slice("heading:".length)))} `;
  return kind === "bullet" ? "- " : kind === "numbered" ? "1. " : kind === "quote" ? "> " : "";
}

/** A Block's marker at a line's start, as the model writes it. */
const BLOCK_MARKER = String.raw`(?:#{1,6}|[-*•]|\d+[.)]|>)[ \t]`;

/**
 * Lines whose text starts like a Block's marker (a typed "1. Background", a
 * pasted "• Revenue grew"), after any backslashes that escape one: from the
 * paragraph's start, or only after its first line.
 */
const LOOKS_MARKED = {
  start: new RegExp(String.raw`(^|\n)(?=\\*${BLOCK_MARKER})`, "g"),
  next: new RegExp(String.raw`(\n)(?=\\*${BLOCK_MARKER})`, "g"),
};
const ESCAPED_MARKER = {
  start: new RegExp(String.raw`(^|\n)\\(?=\\*${BLOCK_MARKER})`, "g"),
  next: new RegExp(String.raw`(\n)\\(?=\\*${BLOCK_MARKER})`, "g"),
};

/**
 * A paragraph's text with each line that would read as a Block's marker
 * escaped the way Markdown does ("\1. Background"), so that it stays text
 * (#703). The first line has nothing to escape after a marker of its own.
 */
const escapeMarkers = (text: string, kind: BlockKind) =>
  text.replace(LOOKS_MARKED[kind === "paragraph" ? "start" : "next"], "$1\\");

/** One of the model's paragraphs with those escapes taken off: one backslash each. */
const unescapeMarkers = (paragraph: string, marked: boolean) =>
  paragraph.replace(ESCAPED_MARKER[marked ? "next" : "start"], "$1");

/** A marker at the start of one of the model's paragraphs: its kind, and how long the marker is. */
function readBlockMarker(paragraph: string): { kind: BlockKind; length: number } | null {
  const marker = new RegExp(`^${BLOCK_MARKER}+`).exec(paragraph)?.[0];
  if (marker === undefined) return null;
  const hashes = /^#+/.exec(marker)?.[0].length;
  const kind: BlockKind = hashes
    ? `heading:${hashes}`
    : marker.startsWith(">")
      ? "quote"
      : /^\d/.test(marker)
        ? "numbered"
        : "bullet";
  return { kind, length: marker.length };
}

/** A stretch of a Mind's text, read for Edit with AI. */
export interface Selection {
  segments: Segment[];
  /** The Citations in it, in order: marker n is `citations[n - 1]`. */
  citations: Attributes[];
  citedElements: Y.XmlElement[];
  /** The User's footnotes in it, in order: marker "[^n]" is `footnotes[n - 1]`. */
  footnotes: Y.XmlElement[];
  /** The selected text as the editor reads it: an inline node as U+FFFC, a line per paragraph. */
  plain: string;
  /**
   * The selected text as the model reads it: markers for Citations,
   * paragraphs apart, each Block that isn't a plain paragraph with its kind's
   * marker (`blockMarker`), and then text that looks like one escaped
   * (`escapeMarkers`).
   */
  text: string;
  /** `text` with each paragraph's name before it (`paragraphName`), and typed text that reads as one escaped (#2356). */
  named: string;
  /** Some paragraph of `text` has a kind's marker: the model's paragraphs are read with theirs. */
  marked: boolean;
  /** The whole paragraphs it is in, the same way. */
  context: string;
  /**
   * The words just before and just after it in its paragraphs, when it is
   * part of one: its new text must fit between them, and not repeat them.
   * "" at a paragraph's edge.
   */
  before: string;
  after: string;
  /** How many characters it holds, for the model's window. */
  characters: number;
}

export type ReadResult =
  | { ok: true; selection: Selection }
  | { ok: false; reason: "changed" | "has-proposals" | "busy" };

const stringOf = (value: unknown) => (typeof value === "string" ? value : "");

/** The paragraphs and headings of the Mind, in order, at any depth, with whether an Answer being written holds them. */
export function textBlocks(
  blocks: Y.XmlFragment,
  { charts = false }: { charts?: boolean } = {},
): { element: Y.XmlElement; busy: boolean }[] {
  return blocks.toArray().flatMap((child) => textBlocksOf(child, { charts }));
}

/** `textBlocks` of one of the Mind's top-level Blocks. */
export function textBlocksOf(
  block: unknown,
  { charts = false }: { charts?: boolean } = {},
): { element: Y.XmlElement; busy: boolean }[] {
  const found: { element: Y.XmlElement; busy: boolean }[] = [];
  const visit = (child: unknown, busy: boolean) => {
    if (!(child instanceof Y.XmlElement) || NOT_EDITED.has(child.nodeName)) return;
    if (TEXT_BLOCKS.has(child.nodeName) || (charts && child.nodeName === CHART_NODE)) {
      found.push({ element: child, busy });
      return;
    }
    const answering =
      busy || (child.nodeName === "answer" && child.getAttribute("status") === "streaming");
    for (const each of child.toArray()) visit(each, answering);
  };
  visit(block, false);
  return found;
}

/** Whether a Block, or one it is in, is a Proposal's whole Block. */
function inProposal(element: Y.XmlElement): boolean {
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    if (at.getAttribute(PROPOSAL_ATTRIBUTE) !== undefined) return true;
  }
  return false;
}

/** An element's children with where each starts in its text, an inline node counting as one. */
export function layout(element: Y.XmlElement) {
  let at = 0;
  return element.toArray().flatMap((node) => {
    if (!(node instanceof Y.XmlText || node instanceof Y.XmlElement)) return [];
    const size = node instanceof Y.XmlText ? node.length : 1;
    const child = { node, start: at, size };
    at += size;
    return [child];
  });
}

const sizeOf = (element: Y.XmlElement) =>
  layout(element).reduce((sum, child) => sum + child.size, 0);

const hasProposal = (attributes: Attributes | undefined) =>
  !!attributes && (PROPOSAL_INSERT_MARK in attributes || PROPOSAL_DELETE_MARK in attributes);

/**
 * How a token is compared: words as they are; an inline node by what it is,
 * after a character no text holds (`n`: a Citation's or footnote's marker).
 */
const keyOf = {
  text: (text: string) => text,
  citation: (n: number) => `\u0000c${n}`,
  footnote: (n: number) => `\u0000f${n}`,
  math: (latex: string) => `\u0000m${latex}`,
  break: () => "\u0000b",
  node: (name: string, n: number) => `\u0000n${name}${n}`,
};

/**
 * Reads the text from `from` to `to`, or says why it can't be edited: a place
 * isn't in the Mind (it changed), the text holds Proposals still waiting, or
 * an Answer being written holds it.
 */
export function readSelection(blocks: Y.XmlFragment, from: TextPlace, to: TextPlace): ReadResult {
  const all = textBlocks(blocks);
  const first = all.findIndex(
    ({ element }) => element.getAttribute(BLOCK_ID_ATTRIBUTE) === from.blockId,
  );
  const last = all.findIndex(
    ({ element }) => element.getAttribute(BLOCK_ID_ATTRIBUTE) === to.blockId,
  );
  if (first < 0 || last < first) return { ok: false, reason: "changed" };
  const chosen = all.slice(first, last + 1);
  if (chosen.some((each) => each.busy)) return { ok: false, reason: "busy" };
  if (chosen.some(({ element }) => inProposal(element)))
    return { ok: false, reason: "has-proposals" };

  const citations: Attributes[] = [];
  const citedElements: Y.XmlElement[] = [];
  const footnotes: Y.XmlElement[] = [];
  const segments: Segment[] = [];
  const plain: string[] = [];
  const text: string[] = [];
  const context: string[] = [];
  let characters = 0;
  /** An inline node of the selection, as the model reads it: a numbered marker, a formula. */
  const nodeToken = (node: Y.XmlElement, attributes: Attributes, index: number): NodeKey => {
    const name = node.nodeName;
    if (name === CITATION_NODE) {
      // One written before Citations had ids goes by its element's, which the versions kept before share.
      const id = attributes[BLOCK_ID_ATTRIBUTE] ?? citationElementId(node);
      citations.push(id ? { ...attributes, [BLOCK_ID_ATTRIBUTE]: id } : attributes);
      citedElements.push(node);
      return { key: keyOf.citation(citations.length), shown: `[${citations.length}]` };
    }
    if (name === FOOTNOTE_NODE) {
      footnotes.push(node);
      return {
        key: keyOf.footnote(footnotes.length),
        shown: `[^${footnotes.length}]`,
        source: node,
      };
    }
    if (name === MATH) {
      const latex = stringOf(attributes.latex);
      return { key: keyOf.math(latex), shown: `$${latex}$` };
    }
    if (name === BREAK) return { key: keyOf.break(), shown: "\n" };
    // Nothing the model can keep: it comes back without it, for the User to review.
    return { key: keyOf.node(name, index), shown: "" };
  };
  for (const [index, { element }] of chosen.entries()) {
    const size = sizeOf(element);
    const start = index === 0 ? from.offset : 0;
    const end = index === chosen.length - 1 ? to.offset : size;
    if (start < 0 || end > size || start > end) return { ok: false, reason: "changed" };
    const tokens = tokensIn(element, start, end, nodeToken);
    if (!tokens) return { ok: false, reason: "has-proposals" };
    // The spaces at either end stay as they are.
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi && /^\s+$/.test(tokens[lo]?.text ?? "x")) lo++;
    while (hi > lo && /^\s+$/.test(tokens[hi - 1]?.text ?? "x")) hi--;
    const kept = tokens.slice(lo, hi);
    const shownText = tokens
      .map((token) => token.text ?? token.shown ?? "")
      .join("")
      .trim();
    const modelText = withEmphasis(tokens).trim();
    const kind = start === 0 ? kindOf(element) : "paragraph";
    segments.push({
      element,
      from: start,
      to: end,
      whole: start === 0 && end === size,
      shown: shownText !== "",
      tokens: kept,
      start: kept[0]?.from ?? start,
      end: kept.at(-1)?.to ?? start,
      kind,
    });
    plain.push(tokens.map((token) => token.text ?? NODE_CHARACTER).join(""));
    text.push(modelText);
    context.push(blockText(element));
    characters += shownText.length;
  }
  const firstBlock = chosen[0]?.element;
  const lastBlock = chosen.at(-1)?.element;
  const marked = segments.some((segment) => segment.shown && segment.kind !== "paragraph");
  const paragraphs = text
    .map((shown, index) => {
      const kind = segments[index]?.kind ?? "paragraph";
      return shown === "" || !marked ? shown : `${blockMarker(kind)}${escapeMarkers(shown, kind)}`;
    })
    .filter((each) => each !== "");
  return {
    ok: true,
    selection: {
      segments,
      citations,
      citedElements,
      footnotes,
      plain: plain.join("\n"),
      text: paragraphs.join("\n\n"),
      named: paragraphs
        .map((each, index) => `${paragraphName(index)} ${escapeNames(each)}`)
        .join("\n\n"),
      marked,
      context: context.join("\n\n"),
      before: firstBlock ? nearWords(blockText(firstBlock, 0, from.offset), "before") : "",
      after: lastBlock ? nearWords(blockText(lastBlock, to.offset), "after") : "",
      characters,
    },
  };
}

/** A word's key with its look; spaces have none, since a run's edges are written outside its marks. */
const lookedKey = (key: string, text: string | undefined, look: Look) =>
  text === undefined || text.trim() === ""
    ? key
    : `${key}${look.bold ? "\u0001b" : ""}${look.italic ? "\u0001i" : ""}${look.strike ? "\u0001s" : ""}`;

const lookOf = (attributes: Attributes | undefined): Look => ({
  ...(attributes && Object.hasOwn(attributes, "bold") && { bold: true as const }),
  ...(attributes && Object.hasOwn(attributes, "italic") && { italic: true as const }),
  ...(attributes && Object.hasOwn(attributes, "strike") && { strike: true as const }),
});

/**
 * The tokens as the model reads them: words that are bold, italic or struck
 * through between `**`, `*` and `~~`, so it can keep them and tell what the
 * Mind already has (#1897). The spaces at a run's edges stay outside, and a
 * `\`, `*`, `_` or `~` in the words is escaped so it reads back as itself.
 */
function withEmphasis(
  tokens: readonly { text?: string; shown?: string; attributes?: Attributes }[],
) {
  let out = "";
  let run = "";
  let runLook: Look = {};
  const flush = () => {
    const [, lead = "", body = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(run) ?? [];
    let marked = escapeRemovedMark(body);
    if (body !== "") {
      if (runLook.strike) marked = `~~${marked}~~`;
      if (runLook.italic) marked = `*${marked}*`;
      if (runLook.bold) marked = `**${marked}**`;
    }
    out += lead + marked + trail;
    run = "";
  };
  for (const token of tokens) {
    const look = token.text === undefined ? {} : lookOf(token.attributes);
    if (
      Boolean(look.bold) !== Boolean(runLook.bold) ||
      Boolean(look.italic) !== Boolean(runLook.italic) ||
      Boolean(look.strike) !== Boolean(runLook.strike)
    ) {
      flush();
      runLook = look;
    }
    run += token.text === undefined ? (token.shown ?? "") : escapeEmphasis(token.text);
  }
  flush();
  return out;
}

/** A text Block's words as the Mind holds them without `request`'s changes, or once they are accepted; null for a Block that isn't there in that view. */
function viewOf(element: Y.XmlElement, request: string, accepted: boolean): string | null {
  // A list item taken out whole has its Proposal on the item, not on its paragraph (#2180).
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    const whole = readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE));
    if (whole?.request === request && whole.kind === (accepted ? "delete" : "insert")) return null;
  }
  let text = "";
  for (const { node } of layout(element)) {
    if (!(node instanceof Y.XmlText)) continue;
    for (const run of node.toDelta() as Run[]) {
      if (typeof run.insert !== "string") continue;
      const adds = readProposalRef(run.attributes?.[PROPOSAL_INSERT_MARK])?.request === request;
      const removes = readProposalRef(run.attributes?.[PROPOSAL_DELETE_MARK])?.request === request;
      if (accepted ? removes : adds) continue;
      text += run.insert;
    }
  }
  return text;
}

/**
 * The text of the Blocks from `from` to `to`, a line to a Block, as the Mind holds it and as it
 * will read once the changes of `request` are accepted: what an edit really did, not what the
 * model wrote.
 */
export function textAround(
  blocks: Y.XmlFragment,
  from: TextPlace,
  to: TextPlace,
  request: string,
): { before: string; after: string } {
  const all = textBlocks(blocks).map((each) => each.element);
  const first = all.findIndex(
    (element) => element.getAttribute(BLOCK_ID_ATTRIBUTE) === from.blockId,
  );
  const last = all.findIndex((element) => element.getAttribute(BLOCK_ID_ATTRIBUTE) === to.blockId);
  const chosen = first < 0 || last < first ? [] : all.slice(first, last + 1);
  const lines = (accepted: boolean) =>
    chosen.flatMap((element) => viewOf(element, request, accepted) ?? []).join("\n");
  return { before: lines(false), after: lines(true) };
}

/** About this many characters of the words around a selection are shown to the model. */
const NEAR_CHARACTERS = 80;

/**
 * The end of `text` nearest the selection, `NEAR_CHARACTERS` of it at most,
 * without a word cut in two at the far end.
 */
function nearWords(text: string, side: "before" | "after"): string {
  if (text.length <= NEAR_CHARACTERS) return text.trim();
  const cut = side === "before" ? text.slice(-NEAR_CHARACTERS) : text.slice(0, NEAR_CHARACTERS);
  const whole = side === "before" ? cut.replace(/^\S*\s+/u, "") : cut.replace(/\s+\S*$/u, "");
  return (whole === "" ? cut : whole).trim();
}

/** How an inline node is compared, and read by the model; a footnote moved takes its text along (`source`). */
interface NodeKey {
  key: string;
  shown?: string;
  source?: Y.XmlElement;
}

/**
 * The tokens of a paragraph's or heading's text from `start` to `end`
 * (`TextPlace` offsets): its words with their marks, and its inline nodes,
 * compared as `keyNode` says. Null when a Proposal waits there.
 */
function tokensIn(
  element: Y.XmlElement,
  start: number,
  end: number,
  keyNode: (node: Y.XmlElement, attributes: Attributes, index: number) => NodeKey,
): OldToken[] | null {
  const tokens: OldToken[] = [];
  for (const child of layout(element)) {
    if (child.node instanceof Y.XmlText) {
      let at = child.start;
      for (const run of child.node.toDelta() as Run[]) {
        if (typeof run.insert !== "string") continue;
        const runFrom = at;
        at += run.insert.length;
        const cut = run.insert.slice(Math.max(0, start - runFrom), Math.max(0, end - runFrom));
        if (at <= start || runFrom >= end || cut === "") continue;
        if (hasProposal(run.attributes)) return null;
        let tokenFrom = Math.max(start, runFrom);
        for (const word of splitWords(cut)) {
          tokens.push({
            key: keyOf.text(word),
            from: tokenFrom,
            to: tokenFrom + word.length,
            target: word,
            text: word,
            attributes: run.attributes ?? {},
          });
          tokenFrom += word.length;
        }
      }
      continue;
    }
    if (child.start < start || child.start >= end) continue;
    const attributes = child.node.getAttributes() as Attributes;
    if (PROPOSAL_ATTRIBUTE in attributes) return null;
    const { key, shown, source } = keyNode(child.node, attributes, tokens.length);
    tokens.push({
      key,
      from: child.start,
      to: child.start + 1,
      target: targetText(child.node),
      ...(shown !== undefined && { shown }),
      node: { name: child.node.nodeName, attributes, ...(source && { source }) },
    });
  }
  return tokens;
}

/**
 * A paragraph's text as context for the model, all of it or from `start` to
 * `end` (`TextPlace` offsets), as the Mind reads it: what Proposals still
 * waiting add left out, inline nodes as they read, Citations as "[·]".
 */
function blockText(element: Y.XmlElement, start = 0, end = Number.POSITIVE_INFINITY): string {
  let text = "";
  for (const { node, start: at, size } of layout(element)) {
    if (at + size <= start || at >= end) continue;
    if (node instanceof Y.XmlText) {
      let offset = at;
      for (const run of node.toDelta() as Run[]) {
        const words = stringOf(run.insert);
        const from = offset;
        offset += typeof run.insert === "string" ? words.length : 1;
        if (run.attributes && PROPOSAL_INSERT_MARK in run.attributes) continue;
        text += words.slice(Math.max(0, start - from), Math.max(0, end - from));
      }
      continue;
    }
    if (readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "insert") continue;
    if (node.nodeName === MATH) text += `$${stringOf(node.getAttribute("latex"))}$`;
    else if (node.nodeName === BREAK) text += "\n";
    else if (node.nodeName === CITATION_NODE) text += "[·]";
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// The model's text

/** A token of the new text: words, or an inline node of the selection kept (or another). */
interface NewToken {
  key: string;
  text?: string;
  /** The words' own marks (an Answer's), instead of those of the words they replace. */
  marks?: Attributes;
  /** The bold, italic and strikethrough the model wrote around the words. */
  look?: Look;
  node?: InlineNode;
}

const MARKER = /\[\^(\d+)\]|\[(\d+)\]|\$([^$\n]+)\$|\n/g;

/**
 * One of the new text's paragraphs: its tokens, and the kind of Block it is
 * by its marker. Null kind: the model wrote no markers at all, though it was
 * shown some, so the paragraph's kind is unknown and it may take any Block's.
 * Only the new text has tables (`NewTable`).
 */
type NewParagraph = NewText | NewTable;

interface NewText {
  kind: BlockKind | null;
  tokens: NewToken[];
  /** What its name says it is (#2356): the passage's paragraph it replaces, by place from 1, or a new one. */
  name?: ParagraphName;
  table?: undefined;
  open?: undefined;
  /** It holds lines that read as a table's rows but make no table. */
  unmade?: true;
  /** Written as a heading, list item or quote in a passage of plain paragraphs, though read as one. */
  asOther?: true;
  notes: Notes;
}

interface NewTable {
  kind: "table";
  /** All its cells' words and inline nodes. */
  tokens: NewToken[];
  name?: ParagraphName;
  /** Each row's cells' tokens, the heading row first, and its columns' alignment. */
  table: { align: TableAlign[]; rows: NewToken[][][] };
  /** Its next row may still be coming: the line after it is the last, and has no "|" yet. */
  open?: true;
  unmade?: undefined;
  asOther?: undefined;
  notes: Notes;
}

/** What the new text had that the Mind doesn't get as it was written, for the model and the card. */
export interface Notes {
  /** Markers for none of the passage's Citations or footnotes: left out. */
  unmatchedMarkers: number;
  /** Sources in a table's cells written as a name in brackets that matched none of its Citations: kept as text. */
  unlinkedSources: number;
  /** Cells beyond a table's columns: their text kept in their row's last cell. */
  extraCells: number;
}

const noNotes = (): Notes => ({ unmatchedMarkers: 0, unlinkedSources: 0, extraCells: 0 });

export const someNotes = ({ unmatchedMarkers, unlinkedSources, extraCells }: Notes) => ({
  ...(unmatchedMarkers > 0 && { unmatchedMarkers }),
  ...(unlinkedSources > 0 && { unlinkedSources }),
  ...(extraCells > 0 && { extraCells }),
});

const addNotes = (to: Notes, from: Notes): void => {
  to.unmatchedMarkers += from.unmatchedMarkers;
  to.unlinkedSources += from.unlinkedSources;
  to.extraCells += from.extraCells;
};

const BREAK_TAG = /<br[ \t]*\/?>/gi;

interface TableText {
  align: TableAlign[];
  rows: string[][];
  extraCells: number;
  open: boolean;
}

function tablesApart(text: string): (string | TableText)[] {
  const lines = text.split("\n");
  const parts: (string | TableText)[] = [];
  let from = 0;
  let at = 0;
  while (at < lines.length) {
    const align = tableStart(lines, at);
    if (!align) {
      at++;
      continue;
    }
    parts.push(lines.slice(from, at).join("\n"));
    const table: TableText = { align, rows: [], extraCells: 0, open: false };
    const add = (line: string) => {
      const { cells, extra } = rowCells(line, align.length);
      table.rows.push(cells.map((cell) => cell.replace(/\\\|/g, "|").replace(BREAK_TAG, "\n")));
      table.extraCells += extra;
    };
    add(lines[at] ?? "");
    at += 2;
    for (; at < lines.length; at++) {
      const line = lines[at] ?? "";
      if (line.trim() === "" || !line.includes("|")) {
        // A row written without a leading "|" has none until its first cell is.
        table.open = line.trim() !== "" && at === lines.length - 1;
        break;
      }
      add(line);
    }
    parts.push(table);
    from = at;
  }
  parts.push(lines.slice(from).join("\n"));
  return parts;
}

/**
 * The new text's paragraphs as tokens. A marker "[n]" is Citation n of the
 * selection, with `fresh` attributes when its check came out differently
 * now, and "[^n]" is its footnote n; a marker for none it had is left out.
 * A formula the selection had is kept; another stays text. When the
 * selection was shown with its Blocks' markers, each paragraph's marker is
 * read off as its kind, and the escapes of text that looks like one are
 * taken off. A table is one paragraph of kind "table". `named`: the passage
 * was shown with its paragraphs' names, and each paragraph's name, before or
 * just after its marker, is read off (#2356); a line that starts with one
 * starts a paragraph, and a name alone names the paragraph after it.
 */
function newParagraphs(
  text: string,
  selection: Selection,
  fresh: ReadonlyMap<number, Attributes>,
  named = false,
): NewParagraph[] {
  const formulas = new Set(
    selection.segments.flatMap((segment) =>
      segment.tokens.flatMap((token) =>
        token.node?.name === MATH ? [stringOf(token.node.attributes.latex)] : [],
      ),
    ),
  );
  // Written with an id of its own; which one is the selection's Citation is settled once the
  // changes are written (`settleCitedIds`).
  const citationNode = (n: number): NewToken | null => {
    const was = selection.citations[n - 1];
    const now = fresh.get(n) ?? was;
    if (!now) return null;
    const { [BLOCK_ID_ATTRIBUTE]: _, ...attributes } = now;
    const cites = was?.[BLOCK_ID_ATTRIBUTE];
    return {
      key: `${keyOf.citation(n)}${fresh.has(n) ? "*" : ""}`,
      node: {
        name: CITATION_NODE,
        attributes,
        ...(typeof cites === "string" && { cites }),
      },
    };
  };
  const footnoteNode = (n: number): NewToken | null => {
    const source = selection.footnotes[n - 1];
    if (!source) return null;
    return {
      key: keyOf.footnote(n),
      node: { name: FOOTNOTE_NODE, attributes: source.getAttributes() as Attributes, source },
    };
  };
  const tokensOf = (written: string, notes: Notes): NewToken[] => {
    const tokens: NewToken[] = [];
    const emphasis = emphasisOf(written);
    const paragraph = emphasis?.plain ?? withoutEmphasisEscapes(written);
    // A paragraph with none of its own leaves the words it adds with the marks they sit beside.
    const looks = emphasis?.looks.some((look) => look.bold || look.italic || look.strike)
      ? emphasis.looks
      : null;
    const words = (part: string, from: number) => {
      let offset = from;
      for (const word of splitWords(part)) {
        tokens.push({
          key: keyOf.text(word),
          text: word,
          ...(looks && { look: looks[offset] ?? {} }),
        });
        offset += word.length;
      }
    };
    let at = 0;
    for (const match of paragraph.matchAll(MARKER)) {
      words(paragraph.slice(at, match.index), at);
      at = match.index + match[0].length;
      const [, footnote, citation, formula] = match;
      if (match[0] === "\n") {
        tokens.push({ key: keyOf.break(), node: { name: BREAK, attributes: {} } });
      } else if (footnote !== undefined || citation !== undefined) {
        const n = Number(footnote ?? citation);
        const node = footnote !== undefined ? footnoteNode(n) : citationNode(n);
        if (node) tokens.push(node);
        else {
          notes.unmatchedMarkers++;
          // Spaces left where an unknown marker was are one.
          if (/\s$/.test(paragraph.slice(0, match.index)) && /^\s/.test(paragraph.slice(at))) at++;
        }
      } else if (formula !== undefined && formulas.has(formula)) {
        tokens.push({
          key: keyOf.math(formula),
          node: { name: MATH, attributes: { latex: formula } },
        });
      } else {
        words(match[0], match.index);
      }
    }
    words(paragraph.slice(at), at);
    return tokens;
  };
  // A line that starts with a Block's mark, or with a name, starts a paragraph, even after a
  // single line break.
  const apart = new RegExp(
    [
      String.raw`\n[ \t]*\n+`,
      ...(selection.marked ? [String.raw`\n(?=${BLOCK_MARKER})`] : []),
      ...(named ? [String.raw`\n(?=${NAME_LINE})`] : []),
    ].join("|"),
  );
  // Pipe lines the passage already had are the User's text, not a table that failed.
  const had = new Set(selection.text.split("\n").map((line) => line.trim()));
  const unmade = (paragraph: string) =>
    paragraph.split("\n").some((line) => looksLikeTable(line) && !had.has(line.trim()));
  const link = (source: NamedSource) => {
    const index = selection.citations.findIndex((citation) => citesSource(citation, source));
    return index < 0 ? null : `[${index + 1}]`;
  };
  /** A name off the start of a paragraph, when the passage was shown with names. */
  const nameOff = (written: string): { name: ParagraphName | null; rest: string } =>
    named ? readName(written) : { name: null, rest: written };
  /** A paragraph's words with the names the passage showed escaped made words again. */
  const unescaped = (paragraph: string) => (named ? unescapeNames(paragraph) : paragraph);
  type Part = { name?: ParagraphName } & (
    | TableText
    | { marker: ReturnType<typeof readBlockMarker>; paragraph: string; asOther?: boolean }
  );
  const source = named ? tableRowsUnnamed(text) : text;
  const read = tablesApart(source).flatMap((part): Part[] =>
    typeof part !== "string"
      ? [part]
      : part
          .split(apart)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph !== "")
          .map((written) => {
            const first = nameOff(written);
            const name = first.name === null ? {} : { name: first.name };
            if (!selection.marked) {
              return {
                ...name,
                marker: null,
                paragraph: unescaped(first.rest),
                asOther: readBlockMarker(first.rest) !== null,
              };
            }
            const marker = readBlockMarker(first.rest);
            const after = marker ? first.rest.slice(marker.length) : first.rest;
            // A name written after the paragraph's mark, as in "- ¶3 …".
            const second = first.name === null ? nameOff(after) : { name: null, rest: after };
            return {
              ...name,
              ...(second.name !== null && { name: second.name }),
              marker,
              paragraph: unescaped(unescapeMarkers(second.rest, marker !== null)),
            };
          }),
  );
  // A name alone names the paragraph after it, as when it stands on the line before a table.
  const parts: Part[] = [];
  for (const [index, part] of read.entries()) {
    const following = read[index + 1];
    const lone = "paragraph" in part && part.name !== undefined && part.paragraph === "";
    if (lone && following && following.name === undefined) {
      following.name = part.name;
      continue;
    }
    parts.push(part);
  }
  const anyMarker = parts.some((part) => "marker" in part && part.marker !== null);
  return parts.map((part): NewParagraph => {
    const notes = noNotes();
    const name = part.name === undefined ? {} : { name: part.name };
    if ("rows" in part) {
      notes.extraCells = part.extraCells;
      const rows = part.rows.map((row) =>
        row.map((cell) => {
          const linked = linkSources(cell, link);
          notes.unlinkedSources += linked.unlinked;
          return tokensOf(linked.text, notes);
        }),
      );
      return {
        kind: "table",
        tokens: rows.flat(2),
        ...name,
        table: { align: part.align, rows },
        ...(part.open && { open: true }),
        notes,
      };
    }
    const { marker, paragraph } = part;
    return {
      kind: marker?.kind ?? (selection.marked && !anyMarker ? null : "paragraph"),
      tokens: tokensOf(paragraph, notes),
      ...name,
      ...(unmade(paragraph) && { unmade: true }),
      ...(part.asOther && { asOther: true }),
      notes,
    };
  });
}

/**
 * A reply's text with the names on its tables' lines moved off them, as a table's first line is a
 * table's only at a line's start: a name before its first row goes on a line of its own, and one
 * before each row after it goes, since a row is no paragraph (Claude Haiku 5.5 names every row).
 */
function tableRowsUnnamed(text: string): string {
  let inTable = false;
  return text
    .split("\n")
    .map((line) => {
      const name = NAME_AT_LINE.exec(line)?.[0] ?? "";
      const rest = line.slice(name.length);
      const row = rest.trimStart().startsWith("|");
      const out = !row || name === "" ? line : inTable ? rest : `${name.trim()}\n${rest}`;
      inTable = row;
      return out;
    })
    .join("\n");
}

/**
 * The words of each paragraph a <removed>…</removed> quotes (#2180), to tell which of the
 * selection's it is: a line each, as a model may run a section's paragraphs together, and a
 * cell each of a table.
 */
function quotedRuns(
  quote: string,
  selection: Selection,
  named: boolean,
): { text: string; chars: string }[] {
  return newParagraphs(quote, selection, new Map(), named)
    .flatMap((paragraph) => {
      if (paragraph.table) return paragraph.table.rows.flat(1);
      const runs: NewToken[][] = [[]];
      for (const token of paragraph.tokens) {
        if (token.node?.name === BREAK) runs.push([]);
        else runs.at(-1)?.push(token);
      }
      return runs;
    })
    .filter((run) => run.some((token) => token.text?.trim()))
    .map((run) => ({
      text: run
        .map((token) => token.text ?? "")
        .join("")
        .trim(),
      chars: newCharsOf(run).chars,
    }));
}

// ---------------------------------------------------------------------------
// Writing

export interface Written {
  /** The Proposals written, in order. */
  proposals: ProposalRef[];
  /** Citations the Proposals would remove and add back nowhere. */
  droppedCitations: number;
  /** The text holds lines that read as a table's rows but make no table: nothing from them on was written. */
  unmadeTable?: true;
  /** Text it quotes as taken out that is in none of the paragraphs it left out word for word, once (#2180). */
  unplaced?: string[];
  /**
   * A paragraph of it named one of the passage's twice, one the passage hasn't, or one with no
   * words for it: nothing from there on was written (#2356).
   */
  misnamed?: true;
  /** What the paragraphs written had that they don't hold as it was written. */
  notes: Notes;
}

/** What a Proposal's marks and attributes hold: which it is, and the text it changes. */
const refOf = ({ id, request, target }: ProposalRef): ProposalRef =>
  target === undefined ? { id, request } : { id, request, target };

/** The marks of words a Proposal adds: AI text, unless they are inline code, which holds no other mark. */
const asAiText = (marks: Attributes): Attributes =>
  INLINE_CODE_MARK in marks ? marks : { ...marks, [GENERATED_MARK]: {} };

/** Text a Proposal adds, and its marks, with no other Proposal's. */
function withoutProposals(attributes: Attributes | undefined): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (key !== PROPOSAL_INSERT_MARK && key !== PROPOSAL_DELETE_MARK) kept[key] = value;
  }
  return kept;
}

/** The marks of the text next to where words are added: no link or code, which they aren't part of. */
function besideMarks(segment: Segment, at: number): Attributes {
  const near =
    [...segment.tokens].reverse().find((token) => token.text !== undefined && token.to <= at) ??
    segment.tokens.find((token) => token.text !== undefined && token.from >= at);
  const { link: _link, code: _code, ...marks } = withoutProposals(near?.attributes);
  return marks;
}

/** Marks `from`..`to` of a Block's text as removed by the Proposal. */
function markRemoved(element: Y.XmlElement, from: number, to: number, ref: ProposalRef): void {
  for (const child of layout(element)) {
    const start = Math.max(from, child.start);
    const end = Math.min(to, child.start + child.size);
    if (start >= end) continue;
    if (child.node instanceof Y.XmlText) {
      child.node.format(start - child.start, end - start, { [PROPOSAL_DELETE_MARK]: refOf(ref) });
    } else {
      setProposal(child.node, { ...refOf(ref), kind: "delete" });
    }
  }
}

/** Sets a node's `proposal` attribute. Yjs types attributes as text, but keeps any JSON value. */
export function setProposal(element: Y.XmlElement, value: ProposalAttribute): void {
  (element as unknown as Y.XmlElement<Record<string, ProposalAttribute>>).setAttribute(
    PROPOSAL_ATTRIBUTE,
    value,
  );
}

/** Puts `node` into a Block's text at `at`, splitting the text there if it must. */
function insertNode(element: Y.XmlElement, at: number, node: Y.XmlElement): void {
  const children = layout(element);
  const inside = children.find(
    (child) => child.node instanceof Y.XmlText && child.start < at && at < child.start + child.size,
  );
  if (inside && inside.node instanceof Y.XmlText) {
    const local = at - inside.start;
    const tail: Run[] = [];
    let offset = 0;
    for (const run of inside.node.toDelta() as Run[]) {
      if (typeof run.insert !== "string") continue;
      const end = offset + run.insert.length;
      if (end > local) {
        tail.push({
          insert: run.insert.slice(Math.max(0, local - offset)),
          attributes: run.attributes ?? {},
        });
      }
      offset = end;
    }
    inside.node.delete(local, inside.size - local);
    const rest = new Y.XmlText();
    rest.applyDelta(tail.map((run) => ({ insert: run.insert, attributes: run.attributes ?? {} })));
    const index = children.indexOf(inside);
    element.insert(index + 1, [node, rest]);
    return;
  }
  element.insert(children.filter((child) => child.start + child.size <= at).length, [node]);
}

/** Puts `text` into a Block's text at `at`, with exactly these marks. */
function insertText(element: Y.XmlElement, at: number, text: string, marks: Attributes): void {
  const children = layout(element);
  const target =
    children.find(
      (child) =>
        child.node instanceof Y.XmlText && child.start < at && at <= child.start + child.size,
    ) ?? children.find((child) => child.node instanceof Y.XmlText && child.start === at);
  if (target && target.node instanceof Y.XmlText) {
    target.node.insert(at - target.start, text, { ...marks });
    return;
  }
  const fresh = new Y.XmlText();
  fresh.insert(0, text, { ...marks });
  element.insert(children.filter((child) => child.start + child.size <= at).length, [fresh]);
}

/**
 * An inline node for new text: a Citation, formula or line break, or a
 * footnote moved, copied with its text under an id of its own, since the
 * one it was copied from stays until the User accepts.
 */
function elementOf(node: InlineNode, newId: () => string): Y.XmlElement {
  if (node.source) {
    const copy = node.source.clone();
    copy.removeAttribute(PROPOSAL_ATTRIBUTE);
    copy.setAttribute(BLOCK_ID_ATTRIBUTE, newId());
    return copy;
  }
  const element = createElement({
    type: node.name,
    attrs: withoutProposalAttribute(node.attributes),
  });
  if (node.cites) citing.set(element, node.cites);
  return element;
}

/** The selection's Citation each Citation a rewrite wrote stands for, by its id (#1933). */
const citing = new WeakMap<Y.XmlElement, string>();

/** Whether the rewrite takes the element out: it, or a Block it is in, is a change that removes it. */
function takenOut(element: Y.XmlElement): boolean {
  if (element._item?.deleted) return true;
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    if (readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "delete") return true;
  }
  return false;
}

/**
 * Each of the selection's Citations goes by its id in one place only (#1933): where it was, while
 * the rewrite keeps it there, else the first Citation the new text writes for it, which moved
 * it. Every other Citation written for it is a copy, with an id of its own.
 */
function settleCitedIds(selection: Selection, blocks: Y.XmlFragment, newId: () => string): void {
  const written = new Map<string, Y.XmlElement[]>();
  for (const block of blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    for (const node of block.createTreeWalker(
      (each) => each instanceof Y.XmlElement && each.nodeName === CITATION_NODE,
    )) {
      const cites = node instanceof Y.XmlElement ? citing.get(node) : undefined;
      if (node instanceof Y.XmlElement && cites)
        written.set(cites, [...(written.get(cites) ?? []), node]);
    }
  }
  for (const [index, original] of selection.citedElements.entries()) {
    const id = selection.citations[index]?.[BLOCK_ID_ATTRIBUTE];
    if (typeof id !== "string") continue;
    const moved = takenOut(original);
    for (const [at, copy] of (written.get(id) ?? []).entries()) {
      const own = copy.getAttribute(BLOCK_ID_ATTRIBUTE);
      if (moved && at === 0) {
        if (own !== id) copy.setAttribute(BLOCK_ID_ATTRIBUTE, id);
      } else if (own === id) copy.setAttribute(BLOCK_ID_ATTRIBUTE, newId());
    }
  }
}

/** An inline node the Proposal adds. */
function nodeElement(node: InlineNode, ref: ProposalRef, newId: () => string): Y.XmlElement {
  const element = elementOf(node, newId);
  setProposal(element, { ...refOf(ref), kind: "insert" });
  return element;
}

function withoutProposalAttribute(attributes: Attributes): Attributes {
  const { [PROPOSAL_ATTRIBUTE]: _proposal, ...rest } = attributes;
  return rest;
}

const sameMarks = (a: Attributes, b: Attributes) => JSON.stringify(a) === JSON.stringify(b);

const LOOK_MARKS = ["bold", "italic", "strike"] as const;

/** Words as the model wrote them: bold, italic and strikethrough exactly as it gave them, whatever the words they replace had. */
function withLook(marks: Attributes, look: Look): Attributes {
  const own = { ...marks };
  for (const name of LOOK_MARKS) {
    if (look[name]) own[name] = {};
    else delete own[name];
  }
  return own;
}

/**
 * Adds the new tokens at `at` in a Block's text, as the Proposal's words:
 * with their own marks (an Answer's), or else with `marks`.
 */
function insertTokens(
  element: Y.XmlElement,
  at: number,
  tokens: readonly NewToken[],
  marks: Attributes,
  ref: ProposalRef,
  newId: () => string,
): void {
  const inserted = refOf(ref);
  let position = at;
  let words = "";
  let wordMarks = marks;
  const flush = () => {
    if (words === "") return;
    insertText(element, position, words, {
      ...asAiText(wordMarks),
      [PROPOSAL_INSERT_MARK]: inserted,
    });
    position += words.length;
    words = "";
  };
  for (const token of tokens) {
    if (token.node) {
      flush();
      insertNode(element, position, nodeElement(token.node, ref, newId));
      position += 1;
      continue;
    }
    const own = token.look ? withLook(token.marks ?? marks, token.look) : (token.marks ?? marks);
    if (!sameMarks(own, wordMarks)) flush();
    wordMarks = own;
    words += token.text ?? "";
  }
  flush();
}

/** A new paragraph or heading holding these tokens, with these attributes. */
function textBlockOf(
  tokens: readonly NewToken[],
  newId: () => string,
  type = "paragraph",
  attrs: Attributes = {},
): Y.XmlElement {
  const block = createElement({ type, attrs });
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  let runs: Run[] = [];
  const flush = () => {
    if (runs.length === 0) return;
    const text = new Y.XmlText();
    text.applyDelta(runs.map((run) => ({ insert: run.insert, attributes: run.attributes ?? {} })));
    children.push(text);
    runs = [];
  };
  for (const token of tokens) {
    if (token.node) {
      flush();
      children.push(elementOf(token.node, newId));
      continue;
    }
    const marks = asAiText(token.marks ?? {});
    const last = runs.at(-1);
    if (last && sameMarks(last.attributes ?? {}, marks)) last.insert += token.text ?? "";
    else runs.push({ insert: token.text ?? "", attributes: marks });
  }
  flush();
  block.insert(0, children);
  return block;
}

/** A new paragraph, as the Proposal's whole Block, holding these tokens. */
function paragraphOf(
  tokens: readonly NewToken[],
  ref: ProposalRef,
  newId: () => string,
): Y.XmlElement {
  return textBlockOf(tokens, newId, "paragraph", {
    [PROPOSAL_ATTRIBUTE]: { ...refOf(ref), kind: "insert" } satisfies ProposalAttribute,
  });
}

/** The element a removed paragraph takes with it: the list item, list or quote that holds only it. */
function removedWith(element: Y.XmlElement): Y.XmlElement {
  let current = element;
  let parent = current.parent;
  while (parent instanceof Y.XmlElement && WRAPPERS.has(parent.nodeName) && parent.length === 1) {
    current = parent;
    parent = current.parent;
  }
  return current;
}

/**
 * Blocks to remove, with each list or quote they empty removed whole in their
 * place, so that accepting the Proposals leaves no empty list behind, which
 * the editor would drop beyond Undo's reach. In the order they come.
 */
function wholeWrappers(removed: readonly Y.XmlElement[]): Y.XmlElement[] {
  let units = [...removed];
  for (let changed = true; changed; ) {
    changed = false;
    for (const unit of units) {
      const parent = unit.parent;
      if (!(parent instanceof Y.XmlElement) || !WRAPPERS.has(parent.nodeName)) continue;
      const children = parent.toArray().filter((child) => child instanceof Y.XmlElement);
      if (!children.every((child) => units.includes(child))) continue;
      units = [...units.filter((each) => !children.includes(each)), parent];
      changed = true;
      break;
    }
  }
  const order = (unit: Y.XmlElement) => removed.findIndex((each) => isInside(each, unit));
  return units.sort((a, b) => order(a) - order(b));
}

/** Whether `element` is `container` or inside it. */
function isInside(element: Y.XmlElement, container: Y.XmlElement): boolean {
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    if (at === container) return true;
  }
  return false;
}

/** Adds `elements` after `anchor`, in its parent. */
function addAfter(anchor: Y.XmlElement, elements: Y.XmlElement[]): void {
  addBeside(anchor, elements, "after");
}

/** Adds `elements` just after or just before `anchor`, in its parent. */
function addBeside(anchor: Y.XmlElement, elements: Y.XmlElement[], side: "after" | "before"): void {
  const parent = anchor.parent;
  if (!(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) return;
  const index = parent.toArray().indexOf(anchor);
  parent.insert(side === "after" ? index + 1 : index, elements);
}

/** The list item, list or quote a Block sits in, as far out as they go; with `tables`, a table too. */
function outermost(element: Y.XmlElement, tables = false): Y.XmlElement {
  let current = element;
  while (
    current.parent instanceof Y.XmlElement &&
    (WRAPPERS.has(current.parent.nodeName) || (tables && TABLE_PARTS.has(current.parent.nodeName)))
  ) {
    current = current.parent;
  }
  return current;
}

function addTable(
  place: Place,
  table: NonNullable<NewParagraph["table"]>,
  ref: ProposalRef,
  newId: () => string,
): Y.XmlElement {
  const element = createElement({ type: "table" });
  element.insert(
    0,
    table.rows.map((cells, index) => {
      const row = createElement({ type: "tableRow" });
      row.insert(
        0,
        cells.map((tokens, column) => {
          const align = table.align[column];
          const cell = createElement({
            type: index === 0 ? "tableHeader" : "tableCell",
            attrs: { colspan: 1, rowspan: 1, ...(align && { align }) },
          });
          cell.insert(0, [textBlockOf(tokens, newId)]);
          return cell;
        }),
      );
      return row;
    }),
  );
  setProposal(element, { ...refOf(ref), kind: "insert" });
  addBeside(outermost(place.element, true), [element], place.side);
  return element;
}

/** Where a new Block goes: next to a paragraph, heading or table, which is of this kind. */
interface Place {
  element: Y.XmlElement;
  kind: BlockKind | "table";
  side: "after" | "before";
}

/**
 * Adds a new Block of `kind` holding `tokens`, as a Proposal of its own, at
 * `place`: a list item into the list the place is in, when it is of that
 * list's kind, or else in a list of its own; a plain paragraph beside a plain
 * one; anything else beside the list or quote the place is in. Returns its
 * paragraph or heading, where the next new Block goes.
 */
function addBlock(
  place: Place,
  kind: BlockKind,
  tokens: readonly NewToken[],
  ref: ProposalRef,
  newId: () => string,
): Y.XmlElement {
  const proposal: ProposalAttribute = { ...refOf(ref), kind: "insert" };
  const heading = kind.startsWith("heading:");
  const text = textBlockOf(
    tokens,
    newId,
    heading ? "heading" : "paragraph",
    heading ? { level: Number(kind.slice("heading:".length)) } : {},
  );
  const listType = kind === "bullet" ? "bulletList" : kind === "numbered" ? "orderedList" : null;
  const item = place.element.parent;
  if (
    listType &&
    item instanceof Y.XmlElement &&
    item.nodeName === "listItem" &&
    item.parent instanceof Y.XmlElement &&
    item.parent.nodeName === listType
  ) {
    const added = createElement({ type: "listItem" });
    setProposal(added, proposal);
    added.insert(0, [text]);
    addBeside(item, [added], place.side);
    return text;
  }
  if (kind === "paragraph" && place.kind === "paragraph") {
    setProposal(text, proposal);
    addBeside(place.element, [text], place.side);
    return text;
  }
  let block = text;
  if (listType) {
    const added = createElement({ type: "listItem" });
    added.insert(0, [text]);
    block = createElement({ type: listType });
    block.insert(0, [added]);
  } else if (kind === "quote") {
    block = createElement({ type: "blockquote" });
    block.insert(0, [text]);
  }
  setProposal(block, proposal);
  addBeside(outermost(place.element), [block], place.side);
  return text;
}

/** The Citation a token is, by its marker (or by what it cites, in an Answer); null for any other token. */
function markerOf(token: { key: string }): string | null {
  const prefix = keyOf.citation(0).slice(0, -1);
  if (!token.key.startsWith(prefix)) return null;
  return token.key.slice(prefix.length).replace(/\*$/, "");
}

/** A run of kept tokens between two changes that joins them: only spaces and a few signs or letters. */
function joinsAcross(tokens: readonly OldToken[]) {
  return (from: number, to: number) => {
    const kept = tokens.slice(from, to);
    if (kept.some((token) => token.node)) return false;
    return (
      kept
        .map((token) => token.text ?? "")
        .join("")
        .replace(/\s+/g, "").length <= 3
    );
  };
}

/** What a Proposal that removes these tokens records as the text it changes. */
const targetOf = (tokens: readonly OldToken[]) => tokens.map((token) => token.target).join("");

/** The Citations Proposals remove and add, by marker, to count those removed and added back nowhere. */
interface CitationNotes {
  removed: Set<string>;
  added: Set<string>;
  /** Characters: what the old text loses, what the new text has that the old hadn't, and all the new text. */
  characters: { removed: number; added: number; written: number };
}

const notesOf = (): CitationNotes => ({
  removed: new Set(),
  added: new Set(),
  characters: { removed: 0, added: 0, written: 0 },
});

const lengthOf = (tokens: readonly { text?: string }[]) =>
  tokens.reduce((sum, token) => sum + (token.text?.length ?? 1), 0);

const noteCitation = (into: Set<string>, token: { key: string }) => {
  const marker = markerOf(token);
  if (marker) into.add(marker);
};

const droppedOf = (notes: CitationNotes) =>
  [...notes.removed].filter((marker) => !notes.added.has(marker)).length;

// DESIGN.md › AI edits: "about 40% or more of a paragraph's words".
const REWRITTEN_SHARE = 0.4;

/**
 * About 40% or more of the paragraph's words changed: written anew, read as
 * one change, before and after whole, never old and new words interleaved.
 * Words only added keep the rest as it was, read word by word.
 */
function rewritten(steps: readonly Step[], old: readonly OldToken[]) {
  const isWord = (text: string | undefined) => text === undefined || !/^\s+$/.test(text);
  let kept = 0;
  let at = 0;
  for (const step of steps) {
    if (step === "insert") continue;
    if (step === "equal" && isWord(old[at]?.text)) kept++;
    at++;
  }
  const words = old.filter((token) => isWord(token.text)).length;
  return words > 0 && words - kept >= words * REWRITTEN_SHARE;
}

/**
 * Writes the changes from a segment's tokens to `tokens`, each place that
 * changed a Proposal of its own (`next`, given the text it changes), from the
 * end, so the places read before each are still right. A whole heading that
 * changed at all, or a whole paragraph written anew, is one change.
 */
function writeHunks(
  segment: Segment,
  tokens: readonly NewToken[],
  next: (target: string) => ProposalRef,
  newId: () => string,
  notes: CitationNotes,
): void {
  // Once the reply gives words a look, a word that only changed its look is a change.
  const looked = tokens.some((token) => token.look);
  const steps = diffSteps(
    segment.tokens.map((token) =>
      looked ? lookedKey(token.key, token.text, lookOf(token.attributes)) : token.key,
    ),
    tokens.map((token) =>
      looked ? lookedKey(token.key, token.text, token.look ?? {}) : token.key,
    ),
  );
  let hunks = hunksOf(steps, joinsAcross(segment.tokens));
  if (
    segment.whole &&
    hunks.length > 0 &&
    (segment.kind.startsWith("heading:") || rewritten(steps, segment.tokens))
  ) {
    hunks = [{ oldFrom: 0, oldTo: segment.tokens.length, newFrom: 0, newTo: tokens.length }];
  }
  const refs = hunks.map((hunk) => next(targetOf(segment.tokens.slice(hunk.oldFrom, hunk.oldTo))));
  for (let at = hunks.length - 1; at >= 0; at--) {
    const hunk = hunks[at] as (typeof hunks)[number];
    const ref = refs[at] as ProposalRef;
    const removed = segment.tokens.slice(hunk.oldFrom, hunk.oldTo);
    const added = tokens.slice(hunk.newFrom, hunk.newTo);
    const end = removed.at(-1)?.to ?? segment.tokens[hunk.oldFrom]?.from ?? segment.end;
    const firstWords = removed.find((token) => token.text !== undefined);
    const marks = firstWords ? withoutProposals(firstWords.attributes) : besideMarks(segment, end);
    insertTokens(segment.element, end, added, marks, ref, newId);
    if (removed.length > 0) markRemoved(segment.element, removed[0]?.from ?? end, end, ref);
    for (const token of removed) noteCitation(notes.removed, token);
    for (const token of added) noteCitation(notes.added, token);
    notes.characters.removed += lengthOf(removed);
    notes.characters.added += lengthOf(added);
  }
}

/** A Proposal maker: each new Proposal of `request`, recording the text it changes, in order. */
function proposalsOf(request: string, newId: () => string) {
  const proposals: ProposalRef[] = [];
  const next = (target: string): ProposalRef => {
    const ref = { id: newId(), request, target: targetHash(target) };
    proposals.push(ref);
    return ref;
  };
  return { proposals, next };
}

const HAN = /^\p{Script=Han}+$/u;

/**
 * The words of a run, for telling how alike two runs are: no spaces or
 * punctuation, any case. Chinese runs count by pairs of characters, as any two
 * Chinese paragraphs share many single ones.
 */
function wordsOf(tokens: readonly { key: string; text?: string }[]): string[] {
  const words: string[] = [];
  let run: string[] = [];
  const endRun = () => {
    if (run.length === 1) words.push(run[0] ?? "");
    for (let index = 1; index < run.length; index++) words.push(`${run[index - 1]}${run[index]}`);
    run = [];
  };
  for (const token of tokens) {
    if (token.text !== undefined && HAN.test(token.text)) {
      run.push(...token.text);
      continue;
    }
    endRun();
    if (token.text === undefined) words.push(token.key.replace(/\*$/, ""));
    else if (/[\p{L}\p{N}]/u.test(token.text)) words.push(token.text.toLowerCase());
  }
  endRun();
  return words;
}

/** The share of `old`'s words that `next` has: 1 when `next` says all of it, in whatever shape. */
function covered(
  old: readonly { key: string; text?: string }[],
  next: readonly { key: string; text?: string }[],
): number {
  const a = wordsOf(old);
  if (a.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const word of wordsOf(next)) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of a) {
    const left = counts.get(word) ?? 0;
    if (left === 0) continue;
    shared++;
    counts.set(word, left - 1);
  }
  return shared / a.length;
}

/** How alike two runs of words are, from 0 to 1: the share of their words they have in common. */
function likeness(old: readonly OldToken[], next: readonly NewToken[]): number {
  const a = wordsOf(old);
  const b = wordsOf(next);
  if (a.length + b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const word of a) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const left = counts.get(word) ?? 0;
    if (left === 0) continue;
    shared++;
    counts.set(word, left - 1);
  }
  return (2 * shared) / (a.length + b.length);
}

/** How alike a paragraph of unknown kind must be to one of the selection's to pair with it. */
const UNKNOWN_KIND_LIKENESS = 0.3;

/**
 * How alike a new paragraph is to one of the selection's as a place to go: as `likeness`, but a
 * paragraph of unknown kind reads as a heading only when most of its words are the heading's. A
 * reply of one plain new sentence has no mark because it needs none, so "Working hours are
 * flexible." is no rewrite of the heading "Hours" (#2180).
 */
function placeLikeness(segment: Segment, paragraph: NewParagraph): number {
  if (
    paragraph.kind === null &&
    segment.kind.startsWith("heading:") &&
    covered(paragraph.tokens, segment.tokens) < MOST_OF_IT
  ) {
    return 0;
  }
  return likeness(segment.tokens, paragraph.tokens);
}
/**
 * How alike a new list item must be to one of the selection's to be its new
 * version: less, and the old one is removed and the new one added (DESIGN.md,
 * AI edits), so a bullet on a degree never reads as turning into one on a job.
 */
const COUNTERPART_LIKENESS = 0.25;
const LIST_ITEMS: ReadonlySet<BlockKind> = new Set(["bullet", "numbered"]);

const SCRIPTS: readonly [string, RegExp][] = [
  ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
];

function scriptOf(tokens: readonly { text?: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    for (const letter of token.text?.match(/\p{L}/gu) ?? []) {
      const script = SCRIPTS.find(([, pattern]) => pattern.test(letter))?.[0] ?? "other";
      counts.set(script, (counts.get(script) ?? 0) + 1);
    }
  }
  let most: string | null = null;
  for (const [script, count] of counts)
    if (most === null || count > (counts.get(most) ?? 0)) most = script;
  return most;
}

/**
 * Whether a new paragraph can be the selection's paragraph written again. A
 * paragraph or heading in its place can, however reworded; a list item, one
 * of a list of separate things, only when close to it, or when the whole text
 * is being translated, since a translation shares no words with it.
 */
function counterpart(segment: Segment, alike: number, translating: boolean): boolean {
  return !LIST_ITEMS.has(segment.kind) || alike >= COUNTERPART_LIKENESS || translating;
}

/**
 * The selection's paragraphs left unpaired that new paragraphs in the same
 * place stand in for, between the same two pairs: one for one when there are
 * as many of each, else those the new ones share any words with, most alike
 * first. An edit that keeps what it left out still takes these out, so an
 * item reworded or replaced is never there twice. With `readsAs`, in a reply
 * that has left paragraphs out, a new one's place says nothing: only those it
 * reads as (#2333).
 */
function replacedIn(
  between: readonly Segment[],
  held: readonly NewParagraph[],
  paired: readonly (number | null)[],
  readsAs: ((segment: Segment, paragraph: NewParagraph) => boolean) | null = null,
): Segment[] {
  const replaced: Segment[] = [];
  let oldFrom = 0;
  let newFrom = 0;
  const gap = (oldTo: number, newTo: number) => {
    const olds = between.slice(oldFrom, oldTo);
    const news = held.slice(newFrom, newTo);
    // A table made of a list or paragraphs says them all in one: it stands in for each it covers.
    for (const paragraph of news) {
      if (!paragraph.table) continue;
      for (const segment of olds) {
        if (covered(segment.tokens, paragraph.tokens) >= NEARLY_ALL) replaced.push(segment);
      }
    }
    if (!readsAs && olds.length === news.length) {
      replaced.push(...olds);
      return;
    }
    const alike = olds
      .flatMap((segment, i) =>
        news.map((paragraph, j) => ({ i, j, alike: placeLikeness(segment, paragraph) })),
      )
      .filter(({ i, j, alike }) =>
        readsAs ? readsAs(olds[i] as Segment, news[j] as NewParagraph) : alike > 0,
      )
      .sort((a, b) => b.alike - a.alike);
    const usedOld = new Set<number>();
    const usedNew = new Set<number>();
    for (const { i, j } of alike) {
      if (usedOld.has(i) || usedNew.has(j)) continue;
      usedOld.add(i);
      usedNew.add(j);
      replaced.push(olds[i] as Segment);
    }
  };
  for (const [j, pair] of paired.entries()) {
    if (pair === null || pair === undefined) continue;
    gap(pair, j);
    oldFrom = pair + 1;
    newFrom = j + 1;
  }
  gap(between.length, held.length);
  return replaced;
}

/** How alike a new paragraph of unknown kind must be to one of the selection's to take its kind. */
const MOVED_LIKENESS = 0.5;
/**
 * How much more like one of the selection's paragraphs than like any other a new one of a reply
 * that leaves some out must be to take its place: a new line on the pattern of several (a cost,
 * a term) is as like each of them, and is added beside them (#2333).
 */
const CLEARLY_MORE = 0.1;
/**
 * How much of a paragraph the reply leaves out another must say for it to go unmarked, moved or
 * made into a table: nearly all of its words, so a new line that only reads like it takes nothing (#2180).
 */
const NEARLY_ALL = 0.9;

/**
 * The fewest words with which a new line says, by its words alone, which paragraph it rewrites: a
 * shorter one, such as "Changed to:" or "Done.", may have only words of a paragraph and name none.
 */
const TELLING_WORDS = 4;

/** A paragraph's words and signs as compared with a quote: no spaces, any case, each character where it is in its Block. */
function charsOf(tokens: readonly OldToken[]): { chars: string; at: number[] } {
  let chars = "";
  const at: number[] = [];
  for (const token of tokens) {
    if (token.text === undefined) continue;
    for (let index = 0; index < token.text.length; index++) {
      const char = token.text[index] as string;
      if (/\s/.test(char)) continue;
      const lower = char.toLowerCase();
      chars += lower;
      for (let unit = 0; unit < lower.length; unit++) at.push(token.from + index);
    }
  }
  return { chars, at };
}

/** New text's words and signs as `charsOf` reads a paragraph's, each character where it is in that text. */
function newCharsOf(tokens: readonly NewToken[]): { chars: string; at: number[] } {
  const text = tokens.map((token) => token.text ?? "").join("");
  let chars = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (/\s/.test(char)) continue;
    const lower = char.toLowerCase();
    chars += lower;
    for (let unit = 0; unit < lower.length; unit++) at.push(index);
  }
  return { chars, at };
}

/** A letter or digit of a word that runs on without spaces, unlike a Chinese character. */
const IN_WORD = /^[\p{L}\p{N}]$/u;
const HAN_CHAR = /^\p{Script=Han}$/u;
/** A sentence or clause mark, a closing bracket or quote: it closes onto the word before it. */
const CLOSING = /^[.,;:!?…)\]}»”’"'。，、；：！？）】》」』]$/u;
/** An opening bracket or quote: the word after it starts there. */
const OPENING = /^[([{«“‘"'（【《「『]$/u;
/** Where a table's text sits: removals never leave one with no Block, so the table keeps its shape. */
const CELLS: ReadonlySet<string> = new Set(["tableCell", "tableHeader"]);

/**
 * Where a quote's words are in a paragraph, as characters of `charsOf` (#2180): the one place
 * they are, word for word and never cutting a word; null when they are nowhere, or in more than one place.
 */
function placeQuote(
  paragraph: { chars: string; at: number[] },
  quote: string,
): { first: number; end: number } | null {
  const places = placesOf(paragraph, quote);
  const [only] = places;
  return places.length === 1 && only !== undefined
    ? { first: only, end: only + quote.length }
    : null;
}

/** Every place a quote's words are in a paragraph, word for word, never cutting a word: "draft" isn't in "drafts". */
function placesOf(paragraph: { chars: string; at: number[] }, quote: string): number[] {
  if (quote === "") return [];
  const places: number[] = [];
  for (
    let at = paragraph.chars.indexOf(quote);
    at >= 0;
    at = paragraph.chars.indexOf(quote, at + 1)
  ) {
    const end = at + quote.length;
    const runsOn = (inside: number, outside: number) => {
      const a = paragraph.chars[inside] ?? "";
      const b = paragraph.chars[outside] ?? "";
      const touching = Math.abs((paragraph.at[inside] ?? 0) - (paragraph.at[outside] ?? 0)) === 1;
      return (
        touching && IN_WORD.test(a) && IN_WORD.test(b) && !HAN_CHAR.test(a) && !HAN_CHAR.test(b)
      );
    };
    if (at > 0 && runsOn(at, at - 1)) continue;
    if (end < paragraph.chars.length && runsOn(end - 1, end)) continue;
    places.push(at);
  }
  return places;
}

/**
 * The kind of a new paragraph the model wrote no mark for: that of the
 * selection's paragraph it is most like, when it is that paragraph moved;
 * else a plain paragraph's.
 */
function kindByLikeness(segments: readonly Segment[], paragraph: NewParagraph): BlockKind {
  let found: BlockKind = "paragraph";
  let best = MOVED_LIKENESS;
  for (const segment of segments) {
    const alike = placeLikeness(segment, paragraph);
    if (alike >= best) {
      best = alike;
      found = segment.kind;
    }
  }
  return found;
}

/**
 * Which of the selection's paragraphs each of the model's is, in order: the
 * pairing with the most pairs of the same kind of Block, the more alike the
 * better, so that a paragraph the new text moves is added where it now goes
 * rather than written into whatever paragraph held that place. One of
 * unknown kind pairs with any. Null: a new paragraph, paired with none.
 */
function pairUp(
  segments: readonly Segment[],
  paragraphs: readonly NewParagraph[],
  translating: boolean,
  may: (segment: Segment, paragraph: NewParagraph) => boolean = () => true,
): (number | null)[] {
  const weight = (i: number, j: number): number | null => {
    const segment = segments[i] as Segment;
    const paragraph = paragraphs[j] as NewParagraph;
    if (paragraph.kind !== null && paragraph.kind !== segment.kind) return null;
    const alike = placeLikeness(segment, paragraph);
    // Of unknown kind, only a paragraph like it can take a Block's place.
    if (paragraph.kind === null && alike < UNKNOWN_KIND_LIKENESS) return null;
    if (!counterpart(segment, alike, translating) || !may(segment, paragraph)) return null;
    return 1 + 2 * alike;
  };
  return bestPairing(segments.length, paragraphs.length, weight);
}

/**
 * Which row each column pairs with, in order (null: none), for the most `weight` in all; a
 * weight of null: those two can't pair.
 */
function bestPairing(
  rows: number,
  columns: number,
  weight: (row: number, column: number) => number | null,
): (number | null)[] {
  const weights = new Float64Array(rows * columns);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) weights[i * columns + j] = weight(i, j) ?? Number.NaN;
  }
  const pairOf = (i: number, j: number) => weights[i * columns + j] ?? Number.NaN;
  // best[i][j]: the most the rows from i and the columns from j can pair for.
  const best = new Float64Array((rows + 1) * (columns + 1));
  const at = (i: number, j: number) => best[i * (columns + 1) + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      const pair = pairOf(i, j);
      best[i * (columns + 1) + j] = Math.max(
        at(i + 1, j),
        at(i, j + 1),
        Number.isNaN(pair) ? Number.NEGATIVE_INFINITY : pair + at(i + 1, j + 1),
      );
    }
  }
  // From the start, pairing whenever that is as good as anything else: a tie pairs in order.
  const paired: (number | null)[] = new Array<number | null>(columns).fill(null);
  const TIE = 1e-9;
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    const pair = pairOf(i, j);
    if (!Number.isNaN(pair) && pair + at(i + 1, j + 1) >= at(i, j) - TIE) {
      paired[j] = i;
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j) - TIE) i++;
    else j++;
  }
  return paired;
}

/**
 * Writes the model's `text` for the selection as Proposals of `request`.
 * Each of its paragraphs pairs with the selection's paragraph it is (see
 * `pairUp`) and is compared with it word by word, so a heading stays a
 * heading and a list item a list item; a paragraph that pairs with none is a
 * new Block of its kind where it goes in the new text; and a paragraph of the
 * selection with none goes (its whole Block, if all of it was selected).
 * `fresh`: Citations whose check came out differently now, by marker, with
 * their new attributes: one the text keeps is replaced by the checked copy.
 * Call it in a Yjs transaction.
 */
export function proposeRewrite(
  selection: Selection,
  text: string,
  request: string,
  newId: () => string,
  fresh: ReadonlyMap<number, Attributes> = new Map(),
  { named = false }: { named?: boolean } = {},
): Written {
  const rewrite = createRewriteStream(selection, request, newId, () => fresh, { named });
  rewrite.write(text, true);
  rewrite.finish();
  return rewrite.written();
}

/** How many of the selection's paragraphs a new one may pass over to pair with one much like it: those it passes go. */
const LOOKAHEAD = 2;

/** Where the next of the new text's paragraphs goes: anew over this paragraph of the selection, or after this one. */
export type RewritePlace = { over: Y.XmlElement } | { after: Y.XmlElement };

/**
 * `proposeRewrite`, as the model's text comes in (#202): each paragraph is
 * written once it is finished and its place is known, and nothing written
 * is written again, so nothing moves under the User. A paragraph much like
 * one of the selection's a little further on pairs with it at once, and those
 * it passes over go. Any other waits for the next that is (or the end), and
 * those between are paired as `pairUp` pairs them, so a section added in the
 * middle is added, not written over the one after it, and one moved up is
 * added where it now goes. When two are like none of the selection's before
 * any is much like one (a translation), each pairs in order as it comes.
 * With `leftOut: "keep"` the text may leave paragraphs out, and a paragraph it
 * doesn't name is never written over or taken out (#2333): a new one pairs by
 * its place only between two the text pairs with, or in a text that rewrites
 * every paragraph, known once it ends; else only with one it reads as
 * (`readsAs`), and otherwise it is added. `finish` takes out the selection's
 * paragraphs the text never reached, or with `leftOut: "keep"` keeps them
 * unless the text quotes them between <removed> and </removed> (#2180); a request stopped before leaves them. Call each in a
 * Yjs transaction on the document `selection` was read from.
 *
 * With `named`, the passage was shown with its paragraphs' names (`Selection.named`), and a text
 * whose first paragraph starts with one says which paragraph each of its own replaces (#2356):
 * each is written into the paragraph it names, one named after a later one moves there, and one
 * named ¶+ (or not at all) is new, after the one before it in the text or, first, before the next
 * it names. A paragraph it doesn't name is never written over or taken out, nor counted as left
 * out: only a quote takes one out. A name twice, one the passage hasn't, or one with no words
 * after it is `misnamed`: nothing more is written, for the edit to be refused. A text whose first
 * paragraph has no name is paired as above.
 */
export function createRewriteStream(
  selection: Selection,
  request: string,
  newId: () => string,
  fresh: (text: string) => ReadonlyMap<number, Attributes>,
  {
    leftOut: onLeftOut = "remove",
    named = false,
  }: { leftOut?: "keep" | "remove"; named?: boolean } = {},
) {
  const { proposals, next } = proposalsOf(request, newId);
  const notes = notesOf();
  // Only the paragraphs the model was shown: an empty one between two isn't in its text.
  const segments = selection.segments.filter((segment) => segment.shown);
  /** The text may leave paragraphs out, which stay: where a new one stands may say nothing of which it is (#2333). */
  const keeps = onLeftOut === "keep";
  const wordsIn = segments.map((segment) => new Set(wordsOf(segment.tokens)));
  /** Each paragraph's words that none of the selection's others has. */
  const ownWords = new Map(
    segments.map((segment, index) => [
      segment,
      new Set(
        [...(wordsIn[index] ?? [])].filter((word) =>
          wordsIn.every((words, other) => other === index || !words.has(word)),
        ),
      ),
    ]),
  );
  const indexOf = new Map(segments.map((segment, index) => [segment, index]));
  const sameAs = segments.map((segment) => charsOf(segment.tokens).chars);
  /**
   * How alike a new paragraph is to each of the selection's, whether it says words of that one's
   * own, how much of it is that one's words, and how many words it has.
   */
  const nearness = new WeakMap<
    NewParagraph,
    { alike: number[]; own: boolean[]; cover: number[]; words: number }
  >();
  const nearnessOf = (paragraph: NewParagraph) => {
    const known = nearness.get(paragraph);
    if (known) return known;
    const words = wordsOf(paragraph.tokens);
    const found = {
      alike: segments.map((segment) => placeLikeness(segment, paragraph)),
      own: segments.map((segment) => words.some((word) => ownWords.get(segment)?.has(word))),
      cover: segments.map((segment) => covered(paragraph.tokens, segment.tokens)),
      words: words.length,
    };
    nearness.set(paragraph, found);
    return found;
  };
  /** Much like one of the selection's paragraphs, whichever it is. */
  const resembles = (paragraph: NewParagraph) =>
    nearnessOf(paragraph).alike.some((alike) => alike >= MOVED_LIKENESS);
  /**
   * A new paragraph reads as this one of the selection's: much like it, and clearly more like it
   * than like any other of whatever kind (a line more like a bullet than a paragraph is no
   * rewrite of the paragraph); or, as a summary of it is, made of nearly all its words and of no
   * other's, in at least `TELLING_WORDS` of them (#2333). One that would `standIn` for a Block
   * of another kind, which it can't pair with, must also say no word only another paragraph has:
   * a summary, or a table, that names several takes none of them out.
   */
  const readsAs = (
    segment: Segment,
    paragraph: NewParagraph,
    { standIn = false, least = MOVED_LIKENESS }: { standIn?: boolean; least?: number } = {},
  ) => {
    const { alike, own, cover, words } = nearnessOf(paragraph);
    const index = indexOf.get(segment) ?? -1;
    const mine = alike[index] ?? 0;
    const rivals = (beaten: (at: number) => boolean) =>
      segments.every(
        (_, at) =>
          at === index ||
          // Two that read the same lose nothing whichever of them it takes.
          sameAs[at] === sameAs[index] ||
          (beaten(at) && (!standIn || own[at] !== true)),
      );
    return (
      (mine >= least && rivals((at) => (alike[at] ?? 0) <= mine - CLEARLY_MORE)) ||
      (words >= TELLING_WORDS &&
        (cover[index] ?? 0) >= NEARLY_ALL &&
        rivals((at) => (cover[at] ?? 0) < NEARLY_ALL))
    );
  };
  const first = segments[0];
  let place: Place | null = first
    ? { element: first.element, kind: first.kind, side: "before" }
    : null;
  /** The selection's next paragraph not yet paired or gone. */
  let at = 0;
  /** How many of the new text's paragraphs are taken: written, or held. */
  let taken = 0;
  /** Paragraphs like none of the selection's, waiting for their place. */
  const held: NewParagraph[] = [];
  /** A paragraph much like one of the selection's was paired: the text is mostly kept. */
  let anchored = false;
  /** How many of the new text's paragraphs were paired with the selection's. */
  let pairedSoFar = 0;
  /** A new paragraph was written, paired or added: where the next goes follows it. */
  let placedAny = false;
  /** Paragraphs like none of the selection's at all, before any was much like one. */
  let unlike = 0;
  /** Two were like none: the text is written anew, and each pairs in order. */
  let anew = false;
  const kept: Segment[] = [];
  /** Of the selection's paragraphs, those new ones stand in for: they go, even when left-out ones are kept. */
  const replaced = new Set<Segment>();
  /** The new text's finished paragraphs so far. */
  let seen: readonly NewParagraph[] = [];
  const selectionScript = scriptOf(segments.flatMap((segment) => segment.tokens));
  /** Most of the new text's paragraphs are in another script than the selection: a translation. */
  const translating = () => {
    const scripts = seen.map((paragraph) => scriptOf(paragraph.tokens)).filter((each) => each);
    const other = scripts.filter((script) => script !== selectionScript).length;
    return selectionScript !== null && other * 2 > scripts.length;
  };
  /** A finished paragraph reads as a table's rows but makes none: nothing more is written. */
  let unmade = false;
  const notesWritten = noNotes();
  /** The text names the paragraph each of its own replaces: null until its first paragraph is read. */
  let byName: boolean | null = named ? null : false;
  /** The selection's paragraphs the text names, by index. */
  const namedSoFar = new Set<number>();
  /** Those it names with their words as they were, which it leaves as they are. */
  const unchangedNamed = new Set<Segment>();
  /** The last of the selection's paragraphs written in its place: one named before it has moved. */
  let lastInPlace = -1;
  /** New paragraphs before any the text names: they go just before the first it names. */
  const comingFirst: NewParagraph[] = [];
  /** Where the next new paragraph the text names as following one of the selection's goes: after those before it. */
  const following = new Map<Segment, Place>();
  let misnamed = false;
  /** The name of the paragraph being written now. */
  let writingName: ParagraphName | undefined;

  const remove = (gone: readonly Segment[]) => {
    const blocks: Y.XmlElement[] = [];
    const strike = (segment: Segment) =>
      markRemoved(segment.element, segment.start, segment.end, next(targetOf(segment.tokens)));
    for (const segment of gone) {
      if (segment.whole) blocks.push(removedWith(segment.element));
      else strike(segment);
      for (const token of segment.tokens) noteCitation(notes.removed, token);
      notes.characters.removed += lengthOf(segment.tokens);
    }
    const units = wholeWrappers(blocks);
    for (const removed of units) {
      // A table cell left with no Block is dropped by the editor beyond Undo's reach (#2180):
      // what it holds keeps its shape, and its text is struck.
      const cell = removed.parent;
      const empties =
        cell instanceof Y.XmlElement &&
        CELLS.has(cell.nodeName) &&
        cell.toArray().every((child) => !(child instanceof Y.XmlElement) || units.includes(child));
      if (empties) {
        for (const segment of gone) if (isInside(segment.element, removed)) strike(segment);
        continue;
      }
      setProposal(removed, { ...refOf(next(targetText(removed))), kind: "delete" });
    }
  };

  /** The selection's paragraphs before `to` not paired go, or are kept. */
  const removeUpTo = (to: number) => {
    const passed = segments.slice(at, to).filter((segment) => segment.tokens.length > 0);
    if (onLeftOut === "keep") {
      remove(passed.filter((segment) => replaced.has(segment)));
      kept.push(...passed.filter((segment) => !replaced.has(segment)));
    } else remove(passed);
    at = Math.max(at, to);
  };

  /** The paragraphs the finished text quotes between <removed> and </removed>, each by its words (#2180). */
  let quotes: { text: string; chars: string }[] = [];
  /** Quotes that are in none of the paragraphs it left out, word for word: nothing was taken out for them. */
  const unplaced: string[] = [];
  /** Characters of the selection's paragraphs the text quotes as taken out. */
  let quotedOut = 0;
  /** Paragraphs added anew: a left-out paragraph much like one of them was moved there. */
  const addedAnew: NewParagraph[] = [];
  /** The selection's paragraphs the text wrote over or moved, each with its new words as a quote is compared. */
  const writtenOver = new Map<Segment, { chars: string; at: number[] }>();

  const pairWith = (paragraph: NewParagraph, index: number) => {
    const segment = segments[index];
    if (!segment) return;
    addNotes(notesWritten, paragraph.notes);
    notes.characters.written += lengthOf(paragraph.tokens);
    removeUpTo(index);
    writtenOver.set(segment, newCharsOf(paragraph.tokens));
    writeHunks(segment, paragraph.tokens, next, newId, notes);
    place = { element: segment.element, kind: segment.kind, side: "after" };
    at = index + 1;
    pairedSoFar++;
    placedAny = true;
  };

  const addNew = (paragraph: NewParagraph) => {
    if (!place) return;
    placedAny = true;
    addedAnew.push(paragraph);
    addNotes(notesWritten, paragraph.notes);
    for (const token of paragraph.tokens) noteCitation(notes.added, token);
    notes.characters.added += lengthOf(paragraph.tokens);
    notes.characters.written += lengthOf(paragraph.tokens);
    if (paragraph.table) {
      place = {
        element: addTable(place, paragraph.table, next(""), newId),
        kind: "table",
        side: "after",
      };
      return;
    }
    const kind = paragraph.kind ?? kindByLikeness(segments, paragraph);
    const added = addBlock(place, kind, paragraph.tokens, next(""), newId);
    place = { element: added, kind, side: "after" };
  };

  /**
   * The paragraphs held, written: paired with the selection's from `at` to `to` as `pairUp`
   * pairs them. `bounded`: the text pairs a paragraph with the selection's at `to` next.
   */
  const writeHeld = (to: number, bounded = false) => {
    const from = at;
    const between = segments.slice(from, to);
    const whole = translating();
    // Where the text may leave paragraphs out, a paragraph it doesn't name is never written over
    // (#2333). A place says which paragraph a new one is only in a stretch of as many new ones as
    // old, each written as their kind. Between two places the text holds, where it pairs with
    // the selection's paragraphs or starts as the selection does, that is one in the place of
    // one, or several each more than half like the one in its place, since a stray line such as
    // "Changed to:" beside a new one names none. After the last (a partial text stops early, so
    // its end holds no place), each must also say in its words which it is: `TELLING_WORDS` of
    // them, somewhat like it and clearly more than like any other. So does a text that rewrites
    // every paragraph, none of its own much like one of the selection's (a translation). Any
    // other pairs only with one it reads as, and is added when it reads as none.
    const byTheirPlace =
      held.length === between.length &&
      held.every((paragraph) => !paragraph.asOther) &&
      (bounded
        ? held.length === 1 ||
          held.every(
            (paragraph, index) =>
              placeLikeness(between[index] as Segment, paragraph) > MOVED_LIKENESS,
          )
        : held.every(
            (paragraph, index) =>
              nearnessOf(paragraph).words >= TELLING_WORDS &&
              readsAs(between[index] as Segment, paragraph, { least: COUNTERPART_LIKENESS }),
          ));
    const rewritesAll =
      keeps &&
      pairedSoFar === 0 &&
      from === 0 &&
      held.length === segments.length &&
      !seen.some(resembles);
    const placed = !keeps || byTheirPlace || rewritesAll;
    // As many new paragraphs as old ones between two that held their place: each rewrites its own.
    const inPlace =
      placed &&
      between.length === held.length &&
      held.every((paragraph, index) => {
        const segment = between[index];
        return (
          segment !== undefined &&
          (paragraph.kind === null || paragraph.kind === segment.kind) &&
          counterpart(segment, likeness(segment.tokens, paragraph.tokens), whole)
        );
      });
    const paired = inPlace
      ? held.map((_, index) => index)
      : pairUp(
          between,
          held,
          whole,
          placed ? undefined : (segment, paragraph) => readsAs(segment, paragraph),
        );
    // A new Block in the place of one of its own kind, in a stretch its place says, takes that
    // one's place, as an item about something else does between two kept items (#1028). A Block
    // of another kind takes a paragraph's place by its place only in a text that rewrites every
    // paragraph: a heading or a table between two kept ones is new text.
    const takesPlace = (segment: Segment, paragraph: NewParagraph) =>
      (byTheirPlace &&
        paragraph.kind === segment.kind &&
        between.indexOf(segment) === held.indexOf(paragraph)) ||
      (!paragraph.table && readsAs(segment, paragraph, { standIn: true }));
    const byPlace = !keeps || rewritesAll;
    for (const segment of replacedIn(between, held, paired, byPlace ? null : takesPlace)) {
      replaced.add(segment);
    }
    // Nothing written yet: what is added goes before the paragraph the text pairs with next, or
    // with none, after the selection's last, never in place of the first.
    if (keeps && !placed && !placedAny) {
      const anchor = bounded ? segments[to] : segments.at(-1);
      if (anchor)
        place = { element: anchor.element, kind: anchor.kind, side: bounded ? "before" : "after" };
    }
    for (const [index, paragraph] of held.entries()) {
      const pair = paired[index];
      if (pair === null || pair === undefined) addNew(paragraph);
      else pairWith(paragraph, from + pair);
    }
    held.length = 0;
  };

  /** The selection's paragraph from `at` most like `paragraph`, when much like it; else null. */
  const muchLike = (paragraph: NewParagraph): number | null => {
    let best: number | null = null;
    let most = MOVED_LIKENESS;
    for (let index = at; index < segments.length; index++) {
      const segment = segments[index] as Segment;
      if (paragraph.kind !== null && paragraph.kind !== segment.kind) continue;
      const alike = placeLikeness(segment, paragraph);
      if (alike > most || (best === null && alike === most)) {
        best = index;
        most = alike;
      }
    }
    return best;
  };

  const take = (paragraph: NewParagraph) => {
    const near = muchLike(paragraph);
    // Much like several on their pattern, it reads as none of them in particular (#2333).
    const like =
      near !== null && keeps && !readsAs(segments[near] as Segment, paragraph) ? null : near;
    if (like !== null && like - at <= LOOKAHEAD + held.length) {
      writeHeld(like, true);
      pairWith(paragraph, like);
      anchored = true;
      return;
    }
    held.push(paragraph);
    if (near === null && !anchored) unlike++;
    // Where paragraphs may be left out, whether the text is written anew is known only at its end.
    if (unlike >= 2 && !keeps) anew = true;
    if (at >= segments.length) writeHeld(at);
    else if (anew) writeHeld(Math.min(segments.length, at + held.length + LOOKAHEAD));
  };

  /**
   * A name the paragraph's own words contradict: they share no word with the paragraph it names,
   * and read as another the text hasn't named. A model can miscount (Claude Haiku 5.5 named ¶7
   * for a rewrite of ¶6, #2356), and that paragraph would be written over; this refuses, and pairs
   * nothing.
   */
  const namesAnother = (paragraph: NewParagraph, index: number): boolean => {
    const segment = segments[index];
    if (!segment || likeness(segment.tokens, paragraph.tokens) > 0) return false;
    return segments.some(
      (other, at) =>
        at !== index &&
        !namedSoFar.has(at) &&
        readsAs(other, paragraph, { least: COUNTERPART_LIKENESS }),
    );
  };

  /** A paragraph of a text that names the one each replaces (#2356), written where its name says. */
  const takeNamed = (paragraph: NewParagraph) => {
    const written = paragraph.name ?? { follows: null };
    // A name just past the last paragraph names none it could write over: the reply numbered a
    // new one (Claude Haiku 5.5 writes ¶16 for a sixteenth), which goes after the last.
    const name =
      "replaces" in written && written.replaces === segments.length + 1
        ? { follows: written.replaces }
        : written;
    const words = paragraph.tokens.some((token) => token.node || token.text?.trim());
    if ("unclear" in name) {
      misnamed = true;
      return;
    }
    const named = "replaces" in name ? name.replaces : name.follows;
    if (named === null) {
      if (!words) return;
      if (placedAny) addNew(paragraph);
      else comingFirst.push(paragraph);
      return;
    }
    const index = "follows" in name && named === segments.length + 1 ? named - 2 : named - 1;
    const segment = segments[index];
    if (!segment || !words || ("replaces" in name && namedSoFar.has(index))) {
      misnamed = true;
      return;
    }
    if ("follows" in name) {
      place = following.get(segment) ?? {
        element: segment.element,
        kind: segment.kind,
        side: "after",
      };
      for (const each of comingFirst.splice(0)) addNew(each);
      addNew(paragraph);
      if (place) following.set(segment, place);
      return;
    }
    if (namesAnother(paragraph, index)) {
      misnamed = true;
      return;
    }
    namedSoFar.add(index);
    const moved = index < lastInPlace;
    if (!moved) place = { element: segment.element, kind: segment.kind, side: "before" };
    for (const each of comingFirst.splice(0)) addNew(each);
    if (
      !moved &&
      !paragraph.table &&
      (paragraph.kind === null || paragraph.kind === segment.kind)
    ) {
      addNotes(notesWritten, paragraph.notes);
      notes.characters.written += lengthOf(paragraph.tokens);
      const before = proposals.length;
      writeHunks(segment, paragraph.tokens, next, newId, notes);
      // Named with its words as they were, it is left as it is, and a quote may still take it out.
      if (proposals.length === before) unchangedNamed.add(segment);
      else writtenOver.set(segment, newCharsOf(paragraph.tokens));
      place = { element: segment.element, kind: segment.kind, side: "after" };
      placedAny = true;
      lastInPlace = index;
      return;
    }
    // Moved, or written as a Block of another kind: it goes where the text has it, and the paragraph it names goes.
    writtenOver.set(segment, newCharsOf(paragraph.tokens));
    addNew(paragraph);
    remove([segment]);
    if (!moved) lastInPlace = index;
  };

  /** New paragraphs that came before any the text names, when it names none: after the selection's last. */
  const placeComingFirst = () => {
    const last = segments.at(-1);
    if (comingFirst.length === 0 || !last) return;
    place = { element: last.element, kind: last.kind, side: "after" };
    for (const each of comingFirst.splice(0)) addNew(each);
  };

  /**
   * Of the paragraphs left out and kept, those the text says again were moved, and the words it
   * quotes as taken out go: a whole paragraph when the quotes say all of it, else only the words
   * quoted. A quote the text's own writing already took out is that writing's; any other that
   * isn't in one kept paragraph exactly once, or is only part of one while the text wrote the
   * same words again elsewhere, takes nothing out, and the edit is refused.
   */
  const settleLeftOut = () => {
    // A text that names its paragraphs says which moved: none it doesn't name is taken for moved.
    const said = byName ? [] : [...addedAnew];
    const moved: Segment[] = [];
    for (const segment of [...kept]) {
      const again = said.findIndex(
        (paragraph) =>
          (paragraph.kind === null || paragraph.kind === segment.kind) &&
          placeLikeness(segment, paragraph) >= MOVED_LIKENESS &&
          covered(segment.tokens, paragraph.tokens) >= NEARLY_ALL,
      );
      if (again < 0) continue;
      const [movedTo] = said.splice(again, 1);
      if (movedTo) writtenOver.set(segment, newCharsOf(movedTo.tokens));
      moved.push(...kept.splice(kept.indexOf(segment), 1));
    }
    const read = new Map(segments.map((segment) => [segment, charsOf(segment.tokens)] as const));
    const stretches = new Map<Segment, { first: number; end: number; quote: string }[]>();
    const none = { chars: "", at: [] };
    for (const quote of quotes) {
      const holds = (segment: Segment) =>
        placesOf(read.get(segment) ?? none, quote.chars).length > 0;
      const stillHolds = (segment: Segment) =>
        placesOf(writtenOver.get(segment) ?? none, quote.chars).length > 0;
      // Words a paragraph the text wrote over, moved or let go held and no longer holds are the
      // ones quoted: the same words in a kept paragraph stay (#2180).
      const dropped = segments.some(
        (segment) => !kept.includes(segment) && holds(segment) && !stillHolds(segment),
      );
      if (dropped) continue;
      const holding = kept.filter(holds);
      // A quote that is all of a paragraph is that paragraph, though its words are in others too.
      const exact = holding.filter((segment) => read.get(segment)?.chars === quote.chars);
      // Words the text wrote again as they were weren't taken out there, so which of their
      // places a part quote means can't be told.
      const writtenAgain = segments.some((segment) => holds(segment) && stillHolds(segment));
      const [target] =
        exact.length === 1 ? exact : holding.length === 1 && !writtenAgain ? holding : [];
      const place = !target
        ? null
        : exact.length === 1
          ? { first: 0, end: quote.chars.length }
          : placeQuote(read.get(target) ?? none, quote.chars);
      if (!target || !place) {
        unplaced.push(quote.text);
        continue;
      }
      stretches.set(target, [...(stretches.get(target) ?? []), { ...place, quote: quote.text }]);
    }
    const whole: Segment[] = [];
    for (const [segment, places] of stretches) {
      const { chars, at } = read.get(segment) ?? { chars: "", at: [] };
      const taken = new Array<boolean>(chars.length).fill(false);
      for (const { first, end } of places) taken.fill(true, first, end);
      if (taken.every(Boolean)) {
        whole.push(segment);
        continue;
      }
      for (let first = taken.indexOf(true); first >= 0; first = taken.indexOf(true, first)) {
        let end = first;
        while (taken[end]) end++;
        const from = at[first] ?? segment.start;
        const part = partOf(segment, from, (at[end - 1] ?? from) + 1);
        if (part) removePart(segment, part);
        else {
          const start = first;
          unplaced.push(
            ...places
              .filter((place) => place.first < end && place.end > start)
              .map((each) => each.quote),
          );
        }
        first = end;
      }
    }
    kept.splice(0, kept.length, ...kept.filter((segment) => !whole.includes(segment)));
    for (const segment of whole) quotedOut += lengthOf(segment.tokens);
    remove([...moved, ...whole].sort((a, b) => segments.indexOf(a) - segments.indexOf(b)));
  };

  /**
   * What taking the quoted words from `quotedFrom` to `quotedTo` out of a paragraph takes (#2180):
   * those words, the Citation markers right after them, and one space beside them: the one after
   * them when nothing but a space, an opening mark or the paragraph's start is before them, or
   * the one before them at the paragraph's end or before a closing mark. Null when the words
   * start or end inside a word of text other than Chinese, hold a formula, a line break or a
   * footnote, or have a footnote right after them: the User's own words or what else would go
   * can't be told.
   */
  const partOf = (
    segment: Segment,
    quotedFrom: number,
    quotedTo: number,
  ): { from: number; to: number } | null => {
    const { tokens } = segment;
    const charAt = (position: number): string | undefined => {
      const token = tokens.find(
        (each) => each.text !== undefined && each.from <= position && position < each.to,
      );
      return token?.text?.[position - token.from];
    };
    const citation = (token: OldToken | undefined) => token?.node?.name === CITATION_NODE;
    const insideWord = (position: number) => {
      const before = charAt(position - 1);
      const after = charAt(position);
      return (
        before !== undefined &&
        after !== undefined &&
        !HAN_CHAR.test(before) &&
        !HAN_CHAR.test(after) &&
        tokens.some((each) => each.text !== undefined && each.from < position && position < each.to)
      );
    };
    if (insideWord(quotedFrom) || insideWord(quotedTo)) return null;
    const holdsNode = tokens.some(
      (each) =>
        each.text === undefined &&
        each.from >= quotedFrom &&
        each.from < quotedTo &&
        !citation(each),
    );
    if (holdsNode) return null;
    let to = quotedTo;
    for (
      let token = tokens.find((each) => each.from === to);
      token?.text === undefined && token?.node;
      token = tokens.find((each) => each.from === to)
    ) {
      if (!citation(token))
        return token.node.name === FOOTNOTE_NODE ? null : { from: quotedFrom, to };
      to = token.to;
    }
    const next = charAt(to);
    const before = charAt(quotedFrom - 1);
    const startsWord =
      before === undefined
        ? !tokens.some((each) => each.to <= quotedFrom)
        : /\s/.test(before) || OPENING.test(before);
    if (next !== undefined && /\s/.test(next)) {
      return startsWord ? { from: quotedFrom, to: to + 1 } : { from: quotedFrom, to };
    }
    const closes =
      next === undefined ? !tokens.some((each) => each.from >= to) : CLOSING.test(next);
    return closes && before !== undefined && /\s/.test(before)
      ? { from: quotedFrom - 1, to }
      : { from: quotedFrom, to };
  };

  /** Takes what `partOf` found out of a paragraph left out. */
  const removePart = (segment: Segment, { from, to }: { from: number; to: number }) => {
    const { tokens } = segment;
    const touched = tokens.filter((token) => token.to > from && token.from < to);
    const target = touched
      .map((token) =>
        token.text === undefined
          ? token.target
          : token.target.slice(
              Math.max(from, token.from) - token.from,
              Math.min(to, token.to) - token.from,
            ),
      )
      .join("");
    markRemoved(segment.element, from, to, next(target));
    for (const token of touched) noteCitation(notes.removed, token);
    const characters = touched.reduce(
      (sum, token) =>
        sum + (token.text === undefined ? 1 : Math.min(to, token.to) - Math.max(from, token.from)),
      0,
    );
    notes.characters.removed += characters;
    quotedOut += characters;
  };

  /** Runs `write`, and says whether it wrote any Proposal. */
  const wrote = (write: () => void): boolean => {
    const before = proposals.length;
    write();
    const blocks = segments[0]?.element.doc?.getXmlFragment(MIND_CONTENT_FIELD);
    if (blocks) settleCitedIds(selection, blocks, newId);
    return proposals.length > before;
  };

  return {
    /**
     * The model's text so far: the paragraphs it has finished (all but the
     * last, or all of them once `done`) are written, or held until their
     * place is known. All at once, they pair as `pairUp` pairs them.
     * Returns whether any Proposal was written.
     */
    write: (text: string, done = false): boolean =>
      wrote(() => {
        if (unmade || misnamed) return;
        const { text: said, quoted } = readRemovals(named ? unnameRemovals(text) : text, done);
        const paragraphs = newParagraphs(said, selection, fresh(said), named);
        if (done) quotes = quoted.flatMap((quote) => quotedRuns(quote, selection, named));
        const open = paragraphs.findIndex((paragraph) => paragraph.open);
        const finished = done
          ? paragraphs.length
          : Math.min(paragraphs.length - 1, open < 0 ? paragraphs.length : open);
        seen = paragraphs.slice(0, finished);
        if (paragraphs.slice(taken, finished).some((paragraph) => paragraph.unmade)) {
          unmade = true;
          return;
        }
        // A name written wrong says no paragraph: which one the text replaces can't be told.
        if (
          paragraphs
            .slice(taken, finished)
            .some((paragraph) => paragraph.name && "unclear" in paragraph.name)
        ) {
          misnamed = true;
          return;
        }
        if (byName === null && finished > 0) byName = paragraphs[0]?.name !== undefined;
        if (byName) {
          for (; taken < finished && !misnamed; taken++) {
            const paragraph = paragraphs[taken];
            if (paragraph) takeNamed(paragraph);
          }
          writingName = paragraphs[finished]?.name;
          return;
        }
        if (done && taken === 0) {
          held.push(...paragraphs);
          taken = paragraphs.length;
        }
        for (; taken < finished; taken++) {
          const paragraph = paragraphs[taken];
          if (paragraph) take(paragraph);
        }
        if (done) writeHeld(segments.length);
      }),

    /**
     * Stopped: the paragraphs held are written, each into the selection's
     * next one when much like it, else as a new Block where the text has got
     * to. Nothing the model never reached goes, so none of the selection's
     * paragraphs is removed.
     */
    stop: (): boolean =>
      wrote(() => {
        if (misnamed) return;
        placeComingFirst();
        for (const paragraph of held) {
          const segment = segments[at];
          const alike =
            segment !== undefined &&
            (paragraph.kind === null || paragraph.kind === segment.kind) &&
            (keeps
              ? readsAs(segment, paragraph)
              : placeLikeness(segment, paragraph) >= MOVED_LIKENESS);
          if (!alike) {
            addNew(paragraph);
            continue;
          }
          addNotes(notesWritten, paragraph.notes);
          notes.characters.written += lengthOf(paragraph.tokens);
          writeHunks(segment, paragraph.tokens, next, newId, notes);
          place = { element: segment.element, kind: segment.kind, side: "after" };
          at += 1;
        }
        held.length = 0;
      }),

    /** The model is done: the selection's paragraphs it never reached go, and those it quotes as taken out. */
    finish: (): boolean =>
      wrote(() => {
        if (unmade || misnamed) return;
        if (byName) {
          placeComingFirst();
          kept.push(
            ...segments.filter(
              (segment, index) =>
                (!namedSoFar.has(index) || unchangedNamed.has(segment)) &&
                segment.tokens.length > 0,
            ),
          );
        } else {
          writeHeld(segments.length);
          removeUpTo(segments.length);
        }
        settleLeftOut();
      }),

    /** The Proposals written so far. */
    written: (): Written => ({
      proposals: [...proposals],
      droppedCitations: droppedOf(notes),
      ...(unmade && { unmadeTable: true }),
      ...(unplaced.length > 0 && { unplaced: [...unplaced] }),
      ...(misnamed && { misnamed: true }),
      notes: { ...notesWritten },
    }),

    /** Characters removed: not those it quotes as taken out, nor those it left out, which stay. */
    extent: () => ({
      mapped: mapsOnto(notes.characters.written - notes.characters.added, notes.characters.written),
      removed: notes.characters.removed - quotedOut,
      added: notes.characters.added,
    }),

    /** The paragraphs the text left out and are kept; none for a text that names its own, which leaves the others as they are. */
    leftOut: (): LeftOutPart[] =>
      (byName ? [] : kept).flatMap((segment) => {
        const blockId = segment.element.getAttribute(BLOCK_ID_ATTRIBUTE);
        return typeof blockId === "string"
          ? [
              {
                blockId,
                from: segment.start,
                to: segment.end,
                whole: segment.whole,
                kind: kindOf(segment.element),
              },
            ]
          : [];
      }),

    /** Where the next paragraph goes; null with no place for any. */
    writingAt(): RewritePlace | null {
      if (byName) {
        const index = writingName && "replaces" in writingName ? writingName.replaces - 1 : -1;
        const over = segments[index];
        if (over && !namedSoFar.has(index)) return { over: over.element };
        return placedAny && place ? { after: place.element } : null;
      }
      const ahead = segments[at];
      if (ahead) return { over: ahead.element };
      return place ? { after: place.element } : null;
    },
  };
}

export type RewriteStream = ReturnType<typeof createRewriteStream>;

/**
 * Adds `text` under the selection, as new paragraphs after the top-level
 * Block it ends in, each a Proposal of `request`. Markers in it are dropped:
 * nothing it says was checked. Call it in a Yjs transaction.
 */
export function proposeAfter(
  blocks: Y.XmlFragment,
  selection: Selection,
  text: string,
  request: string,
  newId: () => string,
): Written {
  const last = selection.segments.at(-1)?.element;
  let top: Y.XmlElement | null = last ?? null;
  while (top && top.parent instanceof Y.XmlElement) top = top.parent;
  if (!top || top.parent !== blocks)
    return { proposals: [], droppedCitations: 0, notes: noNotes() };
  const { proposals, next } = proposalsOf(request, newId);
  const paragraphs = text
    .replace(/\s*\[\^?\d+\]/g, "")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  const added = paragraphs.map((paragraph) =>
    paragraphOf(
      splitWords(paragraph).map((word) => ({ key: keyOf.text(word), text: word })),
      next(""),
      newId,
    ),
  );
  addAfter(top, added);
  return { proposals, droppedCitations: 0, notes: noNotes() };
}

// ---------------------------------------------------------------------------
// An Answer written again, over the User's version

/** What tells one Citation from another in an Answer: what it cites, not its number. */
function citedKey(attributes: Attributes): string {
  const location = attributes.location;
  return [
    attributes.documentId,
    attributes.contentHash,
    attributes.quote,
    attributes.pageFrom,
    attributes.pageTo,
    location === undefined || location === null ? "" : JSON.stringify(location),
  ]
    .map((value) => (value === undefined || value === null ? "" : String(value)))
    .join("\u0001");
}

/** How an inline node of an Answer is compared: a Citation by what it cites, a formula by its LaTeX. */
function answerNodeKey(name: string, attributes: Attributes): string {
  if (name === CITATION_NODE) return `${keyOf.citation(0).slice(0, -1)}${citedKey(attributes)}`;
  if (name === MATH) return keyOf.math(stringOf(attributes.latex));
  if (name === BREAK) return keyOf.break();
  return `\u0000n${name}${JSON.stringify(withoutProposalAttribute(attributes))}`;
}

/** The attributes that make two Blocks of a type differ, beyond their text. */
const shapeOf = (name: string, attributes: Attributes) =>
  `${name}:${[attributes.level, attributes.start, attributes.language]
    .map((value) => (value === undefined || value === null ? "" : String(value)))
    .join(",")}`;

/** What a Block with no text is, beyond its type: a formula's LaTeX, a chart's figures. */
const leafOf = (attributes: Attributes) =>
  JSON.stringify(
    Object.entries(attributes)
      .filter(
        ([key, value]) =>
          key !== BLOCK_ID_ATTRIBUTE &&
          key !== PROPOSAL_ATTRIBUTE &&
          value !== null &&
          value !== undefined,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** How a Block of the Mind is compared with one of the new Answer: its type, shape and text. */
function elementKey(element: Y.XmlElement): string {
  const attributes = element.getAttributes() as Attributes;
  if (INLINE_NODES.has(element.nodeName)) return answerNodeKey(element.nodeName, attributes);
  if (element.length === 0 && !TEXT_BLOCKS.has(element.nodeName)) {
    return `\u0003${element.nodeName}${leafOf(attributes)}`;
  }
  const inside = element
    .toArray()
    .map((child) => {
      if (child instanceof Y.XmlText) {
        return (child.toDelta() as Run[]).map((run) => stringOf(run.insert)).join("");
      }
      return child instanceof Y.XmlElement ? elementKey(child) : "";
    })
    .join("");
  return `\u0003${shapeOf(element.nodeName, attributes)}{${inside}}`;
}

/** The same, for a Block of the new Answer. */
function jsonKey(node: NodeJSON): string {
  if (node.type === "text") return node.text ?? "";
  const attributes = node.attrs ?? {};
  if (INLINE_NODES.has(node.type)) return answerNodeKey(node.type, attributes);
  if ((node.content ?? []).length === 0 && !TEXT_BLOCKS.has(node.type)) {
    return `\u0003${node.type}${leafOf(attributes)}`;
  }
  const inside = (node.content ?? []).map(jsonKey).join("");
  return `\u0003${shapeOf(node.type, attributes)}{${inside}}`;
}

/** The new Answer's inline content as tokens, its words with their own marks. */
function jsonTokens(content: readonly NodeJSON[]): NewToken[] {
  const tokens: NewToken[] = [];
  for (const node of content) {
    if (node.type === "text") {
      const marks = formattingOf(node.marks) ?? {};
      for (const word of splitWords(node.text ?? "")) {
        tokens.push({ key: keyOf.text(word), text: word, marks });
      }
      continue;
    }
    const attributes = node.attrs ?? {};
    tokens.push({
      key: answerNodeKey(node.type, attributes),
      node: { name: node.type, attributes },
    });
  }
  return tokens;
}

/** Every Citation in an element, or in the new Answer's Block, by what it cites. */
export function citationsIn(node: Y.XmlElement | NodeJSON): string[] {
  if (node instanceof Y.XmlElement) {
    if (node.nodeName === CITATION_NODE) return [citedKey(node.getAttributes() as Attributes)];
    return node
      .toArray()
      .flatMap((child) => (child instanceof Y.XmlElement ? citationsIn(child) : []));
  }
  if (node.type === CITATION_NODE) return [citedKey(node.attrs ?? {})];
  return (node.content ?? []).flatMap(citationsIn);
}

const sameShape = (element: Y.XmlElement, node: NodeJSON) =>
  element.nodeName === node.type &&
  shapeOf(element.nodeName, element.getAttributes() as Attributes) ===
    shapeOf(node.type, node.attrs ?? {});

/** Two Blocks whose words are compared one by one: paragraphs, or headings of a level. */
const comparable = (element: Y.XmlElement, node: NodeJSON) =>
  TEXT_BLOCKS.has(element.nodeName) && sameShape(element, node);

const nested = (element: Y.XmlElement, node: NodeJSON) =>
  WRAPPERS.has(element.nodeName) && sameShape(element, node);

const childBlocks = (element: Y.XmlElement) =>
  element.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);

const idOf = (element: Y.XmlElement) => stringOf(element.getAttribute(BLOCK_ID_ATTRIBUTE));

const PAIRED_WORDS = /\p{Script=Han}+|[\p{L}\p{N}]+/gu;

/**
 * The words of all the text a Block holds, in the Mind or in the new text, as `wordsOf` reads
 * them, without `splitWords`: a long Mind compares every Block with every other.
 */
function wordsIn(block: Y.XmlElement | NodeJSON): string[] {
  const texts: string[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText | NodeJSON) => {
    if (node instanceof Y.XmlText) {
      for (const run of node.toDelta() as Run[]) texts.push(stringOf(run.insert));
      return;
    }
    if (!(node instanceof Y.XmlElement) && node.type === "text") {
      texts.push(node.text ?? "");
      return;
    }
    const children =
      node instanceof Y.XmlElement
        ? node
            .toArray()
            .filter((child) => child instanceof Y.XmlElement || child instanceof Y.XmlText)
        : (node.content ?? []);
    for (const child of children) visit(child);
    texts.push(" ");
  };
  visit(block);
  const words: string[] = [];
  for (const [run] of texts.join("").matchAll(PAIRED_WORDS)) {
    if (!HAN.test(run)) words.push(run.toLowerCase());
    else if (run.length === 1) words.push(run);
    else for (let at = 1; at < run.length; at++) words.push(run.slice(at - 1, at + 1));
  }
  return words;
}

function sharedIn(a: Int32Array, b: Int32Array): number {
  let shared = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const x = a[i] ?? 0;
    const y = b[j] ?? 0;
    if (x === y) shared++;
    if (x <= y) i++;
    if (y <= x) j++;
  }
  return shared;
}

/**
 * Which of `old`'s Blocks each of `content`'s is written over (null: none, it is added): the
 * pairing of the most Blocks of a kind, the more of the shorter's words the other holds the
 * better, so a paragraph made longer, split or merged pairs with the one it grew from, and one
 * the new text adds or moves never takes the place of the one after it. A list item pairs only
 * with one close to it (DESIGN.md, How a change reads).
 */
function pairBlocks(old: readonly Y.XmlElement[], content: readonly NodeJSON[]): (number | null)[] {
  const numbers = new Map<string, number>();
  const read = (name: string, attributes: Attributes, block: Y.XmlElement | NodeJSON) => {
    const words = Int32Array.from(wordsIn(block), (word) => {
      const known = numbers.get(word);
      if (known !== undefined) return known;
      numbers.set(word, numbers.size);
      return numbers.size - 1;
    }).sort();
    const pairs = TEXT_BLOCKS.has(name) || WRAPPERS.has(name);
    return { shape: pairs ? shapeOf(name, attributes) : null, words };
  };
  const olds = old.map((element) =>
    read(element.nodeName, element.getAttributes() as Attributes, element),
  );
  const news = content.map((node) => read(node.type, node.attrs ?? {}, node));
  return bestPairing(old.length, content.length, (i, j) => {
    const a = olds[i];
    const b = news[j];
    if (!a || !b || a.shape === null || a.shape !== b.shape) return null;
    const total = a.words.length + b.words.length;
    const shorter = Math.min(a.words.length, b.words.length);
    const shared = shorter === 0 ? 0 : sharedIn(a.words, b.words);
    const held = shorter === 0 ? Number(total === 0) : shared / shorter;
    const alike = total === 0 ? 1 : (2 * shared) / total;
    if (old[i]?.nodeName === "listItem" && alike < COUNTERPART_LIKENESS) return null;
    return 1 + 2 * held;
  });
}

interface BlockWriter {
  next(target: string): ProposalRef;
  newId(): string;
  notes: CitationNotes;
}

/**
 * Writes `content` over `old`, Blocks side by side in `parent`, as Proposals. Blocks that are
 * the same stay as they are. Where they differ, each new Block goes over the old one it pairs
 * with (`pairBlocks`): a paragraph or heading word by word (one change if it is mostly new), a
 * list, list item or quote Block by Block inside it. The rest are removed and added whole, each
 * new one after the old ones before it. Returns the ids of the Blocks `content` is written as.
 */
function writeBlocks(
  parent: Y.XmlElement | Y.XmlFragment,
  old: readonly Y.XmlElement[],
  content: readonly NodeJSON[],
  writer: BlockWriter,
): string[] {
  const ids: string[] = [];
  let last: Y.XmlElement | null = null;
  const keep = (element: Y.XmlElement) => {
    last = element;
    ids.push(idOf(element));
  };
  const remove = (element: Y.XmlElement) => {
    for (const key of citationsIn(element)) writer.notes.removed.add(key);
    setProposal(element, { ...refOf(writer.next(targetText(element))), kind: "delete" });
    last = element;
  };
  const add = (node: NodeJSON) => {
    for (const key of citationsIn(node)) writer.notes.added.add(key);
    const element = createElement(node);
    setProposal(element, { ...refOf(writer.next("")), kind: "insert" });
    const [first] = old;
    if (last) addAfter(last, [element]);
    else if (first) addBeside(first, [element], "before");
    else parent.insert(0, [element]);
    keep(element);
  };
  const writeOver = (element: Y.XmlElement, node: NodeJSON) => {
    const size = sizeOf(element);
    const tokens = comparable(element, node)
      ? tokensIn(element, 0, size, (child, attributes) => ({
          key: answerNodeKey(child.nodeName, attributes),
        }))
      : null;
    if (tokens) {
      const segment: Segment = {
        element,
        from: 0,
        to: size,
        whole: true,
        shown: true,
        tokens,
        start: 0,
        end: size,
        kind: kindOf(element),
      };
      writeHunks(segment, jsonTokens(node.content ?? []), writer.next, writer.newId, writer.notes);
    } else if (nested(element, node)) {
      writeBlocks(element, childBlocks(element), node.content ?? [], writer);
    } else {
      remove(element);
      add(node);
      return;
    }
    keep(element);
  };
  const steps = diffSteps(old.map(elementKey), content.map(jsonKey));
  let at = 0;
  for (const hunk of hunksOf(steps, () => false)) {
    for (; at < hunk.oldFrom; at++) keep(old[at] as Y.XmlElement);
    const removed = old.slice(hunk.oldFrom, hunk.oldTo);
    const added = content.slice(hunk.newFrom, hunk.newTo);
    const paired = pairBlocks(removed, added);
    const waiting: NodeJSON[] = [];
    let from = 0;
    for (const [index, node] of added.entries()) {
      const pair = paired[index];
      if (pair === null || pair === undefined) {
        waiting.push(node);
        continue;
      }
      for (; from < pair; from++) remove(removed[from] as Y.XmlElement);
      for (const each of waiting.splice(0)) add(each);
      writeOver(removed[from] as Y.XmlElement, node);
      from++;
    }
    for (; from < removed.length; from++) remove(removed[from] as Y.XmlElement);
    for (const each of waiting) add(each);
    at = hunk.oldTo;
  }
  for (; at < old.length; at++) keep(old[at] as Y.XmlElement);
  return ids;
}

/**
 * Writes `content` (an Answer written again) over what `container` holds now, as Proposals of
 * `request` (`writeBlocks`): what the User wrote stays until they accept a change to it.
 * `container` must hold no Proposals. Call it in a Yjs transaction.
 */
export function proposeBlocks(
  container: Y.XmlElement,
  content: readonly NodeJSON[],
  request: string,
  newId: () => string,
): Written {
  const { proposals, next } = proposalsOf(request, newId);
  const notes = notesOf();
  writeBlocks(container, childBlocks(container), content, { next, newId, notes });
  return { proposals, droppedCitations: droppedOf(notes), notes: noNotes() };
}

/**
 * Writes `content` over `old`, top-level Blocks side by side in a Mind, as Proposals of
 * `request` (`writeBlocks`). Returns the ids of the top-level Blocks `content` is written as,
 * in its order. Call it in a Yjs transaction.
 */
export function proposeOver(
  blocks: Y.XmlFragment,
  old: readonly Y.XmlElement[],
  content: readonly NodeJSON[],
  request: string,
  newId: () => string,
): string[] {
  const { next } = proposalsOf(request, newId);
  return writeBlocks(blocks, old, content, { next, newId, notes: notesOf() });
}

// ---------------------------------------------------------------------------
// Making a change again

/** The Block-wide Proposal an element is in: its own `proposal` attribute, or one of a Block around it. */
function wholeProposal(element: Y.XmlElement): ProposalAttribute | null {
  for (let at: unknown = element; at instanceof Y.XmlElement; at = at.parent) {
    const attribute = readProposalAttribute(at.getAttribute(PROPOSAL_ATTRIBUTE));
    if (attribute) return attribute;
  }
  return null;
}

/**
 * Rejects the Proposal `id`, in the caller's Yjs transaction, and says where
 * the text it covered is now: from where it starts to the end of the last
 * word it removes, the User's words among them included, for the request to
 * be made again from that text. Null when no paragraph or heading holds
 * text of it (it only added a Block), and nothing is changed then.
 */
export function takeBackForRegenerate(
  blocks: Y.XmlFragment,
  id: string,
): { from: TextPlace; to: TextPlace } | null {
  let from: TextPlace | null = null;
  let to: TextPlace | null = null;
  const isIt = (value: unknown) => readProposalRef(value)?.id === id;
  for (const { element } of textBlocks(blocks)) {
    const blockId = stringOf(element.getAttribute(BLOCK_ID_ATTRIBUTE));
    const whole = wholeProposal(element);
    if (whole?.id === id) {
      if (whole.kind === "delete") {
        from ??= { blockId, offset: 0 };
        to = { blockId, offset: sizeOf(element) };
      }
      continue;
    }
    /** Where each part will be once the Proposal is rejected: what it adds won't be there. */
    let offset = 0;
    for (const child of layout(element)) {
      if (child.node instanceof Y.XmlText) {
        for (const run of child.node.toDelta() as Run[]) {
          const length = typeof run.insert === "string" ? run.insert.length : 1;
          const adds = isIt(run.attributes?.[PROPOSAL_INSERT_MARK]);
          const removes = isIt(run.attributes?.[PROPOSAL_DELETE_MARK]);
          if (adds || removes) from ??= { blockId, offset };
          if (adds) continue;
          offset += length;
          if (removes) to = { blockId, offset };
        }
        continue;
      }
      const attribute = readProposalAttribute(child.node.getAttribute(PROPOSAL_ATTRIBUTE));
      const mine = attribute?.id === id;
      if (mine) from ??= { blockId, offset };
      if (mine && attribute?.kind === "insert") continue;
      offset += 1;
      if (mine) to = { blockId, offset };
    }
  }
  if (!from) return null;
  resolveProposals(blocks, (ref) => ref.id === id, "reject");
  return { from, to: to ?? from };
}
