/**
 * Changes the User asked the assistant for (#880), applied once they
 * have all arrived as Proposals in the Mind. The core wrote them before this
 * window could take them in as its own change, as it does for Edit with AI, so
 * they are first set aside and then written again as the editor's change: one
 * step of its Undo takes the whole turn back, whenever its tab opened.
 */
import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  absolutePositionToRelativePosition,
  updateYFragment,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type ProposalRef,
} from "../../../core/api";
import { copyOrigins } from "../../../shared/blockOrigins";
import {
  pendingProposals,
  type ResolvedProposal,
  readProposalAttribute,
  resolveProposals,
} from "../../../shared/proposals";
import type { ChangePlace } from "./appliedEditLine";
import {
  type BlockPlace,
  type PendingProposal,
  placeOnAccept,
  positionOf,
  proposalsIn,
  rewrittenParagraphOf,
} from "./proposalReview";
import { blockAt } from "./writingPlace";

const isProposalMark = (name: string) =>
  name === PROPOSAL_INSERT_MARK || name === PROPOSAL_DELETE_MARK;

export const proposalKindOf = (node: ProseMirrorNode): "insert" | "delete" | null => {
  if (node.marks.some((mark) => mark.type.name === PROPOSAL_DELETE_MARK)) return "delete";
  if (node.marks.some((mark) => mark.type.name === PROPOSAL_INSERT_MARK)) return "insert";
  return readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE])?.kind ?? null;
};

/** A node as it was before a change took it out: none of the change's marks or attribute. */
export function asItWas(node: ProseMirrorNode): ProseMirrorNode {
  const marks = node.marks.filter((mark) => !isProposalMark(mark.type.name));
  if (node.isText) return node.mark(marks);
  const attrs =
    PROPOSAL_ATTRIBUTE in node.attrs ? { ...node.attrs, [PROPOSAL_ATTRIBUTE]: null } : node.attrs;
  return node.type.create(attrs, node.content, marks);
}

/** A Block by its id, or by that of the first Block in it and how far up from that it is: a list item has none. */
interface BlockAnchor {
  blockId: string;
  up: number;
}

interface Beside {
  block: BlockAnchor;
  side: "before" | "after";
}

// By Block and place in its text, which hold through the rewrite, as positions don't.
type Planned =
  | { kind: "added"; block: BlockAnchor }
  | {
      kind: "removed";
      removed: Fragment;
      /** Null at the Mind's end. */
      beside: Beside | null;
    }
  | {
      kind: "words";
      from: BlockPlace;
      to: BlockPlace;
      removed: Fragment;
      /** The paragraph it writes anew, by Block id. */
      paragraph: string | null;
    };

const idOf = (node: ProseMirrorNode | null | undefined): string | null => {
  const id: unknown = node?.attrs[BLOCK_ID_ATTRIBUTE];
  return typeof id === "string" ? id : null;
};

function textPlaceAt(
  doc: ProseMirrorNode,
  pos: number,
): { blockId: string; offset: number } | null {
  const $pos = doc.resolve(pos);
  const block = $pos.parent;
  const blockId = idOf(block);
  return block.isTextblock && blockId !== null ? { blockId, offset: $pos.parentOffset } : null;
}

export function anchorOf(node: ProseMirrorNode | null): BlockAnchor | null {
  let up = 0;
  for (let at = node; at; at = at.firstChild, up++) {
    const blockId = idOf(at);
    if (blockId !== null) return { blockId, up };
    if (at.isTextblock) return null;
  }
  return null;
}

function blockOf(
  doc: ProseMirrorNode,
  { blockId, up }: BlockAnchor,
): { pos: number; node: ProseMirrorNode } | null {
  const found = blockAt(doc, blockId);
  if (!found || up === 0) return found;
  const $pos = doc.resolve(found.pos);
  const depth = $pos.depth - up + 1;
  return depth >= 1 ? { pos: $pos.before(depth), node: $pos.node(depth) } : null;
}

function besidePlace(doc: ProseMirrorNode, { block, side }: Beside): number | null {
  const found = blockOf(doc, block);
  if (!found) return null;
  return side === "before" ? found.pos : found.pos + found.node.nodeSize;
}

