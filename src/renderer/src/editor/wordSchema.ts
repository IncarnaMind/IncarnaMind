import { Extension, Mark, mergeAttributes, Node, type NodeViewRenderer } from "@tiptap/core";
import { TableView } from "@tiptap/extension-table";
import { Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type * as Y from "yjs";
import {
  IMAGE_NODE,
  WORD_ATOM_NODE,
  WORD_BLOCK_NODE,
  WORD_LOOK_ATTRIBUTE,
  WORD_RUN_MARK,
} from "../../../core/api";
import { readWordAtom, wordAtomText } from "../../../shared/wordFiles";
import { wordLookOf } from "../../../shared/wordLook";
import { editorDoc } from "./proposalReview";

/**
 * An attribute kept in the HTML as `data-word-<name>`, so an atom copied and
 * pasted (into another paragraph, or another Mind) keeps where its XML is.
 */
function dataAttribute(name: string, defaultValue: string | null) {
  const key = `data-word-${name}`;
  return {
    default: defaultValue,
    parseHTML: (element: HTMLElement) => element.getAttribute(key) ?? defaultValue,
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[name];
      return typeof value === "string" ? { [key]: value } : {};
    },
  };
}

const atomAttributes = () => ({
  kind: dataAttribute("kind", "other"),
  label: dataAttribute("label", ""),
  text: dataAttribute("text", ""),
  source: dataAttribute("source", null),
  hash: dataAttribute("hash", null),
  info: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      try {
        const value: unknown = JSON.parse(element.getAttribute("data-word-info") ?? "null");
        return typeof value === "object" ? value : null;
      } catch {
        return null;
      }
    },
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.info ? { "data-word-info": JSON.stringify(attributes.info) } : {},
  },
});

export interface WordAtomOptions {
  /** Draws the atom: its chip, mark or box, and what it says on hover. */
  view: NodeViewRenderer | null;
}

/**
 * What a Word import kept as it is, inside a paragraph's text (#104): a
 * field, a content control, a text box, a footnote's mark, another person's
 * tracked change… (see `WordAtomAttributes`). It can't be edited inside; it
 * moves with the text and goes when that text is deleted.
 */
export const WordAtom = Node.create<WordAtomOptions>({
  name: WORD_ATOM_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return atomAttributes();
  },

  parseHTML() {
    return [{ tag: `span[data-type="${WORD_ATOM_NODE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": WORD_ATOM_NODE }),
      wordAtomText(readWordAtom(node.attrs)),
    ];
  },

  renderText({ node }) {
    return wordAtomText(readWordAtom(node.attrs));
  },

  addNodeView() {
    return this.options.view;
  },
});

export interface WordBlockOptions {
  view: NodeViewRenderer | null;
}

/**
 * What a Word import kept as it is as a Block of its own (#104): a block
 * content control (a table of contents, a cover page), a nested table, a
 * paragraph inside a field over several, the header and the footer. Its
 * text is read for Questions; it can't be edited inside.
 */
export const WordBlock = Node.create<WordBlockOptions>({
  name: WORD_BLOCK_NODE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return atomAttributes();
  },

  parseHTML() {
    return [{ tag: `div[data-type="${WORD_BLOCK_NODE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": WORD_BLOCK_NODE }),
      wordAtomText(readWordAtom(node.attrs)),
    ];
  },

  renderText({ node }) {
    return wordAtomText(readWordAtom(node.attrs));
  },

  addNodeView() {
    return this.options.view;
  },
});

/**
 * A picture in the text, as Tiptap names it (`IMAGE_NODE`): an imported Word
 * file's inline pictures (#104), kept as `data:` URLs (the app's
 * Content-Security-Policy allows no other kind), with the size Word drew them
 * at and where the original is in the package. It can be moved and deleted.
 */
