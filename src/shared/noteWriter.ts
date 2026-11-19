/**
 * Which outside agent wrote a Mind whole, and when (#3306): kept beside the Blocks in the Mind's
 * Yjs document (`MIND_WRITER_FIELD`), so it survives sync and reload and an older version leaves
 * it as it is. Shared by the core, the renderer and the tests.
 */
import type * as Y from "yjs";
import { MIND_WRITER_FIELD, type OutsideAgentRequest } from "../core/api";

const KEY = "agent";

/**
 * Who wrote a Mind, and as which Mind (#3364): a copy of its content carries the record, so the
 * record holds for the Mind it names alone. A record made before it named one has no `mindId`.
 */
export type NoteWriter = OutsideAgentRequest & { mindId?: string };

/** The outside agent that wrote the Mind, or null for a Mind none did. */
export function noteWriterOf(doc: Y.Doc): NoteWriter | null {
  const kept = doc.getMap<unknown>(MIND_WRITER_FIELD).get(KEY);
  if (typeof kept !== "object" || kept === null) return null;
  const { source, agent, pairingId, createdAt, mindId } = kept as Record<string, unknown>;
  if (
    source !== "outside-agent" ||
    typeof agent !== "string" ||
    typeof pairingId !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  return {
    source,
    agent,
    pairingId,
    createdAt,
    ...(typeof mindId === "string" && { mindId }),
  };
}

export function recordNoteWriter(doc: Y.Doc, writer: NoteWriter): void {
  doc.getMap<unknown>(MIND_WRITER_FIELD).set(KEY, { ...writer });
}
