/**
 * Writing Proposals into a Mind the User has edited since the model read it.
 * They are written into a copy of the Mind as the model read it, and what
 * that copy changed is merged into the Mind as Yjs merges two devices' edits:
 * the User's edits stay theirs, and a Proposal whose text they changed
 * arrives out of date (`outOfDateProposals` in src/shared/proposals.ts).
 * Merged, the changes may add Proposals and nothing else: the User's text
 * (`usersText`) must read as it does now, or nothing is merged.
 */
import * as Y from "yjs";
import { INLINE_NODES, NODE_CHARACTER, readProposalAttribute } from "../../shared/proposals";
import {
  BLOCK_ID_ATTRIBUTE,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../api";

interface Run {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

/** A copy of a Mind's document, from its whole state (`MindContent.state`). */
export function docOf(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

type Child = Y.XmlElement | Y.XmlText | Y.XmlHook;

/** `usersText` of these nodes, side by side. */
function readingOf(nodes: readonly Child[]): string {
  let text = "";
  for (const child of nodes) {
    if (child instanceof Y.XmlText) {
      for (const run of child.toDelta() as Run[]) {
        if (run.attributes && PROPOSAL_INSERT_MARK in run.attributes) continue;
        text += typeof run.insert === "string" ? run.insert : NODE_CHARACTER;
      }
    } else if (child instanceof Y.XmlElement) {
      if (readProposalAttribute(child.getAttribute(PROPOSAL_ATTRIBUTE))?.kind === "insert")
        continue;
      if (INLINE_NODES.has(child.nodeName)) {
        text += NODE_CHARACTER;
        continue;
      }
      const inside = readingOf(child.toArray());
      if (inside !== "") text += `<${child.nodeName}>${inside}</${child.nodeName}>`;
    }
  }
  return text;
}

/**
 * The User's text: the Blocks' text without what Proposals add, which isn't in the Note yet, and
 * with what they remove, Block by Block and an inline node as one character. Accepted text is
 * theirs, whoever wrote it. A Block with no text reads as nothing: an empty line holds none of
 * their words for a change to take.
 */
export const usersText = (parent: Y.XmlFragment | Y.XmlElement): string =>
  readingOf(parent.toArray());

/** The User's text (`usersText`) of each top-level Block that holds some, with the Block's id. */
export function usersBlocks(blocks: Y.XmlFragment): { id: string | null; text: string }[] {
  return blocks.toArray().flatMap((child) => {
    const text = readingOf([child]);
    const id = child instanceof Y.XmlElement ? child.getAttribute(BLOCK_ID_ATTRIBUTE) : null;
    return text === "" ? [] : [{ id: typeof id === "string" ? id : null, text }];
  });
}

/**
 * What `fork`, a copy of the Mind made from `base`, has changed since, as an
 * update to apply to the Mind as it is now (`now`, its whole state); or null
 * when, merged there, it would change the User's text and not only add
 * Proposals (as when text was split around words the User typed meanwhile).
 */
export function forkChanges(base: Uint8Array, fork: Y.Doc, now: Uint8Array): Uint8Array | null {
  const update = Y.encodeStateAsUpdate(fork, Y.encodeStateVectorFromUpdate(base));
  const merged = docOf(now);
  try {
    const blocks = merged.getXmlFragment(MIND_CONTENT_FIELD);
    const before = usersText(blocks);
    Y.applyUpdate(merged, update);
    return usersText(blocks) === before ? update : null;
  } finally {
    merged.destroy();
  }
}
