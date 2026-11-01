/**
 * Citations minted for outside agents (#351). Only IncarnaMind mints them:
 * each is a quote the Citation check found at a Location, kept with a short
 * token the agent writes in its text as "[cite:k3x9a2b7]". The token is
 * random, so an agent can't make one up; checking it again later reads what
 * was kept, against the Document as it is then.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Citation, CitationLocation } from "../api";
import type { Database } from "../storage";

/** Lower-case letters and digits that can't be misread (no 0, 1, l or o): 5 bits each. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const TOKEN_LENGTH = 8;

/** A Citation token as an agent writes it; the capture is the token itself. */
export const CITATION_TOKEN = /\[cite:([a-z0-9]{1,32})\]/g;

/** How a token is written in text. */
export const citeTag = (token: string) => `[cite:${token}]`;

/** A Citation minted for an agent. */
export interface AgentCitation {
  token: string;
  pairingId: string;
  passageId: string;
  documentId: string;
  documentName: string;
  contentHash: string;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
  quote: string;
}

interface Row {
  token: string;
  pairing_id: string;
  passage_id: string;
  document_id: string;
  document_name: string;
  content_hash: string;
  page_from: number | null;
  page_to: number | null;
  location: string | null;
  quote: string;
}

const COLUMNS =
  "token, pairing_id, passage_id, document_id, document_name, content_hash, page_from, page_to, location, quote";

function parseLocation(json: string | null): CitationLocation | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as CitationLocation;
  } catch {
    return null;
  }
}

const toCitation = (row: Row): AgentCitation => ({
  token: row.token,
  pairingId: row.pairing_id,
  passageId: row.passage_id,
  documentId: row.document_id,
  documentName: row.document_name,
  contentHash: row.content_hash,
  pageFrom: row.page_from,
  pageTo: row.page_to,
  location: parseLocation(row.location),
  quote: row.quote,
});

function newToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let token = "";
  for (const byte of bytes) token += ALPHABET[byte % ALPHABET.length];
  return token;
}

export function createAgentCitations(db: Database, now: () => string) {
  const find = (token: string): AgentCitation | null => {
    const row = db.get<Row>(
      `SELECT ${COLUMNS} FROM agent_citations WHERE token = ? AND deleted_at IS NULL`,
      [token],
    );
    return row ? toCitation(row) : null;
  };

  return {
    find,

    /**
     * The token of a Citation the check found, for this pairing: the one it
     * had before for the same quote of the same Passage, or a new one.
     */
    mint(pairingId: string, citation: Citation): AgentCitation {
      if (citation.check !== "found") throw new Error("Only a found quote gets a Citation token.");
      const location = citation.location ? JSON.stringify(citation.location) : null;
      const existing = db.get<Row>(
        `SELECT ${COLUMNS} FROM agent_citations
         WHERE pairing_id = ? AND passage_id = ? AND quote = ? AND content_hash = ?
           AND page_from IS ? AND page_to IS ? AND deleted_at IS NULL`,
        [
          pairingId,
          citation.passageId,
          citation.quote,
          citation.contentHash,
          citation.pageFrom,
          citation.pageTo,
        ],
      );
      if (existing) return toCitation(existing);
      const at = now();
      for (;;) {
        const token = newToken();
        // Rare, but two tokens must never stand for different quotes.
        if (find(token)) continue;
        db.run(
          `INSERT INTO agent_citations (id, ${COLUMNS}, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            token,
            pairingId,
            citation.passageId,
            citation.documentId,
            citation.documentName,
            citation.contentHash,
            citation.pageFrom,
            citation.pageTo,
            location,
            citation.quote,
            at,
            at,
          ],
        );
        return {
          token,
          pairingId,
          passageId: citation.passageId,
          documentId: citation.documentId,
          documentName: citation.documentName,
          contentHash: citation.contentHash,
          pageFrom: citation.pageFrom,
          pageTo: citation.pageTo,
          location: citation.location,
          quote: citation.quote,
        };
      }
    },
  };
}

export type AgentCitations = ReturnType<typeof createAgentCitations>;
