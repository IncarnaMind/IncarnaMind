/**
 * Where a Mind's Blocks came from (#201): a Note added from an Answer in the
 * assistant keeps a link back to it, one reference (`ArtifactReference`,
 * ADR-0017) by Block id in the Mind's Yjs document (`MIND_ORIGINS_FIELD`).
 * Kept beside the Blocks, not in their attributes, so an older version's
 * editor, which strips attributes it doesn't know, leaves it alone. A Block
 * deleted since leaves its entry unused. Shared by the core and the renderer.
 */
import type * as Y from "yjs";
import { type BlockOrigin, MIND_ORIGINS_FIELD } from "../core/api";
import { parseReference } from "../core/references";

const originsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_ORIGINS_FIELD);

/** A Block's origin read from stored or received data, or null when it isn't one. */
export function parseOrigin(value: unknown): BlockOrigin | null {
  if (typeof value !== "object" || value === null) return null;
  const { from, question } = value as Record<string, unknown>;
  const reference = parseReference(from);
  if (!reference) return null;
  return { from: reference, question: typeof question === "string" ? question : "" };
}

/** One Block's origin, or null when it wasn't added from an Answer. */
export const originOf = (doc: Y.Doc, blockId: string): BlockOrigin | null =>
  parseOrigin(originsOf(doc).get(blockId));

/** Every Block's origin in the Mind, by Block id. */
export function allOrigins(doc: Y.Doc): Map<string, BlockOrigin> {
  const origins = new Map<string, BlockOrigin>();
  originsOf(doc).forEach((value, blockId) => {
    const origin = parseOrigin(value);
    if (origin) origins.set(blockId, origin);
  });
  return origins;
}

/**
 * The conversation a Mind came from (#1940): the origin of the first Block added
 * from an Answer, whose chat the Mind's ⋯ opens. Null for a Mind written by hand.
 */
export function conversationOrigin(origins: ReadonlyMap<string, BlockOrigin>): BlockOrigin | null {
  for (const origin of origins.values()) {
    if (origin.from.artifactKind === "conversation") return origin;
  }
  return null;
}

/** Gives these Blocks one origin. Call it in the transaction that adds them, where there is one. */
export function setOrigins(doc: Y.Doc, blockIds: readonly string[], origin: BlockOrigin): void {
  const origins = originsOf(doc);
  const stored = { from: origin.from, question: origin.question };
  doc.transact(() => {
    for (const blockId of blockIds) origins.set(blockId, stored);
  });
}

export function removeOrigins(doc: Y.Doc, blockIds: readonly string[]): void {
  const origins = originsOf(doc);
  doc.transact(() => {
    for (const blockId of blockIds) if (origins.has(blockId)) origins.delete(blockId);
  });
}

/** Calls `listener` whenever an origin is set or removed, on any device. Returns how to stop. */
export function observeOrigins(doc: Y.Doc, listener: () => void): () => void {
  const origins = originsOf(doc);
  const onChange = () => listener();
  origins.observe(onChange);
  return () => origins.unobserve(onChange);
}
