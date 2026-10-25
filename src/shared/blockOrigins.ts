/**
 * Where a Mind's Blocks came from (#201): a Note added from an Answer in the
 * assistant keeps a link back to it, one reference (`ArtifactReference`,
 * ADR-0017) by Block id in the Mind's Yjs document (`MIND_ORIGINS_FIELD`).
 * Kept beside the Blocks, not in their attributes, so an older version's
 * editor, which strips attributes it doesn't know, leaves it alone. A Block
 * deleted since leaves its entry unused. Shared by the core and the renderer.
 */
import type * as Y from "yjs";
import { type BlockOrigin, MIND_ORIGINS_FIELD, MIND_REPLACED_ORIGINS_FIELD } from "../core/api";
import { isRecord } from "../core/errors";
import { parseReference } from "../core/references";

const originsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_ORIGINS_FIELD);
const replacedOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_REPLACED_ORIGINS_FIELD);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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

/** Gives these Blocks one origin. Call it in the transaction that adds them, where there is one. */
export function setOrigins(doc: Y.Doc, blockIds: readonly string[], origin: BlockOrigin): void {
  const origins = originsOf(doc);
  const stored = { from: origin.from, question: origin.question };
  doc.transact(() => {
    for (const blockId of blockIds) origins.set(blockId, stored);
  });
}

/**
 * Gives Blocks the origin of `request`'s change, keeping the origin each had before, which
 * rejecting that change in the Block puts back (`restoreOrigins`).
 */
export function setOriginsOf(
  doc: Y.Doc,
  request: string,
  blockIds: readonly string[],
  origin: BlockOrigin,
): void {
  const origins = originsOf(doc);
  const replaced = replacedOf(doc);
  const kept = replaced.get(request);
  const before: Record<string, unknown> = isRecord(kept) ? { ...kept } : {};
  for (const blockId of blockIds) {
    if (origins.has(blockId) && !(blockId in before)) before[blockId] = origins.get(blockId);
  }
  doc.transact(() => {
    if (Object.keys(before).length > 0) replaced.set(request, before);
    setOrigins(doc, blockIds, origin);
  });
}

/** Puts back the origins `request`'s change replaced in these Blocks (`setOriginsOf`), in the caller's transaction. */
export function restoreOrigins(doc: Y.Doc, request: string, blockIds: Iterable<string>): void {
  const before = replacedOf(doc).get(request);
  if (!isRecord(before)) return;
  const origins = originsOf(doc);
  for (const blockId of blockIds) {
    if (blockId in before && !same(origins.get(blockId), before[blockId])) {
      origins.set(blockId, before[blockId]);
    }
  }
}

/** Sets `to`'s origins to `from`'s wherever they differ, in the caller's transaction. */
export function copyOrigins(from: Y.Doc, to: Y.Doc): void {
  const source = originsOf(from);
  const target = originsOf(to);
  source.forEach((value, blockId) => {
    if (!same(target.get(blockId), value)) target.set(blockId, value);
  });
  for (const blockId of [...target.keys()]) if (!source.has(blockId)) target.delete(blockId);
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
