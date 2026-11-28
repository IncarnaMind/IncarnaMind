/**
 * Summarizes a request's pending Proposals in a Mind's Yjs Blocks before they are accepted
 * (#3839), so the core and every window show the same one-line summary (`changeFact`) and place
 * the inline applied-edit line on the same top-level Block.
 */
import * as Y from "yjs";
import {
  BLOCK_ID_ATTRIBUTE,
  type NamedChange,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type ProposalRef,
  type RemovedParagraphs,
} from "../core/api";
import { markValueOf } from "./markKeys";
import {
  addsOnly,
  changeKinds,
  countChanged,
  onlyRemoves,
  readProposalAttribute,
  readProposalRef,
  TEXT_BLOCKS,
} from "./proposals";
import { paragraphStart, paragraphsRemoved } from "./sentenceChanges";

export interface ProposalSummary {
  changed: number;
  added: number;
  tables: number;
  tablesRemoved?: true;
  removed?: RemovedParagraphs;
  named?: NamedChange;
  firstBlockId: string | null;
}

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

const blockIdOf = (node: unknown): string | null => {
  const id = node instanceof Y.XmlElement ? node.getAttribute(BLOCK_ID_ATTRIBUTE) : undefined;
  return typeof id === "string" ? id : null;
};

/**
 * Counts and names what the Proposals matching `belongs` do in `blocks`, read while those
 * Proposals are still pending.
 */
export function summarizeProposalChanges(
  blocks: Y.XmlFragment,
  belongs: (ref: ProposalRef) => boolean,
): ProposalSummary {
  const kinds = changeKinds(blocks, belongs);
  const removedTables = kinds.filter((kind) => kind === "table-removed").length;
  const tables = kinds.filter((kind) => kind === "table-added").length + removedTables;
  const total = countChanged(kinds);
  const added = addsOnly(kinds) ? total : 0;
  const changed = added > 0 ? 0 : total;
  const removesOnly = onlyRemoves(kinds) && tables === 0;

  const ours = (ref: ProposalRef | null) => ref !== null && belongs(ref);
  const removedTexts: string[] = [];
  const remainingTexts: string[] = [];
  let firstStayingBlockId: string | null = null;
  let firstRemovedTopIndex = -1;

  const topChildren = blocks.toArray();
  const topRemoved = new Set<number>();

  const visit = (
    parent: Y.XmlFragment | Y.XmlElement,
    whole: "insert" | "delete" | null,
    topIndex: number,
  ): boolean => {
    let anyTouched = false;
    const children = parent.toArray();
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!(child instanceof Y.XmlElement)) continue;
      const currentTop = parent === blocks ? index : topIndex;
      const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
      const own = whole ?? (ours(proposal) ? (proposal?.kind ?? null) : null);
      if (parent === blocks && own === "delete") {
        topRemoved.add(index);
        if (firstRemovedTopIndex < 0) firstRemovedTopIndex = index;
      }
      if (!TEXT_BLOCKS.has(child.nodeName)) {
        const insideTouched = visit(child, own, currentTop);
        if (own !== null || insideTouched) {
          anyTouched = true;
          if (parent === blocks && own !== "delete" && firstStayingBlockId === null) {
            firstStayingBlockId = blockIdOf(child);
          }
        }
        continue;
      }
      let was = "";
      let will = "";
      let touched = own !== null;
      for (const part of child.toArray()) {
        if (part instanceof Y.XmlText) {
          for (const run of part.toDelta() as Run[]) {
            if (typeof run.insert !== "string") continue;
            const adds = ours(readProposalRef(markValueOf(PROPOSAL_INSERT_MARK, run.attributes)));
            const removes = ours(
              readProposalRef(markValueOf(PROPOSAL_DELETE_MARK, run.attributes)),
            );
            touched ||= adds || removes;
            if (!adds) was += run.insert;
            if (!removes) will += run.insert;
          }
        } else if (
          part instanceof Y.XmlElement &&
          ours(readProposalAttribute(part.getAttribute(PROPOSAL_ATTRIBUTE)))
        ) {
          touched = true;
        }
      }
      if (!touched) continue;
      anyTouched = true;
      if (own === "delete") {
        if (was.trim() !== "") removedTexts.push(was);
      } else {
        if (will.trim() !== "") remainingTexts.push(will);
        if (firstStayingBlockId === null && currentTop >= 0 && !topRemoved.has(currentTop)) {
          firstStayingBlockId = blockIdOf(topChildren[currentTop]);
        }
      }
    }
    return anyTouched;
  };

  visit(blocks, null, -1);

  let firstBlockId: string | null = firstStayingBlockId;
  if (firstBlockId === null && firstRemovedTopIndex >= 0) {
    for (let index = firstRemovedTopIndex + 1; index < topChildren.length; index++) {
      if (topRemoved.has(index)) continue;
      const id = blockIdOf(topChildren[index]);
      if (id !== null) {
        firstBlockId = id;
        break;
      }
    }
  }

  const removed =
    removesOnly && removedTexts.length > 0 ? paragraphsRemoved(removedTexts) : undefined;
  let named: NamedChange | undefined;
  if (!removesOnly && tables === 0 && changed + added === 1 && remainingTexts.length === 1) {
    const start = paragraphStart(remainingTexts[0] ?? "");
    if (start !== "") named = { start, added: added === 1 };
  }

  return {
    changed,
    added,
    tables,
    ...(removedTables > 0 && { tablesRemoved: true as const }),
    ...(removed && { removed }),
    ...(named && { named }),
    firstBlockId,
  };
}
