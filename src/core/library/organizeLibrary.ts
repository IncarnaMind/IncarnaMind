/**
 * The User's Organize of the whole Library, or of one Folder (Organize This Folder): it waits for
 * the Documents still being read, plans them (./plan) with the User's Organize model, and writes
 * the plan into the Review, where nothing moves before the User confirms it (#1569).
 */
import type {
  CloudReadPermit,
  ExternalService,
  OrganizeLibraryResult,
  OrganizeProgress,
  RunEstimate,
} from "../api";
import { decodeVector } from "../documents/vectors";
import { InvalidInputError, isRecord } from "../errors";
import type { Language } from "../language";
import type { OrganizeReviewProposal, OrganizeReviewRun } from "../organizeReview";
import type { OrganizeReviewOrigin } from "../organizeReview/types";
import { classifyProviderError } from "../providers/providerErrors";
import { gateStop } from "../sendGate";
import type { Database } from "../storage";
import { documentType, excerptFromPassages } from "../tags/classify";
import type { GroupClassifier } from "./classifier";
import { organizeExcerpt, type StoredDocument, storedOrganizeSource } from "./excerpt";
import {
  finishPlan,
  type LibraryPlan,
  meanVector,
  type PlanExcerpt,
  type PlanFolder,
  type PlanRequest,
  planLocally,
  wordVectors,
} from "./plan";
import type { LibraryGroup, LibrarySettings } from "./types";

/** Above this, in US dollars, the run shows its cost first. */
const ASK_ABOVE_USD = 1;
/** How much of each Document the model sees. */
const EXCERPT_TOKENS = 150;
/** How many Passages make a Document's word vector, and its mean of vectors. */
const VECTOR_PASSAGES = 30;
const WAIT_MS = 300;

interface Subject extends StoredDocument {
  status: string;
  embedding_model: string | null;
}

/** A run the core starts for the assistant, beside what the User's own run is given (#1569). */
export interface OwnRun {
  /** Who asked, and the id its Undo takes the proposals back by. */
  run: { origin: OrganizeReviewOrigin; runId: string };
  /** The cloud read the User allowed for this run. */
  permit?: CloudReadPermit;
  signal?: AbortSignal;
  /** The only Folders it may propose, by id. */
  folders?: ReadonlySet<string>;
}

const BEING_READ = new Set(["queued", "extracting"]);
const READABLE = new Set(["ready", "embedding", "waiting-for-model"]);

