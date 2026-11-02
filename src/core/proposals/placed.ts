/**
 * The last check on what a change writes into a Mind (#352, #2424): the Citations, footnotes
 * and figures it holds afterwards are the ones what wrote it placed, each told apart by all it
 * holds. An outside agent's change must leave exactly the nodes IncarnaMind placed for it
 * (`holdsOnlyPlaced`); Edit with AI's must leave every node that was there as it was, and add
 * none its reply didn't place (`addsOnlyPlaced`).
 */
import * as Y from "yjs";
import { readProposalAttribute } from "../../shared/proposals";
import {
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
} from "../api";

type Attributes = Record<string, unknown>;

/** The nodes that cite or hold a note: only what writes a change places them. */
export const CITING: ReadonlySet<string> = new Set([
  CITATION_NODE,
  FOOTNOTE_NODE,
  CALCULATED_FIGURE_NODE,
]);

/** How many of each citing node, by `citingKey`. */
export type CitingNodes = Map<string, number>;

/**
 * A node by all it holds but its ids: its name, its other attributes (nulls left out, in order)
 * and each child's key or text. One changed in any of them is another node.
 */
export const nodeKey = (name: string, attributes: Attributes, children: readonly string[] = []) =>
  JSON.stringify([
    name,
    Object.entries(attributes)
      .filter(
        ([key, value]) =>
          key !== BLOCK_ID_ATTRIBUTE &&
          key !== PROPOSAL_ATTRIBUTE &&
          value !== null &&
          value !== undefined,
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ...children,
  ]);

export const citationKey = (attributes: Attributes): string => nodeKey(CITATION_NODE, attributes);

/** A citing node by all it holds (`nodeKey`), its children's own included. */
export function citingKey(element: Y.XmlElement): string {
  const children = element
    .toArray()
    .map((child) => (child instanceof Y.XmlElement ? citingKey(child) : child.toString()));
  return nodeKey(element.nodeName, element.getAttributes(), children);
}

export function tally(counts: CitingNodes, key: string, by: number): void {
  const total = (counts.get(key) ?? 0) + by;
  if (total === 0) counts.delete(key);
  else counts.set(key, total);
}

/**
 * Adds to `counts` (or, with `by` -1, takes away) the citing nodes in `root` as it reads with
 * `request`'s changes accepted and no other's.
 */
export function tallyCiting(
  counts: CitingNodes,
  root: Y.XmlFragment | Y.XmlElement,
  request: string,
  by = 1,
): CitingNodes {
  for (const child of root.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
    const othersToAdd = proposal?.kind === "insert" && proposal.request !== request;
    const takenOut = proposal?.kind === "delete" && proposal.request === request;
    if (othersToAdd || takenOut) continue;
    if (CITING.has(child.nodeName)) tally(counts, citingKey(child), by);
    tallyCiting(counts, child, request, by);
  }
  return counts;
}

const same = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([key, n]) => b.get(key) === n);

/**
 * Whether the Mind, with `request`'s changes accepted, holds exactly the citing nodes
 * IncarnaMind placed (#352): an outside agent's change, whatever the readings before it made of
 * the agent's text.
 */
export function holdsOnlyPlaced(
  blocks: Y.XmlFragment,
  request: string,
  placed: ReadonlyMap<string, number>,
): boolean {
  return same(tallyCiting(new Map(), blocks, request), placed);
}

/**
 * The citing nodes in `root`: those `request` adds, alone or in a Block it adds, and every
 * other, whether a change takes it out or not.
 */
export interface CitingSplit {
  added: CitingNodes;
  others: CitingNodes;
}

export function splitCiting(root: Y.XmlFragment | Y.XmlElement, request: string): CitingSplit {
  const split: CitingSplit = { added: new Map(), others: new Map() };
  const visit = (node: Y.XmlFragment | Y.XmlElement, inAdded: boolean) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
      const added = inAdded || (proposal?.kind === "insert" && proposal.request === request);
      if (CITING.has(child.nodeName)) {
        tally(added ? split.added : split.others, citingKey(child), 1);
      }
      visit(child, added);
    }
  };
  visit(root, false);
  return split;
}

/**
 * Whether what `request` wrote since `before` leaves every citing node that was there as it
 * was, a change taking it out or not, and adds none `placed` doesn't hold, nor more often (#2424):
 * Edit with AI's change, whose reply may cite again what the passage cites.
 */
export function addsOnlyPlaced(
  before: CitingSplit,
  root: Y.XmlFragment | Y.XmlElement,
  request: string,
  placed: ReadonlyMap<string, number>,
): boolean {
  const now = splitCiting(root, request);
  if (!same(now.others, before.others)) return false;
  return [...now.added].every(
    ([key, n]) => n - (before.added.get(key) ?? 0) <= (placed.get(key) ?? 0),
  );
}
