/**
 * A Mind imported from a Word file, and the Blocks it was imported as, in one
 * shape (#105): JSON nodes, as the import made them, flattened into the counterparts
 * that match the document's XML one for one. A paragraph, a heading or a list
 * item's paragraph is a `w:p`; a table, a `w:tbl`; a kept-as-is Block, the
 * element it names. Lists are flat in Word, so a list's items are counterparts of
 * their own, with the list they are in.
 */
import * as Y from "yjs";
import type { MarkJSON, NodeJSON } from "../../../shared/blockJson";
import { isNumberingScheme, itemLevel, type NumberingScheme } from "../../../shared/numbering";
import { readTextColor, readTextFont, readTextSize } from "../../../shared/paragraphFormat";
import { readProposalAttribute, readProposalRef } from "../../../shared/proposals";
import { readWordAtom } from "../../../shared/wordFiles";
import {
  ANSWER_BLOCK,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  TEXT_FONT_MARK,
  TEXT_SIZE_MARK,
  WORD_BLOCK_NODE,
} from "../../api";
import { type Pendings, pendingOf, type ReviewReading } from "../../mindText";

/** The formatting of text the export writes: the editor's marks, and its link. */
export interface TextMarks {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  code: boolean;
  link: string | null;
  color: string | null;
  font: string | null;
  size: number | null;
  vertical: "superscript" | "subscript" | null;
}

export const NO_MARKS: TextMarks = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  highlight: false,
  code: false,
  link: null,
  color: null,
  font: null,
  size: null,
  vertical: null,
};

export function marksOf(marks: readonly MarkJSON[] | undefined): TextMarks {
  const has = (type: string) => marks?.some((mark) => mark.type === type) ?? false;
  const attribute = (type: string, name: string) =>
    marks?.find((mark) => mark.type === type)?.attrs?.[name];
  const link = attribute("link", "href");
  return {
    bold: has("bold"),
    italic: has("italic"),
    underline: has("underline"),
    strike: has("strike"),
    highlight: has("highlight"),
    code: has("code"),
    link: typeof link === "string" && link !== "" ? link : null,
    color: readTextColor(attribute(TEXT_COLOR_MARK, "color")),
    font: readTextFont(attribute(TEXT_FONT_MARK, "family")),
    size: readTextSize(attribute(TEXT_SIZE_MARK, "size")),
    vertical: has(SUPERSCRIPT_MARK) ? "superscript" : has(SUBSCRIPT_MARK) ? "subscript" : null,
  };
}

export const sameMarks = (a: TextMarks, b: TextMarks): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  a.highlight === b.highlight &&
  a.code === b.code &&
  a.link === b.link &&
  a.color === b.color &&
  a.font === b.font &&
  a.size === b.size &&
  a.vertical === b.vertical;

/** Text's marks with the file's colour, font, size and raise where they have none. */
export const withFileFormat = (marks: TextMarks, file: TextMarks): TextMarks => ({
  ...marks,
  color: marks.color ?? file.color,
  font: marks.font ?? file.font,
  size: marks.size ?? file.size,
  vertical: marks.vertical ?? file.vertical,
});

/** What changes still waiting do to a node as a whole: its `proposal` attribute. */
export function nodePendings(node: NodeJSON, review: ReviewReading | undefined): Pendings {
  const attribute = readProposalAttribute(node.attrs?.[PROPOSAL_ATTRIBUTE]);
  const pending = attribute ? pendingOf(attribute, review) : undefined;
  if (!attribute || !pending) return {};
  return attribute.kind === "insert" ? { inserted: pending } : { deleted: pending };
}

/** What changes still waiting do to a text node: its marks. */
export function textPendings(node: NodeJSON, review: ReviewReading | undefined): Pendings {
  const attrsOf = (type: string) => node.marks?.find((mark) => mark.type === type)?.attrs;
  const inserted = pendingOf(attrsOf(PROPOSAL_INSERT_MARK), review);
  const deleted = pendingOf(attrsOf(PROPOSAL_DELETE_MARK), review);
  return { ...(inserted && { inserted }), ...(deleted && { deleted }) };
}

