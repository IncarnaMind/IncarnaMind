/**
 * The assistant's own changes still waiting in a Mind: Blocks an
 * Answer in the assistant added whole (`add_to_mind`, `create_mind`, a Mind
 * made from an Answer), which the User hasn't accepted or rejected, nor typed
 * in. Asked to change that text again ("make it longer", "remove the part
 * about…"), the assistant revises those same waiting Blocks: they are
 * replaced by its new text, still waiting, so the Mind holds one version, not
 * two. Nothing of the User's text is touched, since none is in them.
 */
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { INLINE_CODE_MARK } from "../../shared/aiText";
import { askedFor } from "../../shared/askedChanges";
import { originOf } from "../../shared/blockOrigins";
import { readChart } from "../../shared/charts";
import {
  keepRevised,
  proposalRequestOf,
  readProposalAttribute,
  readProposalRef,
  resolveProposals,
  waitingChanges,
} from "../../shared/proposals";
import { createElement, type NodeJSON, topLevelBlocks } from "../answers/blocks";
import {
  BLOCK_ID_ATTRIBUTE,
  CHART_NODE,
  CITATION_NODE,
  GENERATED_MARK,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
  type TextPlace,
} from "../api";
import { citationsIn, proposeOver, setProposal, textBlocks } from "./write";

/** The assistant's own waiting Blocks a stretch is in, from the first's top-level Block to the last's. */
export interface OwnWaiting {
  kind: "own";
  blockIds: string[];
  /** The Proposals to accept in a copy before their text is rewritten. */
  requests: string[];
  /** What they hold as read, to tell whether they changed since. */
  fingerprint: string;
}

/**
 * What waits in a stretch of a Mind: nothing; only the assistant's own
 * waiting Blocks (`OwnWaiting`); some of those beside the User's text
 * ("mixed"); or changes the assistant can't revise ("other"). `count`: the
 * changes waiting in the whole Mind, as the User is told.
 */
export type WaitingIn = { kind: "none" } | OwnWaiting | { kind: "mixed" | "other"; count: number };

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

const idOf = (element: Y.XmlElement): string => {
  const id = element.getAttribute(BLOCK_ID_ATTRIBUTE);
  return typeof id === "string" ? id : "";
};

function topOf(element: Y.XmlElement): Y.XmlElement {
  let at = element;
  while (at.parent instanceof Y.XmlElement) at = at.parent;
  return at;
}

function holdsProposal(nodes: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): boolean {
  return nodes.some((node) => {
    if (node instanceof Y.XmlText) {
      return (node.toDelta() as Run[]).some(
        (run) =>
          !!run.attributes &&
          (PROPOSAL_INSERT_MARK in run.attributes || PROPOSAL_DELETE_MARK in run.attributes),
      );
    }
    if (!(node instanceof Y.XmlElement)) return false;
    return node.getAttribute(PROPOSAL_ATTRIBUTE) !== undefined || holdsProposal(node.toArray());
  });
}

function requestsIn(nodes: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): string[] {
  const requests = new Set<string>();
  const visit = (nodes: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]) => {
    for (const node of nodes) {
      if (node instanceof Y.XmlText) {
        for (const run of node.toDelta() as Run[]) {
          const insert = readProposalRef(run.attributes?.[PROPOSAL_INSERT_MARK]);
          const removed = readProposalRef(run.attributes?.[PROPOSAL_DELETE_MARK]);
          if (insert) requests.add(insert.request);
          if (removed) requests.add(removed.request);
        }
      } else if (node instanceof Y.XmlElement) {
        const proposal = readProposalAttribute(node.getAttribute(PROPOSAL_ATTRIBUTE));
        if (proposal) requests.add(proposal.request);
        visit(node.toArray());
      }
    }
  };
  visit(nodes);
  return [...requests];
}

