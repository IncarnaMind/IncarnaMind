import type { MessageKey, MessageParams } from "../../shared/i18n";
import { sameName } from "../../shared/names";
import { targetHash } from "../../shared/proposals";
import { estimateTokens, head } from "../answers/context";
import type { DocumentKind } from "../api";
import { InvalidInputError } from "../errors";
import type { Language } from "../language";
import {
  bestClustering,
  CLEAR,
  CLUSTERS,
  type Clustering,
  centred,
  dot,
  nearestMembers,
  SAMPLE,
  silhouette,
} from "../library/plan";
import { storedDocumentVectors } from "../library/vectors";
import type { OrganizeReviewProposal, OrganizeReviewRun } from "../organizeReview";
import type { OrganizeReviewFolder } from "../organizeReview/types";
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
/** Floor for per-Document excerpt sizing when fitting a large-Library batch onto one page (#2737). */
const MIN_EXCERPT_TOKENS = 60;
const EXCERPT_PASSAGES = 6;

type Choice = { id: string; name: string };
type Waiting = {
  id: string;
  name: string;
  kind: DocumentKind;
  version: string;
  folderId: string | null;
};
type WaitingRow = Waiting & {
  content_hash: string | null;
  status: string;
  embedding_model: string | null;
  assignmentSource: string | null;
};
type Scope = {
  pairingId: string;
  documents: string[];
  folders: Choice[];
  shareTagNames: boolean;
};

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

type SamplePlacement =
  | { kind: "folder"; folderId: string }
  | { kind: "newFolder"; name: string; description: string; parentId: string | null };

interface LargeSession {
  scopeKey: string;
  ids: string[];
  indexById: Map<string, number>;
  /** Each Document's version when its vector was read into this session. */
  versions: Map<string, string>;
  vectors: Float32Array[];
  clustering: Clustering;
  sampleIds: string[];
  sampleSet: Set<string>;
  sampleDecisions: Map<string, SamplePlacement | null>;
  servedAllSample: boolean;
  propagated: boolean;
  roundPool: string[] | null;
  /** Documents served in the current round, keyed by id -> served version. */
  servedVersions: Map<string, string>;
  submittedInRound: boolean;
  /** Documents omitted from a submitted round in this request, keyed by id -> served version. */
  skipped: Map<string, string>;
}

const MAX_TAGS = 20;

const samePlacement = (a: SamplePlacement, b: SamplePlacement): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "folder" && b.kind === "folder") return a.folderId === b.folderId;
  if (a.kind === "newFolder" && b.kind === "newFolder") {
    return (
      a.parentId === b.parentId &&
      sameName(a.name.trim().replace(/\s+/g, " "), b.name.trim().replace(/\s+/g, " "))
    );
  }
  return false;
};

/**
 * Picks `total` Documents proportionally across clusters (largest-remainder), keeping at least one
 * from each non-empty cluster while `members.length <= total`, ordered round-robin from largest
 * cluster to smallest so major areas appear in proportion instead of small clusters taking slots.
 */
