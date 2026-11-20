import { targetHash } from "../../shared/proposals";
import type { DocumentKind } from "../api";
import type { Language } from "../language";
import { ORGANIZE_PASSAGES } from "../library/excerpt";
import type { OrganizeReviewProposal, OrganizeReviewRun } from "../organizeReview";
import type { Database } from "../storage";
import { offeredKinds } from "../tags/about";
import { excerptFromPassages, kindId, kindOfId } from "../tags/classify";
import { kindName } from "../tags/kinds";
import { AgentRefusedError } from "./refusals";

export const SORTING_BATCH = 8;

type Choice = { id: string; name: string };
type Waiting = Choice & { kind: DocumentKind; version: string; folderId: string | null };
type Scope = { documents: string[]; folders: Choice[]; shareTagNames: boolean };

export interface SortingBatch {
  documents: (Waiting & { text: string })[];
  folders: Choice[];
  tags: Choice[];
  next: string | null;
}

export interface SortingProposal {
  documentId: string;
  version: string;
  folderId?: string;
  tagIds?: string[];
}

export function createAgentSorting(
  db: Database,
  language: () => Language,
  propose: (run: OrganizeReviewRun, rows: OrganizeReviewProposal[]) => number,
  invalid: () => string,
) {
  const refuse = () => new AgentRefusedError("invalid", invalid());
  function waiting(ids: string[], after: string) {
    const rows = db.all<Waiting & { content_hash: string | null }>(
      `SELECT d.id, d.name, d.kind, d.content_hash, g.group_id AS folderId,
              coalesce(g.request_id, '') AS version
       FROM documents d LEFT JOIN document_groups g ON g.document_id = d.id AND g.deleted_at IS NULL
       WHERE d.id IN (SELECT value FROM json_each(?)) AND d.id > ? AND d.deleted_at IS NULL
         AND d.meeting_mind_id IS NULL AND d.status IN ('ready', 'embedding', 'waiting-for-model')
         AND (g.id IS NULL OR g.status IN ('waiting','pending','failed')
              OR d.tagging_status IN ('pending','waiting-for-provider','off','failed'))
         AND NOT EXISTS (SELECT 1 FROM organize_review_items i WHERE i.document_id = d.id
             AND i.deleted_at IS NULL AND (i.state = 'open' OR i.content_hash IS d.content_hash))
       ORDER BY d.id LIMIT ?`,
      [JSON.stringify(ids), after, BigInt(SORTING_BATCH + 1)],
    );
    return rows.map((row) => ({
      ...row,
      version: targetHash(JSON.stringify([row.id, row.name, row.content_hash, row.version])),
    }));
  }

  function choices(scope: Scope): Choice[] {
    const kinds = offeredKinds(db).map((kind) => ({
      id: kindId(kind),
      name: kindName(kind, language()),
    }));
    if (!scope.shareTagNames) return kinds;
    const tags = db.all<Choice>(
      `SELECT DISTINCT t.id, t.name FROM tags t JOIN document_tags dt ON dt.tag_id = t.id
       WHERE dt.document_id IN (SELECT value FROM json_each(?)) AND dt.deleted_at IS NULL
         AND t.deleted_at IS NULL AND t.kind IS NULL ORDER BY t.name, t.id`,
      [JSON.stringify(scope.documents)],
    );
    return [...kinds, ...tags];
  }

  return {
    list(scope: Scope, after = ""): SortingBatch {
      if (typeof after !== "string" || after.length > 100) throw refuse();
      const rows = waiting(scope.documents, after);
      const documents = rows.slice(0, SORTING_BATCH).map(({ content_hash: _, ...row }) => {
        const passages = db.all<{ text: string }>(
          "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
          [row.id, BigInt(ORGANIZE_PASSAGES)],
        );
        return { ...row, text: excerptFromPassages(passages.map((p) => p.text)) };
      });
      return {
        documents,
        folders: scope.folders,
        tags: choices(scope),
        next: rows.length > SORTING_BATCH ? (documents.at(-1)?.id ?? null) : null,
      };
    },

    submit(scope: Scope, agent: string, proposals: SortingProposal[]) {
      if (!Array.isArray(proposals) || !proposals.length || proposals.length > SORTING_BATCH)
        throw refuse();
      const allowed = new Set(scope.documents);
      const ids = proposals.map((p) => p?.documentId);
      if (new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) throw refuse();
      const docs = new Map(waiting(ids, "").map((doc) => [doc.id, doc]));
      const tags = new Set(choices(scope).map((tag) => tag.id));
      const rows = proposals.map((p): OrganizeReviewProposal => {
        const doc = docs.get(p.documentId);
        if (
          !doc ||
          p.version !== doc.version ||
          (p.folderId !== undefined && !scope.folders.some((folder) => folder.id === p.folderId)) ||
          (p.tagIds !== undefined &&
            (!Array.isArray(p.tagIds) ||
              p.tagIds.length > 20 ||
              !p.tagIds.every((id) => tags.has(id)))) ||
          (!p.folderId && !p.tagIds?.length)
        )
          throw refuse();
        return {
          documentId: doc.id,
          contentHash: doc.content_hash,
          placement: p.folderId ? { kind: "folder", folderId: p.folderId } : { kind: "unchanged" },
          tags: [...new Set(p.tagIds)].map((tagId) => {
            const kind = kindOfId(tagId);
            return kind ? { kind } : { tagId };
          }),
        };
      });
      return propose({ origin: "agent", agent }, rows);
    },
  };
}

export type AgentSorting = ReturnType<typeof createAgentSorting>;
