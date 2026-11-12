/**
 * The last check on what a change writes into a Mind (#352, #2424): the Citations, footnotes
 * and figures it holds afterwards are the ones what wrote it placed, each told apart by all it
 * holds. An outside agent's change must leave exactly the nodes IncarnaMind placed for it
 * (`holdsOnlyPlaced`); Edit with AI's must leave every node that was there as it was, and add
 * none its reply didn't place (`unplacedSince`).
 */
import * as Y from "yjs";
import { readProposalAttribute, readProposalRef } from "../../shared/proposals";
import {
  ANALYSIS_TABLE_NODE,
  BLOCK_ID_ATTRIBUTE,
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  FOOTNOTE_NODE,
  MISSING_NUMBER_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../api";
import { diffSteps, hunksOf, splitWords } from "./diff";

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

/** A paragraph's words, its marks where a figure couldn't be calculated and its calculated figures, in order. */
export type PlaceKeys = readonly string[];

const MARK_KEY = "\u0000mark";
const FIGURE_KEY = "\u0000figure:";

/** A paragraph's keys from its words and nodes: a mark, a calculated figure by its id, else its words. */
export function placeKeysOf(
  parts: readonly ({ text: string } | { node: string; id?: unknown })[],
): string[] {
  return parts.flatMap((part) =>
    "text" in part
      ? splitWords(part.text)
      : part.node === MISSING_NUMBER_NODE
        ? [MARK_KEY]
        : part.node === CALCULATED_FIGURE_NODE
          ? [`${FIGURE_KEY}${String(part.id ?? "")}`]
          : [],
  );
}

/**
 * The paragraphs in `root` as they read with `request`'s changes accepted and no other's, as
 * `takesMissingNumber` compares them (#2577); with `request` null, as they hold, changes and all.
 */
export function paragraphPlaces(
  root: Y.XmlFragment | Y.XmlElement,
  request: string | null,
): PlaceKeys[] {
  const paragraphs: PlaceKeys[] = [];
  const ours = (value: unknown) => request === null || readProposalRef(value)?.request === request;
  const skipped = (proposal: ReturnType<typeof readProposalAttribute>) =>
    request !== null &&
    ((proposal?.kind === "insert" && proposal.request !== request) ||
      (proposal?.kind === "delete" && proposal.request === request));
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    const children = node.toArray();
    if (children.some((child) => child instanceof Y.XmlText)) {
      const parts: ({ text: string } | { node: string; id?: unknown })[] = [];
      for (const child of children) {
        if (child instanceof Y.XmlText) {
          for (const run of child.toDelta() as { insert: unknown; attributes?: Attributes }[]) {
            const added = run.attributes?.[PROPOSAL_INSERT_MARK];
            const removed = run.attributes?.[PROPOSAL_DELETE_MARK];
            if (request !== null && removed !== undefined && ours(removed)) continue;
            if (added !== undefined && !ours(added)) continue;
            if (typeof run.insert === "string") parts.push({ text: run.insert });
          }
        } else if (child instanceof Y.XmlElement) {
          if (skipped(readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE)))) continue;
          parts.push({ node: child.nodeName, id: child.getAttribute(BLOCK_ID_ATTRIBUTE) });
        }
      }
      paragraphs.push(placeKeysOf(parts));
      return;
    }
    for (const child of children) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (skipped(readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE)))) continue;
      visit(child);
    }
  };
  visit(root);
  return paragraphs;
}

/** Whether any of the paragraphs holds the mark where a figure couldn't be calculated. */
export const holdsMissingNumber = (paragraphs: readonly PlaceKeys[]): boolean =>
  paragraphs.some((paragraph) => paragraph.includes(MARK_KEY));

/** How many words two paragraphs share, each counted as often as both have it. */
function shared(one: PlaceKeys, other: PlaceKeys): number {
  const left = new Map<string, number>();
  for (const key of one) left.set(key, (left.get(key) ?? 0) + 1);
  let count = 0;
  for (const key of other) {
    const n = left.get(key) ?? 0;
    if (n > 0 && key.trim() !== "") {
      count++;
      left.set(key, n - 1);
    }
  }
  return count;
}

/**
 * Whether going from the paragraphs `before` to `after` takes out a mark where a figure couldn't
 * be calculated with no calculated figure in its place (#2577). Each paragraph that held a mark is
 * compared word by word with the paragraph it is most like now: a mark a changed place takes out is
 * replaced only by a calculated figure new in that same place, never by digits; a mark the
 * paragraph gained in another place (its sentence moved) keeps it. What it can't tell: a mark's
 * place in a paragraph rewritten past knowing, or split in two, which is compared with the one
 * part most like it; and a sentence the User asked to take out from one that dropped its mark, so
 * a change that takes out the whole sentence holding a mark is refused too.
 */
export function takesMissingNumber(
  before: readonly PlaceKeys[],
  after: readonly PlaceKeys[],
): boolean {
  const figuresBefore = new Set(before.flat().filter((key) => key.startsWith(FIGURE_KEY)));
  const isNewFigure = (key: string) => key.startsWith(FIGURE_KEY) && !figuresBefore.has(key);
  return before.some((old) => {
    if (!old.includes(MARK_KEY)) return false;
    let now: PlaceKeys = [];
    let most = -1;
    for (const candidate of after) {
      const count = shared(old, candidate);
      if (count > most) {
        most = count;
        now = candidate;
      }
    }
    let uncovered = 0;
    let elsewhere = 0;
    for (const hunk of hunksOf(diffSteps(old, now), () => false)) {
      const out = old.slice(hunk.oldFrom, hunk.oldTo).filter((key) => key === MARK_KEY).length;
      const added = now.slice(hunk.newFrom, hunk.newTo);
      const marks = added.filter((key) => key === MARK_KEY).length;
      const figures = added.filter(isNewFigure).length;
      uncovered += Math.max(0, out - marks - figures);
      elsewhere += Math.max(0, marks - out);
    }
    return uncovered > elsewhere;
  });
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
