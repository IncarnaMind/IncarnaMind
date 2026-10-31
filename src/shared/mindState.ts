import * as Y from "yjs";
import { type AskedChangeTransition, MIND_CONTENT_FIELD } from "../core/api";
import { perBlock } from "./memo";
import { targetHash } from "./proposals";

const blockFingerprint = perBlock((block) => targetHash(block.toString()));

/**
 * A cheap comparison of a Note's Blocks, which also changes when a deletion advances no Yjs
 * clock: made of each Block's own, so a change reads only the Blocks it touched.
 */
export const fingerprintOfBlocks = (blocks: Y.XmlFragment): string =>
  targetHash(
    blocks
      .toArray()
      .map((node) =>
        node instanceof Y.XmlElement ? blockFingerprint(node) : targetHash(node.toString()),
      )
      .join(" "),
  );

export const fingerprintOfMind = (doc: Y.Doc): string =>
  fingerprintOfBlocks(doc.getXmlFragment(MIND_CONTENT_FIELD));

export const transitionOfMind = (doc: Y.Doc, since?: Uint8Array): AskedChangeTransition => ({
  vector: Y.encodeStateVector(doc),
  fingerprint: fingerprintOfMind(doc),
  update: since ? Y.encodeStateAsUpdate(doc, since) : Y.encodeStateAsUpdate(doc),
});