export const InlineImage = Node.create({
  name: IMAGE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    const number = (name: string) => ({
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = Number(element.getAttribute(name));
        return Number.isFinite(value) && value > 0 ? value : null;
      },
    });
    return {
      src: { default: null },
      alt: { default: null },
      width: number("width"),
      height: number("height"),
      source: dataAttribute("source", null),
    };
  },

  parseHTML() {
    return [{ tag: 'img[src^="data:image/"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, { class: "mind-image", draggable: "true" })];
  },

  renderText({ node }) {
    return typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  },
});

export const WORD_LOOK_TYPES = ["paragraph", "heading", "table", "tableCell", "tableHeader"];

/** Tiptap's table view keeps the attributes it was made with, so a look given while the Mind is open (the start-up backfill, a sync) makes a new one. */
export class WordLookTableView extends TableView {
  override update(node: ProseMirrorNode): boolean {
    if (node.attrs[WORD_LOOK_ATTRIBUTE] !== this.node.attrs[WORD_LOOK_ATTRIBUTE]) return false;
    return super.update(node);
  }
}
export const WORD_LOOK_DOM_ATTRIBUTE = "data-word-look";
export const WORD_RUN_DOM_ATTRIBUTE = "data-word-run";

function lookKeysOf(doc: Y.Doc | null): ReadonlySet<string> {
  const look = doc ? wordLookOf(doc) : null;
  if (!look) return new Set();
  return new Set(
    [look.paragraphs, look.runs, look.tables, look.cells].flatMap((styles) => Object.keys(styles)),
  );
}

/**
 * Keys name a look by its content, so a pasted key the Mind has is the same
 * look; one it doesn't have came from another file and is dropped.
 */
function withKnownLooks(fragment: Fragment, known: ReadonlySet<string>): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const marks = node.marks.filter(
      (mark) => mark.type.name !== WORD_RUN_MARK || known.has(String(mark.attrs.k)),
    );
    if (node.isText) {
      nodes.push(node.mark(marks));
      return;
    }
    const key = node.attrs[WORD_LOOK_ATTRIBUTE];
    const attrs =
      typeof key === "string" && !known.has(key)
        ? { ...node.attrs, [WORD_LOOK_ATTRIBUTE]: null }
        : node.attrs;
    nodes.push(node.type.create(attrs, withKnownLooks(node.content, known), marks));
  });
  return Fragment.fromArray(nodes);
}

/** `keepOnSplit`: Word gives a new paragraph the properties of the one before. */
export const WordLookAttribute = Extension.create({
  name: "wordLookAttribute",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          transformPasted: (slice) =>
            new Slice(
              withKnownLooks(slice.content, lookKeysOf(editorDoc(editor))),
              slice.openStart,
              slice.openEnd,
            ),
        },
      }),
    ];
  },

  addGlobalAttributes() {
    return [
      {
        types: WORD_LOOK_TYPES,
        attributes: {
          [WORD_LOOK_ATTRIBUTE]: {
            default: null,
            keepOnSplit: true,
            parseHTML: (element: HTMLElement) => element.getAttribute(WORD_LOOK_DOM_ATTRIBUTE),
            renderHTML: (attributes: Record<string, unknown>) => {
              const key = attributes[WORD_LOOK_ATTRIBUTE];
              return typeof key === "string" ? { [WORD_LOOK_DOM_ATTRIBUTE]: key } : {};
            },
          },
        },
      },
    ];
  },
});

/** Inclusive: text typed at a run's end takes its formatting, as in Word. */
export const WordRun = Mark.create({
  name: WORD_RUN_MARK,
  inclusive: true,

  addAttributes() {
    return {
      k: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(WORD_RUN_DOM_ATTRIBUTE),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.k === "string" ? { [WORD_RUN_DOM_ATTRIBUTE]: attributes.k } : {},
      },
    };
  },

  parseHTML: () => [{ tag: `span[${WORD_RUN_DOM_ATTRIBUTE}]` }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
});