const MARK_KINDS: ReadonlyMap<string, "insert" | "delete"> = new Map([
  [PROPOSAL_INSERT_MARK, "insert"],
  [PROPOSAL_DELETE_MARK, "delete"],
]);

/**
 * The changes on what a Mind's node holds, its text and the nodes within it, not on the node
 * itself (that is its counterpart's `pending`): each by its id and kind, with its request.
 */
export function changesWithin(element: Y.XmlElement): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (parent: Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const run of child.toDelta() as { attributes?: Record<string, unknown> }[]) {
          for (const [mark, kind] of MARK_KINDS) {
            const ref = readProposalRef(run.attributes?.[mark]);
            if (ref) found.set(`${ref.id} ${kind}`, ref.request);
          }
        }
      } else if (child instanceof Y.XmlElement) {
        const own = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
        if (own) found.set(`${own.id} ${own.kind}`, own.request);
        visit(child);
      }
    }
  };
  visit(element);
  return found;
}

/** As `changesWithin`, for a node as the import reads it. */
export function importedChangesWithin(node: NodeJSON): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (parent: NodeJSON) => {
    for (const child of parent.content ?? []) {
      for (const mark of child.marks ?? []) {
        const kind = MARK_KINDS.get(mark.type);
        const ref = kind ? readProposalRef(mark.attrs) : null;
        if (kind && ref) found.set(`${ref.id} ${kind}`, ref.request);
      }
      const own = readProposalAttribute(child.attrs?.[PROPOSAL_ATTRIBUTE]);
      if (own) found.set(`${own.id} ${own.kind}`, own.request);
      visit(child);
    }
  };
  visit(node);
  return found;
}

/**
 * A Mind's node as JSON, as the Mind reads it: what a Proposal adds, which
 * isn't the Mind's until it is accepted, is left out (ADR-0003), unless read
 * for review (#107), when only what a change out of date adds is. `elements`
 * maps each node back to its element, for what reads the Mind's own way
 * (Citations, footnotes).
 */
export function mindJson(
  element: Y.XmlElement,
  elements: Map<NodeJSON, Y.XmlElement>,
  review?: ReviewReading,
): NodeJSON | null {
  const attribute = readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE));
  if (attribute?.kind === "insert" && !pendingOf(attribute, review)) return null;
  const content: NodeJSON[] = [];
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const run of child.toDelta() as {
        insert: unknown;
        attributes?: Record<string, unknown>;
      }[]) {
        const attributes = run.attributes ?? {};
        if (
          PROPOSAL_INSERT_MARK in attributes &&
          !pendingOf(attributes[PROPOSAL_INSERT_MARK], review)
        )
          continue;
        if (typeof run.insert !== "string" || run.insert === "") continue;
        const marks: MarkJSON[] = Object.entries(attributes).map(([type, value]) =>
          value && typeof value === "object"
            ? { type, attrs: value as Record<string, unknown> }
            : { type },
        );
        content.push({ type: "text", text: run.insert, ...(marks.length > 0 && { marks }) });
      }
    } else if (child instanceof Y.XmlElement) {
      const node = mindJson(child, elements, review);
      if (node) content.push(node);
    }
  }
  const node: NodeJSON = {
    type: element.nodeName,
    attrs: element.getAttributes() as Record<string, unknown>,
    content,
  };
  elements.set(node, element);
  return node;
}

/** A list a counterpart is an item of: the Mind's list node, whether it is numbered, and how deep. */
export interface ListPlace {
  list: NodeJSON;
  ordered: boolean;
  depth: number;
  /**
   * The level of its scheme its items draw: the level the outermost numbered list it is in starts
   * at, one more for each numbered list between. It is its depth, unless its numbering starts
   * again under an unnumbered list (#1419).
   */
  level: number;
  /** A numbered list's scheme, and the outermost numbered list it is in, whose numbering it shares. */
  numbered: { scheme: NumberingScheme; outer: NodeJSON } | null;
}

