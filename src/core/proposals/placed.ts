/**
 * The last check on what a change writes into a Mind (#352, #2424): the Citations, footnotes
 * and figures it holds afterwards are the ones what wrote it placed, each told apart by all it
 * holds. An outside agent's change must leave exactly the nodes IncarnaMind placed for it
 * (`holdsOnlyPlaced`); Edit with AI's must leave every node that was there as it was, and add
 * none its reply didn't place (`unplacedSince`).
 */
import * as Y from "yjs";
import { readProposalAttribute } from "../../shared/proposals";
import {
  ANALYSIS_TABLE_NODE,
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  MISSING_NUMBER_NODE,
  PROPOSAL_ATTRIBUTE,
} from "../api";

type Attributes = Record<string, unknown>;

/** The nodes that cite or hold a note: only what writes a change places them. */
export const CITING: ReadonlySet<string> = new Set([
  CITATION_NODE,
  FOOTNOTE_NODE,
  CALCULATED_FIGURE_NODE,
  ANALYSIS_TABLE_NODE,
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

/**
 * The marks where a figure couldn't be calculated, and the calculated figures, in `root` as it
 * reads with `request`'s changes accepted and no other's (#2577).
 */
export function figurePlaces(
  root: Y.XmlFragment | Y.XmlElement,
  request: string,
): { marks: number; figures: number } {
  const found = { marks: 0, figures: 0 };
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const proposal = readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE));
      const othersToAdd = proposal?.kind === "insert" && proposal.request !== request;
      const takenOut = proposal?.kind === "delete" && proposal.request === request;
      if (othersToAdd || takenOut) continue;
      if (child.nodeName === MISSING_NUMBER_NODE) found.marks++;
      if (child.nodeName === CALCULATED_FIGURE_NODE) found.figures++;
      visit(child);
    }
  };
  visit(root);
  return found;
}

/**
 * Whether going from `before` to `now` takes out a mark where a figure couldn't be calculated with
 * no calculated figure in its place: only a figure that reaches the Note as a calculated figure
 * may take a mark's place, never digits in text (#2577).
 */
export const takesMissingNumber = (
  before: { marks: number; figures: number },
  now: { marks: number; figures: number },
): boolean => before.marks - now.marks > Math.max(0, now.figures - before.figures);

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

/** What a change wrote that it may not have, by node name and count: never any text. */
export interface Unplaced {
  /** Nodes that were there and are no longer as they were. */
  changed: Record<string, number>;
  /** Nodes it added beyond what was placed, outside a Proposal or as a node changed in place. */
  added: Record<string, number>;
}

const nameOf = (key: string): string => {
  const parsed: unknown = JSON.parse(key);
  return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : "node";
};

const count = (into: Record<string, number>, key: string, by: number) => {
  if (by > 0) into[nameOf(key)] = (into[nameOf(key)] ?? 0) + by;
};

/**
 * What `request` wrote since `before` that it may not have, or null when it left every citing
 * node that was there as it was, a change taking it out or not, and added none `placed` doesn't
 * hold, nor more often (#2424): Edit with AI's change, whose reply may cite again what the
 * passage cites.
 */
export function unplacedSince(
  before: CitingSplit,
  root: Y.XmlFragment | Y.XmlElement,
  request: string,
  placed: ReadonlyMap<string, number>,
): Unplaced | null {
  const now = splitCiting(root, request);
  const found: Unplaced = { changed: {}, added: {} };
  for (const key of new Set([...now.others.keys(), ...before.others.keys()])) {
    const was = before.others.get(key) ?? 0;
    const is = now.others.get(key) ?? 0;
    count(found.changed, key, was - is);
    count(found.added, key, is - was);
  }
  for (const [key, n] of now.added) {
    count(found.added, key, n - (before.added.get(key) ?? 0) - (placed.get(key) ?? 0));
  }
  const none = Object.keys(found.changed).length === 0 && Object.keys(found.added).length === 0;
  return none ? null : found;
}