function proportionalSample(members: readonly number[][], total: number): number[] {
  const nonEmpty = members
    .map((cluster, at) => ({ cluster, at }))
    .filter(({ cluster }) => cluster.length > 0)
    .sort((a, b) => b.cluster.length - a.cluster.length || a.at - b.at);
  const count = nonEmpty.reduce((sum, { cluster }) => sum + cluster.length, 0);
  if (count <= total) return nonEmpty.flatMap(({ cluster }) => cluster);
  const quotas = nonEmpty.map(({ cluster }) => {
    const exact = (cluster.length / count) * total;
    const base = Math.min(
      cluster.length,
      Math.max(nonEmpty.length <= total ? 1 : 0, Math.floor(exact)),
    );
    return { cluster, exact, quota: base };
  });
  let assigned = quotas.reduce((sum, entry) => sum + entry.quota, 0);
  while (assigned > total) {
    const pick = quotas
      .filter((entry) => entry.quota > 1)
      .sort((a, b) => a.exact - a.quota - (b.exact - b.quota))[0];
    if (!pick) break;
    pick.quota--;
    assigned--;
  }
  while (assigned < total) {
    const pick = quotas
      .filter((entry) => entry.quota < entry.cluster.length)
      .sort((a, b) => b.exact - b.quota - (a.exact - a.quota))[0];
    if (!pick) break;
    pick.quota++;
    assigned++;
  }
  const out: number[] = [];
  for (let round = 0; out.length < total; round++) {
    let took = false;
    for (const { cluster, quota } of quotas) {
      if (round >= quota) continue;
      const at = cluster[round];
      if (at === undefined) continue;
      out.push(at);
      took = true;
      if (out.length === total) break;
    }
    if (!took) break;
  }
  return out;
}