/** What a counterpart is, as the export writes it. */
export type CounterpartKind = "paragraph" | "table" | "kept" | "other";

/** One counterpart: a node and, for one imported from the document, the place of its XML. */
export interface Counterpart {
  node: NodeJSON;
  kind: CounterpartKind;
  /** The place of its XML ("w:p#12"); null for content the document didn't have. */
  key: string | null;
  list: ListPlace | null;
  /** What changes still waiting do to it as a whole, or to what holds it (#107). */
  pending: Pendings;
  /** It is in an Answer from before AI text was marked, which is the AI's as a whole. */
  wholeAi: boolean;
}

/** How counterparts are read: with what changes still waiting do (#107), and inside what. */
interface Within {
  review?: ReviewReading;
  pending: Pendings;
  wholeAi: boolean;
}

const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
const PARAGRAPHS = new Set(["paragraph", "heading"]);

/** Whether a kept-as-is Block is a header or a footer: its source names a part, not an element. */
export const isFurniture = (node: NodeJSON): boolean =>
  node.type === WORD_BLOCK_NODE && !readWordAtom(node.attrs ?? {}).source?.includes("#");

/**
 * The counterparts in some Blocks, in order: list items one by one, an Answer's
 * Blocks as if they weren't in one. `keyOf` says where a node's XML is. A
 * header or footer isn't one: it is a part of the package of its own.
 */
export function counterpartsOf(
  blocks: readonly NodeJSON[],
  keyOf: (node: NodeJSON) => string | null,
  review?: ReviewReading,
): Counterpart[] {
  return collect(blocks, keyOf, null, [], {
    ...(review && { review }),
    pending: {},
    wholeAi: false,
  });
}

function collect(
  blocks: readonly NodeJSON[],
  keyOf: (node: NodeJSON) => string | null,
  list: ListPlace | null,
  into: Counterpart[],
  within: Within,
): Counterpart[] {
  for (const node of blocks) {
    const inner: Within = {
      ...within,
      pending: { ...within.pending, ...nodePendings(node, within.review) },
    };
    if (LISTS.has(node.type)) {
      const ordered = node.type === "orderedList";
      const startLevel = itemLevel(0, Number(node.attrs?.startLevel) || 0);
      // Where its items sit in the file, which an outermost list that starts deeper does at its level.
      const depth = list ? Math.min(list.depth + 1, 8) : startLevel;
      const outer = ordered && list?.numbered ? list.numbered : null;
      const scheme = node.attrs?.numbering;
      const place: ListPlace = {
        list: node,
        ordered,
        depth,
        // The scheme's level its items draw: on in the numbered list it is nested in, else at its start.
        level: ordered && list?.numbered ? Math.min(list.level + 1, 8) : startLevel,
        numbered:
          outer ??
          (ordered
            ? { scheme: isNumberingScheme(scheme) ? scheme : "default", outer: node }
            : null),
      };
      for (const item of node.content ?? []) {
        collect(item.content ?? [], keyOf, place, into, {
          ...inner,
          pending: { ...inner.pending, ...nodePendings(item, within.review) },
        });
      }
    } else if (node.type === ANSWER_BLOCK) {
      const older = within.review !== undefined && node.attrs?.generatedMarks !== true;
      collect(node.content ?? [], keyOf, list, into, { ...inner, wholeAi: inner.wholeAi || older });
    } else if (node.type === WORD_BLOCK_NODE) {
      if (isFurniture(node)) continue;
      const source = readWordAtom(node.attrs ?? {}).source;
      into.push({ node, kind: "kept", key: source, list, pending: inner.pending, wholeAi: false });
    } else {
      const key = keyOf(node);
      const kind: CounterpartKind = PARAGRAPHS.has(node.type)
        ? "paragraph"
        : node.type === "table"
          ? "table"
          : "other";
      into.push({
        node,
        kind,
        key: kind === "other" ? null : key,
        list,
        pending: inner.pending,
        wholeAi: inner.wholeAi,
      });
    }
  }
  return into;
}
