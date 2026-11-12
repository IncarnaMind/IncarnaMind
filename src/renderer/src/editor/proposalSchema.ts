import { Extension, Mark } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import {
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  WORD_CHANGE_ID,
} from "../../../core/api";
import { ySyncOf } from "../../../shared/markKeys";
import { readProposalAttribute, readProposalRef } from "../../../shared/proposals";

/**
 * The node types that can carry a `proposal` attribute: Blocks a Proposal
 * adds or removes whole, and the inline nodes it adds or removes in a text
 * (see `PROPOSAL_ATTRIBUTE`).
 */
export const PROPOSAL_NODE_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "blockMath",
  "horizontalRule",
  "table",
  "chart",
  "comparisonTable",
  "citation",
  "footnote",
  "inlineMath",
  "hardBreak",
] as const;

/**
 * The Proposal a mark belongs to, and the text it changes (`ProposalRef`):
 * kept in the Mind, never read from pasted HTML.
 */
const refAttributes = () => ({
  id: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
  request: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
  target: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
});

/** A change's class, and `proposal-theirs` for someone's from a Word file (#108): their words aren't AI text. */
const changeClass = (kind: string, id: string | undefined) =>
  id?.startsWith(WORD_CHANGE_ID) ? `${kind} proposal-theirs` : kind;

/**
 * Words a Proposal adds, drawn as an insertion: underlined, in the Answer's
 * ink. Not inclusive, so what the User types beside it is their own.
 */
export const ProposalInsert = Mark.create({
  name: PROPOSAL_INSERT_MARK,
  inclusive: false,
  excludes: `${PROPOSAL_INSERT_MARK} ${PROPOSAL_DELETE_MARK}`,
  addAttributes: refAttributes,
  // A copied Proposal pastes as plain text: a Proposal waits only where the AI made it.
  parseHTML: () => [],
  renderHTML({ mark }) {
    const ref = readProposalRef(mark.attrs);
    return [
      "ins",
      { class: changeClass("proposal-insert", ref?.id), "data-proposal-id": ref?.id ?? "" },
      0,
    ];
  },
  // Each change under a key of its own in the editor's Yjs sync (patches/y-tiptap/marks.mjs, #2996).
  extendMarkSchema: (extension) =>
    extension.name === PROPOSAL_INSERT_MARK ? ySyncOf(PROPOSAL_INSERT_MARK) : {},
});

/** Words a Proposal removes, kept until it is resolved, drawn struck. */
export const ProposalDelete = Mark.create({
  name: PROPOSAL_DELETE_MARK,
  inclusive: false,
  excludes: `${PROPOSAL_INSERT_MARK} ${PROPOSAL_DELETE_MARK}`,
  addAttributes: refAttributes,
  parseHTML: () => [],
  renderHTML({ mark }) {
    const ref = readProposalRef(mark.attrs);
    return [
      "del",
      { class: changeClass("proposal-delete", ref?.id), "data-proposal-id": ref?.id ?? "" },
      0,
    ];
  },
  extendMarkSchema: (extension) =>
    extension.name === PROPOSAL_DELETE_MARK ? ySyncOf(PROPOSAL_DELETE_MARK) : {},
});

/** Blocks that hold others: a Block the User adds inside one keeps it as it is. */
const HOLDERS: ReadonlySet<string> = new Set([
  "listItem",
  "bulletList",
  "orderedList",
  "blockquote",
]);

/** A Block with no text: an empty paragraph or heading, or a list item or quote of only those. */
const blank = (node: ProseMirrorNode): boolean =>
  node.isTextblock
    ? node.content.size === 0
    : HOLDERS.has(node.type.name) &&
      node.childCount > 0 &&
      Array.from({ length: node.childCount }, (_, index) => node.child(index)).every(blank);

/** The User's own edit, not a change that came from the Mind's document. */
const typedHere = (tr: Transaction) => tr.docChanged && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin;

/** The `proposal` attribute of whole Blocks and inline nodes a Proposal adds or removes. */
export const ProposalAttributes = Extension.create({
  name: "proposalAttributes",

  addGlobalAttributes() {
    return [
      {
        types: [...PROPOSAL_NODE_TYPES],
        attributes: {
          [PROPOSAL_ATTRIBUTE]: {
            default: null,
            parseHTML: () => null,
            renderHTML: (attributes: Record<string, unknown>) => {
              const value = readProposalAttribute(attributes[PROPOSAL_ATTRIBUTE]);
              return value ? { "data-proposal": value.kind, "data-proposal-id": value.id } : {};
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("proposalBlocksTyped"),
        // Enter at the end of a Block the assistant proposes makes an empty one that would carry
        // its Proposal: it is the User's, as words typed beside a Proposal are (#202).
        appendTransaction(transactions, _before, state) {
          if (!transactions.some(typedHere)) return null;
          let tr: Transaction | null = null;
          state.doc.descendants((node, pos) => {
            if (!node.isBlock) return false;
            if (readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind !== "insert")
              return true;
            if (!blank(node)) return true;
            tr = (tr ?? state.tr).setNodeAttribute(pos, PROPOSAL_ATTRIBUTE, null);
            return false;
          });
          return tr;
        },
      }),
    ];
  },
});
