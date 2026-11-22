import * as Y from "yjs";
import type { NodeJSON } from "../../shared/blockJson";
import { wordFingerprint } from "../../shared/wordFiles";
import { createElement, nodeOf } from "../answers/blocks";
import { BLOCK_ID_ATTRIBUTE, type MeetingFill } from "../api";

export interface FillVersion extends MeetingFill {
  blocks: string[];
  fingerprints?: Record<string, string>;
}

interface ReplacedBlock {
  node: NodeJSON;
  position: number[];
  afterId?: string;
}

export interface Refill {
  previous: FillVersion;
  previousTemplateId: string | null;
  templateId: string | null;
  removed: ReplacedBlock[];
  undone?: true;
}

export const fillFingerprint = wordFingerprint;

export function fillFingerprints(
  ids: readonly string[],
  find: (id: string) => Y.XmlElement | null,
): Record<string, string> {
  return Object.fromEntries(
    ids.flatMap((id) => {
      const block = find(id);
      return block ? [[id, wordFingerprint(block)]] : [];
    }),
  );
}

export function replaceableFillBlocks(
  previous: FillVersion,
  find: (id: string) => Y.XmlElement | null,
): Set<string> {
  return new Set(
    previous.blocks.filter((id) => {
      const block = find(id);
      return block !== null && previous.fingerprints?.[id] === wordFingerprint(block);
    }),
  );
}

export function removePreviousFill(
  previous: FillVersion,
  find: (id: string) => Y.XmlElement | null,
): ReplacedBlock[] {
  const removals = previous.blocks.flatMap((id) => {
    const block = find(id);
    const parent = block?.parent;
    if (!block || !(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) return [];
    // Earlier versions did not record whether an AI-only block was shortened by the User.
    if (previous.fingerprints?.[id] !== wordFingerprint(block)) return [];
    const at = parent.toArray().indexOf(block);
    const position = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(parent, at, -1),
    );
    return [{ block, parent, snapshot: { node: nodeOf(block), position: [...position] } }];
  });
  for (const { block, parent } of removals) {
    parent.delete(parent.toArray().indexOf(block), 1);
  }
  return removals.map(({ snapshot }) => snapshot);
}

export function restorePreviousFill(
  removed: readonly ReplacedBlock[],
  doc: Y.Doc,
  find: (id: string) => Y.XmlElement | null,
): void {
  for (const { node, position, afterId } of removed) {
    const id = node.attrs?.[BLOCK_ID_ATTRIBUTE];
    if (typeof id === "string" && find(id)) continue;
    const where = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Uint8Array.from(position)),
      doc,
    );
    if (where?.type instanceof Y.XmlElement || where?.type instanceof Y.XmlFragment) {
      const previous = afterId ? find(afterId) : null;
      const index =
        previous?.parent === where.type ? where.type.toArray().indexOf(previous) + 1 : where.index;
      where.type.insert(index, [createElement(node)]);
    }
  }
}