const WRITTEN_ATOMS: ReadonlySet<string> = new Set([
  CITATION_NODE,
  "hardBreak",
  "paragraph",
  "heading",
]);
// A formula, picture, chart or code block carries no mark in the Mind, so one among the
// assistant's text already there may be the User's: only Citations, line breaks and empty
// paragraphs are its own.
const writtenAtom = (atom: Y.XmlElement): boolean => WRITTEN_ATOMS.has(atom.nodeName);

function allAiText(
  element: Y.XmlElement,
  ownAtom: (atom: Y.XmlElement) => boolean = () => true,
): boolean {
  // A code block's text can't carry the mark.
  if (element.nodeName === "codeBlock" || element.length === 0) return ownAtom(element);
  return element.toArray().every((node) => {
    if (node instanceof Y.XmlElement) return allAiText(node, ownAtom);
    if (!(node instanceof Y.XmlText)) return true;
    return (node.toDelta() as Run[]).every(
      (run) =>
        typeof run.insert !== "string" ||
        run.insert === "" ||
        (!!run.attributes &&
          (GENERATED_MARK in run.attributes || INLINE_CODE_MARK in run.attributes)),
    );
  });
}

function isOwn(element: Y.XmlElement): boolean {
  const attribute = readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE));
  const doc = element.doc;
  return (
    attribute?.kind === "insert" &&
    !!doc &&
    proposalRequestOf(doc, attribute.request)?.source === "answer-added" &&
    !holdsProposal(element.toArray()) &&
    allAiText(element)
  );
}

function elementText(element: Y.XmlElement): string {
  return element
    .toArray()
    .map((node) =>
      node instanceof Y.XmlText
        ? (node.toDelta() as Run[])
            .map((run) => (typeof run.insert === "string" ? run.insert : ""))
            .join("")
        : node instanceof Y.XmlElement
          ? elementText(node)
          : "",
    )
    .join(" ");
}

/**
 * The text of each of the assistant's own waiting Blocks but its headings and
 * those of request `except`, with the heading it sits under (null: none).
 */
export function ownWaitingTexts(
  blocks: Y.XmlFragment,
  except: string | null,
): { heading: string | null; text: string }[] {
  let heading: string | null = null;
  return topLevelBlocks(blocks).flatMap((element) => {
    if (element.nodeName === "heading") {
      heading = elementText(element);
      return [];
    }
    return isOwn(element) &&
      readProposalAttribute(element.getAttribute(PROPOSAL_ATTRIBUTE))?.request !== except
      ? [{ heading, text: elementText(element) }]
      : [];
  });
}

function rangeOf(blocks: Y.XmlFragment, from: TextPlace, to: TextPlace): Y.XmlElement[] {
  const texts = textBlocks(blocks).map((each) => each.element);
  const first = texts.find((element) => idOf(element) === from.blockId);
  const last = texts.find((element) => idOf(element) === to.blockId);
  if (!first || !last) return [];
  const top = topLevelBlocks(blocks);
  const start = top.indexOf(topOf(first));
  const end = top.indexOf(topOf(last));
  return start < 0 || end < start ? [] : top.slice(start, end + 1);
}

const fingerprintOf = (elements: readonly Y.XmlElement[]) =>
  elements.map((element) => element.toString()).join("\n");

export function waitingIn(
  blocks: Y.XmlFragment,
  from: TextPlace,
  to: TextPlace,
  inTurn: ReadonlySet<string> = new Set(),
): WaitingIn {
  const range = rangeOf(blocks, from, to);
  if (!holdsProposal(range)) return { kind: "none" };
  const count = waitingChanges(blocks);
  const requests = requestsIn(range);
  const own = range.filter(isOwn);
  const thisTurn = range
    .filter((element) => element.nodeName !== "heading")
    .every((element) => {
      const requests = requestsIn([element]);
      return requests.length > 0 && requests.every((request) => inTurn.has(request));
    });
  if (thisTurn || own.length === range.length) {
    return { kind: "own", blockIds: range.map(idOf), requests, fingerprint: fingerprintOf(range) };
  }
  const others = range.filter((element) => !own.includes(element));
  return { kind: own.length > 0 && !holdsProposal(others) ? "mixed" : "other", count };
}