/** Undefined: nothing beside it stays. */
function besideStaying(
  doc: ProseMirrorNode,
  pos: number,
  picked: ReadonlySet<string>,
  accepted?: ReadonlySet<string>,
): Beside | null | undefined {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const stays = (node: ProseMirrorNode) => {
    const proposal = readProposalAttribute(node.attrs[PROPOSAL_ATTRIBUTE]);
    return !(
      proposal?.kind === "delete" &&
      picked.has(proposal.request) &&
      (!accepted || accepted.has(proposal.id))
    );
  };
  const beside = (at: number, side: Beside["side"]) => {
    const block = anchorOf(parent.child(at));
    return block ? { block, side } : undefined;
  };
  for (let at = $pos.index() + 1; at < parent.childCount; at++) {
    if (stays(parent.child(at))) return beside(at, "before");
  }
  if ($pos.depth === 0) return null;
  for (let at = $pos.index() - 1; at >= 0; at--) {
    if (stays(parent.child(at))) return beside(at, "after");
  }
  return undefined;
}

/** The requests' changes, read before they are applied, as `anchorChanges` places them after. */
export function planChanges(
  state: EditorState | ProseMirrorNode,
  requests: ReadonlySet<string>,
  accepted?: ReadonlySet<string>,
): Planned[] {
  const doc = "doc" in state ? state.doc : state;
  return proposalsIn(doc)
    .filter(
      (proposal) => requests.has(proposal.request) && (!accepted || accepted.has(proposal.id)),
    )
    .flatMap((proposal: PendingProposal): Planned[] => {
      if (proposal.block === "insert") {
        const block = anchorOf(doc.nodeAt(proposal.from));
        return block ? [{ kind: "added", block }] : [];
      }
      if (proposal.block === "delete") {
        const node = doc.nodeAt(proposal.from);
        const beside = besideStaying(doc, proposal.from, requests, accepted);
        if (beside === undefined) {
          console.warn(
            `Review changes can't place Block ${proposal.id} of request ${proposal.request}, taken out with everything beside it: it won't show there.`,
          );
          return [];
        }
        return [
          {
            kind: "removed",
            removed: node ? Fragment.from(asItWas(node)) : Fragment.empty,
            beside,
          },
        ];
      }
      const removed: ProseMirrorNode[] = [];
      const added = { from: -1, to: -1 };
      let end = proposal.from;
      for (const range of proposal.ranges) {
        doc.nodesBetween(range.from, range.to, (node, pos) => {
          if (node.isBlock) return true;
          const from = Math.max(pos, range.from);
          const to = Math.min(pos + node.nodeSize, range.to);
          const kind = proposalKindOf(node);
          if (kind === "delete") {
            removed.push(asItWas(node.isText ? node.cut(from - pos, to - pos) : node));
            end = to;
          } else if (kind === "insert") {
            if (added.from < 0) added.from = from;
            added.to = to;
          }
          return false;
        });
      }
      const words = added.from < 0 ? { from: end, to: end } : added;
      const from = textPlaceAt(doc, words.from);
      const to = textPlaceAt(doc, words.to);
      const fromPlace = from && placeOnAccept(doc, from, accepted);
      const toPlace = to && placeOnAccept(doc, to, accepted);
      return fromPlace && toPlace
        ? [
            {
              kind: "words",
              from: fromPlace,
              to: toPlace,
              removed: Fragment.from(removed),
              paragraph: rewrittenParagraphOf(doc, proposal),
            },
          ]
        : [];
    });
}

