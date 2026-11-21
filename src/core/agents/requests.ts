/**
 * What the User asked their own AI about a Note (#3419) or the Documents they have open (#3533),
 * beyond the line typed in the agent's app: the line says what they want in their own words, and
 * the rest (which Note, which sentences, what the check found, what to change and what to leave
 * alone) waits here for that agent, which reads it with `read_request`. Each is read once, so two
 * requests made before either is sent each reach the agent once; read, it stays in that agent's
 * activity list. On this device only, as the pairings are.
 */
import type { AgentRequest } from "../api";
import { isRecord } from "../errors";
import type { Database } from "../storage";

/** The requests kept per pairing, as many as its activity list keeps calls; older ones go. */
const REQUESTS_KEPT = 500;

interface RequestRow {
  id: string;
  pairing_id: string;
  mind_id: string;
  title: string;
  sentences: string;
  text: string;
  named: string | null;
  read_at: string | null;
  created_at: string;
}

/**
 * What a question named of what the User looks at, by id: the Documents open, and the Folders and
 * Documents of the chat box's Search scope (#3533). Their names are put in the text when the agent
 * reads it, and only for those it still reads.
 */
export interface RequestNamed {
  organize?: "loose" | "selected" | "folder";
  open: string[];
  folders: string[];
  documents: string[];
}

/** A request as IncarnaMind keeps it, with the name its line gave (a Note's, else a Document's) and the text the agent reads. */
export interface KeptRequest extends AgentRequest {
  title: string;
  /** What waits besides what the request names, which is put in when it is read. */
  text: string;
  named: RequestNamed | null;
}

const COLUMNS = "id, pairing_id, mind_id, title, sentences, text, named, read_at, created_at";

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

function namedOf(json: string | null): RequestNamed | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value)
      ? {
          ...((value.organize === "loose" ||
            value.organize === "selected" ||
            value.organize === "folder") && { organize: value.organize }),
          open: idsOf(value.open),
          folders: idsOf(value.folders),
          documents: idsOf(value.documents),
        }
      : null;
  } catch {
    return null;
  }
}

function sentencesOf(json: string): AgentRequest["sentences"] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.flatMap((each) =>
          isRecord(each) && typeof each.sentence === "string"
            ? [
                {
                  sentence: each.sentence,
                  checkId: typeof each.checkId === "string" ? each.checkId : null,
                },
              ]
            : [],
        )
      : [];
  } catch {
    return [];
  }
}

/** The column can't hold null (migration 146), so a request about no Note keeps an empty id (#3533). */
const NO_NOTE = "";

const toRequest = (row: RequestRow): KeptRequest => ({
  id: row.id,
  pairingId: row.pairing_id,
  mindId: row.mind_id === NO_NOTE ? null : row.mind_id,
  title: row.title,
  sentences: sentencesOf(row.sentences),
  text: row.text,
  named: namedOf(row.named),
  createdAt: row.created_at,
  readAt: row.read_at,
});

export function createAgentRequests(db: Database, now: () => string, newId: () => string) {
  return {
    keep(request: Omit<KeptRequest, "id" | "createdAt" | "readAt">): KeptRequest {
      const id = newId();
      const at = now();
      db.transaction(() => {
        db.run(
          `INSERT INTO agent_requests (id, pairing_id, mind_id, title, sentences, text, named,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            request.pairingId,
            request.mindId ?? NO_NOTE,
            request.title,
            JSON.stringify(request.sentences),
            request.text,
            request.named === null ? null : JSON.stringify(request.named),
            at,
            at,
          ],
        );
        db.run(
          `UPDATE agent_requests SET deleted_at = ?, updated_at = ?
           WHERE pairing_id = ? AND deleted_at IS NULL AND id NOT IN (
             SELECT id FROM agent_requests WHERE pairing_id = ? AND deleted_at IS NULL
             ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
          [at, at, request.pairingId, request.pairingId, BigInt(REQUESTS_KEPT)],
        );
      });
      return { ...request, id, createdAt: at, readAt: null };
    },

    /** The pairing's requests, read or waiting, the newest first. */
    ofPairing(pairingId: string): KeptRequest[] {
      return db
        .all<RequestRow>(
          `SELECT ${COLUMNS} FROM agent_requests
           WHERE pairing_id = ? AND deleted_at IS NULL
           ORDER BY created_at DESC, rowid DESC`,
          [pairingId],
        )
        .map(toRequest);
    },

    /**
     * Marks a request read, as it is now; null when it was read or let go already. `text` is what the
     * agent was given, with the names put in, which its activity shows.
     */
    markRead(id: string, text?: string): KeptRequest | null {
      return db.transaction(() => {
        const row = db.get<RequestRow>(
          `SELECT ${COLUMNS} FROM agent_requests
           WHERE id = ? AND read_at IS NULL AND deleted_at IS NULL`,
          [id],
        );
        if (!row) return null;
        const at = now();
        const given = text ?? row.text;
        db.run("UPDATE agent_requests SET read_at = ?, text = ?, updated_at = ? WHERE id = ?", [
          at,
          given,
          at,
          id,
        ]);
        return toRequest({ ...row, text: given, read_at: at });
      });
    },

    /** The text of each request named, by id, for the activity list. */
    texts(ids: readonly string[]): Map<string, string> {
      if (ids.length === 0) return new Map();
      const rows = db.all<{ id: string; text: string }>(
        `SELECT id, text FROM agent_requests
         WHERE deleted_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      return new Map(rows.map((row) => [row.id, row.text]));
    },

    /** The requests about a Note, of the pairings still connected, the newest first. */
    forMind(mindId: string): KeptRequest[] {
      return db
        .all<RequestRow>(
          `SELECT ${COLUMNS} FROM agent_requests
           WHERE mind_id = ? AND deleted_at IS NULL AND pairing_id IN (
             SELECT id FROM agent_pairings WHERE deleted_at IS NULL)
           ORDER BY created_at DESC, rowid DESC LIMIT 50`,
          [mindId],
        )
        .map(toRequest);
    },

    /** A disconnected agent's requests go with its activity list. */
    forget(pairingId: string, at: string): void {
      db.run(
        `UPDATE agent_requests SET deleted_at = ?, updated_at = ?
         WHERE pairing_id = ? AND deleted_at IS NULL`,
        [at, at, pairingId],
      );
    },

    /** Deletes for good the requests marked deleted before `before` (#3430). */
    forgetGone(before: string): void {
      db.run("DELETE FROM agent_requests WHERE deleted_at IS NOT NULL AND deleted_at < ?", [
        before,
      ]);
    },
  };
}

export type AgentRequests = ReturnType<typeof createAgentRequests>;