/** The Blocks of `own` in the Mind now, in order; null once they have changed. */
function blocksOf(
  blocks: Y.XmlFragment,
  own: Pick<OwnWaiting, "blockIds" | "fingerprint">,
): Y.XmlElement[] | null {
  const top = topLevelBlocks(blocks);
  const start = top.findIndex((element) => idOf(element) === own.blockIds[0]);
  if (start < 0) return null;
  const range = top.slice(start, start + own.blockIds.length);
  const same =
    range.length === own.blockIds.length &&
    range.every((element, index) => idOf(element) === own.blockIds[index]) &&
    fingerprintOf(range) === own.fingerprint;
  return same ? range : null;
}

/**
 * Accepts the Proposals of `own`'s Blocks in a copy of the Mind, so its text
 * reads as the User would see it once accepted: what a revision rewrites.
 * Call it in a Yjs transaction.
 */
export function acceptOwnIn(blocks: Y.XmlFragment, own: OwnWaiting): void {
  if (!blocksOf(blocks, own)) return;
  const requests = new Set(own.requests);
  resolveProposals(blocks, (proposal) => requests.has(proposal.request), "accept");
}

/**
 * Where `own`'s Blocks are in a copy of the Mind: how many top-level Blocks
 * come before them and after them, which a revision there leaves as they are.
 */
export function boundsOf(
  blocks: Y.XmlFragment,
  own: OwnWaiting,
): { before: number; after: number } | null {
  const top = topLevelBlocks(blocks);
  const start = top.findIndex((element) => idOf(element) === own.blockIds[0]);
  const end = top.findIndex((element) => idOf(element) === own.blockIds.at(-1));
  return start < 0 || end < start ? null : { before: start, after: top.length - end - 1 };
}

/** The text of each of the assistant's own Blocks already in the Mind, accepted or added with Add to note, but its headings. */
export function ownAppliedTexts(blocks: Y.XmlFragment): string[] {
  return topLevelBlocks(blocks).flatMap((element) =>
    element.nodeName !== "heading" &&
    element.getAttribute(PROPOSAL_ATTRIBUTE) === undefined &&
    !holdsProposal(element.toArray()) &&
    allAiText(element)
      ? [elementText(element)]
      : [],
  );
}

/**
 * The assistant's own text already in the Mind, accepted or added with Add to note: whole
 * top-level Blocks of AI text over a stretch, with nothing waiting in them (#1061).
 */
export interface OwnApplied {
  kind: "applied";
  blockIds: string[];
  fingerprint: string;
}

export function ownAppliedIn(
  blocks: Y.XmlFragment,
  from: TextPlace,
  to: TextPlace,
): OwnApplied | null {
  const range = rangeOf(blocks, from, to);
  if (
    range.length === 0 ||
    holdsProposal(range) ||
    !range.every((element) => allAiText(element, writtenAtom))
  ) {
    return null;
  }
  return { kind: "applied", blockIds: range.map(idOf), fingerprint: fingerprintOf(range) };
}

/**
 * The top-level Blocks the Answer `answerId` wrote into a Mind, by their origin, to write again
 * whole (#1149), and, `heading`, the untitled heading above them; null for none. `edited`: the
 * User has typed in them since.
 */