export function createLibraryOrganizer(options: {
  db: Database;
  folders(): LibraryGroup[];
  settings(): LibrarySettings;
  language(): Language;
  isExampleDocument(id: string): boolean;
  /** The Folder keeping its work inside it that this one is in, or is; null outside walls. */
  wallOf(folderId: string): string | null;
  embedding: { enabled(): boolean; readonly id: string };
  organizeService(settings: LibrarySettings): ExternalService | null;
  prepare(settings: LibrarySettings, permit?: CloudReadPermit): Promise<GroupClassifier>;
  /** What these requests would cost on the Organize model; null for one not billed per token. */
  estimate(settings: LibrarySettings, requests: readonly PlanRequest[]): RunEstimate | null;
  /** The estimate in US dollars, or null when it has no price. */
  inDollars(estimate: RunEstimate): number | null;
  tokensOf(text: string): number;
  propose(run: OrganizeReviewRun, proposals: readonly OrganizeReviewProposal[]): number;
  progress(progress: OrganizeProgress): void;
}) {
  const { db } = options;
  let current: AbortController | null = null;

  const subjectColumns =
    "d.id, d.name, d.kind, d.page_count, d.content_hash, d.status, d.embedding_model";
  const live = "d.deleted_at IS NULL AND d.meeting_mind_id IS NULL";
  const placeOf = (id: string) =>
    db.get<{ group_id: string }>(
      `SELECT a.group_id FROM document_groups a JOIN library_groups g ON g.id = a.group_id
       WHERE a.document_id = ? AND a.deleted_at IS NULL AND g.deleted_at IS NULL`,
      [id],
    )?.group_id ?? null;

  /** The Documents a run organizes, as they are now. */
  const subjectsOf = (input: ParsedInput): Subject[] => {
    const rows = input.documentIds
      ? db.all<Subject>(
          `SELECT ${subjectColumns} FROM documents d
           WHERE ${live} AND d.id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(input.documentIds)],
        )
      : input.folderId
        ? db.all<Subject>(
            `SELECT ${subjectColumns} FROM documents d JOIN document_groups a ON a.document_id = d.id
             WHERE ${live} AND a.deleted_at IS NULL AND a.group_id = ? ORDER BY d.created_at, d.rowid`,
            [input.folderId],
          )
        : db.all<Subject>(
            `SELECT ${subjectColumns} FROM documents d WHERE ${live} AND NOT EXISTS (
               SELECT 1 FROM document_groups a JOIN library_groups g ON g.id = a.group_id
               WHERE a.document_id = d.id AND a.deleted_at IS NULL AND g.deleted_at IS NULL)
             ORDER BY d.created_at, d.rowid`,
          );
    return rows.filter((row) => !options.isExampleDocument(row.id));
  };

  const hasText = (id: string) =>
    !!db.get("SELECT 1 FROM passages WHERE document_id = ? AND deleted_at IS NULL LIMIT 1", [id]);

  const waitsToBeRead = (subject: Subject) =>
    BEING_READ.has(subject.status) ||
    (subject.status === "embedding" && options.embedding.enabled());

  /**
   * Each readable Document's vector: the search embeddings when every one has them from the
   * model in use, else its words. Never the two mixed.
   */
  const vectorsOf = (subjects: readonly Subject[]): Float32Array[] => {
    const { embedding } = options;
    const embedded =
      embedding.enabled() &&
      subjects.every((each) => each.status === "ready" && each.embedding_model === embedding.id);
    if (embedded) {
      const vectors = subjects.map((each) =>
        meanVector(
          db
            .all<{ embedding: Uint8Array }>(
              `SELECT embedding FROM passages WHERE document_id = ? AND deleted_at IS NULL
                 AND embedding IS NOT NULL ORDER BY position LIMIT ?`,
              [each.id, BigInt(VECTOR_PASSAGES)],
            )
            .map((row) => decodeVector(row.embedding)),
        ),
      );
      if (vectors.every((vector) => vector !== null)) return vectors as Float32Array[];
    }
    return wordVectors(
      subjects.map((each) =>
        [
          each.name,
          ...db
            .all<{ text: string }>(
              "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
              [each.id, BigInt(VECTOR_PASSAGES)],
            )
            .map((row) => row.text),
        ].join("\n"),
      ),
    );
  };

  const excerptOf = (subject: Subject): Omit<PlanExcerpt, "ref"> => {
    const excerpt = organizeExcerpt(storedOrganizeSource(db, subject));
    return {
      name: excerpt.name,
      type: documentType(excerpt),
      text: excerptFromPassages(
        excerpt.outline ? [excerpt.outline, excerpt.text] : [excerpt.text],
        EXCERPT_TOKENS,
      ),
    };
  };

  /** The Folders a run may file into, each named by its path: every Folder, or the Folder's own. */
  const candidatesOf = (folderId: string | null, allowed?: ReadonlySet<string>): PlanFolder[] => {
    const folders = options.folders();
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const pathOf = (folder: LibraryGroup): string[] | null => {
      const names: string[] = [];
      const seen = new Set<string>();
      for (let at: LibraryGroup | undefined = folder; at; at = byId.get(at.parentId ?? "")) {
        if (seen.has(at.id)) return null;
        seen.add(at.id);
        if (at.id === folderId) return names;
        names.unshift(at.name);
      }
      return folderId === null ? names : null;
    };
    return folders.flatMap((folder) => {
      const path =
        folder.id === folderId || allowed?.has(folder.id) === false ? null : pathOf(folder);
      return path && path.length > 0
        ? [{ id: folder.id, name: path.join(" › "), description: folder.description }]
        : [];
    });
  };

  return {
    /** Stops the run under way: nothing it planned is written. */
    stop(): void {
      current?.abort();
    },

    async organize(raw: unknown, own?: OwnRun): Promise<OrganizeLibraryResult> {
      const input = parseInput(raw);
      const settings = options.settings();
      if (input.folderId !== null && !options.folders().some((f) => f.id === input.folderId))
        throw new InvalidInputError({ key: "error.folder.notFound" });
      const runId = own?.run.runId ?? crypto.randomUUID();
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const signal = own?.signal
        ? AbortSignal.any([controller.signal, own.signal])
        : controller.signal;
      try {
        // A continuation sorts only for the service its press was authorized for (#2308).
        if (
          input.forService !== undefined &&
          options.organizeService(settings)?.id !== input.forService
        )
          return { status: "stopped", runId };

        let subjects = subjectsOf(input);
        for (;;) {
          const waiting = subjects.filter(waitsToBeRead).length;
          if (waiting === 0) break;
          options.progress({ runId, waiting, done: 0, total: subjects.length });
          await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
          if (signal.aborted) return { status: "stopped", runId };
          subjects = subjectsOf(input);
        }

        const walls = new Map<string, string>();
        if (input.folderId === null)
          for (const subject of subjects) {
            const place = placeOf(subject.id);
            const wall = place === null ? null : options.wallOf(place);
            if (wall !== null) walls.set(subject.id, wall);
          }
        const readable = subjects.filter(
          (each) => !walls.has(each.id) && READABLE.has(each.status) && hasText(each.id),
        );
        options.progress({ runId, waiting: 0, done: 0, total: subjects.length });
        const vectors = vectorsOf(readable);
        const local = planLocally({
          documents: readable.map((each, at) => ({
            id: each.id,
            vector: vectors[at] as Float32Array,
          })),
          excerptOf: (id) => excerptOf(readable.find((each) => each.id === id) as Subject),
          folders: candidatesOf(input.folderId, own?.folders),
          language: options.language(),
          within:
            input.folderId === null
              ? null
              : (options.folders().find((folder) => folder.id === input.folderId)?.name ?? null),
        });

        if (readable.length > 0 && !input.costAccepted) {
          const estimate = options.estimate(settings, local.requests(options.tokensOf));
          const dollars = estimate && options.inDollars(estimate);
          if (estimate && dollars !== null && dollars !== undefined && dollars > ASK_ABOVE_USD)
            return { status: "estimate", estimate };
        }

        let plan: LibraryPlan | null = null;
        if (readable.length > 0) {
          const classifier = await options.prepare(settings, own?.permit);
          if (!classifier.plan) throw new InvalidInputError({ key: "error.library.cantPropose" });
          const model = classifier.plan;
          plan = await finishPlan(local, {
            model,
            signal,
            progress: (done) =>
              options.progress({ runId, waiting: 0, done, total: subjects.length }),
            leavesOut: (error) =>
              !gateStop(error) &&
              ["network", "provider", "rate-limit"].includes(classifyProviderError(error).kind),
          });
        }
        if (signal.aborted) return { status: "stopped", runId };

        const service = options.organizeService(settings)?.name ?? "";
        const proposals = subjects.map((subject): OrganizeReviewProposal => {
          const proposal = (placement: OrganizeReviewProposal["placement"]) => ({
            documentId: subject.id,
            contentHash: subject.content_hash,
            placement,
            tags: [],
          });
          const wall = walls.get(subject.id);
          if (wall)
            return proposal({ kind: "leftOut", leftOut: { reason: "walled", folderId: wall } });
          const place = plan?.places.get(subject.id);
          if (!place) return proposal({ kind: "leftOut", leftOut: { reason: "noText" } });
          if (place.kind === "folder")
            return proposal({ kind: "folder", folderId: place.folderId });
          if (place.kind === "none")
            return proposal({
              kind: "leftOut",
              leftOut: place.unreachable
                ? { reason: "unreachable", service }
                : input.folderId !== null
                  ? { reason: "staysInFolder" }
                  : { reason: "doesntFit" },
            });
          const folder = plan?.folders.find((each) => each.key === place.key);
          const parent = folder?.parentKey
            ? plan?.folders.find((each) => each.key === folder.parentKey)
            : undefined;
          if (!folder) return proposal({ kind: "leftOut", leftOut: { reason: "doesntFit" } });
          return proposal({
            kind: "newFolder",
            name: folder.name,
            description: folder.description,
            parentId: input.folderId,
            parent: parent ? { name: parent.name, description: parent.description } : null,
          });
        });
        const proposed = options.propose(
          own?.run ?? {
            origin: input.folderId === null ? "library" : "folder",
            runId,
            folderId: input.folderId,
          },
          proposals,
        );
        return {
          status: "done",
          runId,
          documents: subjects.length,
          proposed,
          placedByModel: plan?.placedByModel ?? 0,
          requests: plan?.requests ?? 0,
        };
      } catch (error) {
        if (signal.aborted) return { status: "stopped", runId };
        throw error;
      } finally {
        if (current === controller) current = null;
      }
    },
  };
}

interface ParsedInput {
  documentIds: string[] | null;
  folderId: string | null;
  forService: string | undefined;
  costAccepted: boolean;
}

function parseInput(input: unknown): ParsedInput {
  if (input === undefined) input = {};
  if (!isRecord(input)) throw new InvalidInputError("organizeLibrary expects an object.");
  const { documentIds, folderId, forService, costAccepted } = input;
  if (
    documentIds !== undefined &&
    !(Array.isArray(documentIds) && documentIds.every((id) => typeof id === "string" && id !== ""))
  )
    throw new InvalidInputError("Choose valid Documents.");
  if (folderId !== undefined && (typeof folderId !== "string" || folderId === ""))
    throw new InvalidInputError({ key: "error.folder.notFound" });
  if (forService !== undefined && typeof forService !== "string")
    throw new InvalidInputError("forService must be a service id.");
  if (costAccepted !== undefined && typeof costAccepted !== "boolean")
    throw new InvalidInputError("costAccepted must be true or false.");
  if (documentIds !== undefined && folderId !== undefined)
    throw new InvalidInputError("Organize either these Documents or one Folder.");
  return {
    documentIds: documentIds === undefined ? null : [...new Set(documentIds as string[])],
    folderId: folderId ?? null,
    forService,
    costAccepted: costAccepted ?? false,
  };
}

export type LibraryOrganizer = ReturnType<typeof createLibraryOrganizer>;
