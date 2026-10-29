/**
 * What of a write needs a look now (#1635), by the badge's one rule (`noteHealth`'s `lookClaims`:
 * a claim found unsupported or contradicted, or with a Citation not found), within the write's
 * top-level Blocks: the count on the change's line, and where it takes the User. An open Mind's
 * health comes from `healthNow` (./healthNow).
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { BLOCK_ID_ATTRIBUTE } from "../../../core/api";
import type { NoteHealth } from "./healthCounts";

/** Where the claims of `blocks` that need a look start, in page order. */
export function lookPlaces(
  doc: ProseMirrorNode,
  health: NoteHealth,
  blocks: readonly string[],
): number[] {
  const ids = new Set(blocks);
  const spans: { from: number; to: number }[] = [];
  doc.forEach((node, offset) => {
    if (ids.has(String(node.attrs[BLOCK_ID_ATTRIBUTE]))) {
      spans.push({ from: offset, to: offset + node.nodeSize });
    }
  });
  return health.lookClaims
    .filter((pos) => spans.some((span) => span.from <= pos && pos < span.to))
    .sort((a, b) => a - b);
}

/** The first Block of `blocks` still in the Mind: where the count goes once none needs a look. */
export function firstBlockOf(doc: ProseMirrorNode, blocks: readonly string[]): number | null {
  const ids = new Set(blocks);
  let found: number | null = null;
  doc.forEach((node, offset) => {
    if (found === null && ids.has(String(node.attrs[BLOCK_ID_ATTRIBUTE]))) found = offset + 1;
  });
  return found;
}
