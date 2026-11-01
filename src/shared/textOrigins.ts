/**
 * Which of a Mind's Blocks hold third-party text (#78, ADR-0013): a
 * `ThirdPartySource` by Block id, in a map beside the Blocks in the Mind's Yjs
 * document (`MIND_TEXT_ORIGINS_FIELD`), so it survives sync and reload and an
 * older version leaves it as it is. A Question whose context holds such a
 * Block is answered by a Run that counts as having read third-party text.
 * Whatever adds third-party text to a Mind records it here: an Answer written
 * after reading some (the core), a .docx imported from someone else (#104),
 * a quote added from a web page (#101), what an outside agent proposed (#352).
 * Text pasted from other apps can't be traced, and counts as the User's.
 * Shared by the core, the renderer and the tests.
 */
import type * as Y from "yjs";
import { MIND_TEXT_ORIGINS_FIELD, type ThirdPartySource } from "../core/api";

const SOURCES: readonly ThirdPartySource[] = [
  "imported",
  "web-page",
  "checked-document",
  "outside-agent",
];

/** A stored source, or null for none, or one this version doesn't know. */
export const parseThirdPartySource = (value: unknown): ThirdPartySource | null =>
  SOURCES.find((source) => source === value) ?? null;

const originsOf = (doc: Y.Doc): Y.Map<unknown> => doc.getMap(MIND_TEXT_ORIGINS_FIELD);

/** Where the text of the Block with this id came from, or null: the User's own. */
export function textOriginOf(doc: Y.Doc, blockId: string): ThirdPartySource | null {
  return parseThirdPartySource(originsOf(doc).get(blockId));
}

/**
 * Records that these Blocks hold third-party text from `source`, or, with
 * null, that they no longer do (an Answer written again by a Run that read
 * none), in one Yjs transaction.
 */
export function setTextOrigin(
  doc: Y.Doc,
  blockIds: readonly string[],
  source: ThirdPartySource | null,
): void {
  const origins = originsOf(doc);
  doc.transact(() => {
    for (const blockId of blockIds) {
      if (source === null) {
        if (origins.has(blockId)) origins.delete(blockId);
      } else if (origins.get(blockId) !== source) {
        origins.set(blockId, source);
      }
    }
  });
}
