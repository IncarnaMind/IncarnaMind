/**
 * Reading and writing Blocks in a Mind's Yjs document from the core, in the
 * shape Tiptap's Yjs binding (y-tiptap) gives them, so the editor shows what
 * the core writes and leaves it alone:
 *
 * - a node is a `Y.XmlElement` named after its type, with each non-null
 *   attribute set, the schema's defaults included;
 * - consecutive text nodes are one `Y.XmlText`, each mark a formatting
 *   attribute named after the mark, holding its attributes;
 * - inline nodes that aren't text (a formula, a line break) are elements
 *   between the texts.
 *
 * The core knows no editor schema: it writes only the node types and marks of
 * Notes (see `NOTE_BLOCK_TYPES`), and the tests check what it writes against
 * the editor's schema.
 */
import { createHash, randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { MarkJSON, NodeJSON } from "../../shared/blockJson";
import { BLOCK_ID_ATTRIBUTE, NOTE_BLOCK_TYPES } from "../api";
import { isRecord } from "../errors";
import { contentMarkdownOf, elementMarkdown } from "./contextText";

export type { MarkJSON, NodeJSON };

type FormattingAttributes = Record<string, unknown>;

/** A stretch of text with one set of marks, as `Y.XmlText.toDelta()` gives it. */
interface Run {
  insert: string;
  attributes?: FormattingAttributes;
}

type Child = { kind: "text"; runs: Run[] } | { kind: "element"; node: NodeJSON };

/** Node types that carry a Block ID. Tiptap's UniqueID gives them one; the core does for those it writes. */
const ID_TYPES: ReadonlySet<string> = new Set(NOTE_BLOCK_TYPES);

/** The top-level Blocks of a Mind, in order. */
export function topLevelBlocks(blocks: Y.XmlFragment): Y.XmlElement[] {
  return blocks.toArray().filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
}

/** The top-level Block of this type with this ID, and its index among the Mind's children. */
export function findBlock(
  blocks: Y.XmlFragment,
  type: string,
  id: string,
): { element: Y.XmlElement; index: number } | null {
  const children = blocks.toArray();
  for (let index = 0; index < children.length; index++) {
    const element = children[index];
    if (
      element instanceof Y.XmlElement &&
      element.nodeName === type &&
      element.getAttribute(BLOCK_ID_ATTRIBUTE) === id
    ) {
      return { element, index };
    }
  }
  return null;
}

/** An attribute of an element, or null when it isn't set. */
export function attribute(element: Y.XmlElement, name: string): unknown {
  return element.getAttribute(name) ?? null;
}

export function textAttribute(element: Y.XmlElement, name: string): string | null {
  const value = element.getAttribute(name);
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Writing

function childrenOf(content: readonly NodeJSON[]): Child[] {
  const children: Child[] = [];
  let text: Run[] | null = null;
  for (const node of content) {
    if (node.type === "text") {
      if (!node.text) continue;
      if (!text) {
        text = [];
        children.push({ kind: "text", runs: text });
      }
      text.push({ insert: node.text, attributes: formattingOf(node.marks) });
    } else {
      text = null;
      children.push({ kind: "element", node });
    }
  }
  return children;
}

/** A text node's marks as Yjs formatting attributes, each named after its mark. */
export function formattingOf(
  marks: readonly MarkJSON[] | undefined,
): FormattingAttributes | undefined {
  if (!marks || marks.length === 0) return undefined;
  return Object.fromEntries(marks.map((mark) => [mark.type, mark.attrs ?? {}]));
}

/** A node's attributes that are set (y-tiptap stores no null attribute). */
function setAttributes(node: NodeJSON): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined) set[key] = value;
  }
  return set;
}

/** The attributes to store for a new node: those set, plus a new Block ID if its type takes one. */
function attributesToStore(node: NodeJSON): Record<string, unknown> {
  const stored = setAttributes(node);
  if (ID_TYPES.has(node.type) && stored[BLOCK_ID_ATTRIBUTE] === undefined) {
    stored[BLOCK_ID_ATTRIBUTE] = randomUUID();
  }
  return stored;
}

function createText(runs: readonly Run[]): Y.XmlText {
  const text = new Y.XmlText();
  text.applyDelta(runs.map((run) => ({ insert: run.insert, attributes: run.attributes ?? {} })));
  return text;
}

/** A new Yjs element for a node and everything in it. */
export function createElement(node: NodeJSON): Y.XmlElement {
  const element = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(attributesToStore(node))) {
    // biome-ignore lint/suspicious/noExplicitAny: Yjs types attribute values loosely.
    element.setAttribute(key, value as any);
  }
  element.insert(0, childrenOf(node.content ?? []).map(createChild));
  return element;
}

/** A Yjs element as ProseMirror writes its node in JSON: what `createElement` makes it from. */
export function nodeOf(element: Y.XmlElement): NodeJSON {
  const attrs = element.getAttributes();
  const content = element.toArray().flatMap((child): NodeJSON[] => {
    if (child instanceof Y.XmlElement) return [nodeOf(child)];
    if (!(child instanceof Y.XmlText)) return [];
    return (child.toDelta() as Run[]).flatMap((run) => {
      if (typeof run.insert !== "string") return [];
      const marks = Object.entries(run.attributes ?? {}).map(([type, value]) => ({
        type,
        ...(isRecord(value) && { attrs: value }),
      }));
      return [{ type: "text", text: run.insert, ...(marks.length > 0 && { marks }) }];
    });
  });
  return {
    type: element.nodeName,
    ...(Object.keys(attrs).length > 0 && { attrs }),
    ...(content.length > 0 && { content }),
  };
}

