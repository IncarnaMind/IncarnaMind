/**
 * Which outside agent wrote a Mind whole, and when (#3306): kept beside the Blocks in the Mind's
 * Yjs document (`MIND_WRITER_FIELD`), so it survives sync and reload and an older version leaves
 * it as it is. Shared by the core, the renderer and the tests.
 */
import type * as Y from "yjs";
import { MIND_WRITER_FIELD, type OutsideAgentRequest } from "../core/api";

const KEY = "agent";

/** The outside agent that wrote the Mind, or null for a Mind none did. */
export function noteWriterOf(doc: Y.Doc): OutsideAgentRequest | null {
  const kept = doc.getMap<unknown>(MIND_WRITER_FIELD).get(KEY);
  if (typeof kept !== "object" || kept === null) return null;
  const { source, agent, pairingId, createdAt } = kept as Record<string, unknown>;
  if (
    source !== "outside-agent" ||
    typeof agent !== "string" ||
    typeof pairingId !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  return { source, agent, pairingId, createdAt };
}

export function recordNoteWriter(doc: Y.Doc, writer: OutsideAgentRequest): void {
  doc.getMap<unknown>(MIND_WRITER_FIELD).set(KEY, { ...writer });
}
