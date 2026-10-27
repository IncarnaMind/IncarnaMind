import * as Y from "yjs";
import { type AskedChangeTransition, MIND_CONTENT_FIELD } from "../core/api";
import { targetHash } from "./proposals";

/** A cheap comparison of the Mind's current content, which also changes when a deletion advances no Yjs clock. */
export const fingerprintOfMind = (doc: Y.Doc): string =>
  targetHash(doc.getXmlFragment(MIND_CONTENT_FIELD).toString());

export const transitionOfMind = (doc: Y.Doc, since?: Uint8Array): AskedChangeTransition => ({
  vector: Y.encodeStateVector(doc),
  fingerprint: fingerprintOfMind(doc),
  update: since ? Y.encodeStateAsUpdate(doc, since) : Y.encodeStateAsUpdate(doc),
});
