import { mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { Fragment, type NodeType, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { CITATION_NODE, type CitationAttributes } from "../../../core/api";
import { citationReference, parseQuotedWords } from "../../../shared/citations";
import { parseLocation } from "../../../shared/locations";

export interface CitationOptions {
  /** Draws the Citation: its badge, and what clicking it does. */
  view: NodeViewRenderer | null;
}

/**
 * An attribute kept in the HTML as `data-<name>`, so a Citation copied and
 * pasted (into a Note, or another Mind) keeps everything it stores.
 */
function dataAttribute(name: string, kind: "text" | "page" = "text") {
  const key = `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute(key);
      if (value === null) return null;
      if (kind === "text") return value;
      const page = Number(value);
      return Number.isInteger(page) && page >= 1 ? page : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[name];
      return value === null || value === undefined ? {} : { [key]: String(value) };
    },
  };
}

const ID_KEY = "data-citation-id";

export const citationCopiesKey = new PluginKey("citationCopies");

/** The slice without the ids of Citations `doc` still holds: a copy is a Citation of its own. */
function withoutRepeatedIds(slice: Slice, doc: ProseMirrorNode, type: NodeType): Slice {
  const held = new Set<string>();
  doc.descendants((node) => {
    if (node.type === type && typeof node.attrs.id === "string") held.add(node.attrs.id);
  });
  if (held.size === 0) return slice;
  const strip = (fragment: Fragment): Fragment => {
    const nodes: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      if (node.type === type && typeof node.attrs.id === "string" && held.has(node.attrs.id))
        nodes.push(type.create({ ...node.attrs, id: undefined }, node.content, node.marks));
      else nodes.push(node.isLeaf ? node : node.copy(strip(node.content)));
    });
    return Fragment.from(nodes);
  };
  return new Slice(strip(slice.content), slice.openStart, slice.openEnd);
}

/**
 * A Citation: an inline node in the text of an Answer, which the core writes
 * for each marker the model cited (see `CitationAttributes`). It moves with
 * the text around it, goes when that text is deleted, and keeps its Passage,
 * quote and check result when copied, e.g. into a Note.
 */
export const Citation = Node.create<CitationOptions>({
  name: CITATION_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    const attributes: Record<keyof CitationAttributes, object> = {
      passageId: dataAttribute("passageId"),
      documentId: dataAttribute("documentId"),
      documentName: dataAttribute("documentName"),
      contentHash: dataAttribute("contentHash"),
      pageFrom: dataAttribute("pageFrom", "page"),
      pageTo: dataAttribute("pageTo", "page"),
      // Where it points (ADR-0011), as JSON in the HTML.
      location: {
        default: null,
        parseHTML: (element: HTMLElement) => parseLocation(element.getAttribute("data-location")),
        renderHTML: (attributes: Record<string, unknown>) => {
          const location = parseLocation(attributes.location);
          return location ? { "data-location": JSON.stringify(location) } : {};
        },
      },
      quote: dataAttribute("quote"),
      check: {
        default: "checking",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-check") ?? "checking",
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-check": attributes.check }),
      },
      checkReason: dataAttribute("checkReason"),
      // Only a claim check sets it, so a Citation without one stores nothing.
      verdict: { ...dataAttribute("verdict"), default: undefined },
      // Only an Answer whose quoted words weren't found sets it (#483), as JSON in the HTML.
      quotedWords: {
        default: undefined,
        parseHTML: (element: HTMLElement) =>
          parseQuotedWords(element.getAttribute("data-quoted-words")) ?? undefined,
        renderHTML: (attributes: Record<string, unknown>) => {
          const words = parseQuotedWords(attributes.quotedWords);
          return words ? { "data-quoted-words": JSON.stringify(words) } : {};
        },
      },
      // Only Keep citing the old version sets it (#99), so a Citation without one stores nothing.
      keptOver: { ...dataAttribute("keptOver"), default: undefined },
      // Only "Checked by me" gives it (#1933), so a Citation never marked stores nothing. A copy
      // carries it; one pasted where the Citation still is loses it (`withoutRepeatedIds`).
      id: {
        default: undefined,
        parseHTML: (element: HTMLElement) => element.getAttribute(ID_KEY) ?? undefined,
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.id === "string" ? { [ID_KEY]: attributes.id } : {},
      },
    };
    return attributes;
  },

  addProseMirrorPlugins() {
    const type = this.type;
    return [
      new Plugin({
        key: citationCopiesKey,
        props: {
          // A Citation moved keeps its id, and the User's mark with it; a copy beside it doesn't.
          transformPasted: (slice, view) =>
            view.dragging?.move ? slice : withoutRepeatedIds(slice, view.state.doc, type),
        },
      }),
    ];
  },

  parseHTML() {
    // The footnote list a copy carries (see `addFootnotes`) isn't text to paste.
    return [
      { tag: `span[data-type="${CITATION_NODE}"]` },
      { tag: "div[data-citation-notes]", ignore: true },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": CITATION_NODE }),
      citationReference(node.attrs as CitationAttributes),
    ];
  },

  renderText({ node }) {
    return citationReference(node.attrs as CitationAttributes);
  },

  addNodeView() {
    return this.options.view;
  },
});
