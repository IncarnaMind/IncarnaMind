import type { MessageKey, MessageParams } from "../../shared/i18n";
import { targetHash } from "../../shared/proposals";
import { estimateTokens } from "../answers/context";
import type { DocumentKind } from "../api";
import { InvalidInputError } from "../errors";
import type { Language } from "../language";
import { ORGANIZE_PASSAGES } from "../library/excerpt";
import type { OrganizeReviewProposal, OrganizeReviewRun } from "../organizeReview";
import type { Database } from "../storage";
import { offeredKinds } from "../tags/about";
import { BATCH_EXCERPT_TOKENS, excerptFromPassages, kindId, kindOfId } from "../tags/classify";
import { kindName } from "../tags/kinds";
import { READ_PART_TOKENS } from "./access";
import { AgentRefusedError } from "./refusals";

/**
 * The most Documents one list_sorting answer holds and one propose_sorting call takes. An answer
 * holds fewer when its excerpts reach `READ_PART_TOKENS`, so a small Library comes whole and a
 * group is never split across pages by a count (#3626).
 */
export const SORTING_MOST = 40;

type Choice = { id: string; name: string };
type Waiting = Choice & { kind: DocumentKind; version: string; folderId: string | null };
type Scope = { documents: string[]; folders: Choice[]; shareTagNames: boolean };

/** What propose_sorting took: how many wait now, and, past `SORTING_MOST`, what to send again. */
export interface SortingTaken {
  waiting: number;
  left?: string;
}

export interface SortingBatch {
  documents: (Waiting & { text: string })[];
  /** How many wait in all, on every page (#3610). */
  total: number;
  folders: Choice[];
  tags: Choice[];
  next: string | null;
}

/** Neither a Folder nor a Tag: nothing fits the Document, and nothing waits for it. */
export interface SortingProposal {
  documentId: string;
  version: string;
  folderId?: string;
  /** A Folder's name, made at Confirm where the Document is now (#3610). */
  newFolder?: string;
  tagIds?: string[];
  /** Tags' names, made at Confirm (#3610). */
  newTags?: string[];
}

const MAX_TAGS = 20;

