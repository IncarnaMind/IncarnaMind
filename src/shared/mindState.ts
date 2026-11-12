import * as Y from "yjs";
import { type AskedChangeTransition, MIND_CONTENT_FIELD } from "../core/api";
import { perBlock } from "./memo";
import { targetHash } from "./proposals";

interface TextRun {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

const pairs = (values: unknown): string =>
  typeof values === "object" && values !== null
    ? Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => ` ${key}="${value}"`)
        .join("")
    : "";

const runXml = ({ insert, attributes = {} }: TextRun): string => {
  const marks = Object.keys(attributes).sort();
  const open = marks.map((name) => `<${name}${pairs(attributes[name])}>`).join("");
  const close = marks
    .reverse()
    .map((name) => `</${name}>`)
    .join("");
  return `${open}${insert}${close}`;
};

/**
 * A Block's XML as Yjs writes it, but with no key whose value is undefined. A mark's attributes
 * travel as JSON, which leaves such a key out: read with it, the copy whose editor set a check's
 * `fromAnswer` to undefined (#2313) would never match the core's, and the Figure schedule would
 * refuse every reading of the Note after a change made there.
 */
function xmlOf(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) return node.toDelta().map(runXml).join("");
  if (!(node instanceof Y.XmlElement)) return node.toString();
  const name = node.nodeName.toLocaleLowerCase();
  return `<${name}${pairs(node.getAttributes())}>${node.toArray().map(xmlOf).join("")}</${name}>`;
}

const blockFingerprint = perBlock((block) => targetHash(xmlOf(block)));

/**
 * A cheap comparison of a Note's Blocks, which also changes when a deletion advances no Yjs
 * clock: made of each Block's own, so a change reads only the Blocks it touched.
 */
export const fingerprintOfBlocks = (blocks: Y.XmlFragment): string =>
  targetHash(
    blocks
      .toArray()
      .map((node) =>
        node instanceof Y.XmlElement ? blockFingerprint(node) : targetHash(xmlOf(node)),
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