export function writtenByAnswer(
  blocks: Y.XmlFragment,
  answerId: string,
  { heading = false }: { heading?: boolean } = {},
): { applied: OwnApplied; edited: boolean } | null {
  const doc = blocks.doc;
  if (!doc) return null;
  const top = topLevelBlocks(blocks);
  const fromAnswer = (element: Y.XmlElement) => {
    const from = originOf(doc, idOf(element))?.from;
    return from?.anchor.kind === "message" && from.anchor.messageId === answerId;
  };
  const range = top.filter(fromAnswer);
  const [first] = top;
  if (range.length === 0) return null;
  if (heading && first && first.nodeName === "heading" && !fromAnswer(first)) range.unshift(first);
  const ids = new Set(range.map(idOf));
  // A chart carries no mark, but one drawn from the Answer's own table there is the Answer's:
  // written again, it is drawn again from the new table (#1091).
  const drawnHere = (element: Y.XmlElement) => {
    if (element.nodeName !== CHART_NODE) return false;
    const { source } = readChart(element.getAttributes());
    return source.kind === "table" && source.blockId !== null && ids.has(source.blockId);
  };
  return {
    applied: { kind: "applied", blockIds: [...ids], fingerprint: fingerprintOf(range) },
    edited: !range.every(
      (element) => !fromAnswer(element) || drawnHere(element) || allAiText(element, writtenAtom),
    ),
  };
}

/**
 * Proposes `revised` in place of `applied`'s Blocks, as Proposals of `request`, so rejecting
 * them leaves the text as it was: only the paragraphs that differ change (`proposeOver`), or
 * with `whole`, each old Block is removed and each new one added after them. Returns the ids of
 * the Blocks `revised` is written as; null, changing nothing, when the old ones changed since
 * they were read. Call it in a Yjs transaction.
 */
export function replaceApplied(
  blocks: Y.XmlFragment,
  applied: OwnApplied,
  revised: readonly NodeJSON[],
  request: string,
  { whole }: { whole: boolean },
): string[] | null {
  const old = blocksOf(blocks, applied);
  const last = old?.at(-1);
  if (!old || !last) return null;
  if (!whole) return proposeOver(blocks, old, revised, request, randomUUID);
  const added = revised.map(createElement);
  for (const element of old) setProposal(element, { id: randomUUID(), request, kind: "delete" });
  blocks.insert(blocks.toArray().indexOf(last) + 1, added);
  for (const element of added) setProposal(element, { id: randomUUID(), request, kind: "insert" });
  return added.map(idOf);
}

/** How many of the Citations in `over`'s Blocks `revised` leaves out; 0 once they have changed. */
export function citationsDropped(
  blocks: Y.XmlFragment,
  over: Pick<OwnWaiting, "blockIds" | "fingerprint">,
  revised: readonly NodeJSON[],
): number {
  const kept = new Set(revised.flatMap(citationsIn));
  return (blocksOf(blocks, over) ?? []).flatMap(citationsIn).filter((key) => !kept.has(key)).length;
}

/** Whether the User asked for all of the text `own` holds (#880): a revision of it is asked for too. */
export function ownAsked(blocks: Y.XmlFragment, own: OwnWaiting): boolean {
  const doc = blocks.doc;
  return (
    blocksOf(blocks, own) !== null &&
    !!doc &&
    own.requests.every((request) => askedFor(doc, request))
  );
}

/**
 * Puts `revised` in place of `own`'s Blocks, each waiting whole as a Proposal
 * of `request`, and keeps what they replaced (`MIND_REVISIONS_FIELD`), so
 * rejecting the revision brings it back. Returns the new Blocks' ids; null,
 * changing nothing, when `own`'s Blocks have changed since they were read.
 * Call it in a Yjs transaction.
 */
export function replaceOwn(
  blocks: Y.XmlFragment,
  own: OwnWaiting,
  revised: readonly Y.XmlElement[],
  request: string,
): string[] | null {
  const old = blocksOf(blocks, own);
  const first = old?.[0];
  if (!old || !first) return null;
  keepRevised(blocks, request, old);
  const at = blocks.toArray().indexOf(first);
  blocks.delete(at, old.length);
  blocks.insert(at, [...revised]);
  for (const element of revised)
    setProposal(element, { id: randomUUID(), request, kind: "insert" });
  return revised.map(idOf);
}