export function createAgentSorting(
  db: Database,
  language: () => Language,
  propose: (run: OrganizeReviewRun, rows: OrganizeReviewProposal[]) => number,
  say: (key: MessageKey, values?: MessageParams) => string,
  options?: {
    offeredFolders?: () => OrganizeReviewFolder[];
    embedding?: { enabled(): boolean; readonly id: string };
  },
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

  const sessions = new Map<string, LargeSession>();
  const MAX_SESSIONS = 8;

  const hydrate = (rows: WaitingRow[]): WaitingRow[] =>
    rows.map((row) => ({
      ...row,
      version: targetHash(JSON.stringify([row.id, row.name, row.content_hash, row.version])),
    }));

  function waiting(ids: string[], after: string, most: number): WaitingRow[] {
    return hydrate(
      db.all<WaitingRow>(
        `SELECT d.id, d.name, d.kind, d.content_hash, d.status, d.embedding_model,
                g.group_id AS folderId, g.source AS assignmentSource,
                coalesce(g.request_id, '') AS version
         ${WAITING} AND d.id > ? ORDER BY d.id LIMIT ?`,
        [JSON.stringify(ids), after, BigInt(most)],
      ),
    );
  }

  function allWaiting(ids: string[]): WaitingRow[] {
    return hydrate(
      db.all<WaitingRow>(
        `SELECT d.id, d.name, d.kind, d.content_hash, d.status, d.embedding_model,
                g.group_id AS folderId, g.source AS assignmentSource,
                coalesce(g.request_id, '') AS version
         ${WAITING} ORDER BY d.id`,
        [JSON.stringify(ids)],
      ),
    );
  }

  const scopeKeyOf = (scope: Scope) =>
    targetHash(JSON.stringify([scope.pairingId, ...[...scope.documents].sort()]));

  function hasOpenReviewInScope(scope: Scope): boolean {
    return !!db.get(
      `SELECT 1 FROM organize_review_items i
       WHERE i.state = 'open' AND i.deleted_at IS NULL
         AND i.document_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
      [JSON.stringify(scope.documents)],
    );
  }

  /**
   * Open proposed Folders already waiting in Suggestions for Documents inside `scope`, never
   * exposing proposed Folders from outside the pairing's reach.
   */
  function scopedOfferedFolders(scope: Scope): OrganizeReviewFolder[] {
    if (!options?.offeredFolders) return [];
    const liveIds = new Set(scope.folders.map((folder) => folder.id));
    const scopeJson = JSON.stringify(scope.documents);
    return options.offeredFolders().filter((folder) => {
      if (folder.parentNewFolderId !== null) return false;
      if (folder.parentId !== null && !liveIds.has(folder.parentId)) return false;
      if (scope.folders.some((live) => sameName(live.name, folder.name))) return false;
      return !!db.get(
        `SELECT 1 FROM organize_review_items i
         WHERE i.folder_id = ? AND i.placement = 'newFolder'
           AND i.state = 'open' AND i.deleted_at IS NULL
           AND i.document_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
        [folder.id, scopeJson],
      );
    });
  }

  function folderChoices(scope: Scope, includeOffered: boolean): Choice[] {
    if (!includeOffered) return scope.folders;
    const offered = scopedOfferedFolders(scope).map(({ id, name }) => ({ id, name }));
    return [...scope.folders, ...offered];
  }

  function choices(scope: Scope): Choice[] {
    const kinds: Choice[] = offeredKinds(db).map((kind) => ({
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

  function startLargeSession(scopeKey: string, rows: WaitingRow[]): LargeSession {
    const vectors = centred(storedDocumentVectors(db, rows, options?.embedding));
    const most = Math.min(CLUSTERS.max, Math.floor(vectors.length / 5));
    const clustering = bestClustering(vectors, CLUSTERS.min, most);
    const sampleIndices = proportionalSample(
      nearestMembers(vectors, clustering, vectors.length),
      Math.min(SORTING_MOST, vectors.length),
    );
    const ids = rows.map((row) => row.id);
    const sampleIds = sampleIndices.map((at) => ids[at] as string);
    return {
      scopeKey,
      ids,
      indexById: new Map(ids.map((id, at) => [id, at])),
      versions: new Map(rows.map((row) => [row.id, row.version])),
      vectors,
      clustering,
      sampleIds,
      sampleSet: new Set(sampleIds),
      sampleDecisions: new Map(),
      servedAllSample: false,
      propagated: false,
      roundPool: null,
      servedVersions: new Map(),
      submittedInRound: false,
      skipped: new Map(),
    };
  }

  function buildBatch(
    rows: WaitingRow[],
    after: string,
    total: number,
    folders: Choice[],
    tags: Choice[],
    compact = false,
    order?: readonly string[],
  ): SortingBatch {
    let start = 0;
    if (after !== "") {
      if (order) {
        const cursorPos = order.indexOf(after);
        if (cursorPos >= 0) {
          const posById = new Map(order.map((id, idx) => [id, idx]));
          const nextIdx = rows.findIndex((row) => (posById.get(row.id) ?? -1) > cursorPos);
          start = nextIdx >= 0 ? nextIdx : rows.length;
        } else {
          const at = rows.findIndex((row) => row.id === after);
          start = at >= 0 ? at + 1 : 0;
        }
      } else {
        const nextIdx = rows.findIndex((row) => row.id > after);
        start = nextIdx >= 0 ? nextIdx : rows.length;
      }
    }
    const slice = rows.slice(start, start + SORTING_MOST + 1);
    const pageRows = slice.slice(0, SORTING_MOST);
    let size = estimateTokens(JSON.stringify({ total, folders, tags, next: slice[0]?.id ?? "" }));
    const perDocBudget =
      compact && pageRows.length > 0
        ? Math.floor((READ_PART_TOKENS - size) / pageRows.length)
        : null;
    const documents: SortingBatch["documents"] = [];
    for (const {
      content_hash: _h,
      status: _s,
      embedding_model: _e,
      assignmentSource: _a,
      ...row
    } of pageRows) {
      const passages = db.all<{ text: string }>(
        "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
        [row.id, BigInt(EXCERPT_PASSAGES)],
      );
      const fullText = excerptFromPassages(
        passages.map((p) => p.text),
        BATCH_EXCERPT_TOKENS,
      );
      let text = fullText;
      if (perDocBudget !== null) {
        const metaCost = estimateTokens(JSON.stringify({ ...row, text: "" })) + 5;
        let textCap = Math.max(MIN_EXCERPT_TOKENS, perDocBudget - metaCost);
        if (estimateTokens(fullText) > textCap) text = head(fullText, textCap);
        while (
          estimateTokens(JSON.stringify({ ...row, text })) + 1 > perDocBudget &&
          textCap > MIN_EXCERPT_TOKENS
        ) {
          textCap = Math.max(MIN_EXCERPT_TOKENS, textCap - 15);
          text = head(fullText, textCap);
        }
      }
      const doc = { ...row, text };
      const cost = estimateTokens(JSON.stringify(doc)) + 1;
      if (documents.length > 0 && size + cost > READ_PART_TOKENS) break;
      documents.push(doc);
      size += cost;
    }
    return {
      documents,
      total,
      folders,
      tags,
      next: slice.length > documents.length ? (documents.at(-1)?.id ?? null) : null,
    };
  }

  /** Step 4 of Organize's planner (../library/plan): copy unanimous Folder placements locally, never Tags. */
  function propagateFromSample(
    active: LargeSession,
    waitingNow: WaitingRow[],
    liveFolders: ReadonlySet<string>,
  ): number {
    const { clustering, vectors, ids, sampleSet, sampleDecisions, versions } = active;
    const sampledIndices = ids
      .map((id, at) => (sampleSet.has(id) ? at : -1))
      .filter((at) => at >= 0);

    const clusterPlace: (SamplePlacement | null)[] = clustering.centres.map((_, cluster) => {
      const members = sampledIndices.filter((at) => clustering.assignment[at] === cluster);
      if (members.length === 0) return null;
      const decisions = members.map((at) => sampleDecisions.get(ids[at] as string) ?? null);
      const first = decisions[0];
      if (!first) return null;
      if (!decisions.every((d) => d !== null && samePlacement(d, first))) return null;
      return first;
    });

    const propagatedRows: OrganizeReviewProposal[] = [];
    for (const doc of waitingNow) {
      if (sampleSet.has(doc.id)) continue;
      if (doc.assignmentSource === "user") continue;
      if (active.skipped.get(doc.id) === doc.version) continue;
      if (versions.get(doc.id) !== doc.version) continue;
      const at = active.indexById.get(doc.id);
      if (at === undefined) continue;
      const own = clustering.assignment[at] ?? 0;
      const place = clusterPlace[own];
      if (!place) continue;
      if (place.kind === "folder" && !liveFolders.has(place.folderId)) continue;
      if (place.kind === "newFolder" && place.parentId !== null && !liveFolders.has(place.parentId))
        continue;
      const elsewhere = clustering.centres.filter((_, cluster) => {
        const other = clusterPlace[cluster];
        return cluster !== own && !(other && samePlacement(other, place));
      });
      const vector = vectors[at] as Float32Array;
      let nearest = -1;
      let bestSim = Number.NEGATIVE_INFINITY;
      for (const sampled of sampledIndices) {
        const sim = dot(vector, vectors[sampled] as Float32Array);
        if (sim > bestSim) {
          bestSim = sim;
          nearest = sampled;
        }
      }
      const nearestDecision = nearest >= 0 ? sampleDecisions.get(ids[nearest] as string) : null;
      if (
        silhouette(vector, clustering.centres[own] as Float32Array, elsewhere) < CLEAR ||
        !nearestDecision ||
        !samePlacement(nearestDecision, place)
      )
        continue;
      propagatedRows.push({
        documentId: doc.id,
        contentHash: doc.content_hash,
        placement: place,
        tags: [],
      });
    }
    if (propagatedRows.length === 0) return 0;
    // Marked as IncarnaMind's own Suggestions (not the agent's) and subject to the user-filed guard.
    return propose({ origin: "library" }, propagatedRows);
  }

  return {
    list(scope: Scope, after = ""): SortingBatch {
      if (typeof after !== "string" || after.length > 100) throw refuse();
      const key = scopeKeyOf(scope);
      const all = allWaiting(scope.documents);

      let session = sessions.get(key) ?? null;
      if (session && (all.length === 0 || (session.propagated && !hasOpenReviewInScope(scope)))) {
        sessions.delete(key);
        session = null;
      }

      if (!session && all.length > SAMPLE) {
        if (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest !== undefined) sessions.delete(oldest);
        }
        session = startLargeSession(key, all);
        sessions.set(key, session);
      }

      if (session) {
        if (after === "" && session.servedVersions.size > 0) {
          if (session.submittedInRound) {
            const waitingById = new Map(all.map((row) => [row.id, row]));
            for (const [servedId, servedVersion] of session.servedVersions) {
              const still = waitingById.get(servedId);
              if (still && still.version === servedVersion) {
                session.skipped.set(servedId, servedVersion);
              }
            }
            session.servedVersions.clear();
            session.submittedInRound = false;
            session.roundPool = null;
            if (!session.propagated && session.servedAllSample) {
              session.propagated = true;
            }
          } else {
            // Fresh list from the top without a submission resets skipped state for the new request.
            session.skipped.clear();
            session.roundPool = null;
          }
        }
        const remaining = all.filter((row) => session?.skipped.get(row.id) !== row.version);
        if (remaining.length === 0) {
          sessions.delete(key);
          return {
            documents: [],
            total: 0,
            folders: folderChoices(scope, true),
            tags: choices(scope),
            next: null,
          };
        }
        const remainingById = new Map(remaining.map((row) => [row.id, row]));
        let pool: WaitingRow[];
        let order: readonly string[];
        if (!session.propagated) {
          order = session.sampleIds;
          pool = session.sampleIds.flatMap((id) => {
            const row = remainingById.get(id);
            return row ? [row] : [];
          });
        } else {
          if (after === "" || !session.roundPool) {
            // Group remaining Documents by cluster index, capped to one batch.
            const ordered = [...remaining].sort((a, b) => {
              const cA = session?.clustering.assignment[session.indexById.get(a.id) ?? -1] ?? 0;
              const cB = session?.clustering.assignment[session.indexById.get(b.id) ?? -1] ?? 0;
              return cA !== cB ? cA - cB : a.id.localeCompare(b.id);
            });
            session.roundPool = ordered.slice(0, SORTING_MOST).map((row) => row.id);
          }
          order = session.roundPool;
          pool = session.roundPool.flatMap((id) => {
            const row = remainingById.get(id);
            return row ? [row] : [];
          });
        }
        const batch = buildBatch(
          pool,
          after,
          remaining.length,
          folderChoices(scope, session.propagated),
          choices(scope),
          true,
          order,
        );
        if (after === "") session.servedVersions.clear();
        for (const doc of batch.documents) session.servedVersions.set(doc.id, doc.version);
        if (!session.propagated && batch.next === null) session.servedAllSample = true;
        return batch;
      }

      return buildBatch(all, after, all.length, scope.folders, choices(scope));
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
      const liveFolders = new Set(scope.folders.map((folder) => folder.id));
      const offeredById = new Map(scopedOfferedFolders(scope).map((folder) => [folder.id, folder]));
      const active = sessions.get(scopeKeyOf(scope)) ?? null;

      const sampleUpdates: [string, SamplePlacement | null][] = [];
      const rows = proposals.flatMap((p): OrganizeReviewProposal[] => {
        const doc = docs.get(p.documentId);
        const offered = p.folderId !== undefined ? offeredById.get(p.folderId) : undefined;
        if (
          !doc ||
          p.version !== doc.version ||
          (p.folderId !== undefined && !liveFolders.has(p.folderId) && !offered) ||
          (p.folderId !== undefined && p.newFolder !== undefined) ||
          (p.tagIds !== undefined &&
            (!Array.isArray(p.tagIds) ||
              p.tagIds.length > MAX_TAGS ||
              !p.tagIds.every((id) => tags.has(id)))) ||
          (p.newTags !== undefined && (!Array.isArray(p.newTags) || p.newTags.length > MAX_TAGS))
        )
          throw refuse();

        const placement: OrganizeReviewProposal["placement"] = offered
          ? {
              kind: "newFolder",
              name: offered.name,
              description: offered.description,
              parentId: offered.parentId,
            }
          : p.folderId
            ? { kind: "folder", folderId: p.folderId }
            : p.newFolder !== undefined
              ? { kind: "newFolder", name: p.newFolder, description: "", parentId: doc.folderId }
              : { kind: "unchanged" };

        const resolvedTags = [
          ...[...new Set(p.tagIds)].map((tagId) => {
            const kind = kindOfId(tagId);
            return kind ? { kind } : { tagId };
          }),
          ...(p.newTags ?? []).map((name) => ({ name, description: "" })),
        ];

        if (
          active &&
          !active.propagated &&
          active.sampleSet.has(doc.id) &&
          active.versions.get(doc.id) === doc.version
        ) {
          sampleUpdates.push([
            doc.id,
            placement.kind === "folder"
              ? { kind: "folder", folderId: placement.folderId }
              : placement.kind === "newFolder"
                ? {
                    kind: "newFolder",
                    name: placement.name,
                    description: placement.description,
                    parentId: placement.parentId ?? null,
                  }
                : null,
          ]);
        }

        if (placement.kind === "unchanged" && resolvedTags.length === 0) {
          if (active) {
            return [
              {
                documentId: doc.id,
                contentHash: doc.content_hash,
                placement: { kind: "leftOut", leftOut: { reason: "doesntFit" } },
                tags: [],
              },
            ];
          }
          return [];
        }
        return [
          {
            documentId: doc.id,
            contentHash: doc.content_hash,
            placement,
            tags: resolvedTags,
          },
        ];
      });

      let written = 0;
      if (rows.length > 0) {
        try {
          written = propose({ origin: "agent", agent }, rows);
        } catch (error) {
          // A name the Library can't take, in the words the User's own form gives.
          if (error instanceof InvalidInputError && error.wording)
            throw new AgentRefusedError("invalid", say(error.wording.key, error.wording.values));
          throw error;
        }
      }

      if (active) {
        active.submittedInRound = true;
        for (const [docId, decision] of sampleUpdates) active.sampleDecisions.set(docId, decision);
        if (
          !active.propagated &&
          left === 0 &&
          active.servedAllSample &&
          active.sampleDecisions.size >= Math.ceil(active.sampleIds.length * 0.5)
        ) {
          const waitingNow = allWaiting(scope.documents);
          const waitingById = new Map(waitingNow.map((row) => [row.id, row]));
          for (const sampleId of active.sampleIds) {
            const still = waitingById.get(sampleId);
            const servedVersion = active.servedVersions.get(sampleId);
            if (
              still &&
              servedVersion !== undefined &&
              still.version === servedVersion &&
              !active.sampleDecisions.has(sampleId)
            ) {
              active.skipped.set(still.id, servedVersion);
            }
          }
          try {
            written += propagateFromSample(active, waitingNow, liveFolders);
          } catch (error) {
            console.error("Couldn't propagate agent sorting sample.", error);
          }
          active.propagated = true;
        }
      }

      let leftMessage: string | undefined;
      if (left > 0) {
        leftMessage = say(left === 1 ? "agents.sorting.left.one" : "agents.sorting.left.other", {
          count: left,
          total: sent.length,
        });
      } else if (active) {
        const waitingAfter = allWaiting(scope.documents).filter(
          (row) =>
            active.skipped.get(row.id) !== row.version &&
            active.servedVersions.get(row.id) !== row.version,
        );
        if (waitingAfter.length > 0) {
          leftMessage = say(
            waitingAfter.length === 1
              ? "agents.sorting.moreWaiting.one"
              : "agents.sorting.moreWaiting.other",
            { count: waitingAfter.length },
          );
        }
      }

      return {
        taken: {
          waiting: written,
          ...(leftMessage && { left: leftMessage }),
        },
        documentIds: ids,
      };
    },
  };
}

export type AgentSorting = ReturnType<typeof createAgentSorting>;
