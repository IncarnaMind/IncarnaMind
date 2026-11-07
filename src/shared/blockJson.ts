/**
 * Blocks as ProseMirror (and Tiptap) write them in JSON, and the Citations in
 * an Answer's text: what the core writes into a Mind, and what the assistant
 * draws an Answer of a conversation with (ADR-0017), from the same Markdown
 * and Citations. Pure: the core and the window share it.
 */
import { CITATION_NODE, type Citation, type CitationAttributes } from "../core/api";

/** A node as ProseMirror (and Tiptap) write it in JSON. */
export interface NodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NodeJSON[];
  /** Text nodes only. */
  text?: string;
  /** Text nodes only. */
  marks?: MarkJSON[];
}

export interface MarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A Citation marker as the model writes it in the text: "[^1]". */
const CITATION_MARKER = /\[\^(\d{1,4})\]/g;

/**
 * A Citation node, every attribute set (null ones are left out, as y-tiptap
 * stores them); with no Citation, one still being checked.
 */
/** Every attribute a Citation's node keeps: a Record, so the compiler names a new one left out. */
const citationAttributeNames: Record<keyof CitationAttributes, true> = {
  passageId: true,
  documentId: true,
  documentName: true,
  contentHash: true,
  pageFrom: true,
  pageTo: true,
  location: true,
  quote: true,
  check: true,
  checkReason: true,
  yourNoteAt: true,
  unsure: true,
  pageChecked: true,
  verdict: true,
  quotedWords: true,
  keptOver: true,
  id: true,
};

/** Every attribute of a Citation, its provenance included, with the nulls a note keeps by leaving them out. */
export function citationAttributesOf(
  citation: Citation & Partial<Pick<CitationAttributes, "pageChecked" | "keptOver" | "id">>,
): CitationAttributes {
  return {
    passageId: citation.passageId ?? null,
    documentId: citation.documentId ?? null,
    documentName: citation.documentName ?? null,
    contentHash: citation.contentHash ?? null,
    pageFrom: citation.pageFrom ?? null,
    pageTo: citation.pageTo ?? null,
    location: citation.location ?? null,
    quote: citation.quote ?? null,
    check: citation.check,
    checkReason: citation.checkReason ?? null,
    yourNoteAt: citation.yourNoteAt ?? null,
    unsure: citation.unsure ?? null,
    pageChecked: citation.pageChecked ?? null,
    verdict: citation.verdict ?? null,
    quotedWords: citation.quotedWords ?? null,
    keptOver: citation.keptOver ?? null,
    id: citation.id ?? null,
  };
}

export function citationNode(citation: Citation | null): NodeJSON {
  const attrs: CitationAttributes = citation ?? {
    passageId: null,
    documentId: null,
    documentName: null,
    contentHash: null,
    pageFrom: null,
    pageTo: null,
    location: null,
    quote: null,
    check: "checking",
    checkReason: null,
  };
  const kept = Object.fromEntries(
    (Object.keys(citationAttributeNames) as (keyof CitationAttributes)[]).map((name) => [
      name,
      attrs[name],
    ]),
  );
  return {
    type: CITATION_NODE,
    attrs: Object.fromEntries(
      Object.entries(kept).filter(([, value]) => value !== null && value !== undefined),
    ),
  };
}

/**
 * Turns the markers in an Answer's text into Citation nodes: `node` gives a
 * marker's node, or null to remove the marker (with the space before it, so
 * "a claim [^3]." reads "a claim."). Code keeps its markers.
 */
export function withCitations(
  blocks: readonly NodeJSON[],
  node: (marker: number) => NodeJSON | null,
): NodeJSON[] {
  return replaceMarkers(blocks, CITATION_MARKER, (match, before, after) => {
    const citation = node(Number(match[1]));
    if (citation) return { before, put: citation };
    return { before: withoutSpaceBeforeRemoved(before, after), put: null };
  });
}

/** The text before a marker that is removed: without the space before it, unless a word follows. */
export const withoutSpaceBeforeRemoved = (before: string, after: string): string =>
  /^\p{L}/u.test(after) ? before : before.replace(/[ \t]+$/, "");

/** What goes where a marker was (see `replaceMarkers`). */
export interface MarkerReplacement {
  /** The text before it, since the last marker in its text node, as it is to stay. */
  before: string;
  /** In its place: a node, text with the marks of the text around it, or nothing. */
  put: NodeJSON | string | null;
  /** How many characters of the text after it to leave out too. */
  skip?: number;
}

/**
 * Replaces each match of `pattern` (a global RegExp) in the text of `blocks`
 * with what `replace` gives for it, from the match, the text before it in its
 * text node (since the last match) and the text after it. Inline code and
 * code blocks keep their markers.
 */
export function replaceMarkers(
  blocks: readonly NodeJSON[],
  pattern: RegExp,
  replace: (match: RegExpMatchArray, before: string, after: string) => MarkerReplacement,
): NodeJSON[] {
  return blocks.map((block) => replaceIn(block, pattern, replace));
}

function replaceIn(
  block: NodeJSON,
  pattern: RegExp,
  replace: (match: RegExpMatchArray, before: string, after: string) => MarkerReplacement,
): NodeJSON {
  if (!block.content || block.type === "codeBlock") return block;
  const content: NodeJSON[] = [];
  for (const child of block.content) {
    const isCode = child.marks?.some((mark) => mark.type === "code") ?? false;
    if (child.type !== "text" || !child.text || isCode) {
      content.push(replaceIn(child, pattern, replace));
      continue;
    }
    let last = 0;
    for (const match of child.text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const {
        before,
        put,
        skip = 0,
      } = replace(match, child.text.slice(last, match.index), child.text.slice(end));
      if (before) content.push({ ...child, text: before });
      if (typeof put === "string") {
        if (put) content.push({ ...child, text: put });
      } else if (put) {
        content.push(put);
      }
      last = end + skip;
    }
    const rest = child.text.slice(last);
    if (rest) content.push(last === 0 ? child : { ...child, text: rest });
  }
  // Two text nodes with the same marks that a replaced marker left side by side become one.
  const merged: NodeJSON[] = [];
  for (const child of content) {
    const previous = merged.at(-1);
    if (
      previous?.type === "text" &&
      child.type === "text" &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(child.marks ?? [])
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: `${previous.text ?? ""}${child.text ?? ""}`,
      };
    } else {
      merged.push(child);
    }
  }
  return { ...block, content: merged };
}