function createChild(child: Child): Y.XmlElement | Y.XmlText {
  return child.kind === "text" ? createText(child.runs) : createElement(child.node);
}

/**
 * Makes an element's content match `content` with as small a change as
 * possible: what is already there stays, and text that grew gets only the new
 * characters. A streaming Answer then changes only at its end, so nothing
 * above the end is redrawn.
 */
export function syncContent(element: Y.XmlElement, content: readonly NodeJSON[]): void {
  const wanted = childrenOf(content);
  for (let index = 0; index < wanted.length; index++) {
    const want = wanted[index] as Child;
    const current = element.get(index);
    if (current instanceof Y.XmlText && want.kind === "text") {
      syncText(current, want.runs);
    } else if (
      current instanceof Y.XmlElement &&
      want.kind === "element" &&
      current.nodeName === want.node.type
    ) {
      syncAttributes(current, want.node);
      syncContent(current, want.node.content ?? []);
    } else {
      if (current !== undefined) element.delete(index, 1);
      element.insert(index, [createChild(want)]);
    }
  }
  if (element.length > wanted.length) element.delete(wanted.length, element.length - wanted.length);
}

function syncAttributes(element: Y.XmlElement, node: NodeJSON): void {
  const wanted = setAttributes(node);
  delete wanted[BLOCK_ID_ATTRIBUTE];
  const current = element.getAttributes() as Record<string, unknown>;
  for (const [key, value] of Object.entries(wanted)) {
    // biome-ignore lint/suspicious/noExplicitAny: Yjs types attribute values loosely.
    if (!sameValue(current[key], value)) element.setAttribute(key, value as any);
  }
  // The Block ID stays, whoever set it.
  for (const key of Object.keys(current)) {
    if (key !== BLOCK_ID_ATTRIBUTE && !(key in wanted)) element.removeAttribute(key);
  }
}

/** Keeps the longest common start of the text, then writes the rest. */
function syncText(text: Y.XmlText, wanted: readonly Run[]): void {
  const current = (text.toDelta() as Run[]).filter((run) => typeof run.insert === "string");
  let keep = commonStart(current, wanted);
  const joined = wanted.map((run) => run.insert).join("");
  // Never split a surrogate pair.
  if (keep > 0 && isHighSurrogate(joined.charCodeAt(keep - 1))) keep--;
  if (keep < text.length) text.delete(keep, text.length - keep);
  let offset = 0;
  let at = keep;
  for (const run of wanted) {
    const end = offset + run.insert.length;
    if (end > keep) {
      const piece = run.insert.slice(Math.max(0, keep - offset));
      text.insert(at, piece, run.attributes ?? {});
      at += piece.length;
    }
    offset = end;
  }
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** How many characters two runs of text share from their start, marks included. */
function commonStart(a: readonly Run[], b: readonly Run[]): number {
  let length = 0;
  let i = 0;
  let j = 0;
  let offsetA = 0;
  let offsetB = 0;
  while (i < a.length && j < b.length) {
    const runA = a[i] as Run;
    const runB = b[j] as Run;
    if (!sameValue(runA.attributes ?? {}, runB.attributes ?? {})) break;
    while (
      offsetA < runA.insert.length &&
      offsetB < runB.insert.length &&
      runA.insert[offsetA] === runB.insert[offsetB]
    ) {
      offsetA++;
      offsetB++;
      length++;
    }
    if (offsetA < runA.insert.length && offsetB < runB.insert.length) break;
    if (offsetA === runA.insert.length) {
      i++;
      offsetA = 0;
    }
    if (offsetB === runB.insert.length) {
      j++;
      offsetB = 0;
    }
  }
  return length;
}

/** Deep equality for attribute values (JSON), ignoring key order and treating null keys as absent. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  const entriesOf = (value: object) =>
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined);
  const left = entriesOf(a);
  const right = new Map(entriesOf(b));
  return (
    left.length === right.size &&
    left.every(([key, item]) => right.has(key) && sameValue(item, right.get(key)))
  );
}

// ---------------------------------------------------------------------------
// Reading, as Markdown (the reading itself is ../mindText's)

/** A Block (or any element) as Markdown, e.g. for Question context. */
export const toMarkdown = elementMarkdown;

/** An element's content as Markdown: its child Blocks separated by blank lines. */
export const contentMarkdown = contentMarkdownOf;

/** A fingerprint of an element's content, to tell whether it changed since. */
export function contentHash(element: Y.XmlElement): string {
  return createHash("sha256").update(contentMarkdown(element)).digest("base64url").slice(0, 22);
}

/** The User has changed the Answer since it was written. */
export function isEdited(answer: Y.XmlElement): boolean {
  const hash = textAttribute(answer, "generatedHash");
  return hash !== null && hash !== contentHash(answer);
}
