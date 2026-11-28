import type { MessageKey, MessageParams } from "../../shared/i18n";
import { sameName } from "../../shared/names";
import { targetHash } from "../../shared/proposals";
import { estimateTokens, head } from "../answers/context";
import type { DocumentKind } from "../api";
import { InvalidInputError } from "../errors";
import type { Language } from "../language";
import { documentOutline, ORGANIZE_PASSAGES, storedOrganizeUnits } from "../library/excerpt";
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
import { KIND_MEANINGS, kindName, type TagKind } from "../tags/kinds";
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

type Choice = { id: string; name: string };
type TagChoice = Choice & { description?: string };
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
};
type Scope = { documents: string[]; folders: Choice[]; shareTagNames: boolean };

/** What propose_sorting took: how many wait now, and, past `SORTING_MOST`, what to send again. */
export interface SortingTaken {
  waiting: number;
  left?: string;
}

export interface SortingBatch {
  documents: (Waiting & { outline?: string; text: string })[];
  /** How many wait in all, on every page (#3610). */
  total: number;
  folders: Choice[];
  tags: TagChoice[];
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

interface SampleDecision {
  folderKey: string | null;
  placement:
    | { kind: "folder"; folderId: string }
    | { kind: "newFolder"; name: string; description: string }
    | null;
  kind: TagKind | null;
}

interface LargeSession {
  scopeKey: string;
  ids: string[];
  indexById: Map<string, number>;
  vectors: Float32Array[];
  clustering: Clustering;
  sampleIds: string[];
  sampleSet: Set<string>;
  sampleDecisions: Map<string, SampleDecision>;
  servedAllSample: boolean;
  propagated: boolean;
  lastAgent: string | null;
  roundPool: string[] | null;
  servedIds: Set<string>;
  submittedInRound: boolean;
  /** Documents explicitly omitted from a submitted round, keyed by id -> version. */
  skipped: Map<string, string>;
}

const MAX_TAGS = 20;

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

const folderNameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

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
                g.group_id AS folderId, coalesce(g.request_id, '') AS version
         ${WAITING} AND d.id > ? ORDER BY d.id LIMIT ?`,
        [JSON.stringify(ids), after, BigInt(most)],
      ),
    );
  }

  function allWaiting(ids: string[]): WaitingRow[] {
    return hydrate(
      db.all<WaitingRow>(
        `SELECT d.id, d.name, d.kind, d.content_hash, d.status, d.embedding_model,
                g.group_id AS folderId, coalesce(g.request_id, '') AS version
         ${WAITING} ORDER BY d.id`,
        [JSON.stringify(ids)],
      ),
    );
  }

  const scopeKeyOf = (scope: Scope) => targetHash(JSON.stringify([...scope.documents].sort()));

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

  function choices(scope: Scope): TagChoice[] {
    const kinds: TagChoice[] = offeredKinds(db).map((kind) => ({
      id: kindId(kind),
      name: kindName(kind, language()),
      description: KIND_MEANINGS[kind],
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

  function outlineOf(id: string, kind: DocumentKind, contentHash: string | null): string | null {
    if (kind !== "pptx" && kind !== "xlsx") return null;
    return documentOutline({ kind, units: storedOrganizeUnits(db, id, contentHash) });
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
      vectors,
      clustering,
      sampleIds,
      sampleSet: new Set(sampleIds),
      sampleDecisions: new Map(),
      servedAllSample: false,
      propagated: false,
      lastAgent: null,
      roundPool: null,
      servedIds: new Set(),
      submittedInRound: false,
      skipped: new Map(),
    };
  }

  function buildBatch(
    rows: WaitingRow[],
    after: string,
    total: number,
    folders: Choice[],
    tags: TagChoice[],
    compact = false,
  ): SortingBatch {
    let start = 0;
    if (after !== "") {
      const at = rows.findIndex((row) => row.id === after);
      start = at >= 0 ? at + 1 : 0;
    }
    const slice = rows.slice(start, start + SORTING_MOST + 1);
    const pageRows = slice.slice(0, SORTING_MOST);
    // What else the answer carries, and room for a next.
    let size = estimateTokens(JSON.stringify({ total, folders, tags, next: slice[0]?.id ?? "" }));
    const perDocBudget =
      compact && pageRows.length > 0
        ? Math.floor((READ_PART_TOKENS - size) / pageRows.length)
        : null;
    const documents: SortingBatch["documents"] = [];
    for (const { content_hash, status: _s, embedding_model: _e, ...row } of pageRows) {
      const passages = db.all<{ text: string }>(
        "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
        [row.id, BigInt(ORGANIZE_PASSAGES)],
      );
      const outline = outlineOf(row.id, row.kind, content_hash);
      const fullText = excerptFromPassages(
        passages.map((p) => p.text),
        BATCH_EXCERPT_TOKENS,
      );
      let text = fullText;
      if (perDocBudget !== null) {
        const metaCost =
          estimateTokens(JSON.stringify({ ...row, ...(outline ? { outline } : {}), text: "" })) + 5;
        let textCap = Math.max(MIN_EXCERPT_TOKENS, perDocBudget - metaCost);
        if (estimateTokens(fullText) > textCap) text = head(fullText, textCap);
        while (
          estimateTokens(JSON.stringify({ ...row, ...(outline ? { outline } : {}), text })) + 1 >
            perDocBudget &&
          textCap > MIN_EXCERPT_TOKENS
        ) {
          textCap = Math.max(MIN_EXCERPT_TOKENS, textCap - 15);
          text = head(fullText, textCap);
        }
      }
      const doc = {
        ...row,
        ...(outline ? { outline } : {}),
        text,
      };
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

  /** Step 4 of Organize's planner (../library/plan): propagate unanimous, clear clusters locally. */
  function propagateFromSample(
    active: LargeSession,
    agent: string,
    waitingNow: WaitingRow[],
  ): number {
    const { clustering, vectors, ids, sampleSet, sampleDecisions } = active;
    const sampledIndices = ids
      .map((id, at) => (sampleSet.has(id) ? at : -1))
      .filter((at) => at >= 0);

    const clusterPlace: (SampleDecision | null)[] = clustering.centres.map((_, cluster) => {
      const members = sampledIndices.filter((at) => clustering.assignment[at] === cluster);
      if (members.length === 0) return null;
      const decisions = members.map((at) => sampleDecisions.get(ids[at] as string) ?? null);
      const first = decisions[0];
      if (!first?.folderKey || !first.placement) return null;
      if (!decisions.every((d) => d?.folderKey === first.folderKey)) return null;
      const unanimousKind =
        first.kind !== null && decisions.every((d) => d?.kind === first.kind) ? first.kind : null;
      return { folderKey: first.folderKey, placement: first.placement, kind: unanimousKind };
    });

    const propagatedRows: OrganizeReviewProposal[] = [];
    for (const doc of waitingNow) {
      if (sampleSet.has(doc.id)) continue;
      if (active.skipped.get(doc.id) === doc.version) continue;
      const at = active.indexById.get(doc.id);
      if (at === undefined) continue;
      const own = clustering.assignment[at] ?? 0;
      const place = clusterPlace[own];
      if (!place?.placement || !place.folderKey) continue;
      const elsewhere = clustering.centres.filter((_, cluster) => {
        const other = clusterPlace[cluster];
        return cluster !== own && other?.folderKey !== place.folderKey;
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
        nearestDecision?.folderKey !== place.folderKey
      )
        continue;
      const placement: OrganizeReviewProposal["placement"] =
        place.placement.kind === "folder"
          ? { kind: "folder", folderId: place.placement.folderId }
          : {
              kind: "newFolder",
              name: place.placement.name,
              description: place.placement.description,
              parentId: doc.folderId,
            };
      propagatedRows.push({
        documentId: doc.id,
        contentHash: doc.content_hash,
        placement,
        tags: place.kind ? [{ kind: place.kind }] : [],
      });
    }
    if (propagatedRows.length === 0) return 0;
    return propose({ origin: "agent", agent }, propagatedRows);
  }

  return {
    list(scope: Scope, after = ""): SortingBatch {
      if (typeof after !== "string" || after.length > 100) throw refuse();
      const key = scopeKeyOf(scope);
      const all = allWaiting(scope.documents);

      // Drop stale large-Library session when nothing waits or Review was cleared.
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
        // Documents from the previous served batch that remained unproposed when the agent asks
        // for the next batch were intentionally left out: skip them so they never loop.
        if (after === "" && session.submittedInRound && session.servedIds.size > 0) {
          const waitingById = new Map(all.map((row) => [row.id, row]));
          for (const servedId of session.servedIds) {
            const still = waitingById.get(servedId);
            if (still) session.skipped.set(still.id, still.version);
          }
          session.servedIds.clear();
          session.submittedInRound = false;
          session.roundPool = null;
          if (
            !session.propagated &&
            session.servedAllSample &&
            session.sampleDecisions.size > 0 &&
            session.lastAgent !== null
          ) {
            propagateFromSample(session, session.lastAgent, all);
            session.propagated = true;
          }
        }
        const currentAll = session.propagated ? allWaiting(scope.documents) : all;
        const remaining = currentAll.filter((row) => session?.skipped.get(row.id) !== row.version);
        if (remaining.length === 0) {
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
        if (!session.propagated) {
          pool = session.sampleIds.flatMap((id) => {
            const row = remainingById.get(id);
            return row ? [row] : [];
          });
        } else {
          if (after === "" || !session.roundPool) {
            // Order uncertain remaining Documents by local cluster similarity, capped to one batch.
            const ordered = [...remaining].sort((a, b) => {
              const cA = session?.clustering.assignment[session.indexById.get(a.id) ?? -1] ?? 0;
              const cB = session?.clustering.assignment[session.indexById.get(b.id) ?? -1] ?? 0;
              return cA !== cB ? cA - cB : a.id.localeCompare(b.id);
            });
            session.roundPool = ordered.slice(0, SORTING_MOST).map((row) => row.id);
          }
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
        );
        if (after === "") session.servedIds.clear();
        for (const doc of batch.documents) session.servedIds.add(doc.id);
        if (!session.propagated && batch.next === null) session.servedAllSample = true;
        return batch;
      }

      // Small / medium Library (<= SAMPLE): list every Document in natural order with full excerpts.
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

      const sampleUpdates: [string, SampleDecision][] = [];
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
              parentId: offered.parentId ?? doc.folderId,
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

        if (active && !active.propagated && active.sampleSet.has(doc.id)) {
          const kindTags = resolvedTags.flatMap((t) => ("kind" in t ? [t.kind] : []));
          const folderKey =
            placement.kind === "folder"
              ? `folder:${placement.folderId}`
              : placement.kind === "newFolder"
                ? `new:${folderNameKey(placement.name)}`
                : null;
          sampleUpdates.push([
            doc.id,
            {
              folderKey,
              placement:
                placement.kind === "folder"
                  ? { kind: "folder", folderId: placement.folderId }
                  : placement.kind === "newFolder"
                    ? {
                        kind: "newFolder",
                        name: placement.name,
                        description: placement.description,
                      }
                    : null,
              kind: kindTags.length === 1 ? (kindTags[0] as TagKind) : null,
            },
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
        active.lastAgent = agent;
        for (const [docId, decision] of sampleUpdates) active.sampleDecisions.set(docId, decision);
        if (
          !active.propagated &&
          left === 0 &&
          active.servedAllSample &&
          active.sampleDecisions.size >= Math.ceil(active.sampleIds.length * 0.5)
        ) {
          const waitingNow = allWaiting(scope.documents);
          const waitingById = new Map(waitingNow.map((row) => [row.id, row]));
          // Sampled Documents the agent omitted are left out so they neither propagate nor loop.
          for (const sampleId of active.sampleIds) {
            const still = waitingById.get(sampleId);
            if (still && !active.sampleDecisions.has(sampleId)) {
              active.skipped.set(still.id, still.version);
            }
          }
          written += propagateFromSample(active, agent, waitingNow);
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
        // Count remaining unskipped waiting Documents (excluding any omitted from the round just submitted).
        const waitingAfter = allWaiting(scope.documents).filter(
          (row) => active.skipped.get(row.id) !== row.version && !active.servedIds.has(row.id),
        );
        if (waitingAfter.length > 0) {
          leftMessage = say("agents.sorting.moreWaiting", { count: waitingAfter.length });
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