/** The planned changes as `appliedEditLine` keeps them, once applied, for Review changes. */
export function anchorChanges(state: EditorState, planned: readonly Planned[]): ChangePlace[] {
  const binding = ySyncPluginKey.getState(state)?.binding;
  if (!binding) return [];
  const relative = (pos: number): unknown =>
    absolutePositionToRelativePosition(pos, binding.type, binding.mapping);
  const { doc } = state;
  return planned.flatMap((change): ChangePlace[] => {
    if (change.kind === "added") {
      const found = blockOf(doc, change.block);
      if (!found) return [];
      // Inside the new Block's end: at the Mind's end, the end itself would take in what comes after it.
      return [
        {
          from: relative(found.pos),
          to: relative(found.pos + found.node.nodeSize - 1),
          removed: Fragment.empty,
          block: "added",
        },
      ];
    }
    if (change.kind === "removed") {
      const at = change.beside === null ? doc.content.size : besidePlace(doc, change.beside);
      if (at === null) return [];
      return [{ from: relative(at), to: relative(at), removed: change.removed, block: "removed" }];
    }
    const from = positionOf(doc, change.from);
    const to = positionOf(doc, change.to);
    if (from === null || to === null) return [];
    return [
      {
        from: relative(from),
        to: relative(to),
        removed: change.removed,
        block: null,
        ...(change.paragraph && { paragraph: change.paragraph }),
      },
    ];
  });
}

const blockIdOf = (node: Y.XmlElement | Y.XmlText | Y.XmlHook | undefined): string | null => {
  const id = node instanceof Y.XmlElement ? node.getAttribute(BLOCK_ID_ATTRIBUTE) : undefined;
  return typeof id === "string" ? id : null;
};

// Only the Blocks that differ are written again: the rest keep what is anchored in them.
function writeAs(doc: Y.Doc, blocks: Y.XmlFragment, wanted: Y.XmlFragment, schema: Schema): void {
  const content = yXmlFragmentToProseMirrorRootNode(wanted, schema);
  const target = wanted
    .toArray()
    .filter((node): node is Y.XmlElement | Y.XmlText => !(node instanceof Y.XmlHook));
  const targetIds = new Set(target.map(blockIdOf).filter((id): id is string => id !== null));
  const goes = (node: Y.XmlElement | Y.XmlText | Y.XmlHook | undefined) => {
    const id = blockIdOf(node);
    return id !== null && !targetIds.has(id);
  };
  let index = 0;
  for (const want of target) {
    while (goes(blocks.get(index))) blocks.delete(index, 1);
    const here = blocks.get(index);
    if (!here || blockIdOf(here) !== blockIdOf(want)) {
      blocks.insert(index, [want.clone()]);
    } else if (here.toString() !== want.toString()) {
      if (
        here instanceof Y.XmlElement &&
        want instanceof Y.XmlElement &&
        here.nodeName === want.nodeName
      ) {
        // Earlier reviews are anchored in these Yjs types; replacing a Block loses them.
        updateYFragment(doc, here, content.child(index), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      } else {
        blocks.delete(index, 1);
        blocks.insert(index, [want.clone()]);
      }
    }
    index += 1;
  }
  if (blocks.length > index) blocks.delete(index, blocks.length - index);
}

/**
 * Applies the requests' Proposals in `doc` as a change of the `tracked`
 * origin, so the Undo that tracks it takes them back: first they are set aside
 * (`aside`, which no Undo tracks), then the Mind is written as accepting them
 * makes it.
 */
export function writeAccepted(
  doc: Y.Doc,
  requests: ReadonlySet<string>,
  aside: unknown,
  tracked: unknown,
  schema: Schema,
): ResolvedProposal[] {
  const picked = (ref: ProposalRef) => requests.has(ref.request);
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const accepted = scratch.getXmlFragment(MIND_CONTENT_FIELD);
    let resolved: ResolvedProposal[] = [];
    scratch.transact(() => {
      resolved = resolveProposals(accepted, picked, "accept");
    });
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    doc.transact(() => {
      for (let depth = 0; depth < 100; depth++) {
        resolveProposals(blocks, picked, "reject");
        if (!pendingProposals(blocks).some(picked)) break;
      }
      if (pendingProposals(blocks).some(picked)) throw new Error("Too many revisions to set aside");
    }, aside);
    // Setting the changes aside gave the Blocks they were written over their earlier origins back;
    // accepted, those Blocks keep the change's.
    doc.transact(() => {
      writeAs(doc, blocks, accepted, schema);
      copyOrigins(scratch, doc);
    }, tracked);
    return resolved;
  } finally {
    scratch.destroy();
  }
}