export function createAgentSorting(
  db: Database,
  language: () => Language,
  propose: (run: OrganizeReviewRun, rows: OrganizeReviewProposal[]) => number,
  say: (key: MessageKey, values?: MessageParams) => string,
) {
  const refuse = () => new AgentRefusedError("invalid", say("agents.sorting.invalid"));
  const WAITING = `FROM documents d
       LEFT JOIN document_groups g ON g.document_id = d.id AND g.deleted_at IS NULL
       WHERE d.id IN (SELECT value FROM json_each(?)) AND d.deleted_at IS NULL
         AND d.meeting_mind_id IS NULL AND d.status IN ('ready', 'embedding', 'waiting-for-model')
         AND (g.id IS NULL OR g.status IN ('waiting','pending','failed')
              OR d.tagging_status IN ('pending','waiting-for-provider','off','failed'))
         AND NOT EXISTS (SELECT 1 FROM organize_review_items i WHERE i.document_id = d.id
             AND i.deleted_at IS NULL AND (i.state = 'open' OR i.content_hash IS d.content_hash))`;
  function waiting(ids: string[], after: string, most: number) {
    const rows = db.all<Waiting & { content_hash: string | null }>(
      `SELECT d.id, d.name, d.kind, d.content_hash, g.group_id AS folderId,
              coalesce(g.request_id, '') AS version
       ${WAITING} AND d.id > ? ORDER BY d.id LIMIT ?`,
      [JSON.stringify(ids), after, BigInt(most)],
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
      const rows = waiting(scope.documents, after, SORTING_MOST + 1);
      const total =
        db.get<{ total: number }>(`SELECT count(*) AS total ${WAITING}`, [
          JSON.stringify(scope.documents),
        ])?.total ?? 0;
      const tags = choices(scope);
      // What else the answer carries, and room for a next.
      let size = estimateTokens(
        JSON.stringify({ total, folders: scope.folders, tags, next: rows[0]?.id ?? "" }),
      );
      const documents: SortingBatch["documents"] = [];
      for (const { content_hash: _, ...row } of rows.slice(0, SORTING_MOST)) {
        const passages = db.all<{ text: string }>(
          "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
          [row.id, BigInt(ORGANIZE_PASSAGES)],
        );
        const doc = {
          ...row,
          text: excerptFromPassages(
            passages.map((p) => p.text),
            BATCH_EXCERPT_TOKENS,
          ),
        };
        const cost = estimateTokens(JSON.stringify(doc)) + 1;
        if (documents.length > 0 && size + cost > READ_PART_TOKENS) break;
        documents.push(doc);
        size += cost;
      }
      return {
        documents,
        total,
        folders: scope.folders,
        tags,
        next: rows.length > documents.length ? (documents.at(-1)?.id ?? null) : null,
      };
    },

    /** What it took, and the Documents of the proposals it took. */
    submit(
      scope: Scope,
      agent: string,
      sent: SortingProposal[],
    ): { taken: SortingTaken; documentIds: string[] } {
      if (!Array.isArray(sent) || !sent.length) throw refuse();
      // Past what one call takes, the rest is never refused: the agent is told to send it again
      // (#3626).
      const proposals = sent.slice(0, SORTING_MOST);
      const left = sent.length - proposals.length;
      const allowed = new Set(scope.documents);
      const ids = proposals.map((p) => p?.documentId);
      if (new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) throw refuse();
      const docs = new Map(waiting(ids, "", ids.length).map((doc) => [doc.id, doc]));
      const tags = new Set(choices(scope).map((tag) => tag.id));
      const rows = proposals.flatMap((p): OrganizeReviewProposal[] => {
        const doc = docs.get(p.documentId);
        if (
          !doc ||
          p.version !== doc.version ||
          (p.folderId !== undefined && !scope.folders.some((folder) => folder.id === p.folderId)) ||
          (p.folderId !== undefined && p.newFolder !== undefined) ||
          (p.tagIds !== undefined &&
            (!Array.isArray(p.tagIds) ||
              p.tagIds.length > MAX_TAGS ||
              !p.tagIds.every((id) => tags.has(id)))) ||
          (p.newTags !== undefined && (!Array.isArray(p.newTags) || p.newTags.length > MAX_TAGS))
        )
          throw refuse();
        const proposed: OrganizeReviewProposal = {
          documentId: doc.id,
          contentHash: doc.content_hash,
          // As the Library's own Organize makes them: at the top level for a Document in no
          // Folder, inside the Folder of one in a Folder.
          placement: p.folderId
            ? { kind: "folder", folderId: p.folderId }
            : p.newFolder !== undefined
              ? { kind: "newFolder", name: p.newFolder, description: "", parentId: doc.folderId }
              : { kind: "unchanged" },
          tags: [
            ...[...new Set(p.tagIds)].map((tagId) => {
              const kind = kindOfId(tagId);
              return kind ? { kind } : { tagId };
            }),
            ...(p.newTags ?? []).map((name) => ({ name, description: "" })),
          ],
        };
        return proposed.placement.kind === "unchanged" && proposed.tags.length === 0
          ? []
          : [proposed];
      });
      const taken = (waiting: number) => ({
        taken: {
          waiting,
          ...(left > 0 && {
            left: say(left === 1 ? "agents.sorting.left.one" : "agents.sorting.left.other", {
              count: left,
              total: sent.length,
            }),
          }),
        },
        documentIds: ids,
      });
      if (!rows.length) return taken(0);
      try {
        return taken(propose({ origin: "agent", agent }, rows));
      } catch (error) {
        // A name the Library can't take, in the words the User's own form gives.
        if (error instanceof InvalidInputError && error.wording)
          throw new AgentRefusedError("invalid", say(error.wording.key, error.wording.values));
        throw error;
      }
    },
  };
}

export type AgentSorting = ReturnType<typeof createAgentSorting>;
