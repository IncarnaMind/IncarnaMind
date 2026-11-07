import { randomUUID } from "node:crypto";
import { type CitationStyleId, isCitationStyleId } from "../../shared/citationStyles";
import { wordingOf } from "../../shared/errorWording";
import { translate } from "../../shared/i18n";
import {
  LIBRARY_DEFAULTS,
  organizeModelOf,
  supportsLibraryImages,
} from "../../shared/libraryModels";
import { libraryPresetKeys } from "../../shared/libraryPresets";
import { sameName } from "../../shared/names";
import type {
  CloudReadPermit,
  DocumentKind,
  ExternalService,
  FolderDeletion,
  MovedDocument,
  ProviderError,
  TagLinkChange,
} from "../api";
import type { BackgroundQueue } from "../backgroundQueue";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  ConsentNeededError,
  InvalidInputError,
  isRecord,
  NotFoundError,
  TaggingNotReadyError,
} from "../errors";
import type { Language } from "../language";
import type { OrganizeReviewProposal, OrganizeReviewRun } from "../organizeReview";
import type { OrganizeReviewFolder } from "../organizeReview/types";
import { isDecisionHost, isDecisionModelId } from "../providers/catalog/decisions";
import { normalizeBaseUrl, serviceForUrl } from "../providers/kinds";
import { classifyProviderError } from "../providers/providerErrors";
import { redactMessage } from "../redact";
import { gateStop } from "../sendGate";
import { isChatModelChoice, type SettingsStore } from "../settings";
import type { Database } from "../storage";
import type { TagsStore } from "../tags";
import { documentType, excerptFromPassages } from "../tags/classify";
import { clearForService, mayBackgroundSend, nextSequence } from "../tags/held";
import { type RateLimitPause, rateLimitError } from "../tags/rateLimit";
import { fallbackLine } from "../tags/suggest";
import type { FolderChoice, FolderSample, GroupClassifier } from "./classifier";
import {
  ORGANIZE_PASSAGES,
  type OrganizeSource,
  type OrganizeUnit,
  organizeExcerpt,
  organizeNeedsPageImages,
  organizeReadsPages,
  ROUTING_PAGE_CHARACTERS,
  ROUTING_PAGES,
} from "./excerpt";
import type { DocumentPageImage } from "./pdfImages";
import { reachedPlanLimit } from "./planPace";
import type {
  AssignmentChange,
  AssignmentState,
  ClassificationModel,
  ClassificationStatus,
  DocumentGroupAssignment,
  DocumentTagging,
  LibraryClassifier,
  LibraryGroup,
  LibrarySettings,
  LibrarySnapshot,
  TaggingClassifier,
} from "./types";

const AUTOMATIC: LibraryClassifier = { kind: "automatic" };

/** A Document read to the end with nothing Organize can read. */
const NO_TEXT = new Set(["no-text", "failed"]);

const AUTOMATIC_OFF_NOTICE = "libraryAutomaticOffNotice";

/** How many Documents an upgrade moved from their Suggested Folders into Suggestions (migration 136). */
const REVIEW_MOVED_NOTICE = "organizeReviewMovedNotice";

function taggingClassifierOf(value: unknown): TaggingClassifier | null {
  if (!isRecord(value)) return null;
  const { kind, baseUrl, modelId } = value;
  if (kind === "jev") return { kind };
  if (kind === "decision") {
    const { host } = value;
    return isDecisionHost(host) && typeof modelId === "string" ? { kind, host, modelId } : null;
  }
  if (kind === "chat")
    return isChatModelChoice(value.choice) ? { kind, choice: value.choice } : null;
  if (typeof baseUrl !== "string") return null;
  if (kind === "auto") return { kind, baseUrl };
  if (kind !== "ollama" || typeof modelId !== "string") return null;
  return { kind, baseUrl, modelId, ...(value.usePageImages === true && { usePageImages: true }) };
}

interface AssignmentRow {
  document_id: string;
  group_id: string | null;
  created_at: string;
  filed_at: string | null;
  source: "automatic" | "user";
  status: ClassificationStatus;
  content_hash: string | null;
  request_id: string;
  error_kind: ProviderError["kind"] | null;
  error_message: string | null;
  error_wording: string | null;
  classification_model: string | null;
}
interface DocumentRow {
  id: string;
  name: string;
  kind: DocumentKind;
  page_count: number | null;
  content_hash: string | null;
  status: string;
}
const GROUP_COLUMNS =
  "id, name, description, parent_id AS parentId, counts_own_files, keep_inside, created_at AS createdAt, updated_at AS updatedAt";

/** A live Folder and every live Folder inside it, at any depth; none for a deleted one. */
const SUBTREE = `
  WITH RECURSIVE subtree (id) AS (
    SELECT id FROM library_groups WHERE id = ? AND deleted_at IS NULL
    UNION
    SELECT g.id FROM library_groups g JOIN subtree ON g.parent_id = subtree.id
    WHERE g.deleted_at IS NULL
  )
  SELECT id FROM subtree`;

/** A Folder and the Folders deleted with it: those inside it whose deleted_at is its own. */
const DELETED_SUBTREE = `
  WITH RECURSIVE subtree (id) AS (
    SELECT id FROM library_groups WHERE id = ? AND deleted_at = ?
    UNION
    SELECT g.id FROM library_groups g JOIN subtree ON g.parent_id = subtree.id
    WHERE g.deleted_at = ?
  )
  SELECT id FROM subtree`;

/**
 * A Folder and the Folders inside it, stopping at a Folder that keeps its work inside it: that
 * Folder's work is behind its own wall, never the wall around it (#1934, #246).
 */
const TREE = `
  WITH RECURSIVE tree (id, wall) AS (
    SELECT id, 0 FROM library_groups WHERE id = ? AND deleted_at IS NULL
    UNION
    SELECT g.id, g.keep_inside FROM library_groups g JOIN tree ON g.parent_id = tree.id
    WHERE g.deleted_at IS NULL AND tree.wall = 0
  )
  SELECT id FROM tree WHERE wall = 0`;

/** A stored Folder: its switches are 0 or 1. */
type GroupRow = Omit<LibraryGroup, "countsOwnFiles" | "keepInside"> & {
  counts_own_files: number;
  keep_inside: number;
};

const toGroup = ({ counts_own_files, keep_inside, ...row }: GroupRow): LibraryGroup => ({
  ...row,
  countsOwnFiles: counts_own_files === 1,
  keepInside: keep_inside === 1,
});

const errorOf = (row: AssignmentRow): ProviderError => {
  const wording = row.error_wording === null ? null : wordingOf(row.error_wording);
  return {
    kind: row.error_kind ?? "unknown",
    message: row.error_message ?? "",
    ...(wording && { wording }),
  };
};

/** An assignment's own fields as the API gives them, without its Document id. */
const assignmentFields = (row: AssignmentRow): Omit<DocumentGroupAssignment, "documentId"> => ({
  groupId: row.group_id,
  filedAt: row.filed_at ?? row.created_at,
  source: row.source,
  status: row.status,
  error: row.error_kind ? errorOf(row) : null,
  model: row.classification_model
    ? (JSON.parse(row.classification_model) as ClassificationModel)
    : null,
});

/** A stored assignment as the API gives it, with the Document's tagging row it was read with. */
const assignmentOf = (row: AssignmentRow, tagging?: DocumentTagging): DocumentGroupAssignment => ({
  documentId: row.document_id,
  ...assignmentFields(row),
  ...(tagging && { tagging }),
});

const CLASSIFICATION_STATUSES: readonly ClassificationStatus[] = [
  "pending",
  "classifying",
  "classified",
  "waiting",
  "failed",
];

const STORED_TAGGING_STATES: readonly DocumentTagging["status"][] = [
  "pending",
  "waiting-for-provider",
  "tagging",
  "tagged",
  "no-tags",
  "failed",
  "stopped",
  "off",
];

/** The documents row's tagging columns, as the Library's queries read them with an assignment. */
interface TaggingColumns {
  tagging_status: string;
  tagging_error_kind: ProviderError["kind"] | null;
  tagging_error_message: string | null;
  tagging_error_resets_at: string | null;
  tagging_row_updated_at: string;
}

const taggingOf = (row: TaggingColumns): DocumentTagging | null => {
  const status = STORED_TAGGING_STATES.find((each) => each === row.tagging_status);
  if (status === undefined) return null;
  return {
    status,
    error:
      row.tagging_error_kind === null
        ? null
        : {
            kind: row.tagging_error_kind,
            message: row.tagging_error_message ?? "",
            ...(row.tagging_error_resets_at !== null && {
              resetsAt: row.tagging_error_resets_at,
            }),
          },
    updatedAt: row.tagging_row_updated_at,
  };
};

/** What Undo compares: the assignment's own fields, and the tagging row's. */
const assignmentKey = (item: Omit<DocumentGroupAssignment, "documentId">): string =>
  JSON.stringify([
    item.groupId,
    item.source,
    item.status,
    item.error,
    item.model,
    item.filedAt ?? null,
  ]);

const taggingKey = (tagging: DocumentTagging | null): string =>
  JSON.stringify([tagging?.status ?? null, tagging?.error ?? null, tagging?.updatedAt ?? null]);

const sameAssignment = (
  current: Omit<DocumentGroupAssignment, "documentId"> | null,
  expected: Omit<DocumentGroupAssignment, "documentId"> | null,
): boolean =>
  expected === null
    ? current === null
    : current !== null && assignmentKey(current) === assignmentKey(expected);

function parseAssignmentFields(
  input: unknown,
  invalid: InvalidInputError,
): Omit<DocumentGroupAssignment, "documentId"> | null {
  if (input === null) return null;
  if (!isRecord(input)) throw invalid;
  const { groupId, filedAt, source, status, error, model } = input;
  if (groupId !== null && (typeof groupId !== "string" || groupId === "")) throw invalid;
  if (
    filedAt !== undefined &&
    (typeof filedAt !== "string" ||
      !Number.isFinite(Date.parse(filedAt)) ||
      new Date(filedAt).toISOString() !== filedAt)
  )
    throw invalid;
  if (source !== "automatic" && source !== "user") throw invalid;
  const known = CLASSIFICATION_STATUSES.find((each) => each === status);
  if (!known) throw invalid;
  if (
    error !== null &&
    !(isRecord(error) && typeof error.kind === "string" && typeof error.message === "string")
  )
    throw invalid;
  if (model !== null && !(isRecord(model) && typeof model.id === "string")) throw invalid;
  return {
    groupId,
    ...(filedAt !== undefined && { filedAt }),
    source,
    status: known,
    error: error as ProviderError | null,
    model: model as ClassificationModel | null,
  };
}

function parseTagging(input: unknown, invalid: InvalidInputError): DocumentTagging | null {
  if (input === null) return null;
  if (!isRecord(input)) throw invalid;
  const status = STORED_TAGGING_STATES.find((each) => each === input.status);
  const { error, updatedAt } = input;
  if (
    status === undefined ||
    typeof updatedAt !== "string" ||
    (error !== null &&
      !(isRecord(error) && typeof error.kind === "string" && typeof error.message === "string"))
  )
    throw invalid;
  return { status, error: error as ProviderError | null, updatedAt };
}

function parseAssignmentState(input: unknown): AssignmentState {
  const invalid = new InvalidInputError("A change says the Document's assignment and its tagging.");
  if (!isRecord(input)) throw invalid;
  return {
    assignment: parseAssignmentFields(input.assignment, invalid),
    tagging: parseTagging(input.tagging, invalid),
  };
}

/**
 * What Organize sends to a cloud model: the Folders and Tags, and each
 * Document's excerpt. A scan's page images are the "scan-images" flow's, which
 * choosing the provider doesn't allow.
 */
export const CLASSIFICATION_FLOW_SENDS = ["groups", "tags", "document-excerpts"] as const;

/** How many Documents a Folder proposal reads the start of, how much of each, and how many more by name. */
const SAMPLED = 60;
const SAMPLE_TOKENS = 120;
const NAMED = 240;

/** Up to 3 page images of a PDF with no text, to a model that reads images. */
export const SCAN_IMAGES_FLOW_SENDS = ["page-images"] as const;

/**
 * One flat group per Document; user choices, including Not in a Folder, always win.
 * Organize files nothing: what it chooses waits in Suggestions for the User (#1569).
 */
export function createLibrary(options: {
  db: Database;
  now(): string;
  settings: SettingsStore;
  background: BackgroundQueue;
  /** The Folders or settings changed, or many assignments at once: the snapshot is to be read again. */
  changed(): void;
  /** These Documents' assignments changed, each whole. */
  assigned(assignments: DocumentGroupAssignment[]): void;
  tags: TagsStore;
  tagged(ids: string[]): void;
  /** Organize made new Tags: the list of Tags is to be read again. */
  tagsMade?(): void;
  prepare(settings: LibrarySettings, permit?: CloudReadPermit): Promise<GroupClassifier>;
  providerExists(id: string): boolean;
  /**
   * Whether a model that tags reads a PDF's pages, so it can organize one with
   * no text, a scan: itself, or through the image model.
   */
  readsPages(classifier: TaggingClassifier): boolean;
  /**
   * The services tagging and organizing by themselves would send to, none for models on this
   * computer: the switch for doing it by itself is off for one until the User turns it on there.
   */
  sendsTo(settings: {
    classifier: LibraryClassifier;
    organizeWith: TaggingClassifier | null;
  }): ExternalService[];
  /** When the User allowed tagging or Organize to send to this service (../consent); null if not. */
  consentedAt(service: ExternalService): string | null;
  /** Whether the User's consent to tagging sending to this service stands (../consent). */
  taggingAllowed(service: ExternalService): boolean;
  /**
   * The service an Organize request with these settings sends a Document to; none on this
   * computer. A scan's page images may go to the image model's too, which the User allows for
   * itself (the "scan-images" flow).
   */
  organizeService(settings: LibrarySettings): ExternalService | null;
  /**
   * The service that would read a scan's pages for this classifier if the User
   * allowed it, while they haven't; null when it reads them, or can't.
   */
  pagesWaitFor(classifier: TaggingClassifier): ExternalService | null;
  pageImages(id: string, contentHash: string, signal: AbortSignal): Promise<DocumentPageImage[]>;
  /** The pause a rate limit puts on all Tagging (see ../tags/rateLimit). */
  rateLimit: Pick<RateLimitPause, "pausedUntil" | "pause" | "succeeded" | "refusal" | "refuse">;
  /**
   * Whether a Document belongs to the examples', which Organize leaves where
   * they are: never filed into the User's Folders, never given Tags of its own
   * (#1942). Asked at each use, since the examples are made after the Library.
   */
  isExampleDocument?(id: string): boolean;
  /**
   * A Document's first pages, while the rest of its scan is still being read (#2308): Organize
   * reads them as it would read the finished Document, so it sorts it once, at once.
   */
  head?(id: string): Pick<OrganizeSource, "pageCount" | "passages" | "units"> | null;
  /** Local mode: nothing goes to a cloud service, so nothing waits to be allowed there. */
  localOnly?(): boolean;
  /** How many Documents wait in Suggestions (`LibrarySnapshot.reviewCount`). */
  reviewCount(): number;
  /** Suggestions (../organizeReview): where Organize's choices go. */
  review: {
    propose(run: OrganizeReviewRun, proposals: readonly OrganizeReviewProposal[]): number;
    proposeFolders(
      folders: readonly { name: string; description: string; parentId?: string | null }[],
    ): OrganizeReviewFolder[];
    offeredFolders(): OrganizeReviewFolder[];
  };
}) {
  const { db, now, settings, background, changed } = options;
  const lifetime = new AbortController();
  const queued = new Set<string>();
  let revision = 0;
  /**
   * The Tagging setting. A Library that never chose a model, or chose
   * "Organize manually" before there was Automatic, gets Automatic; any other
   * choice is kept as it was saved.
   */
  const savedSettings = () => {
    const stored = settings.readDeviceValue("library");
    const saved = isRecord(stored) ? stored : {};
    return {
      classifier: taggingClassifierOf(saved.classifier) ?? LIBRARY_DEFAULTS.classifier,
      // Null until the User sets the switch: it follows the model then (see `LibrarySettings.automatic`).
      automatic: typeof saved.automatic === "boolean" ? saved.automatic : null,
      // When the User turned it on for each service; null for a switch saved before these were kept.
      automaticSince: isRecord(saved.automaticSince)
        ? Object.fromEntries(
            Object.entries(saved.automaticSince).filter(
              (each): each is [string, string] => typeof each[1] === "string",
            ),
          )
        : null,
      // Where each turn-on is in the database's order, which decides what came after it (#2370).
      automaticSinceSeq: isRecord(saved.automaticSinceSeq)
        ? Object.fromEntries(
            Object.entries(saved.automaticSinceSeq).filter(
              (each): each is [string, number] => typeof each[1] === "number",
            ),
          )
        : null,
      organizeWith: taggingClassifierOf(saved.organizeWith),
      taggingStopped: Array.isArray(saved.taggingStopped)
        ? saved.taggingStopped.filter(
            (each): each is string | null => each === null || typeof each === "string",
          )
        : [],
    };
  };
  const usesCloud = (saved: Parameters<typeof options.sendsTo>[0]) =>
    options.sendsTo(saved).length > 0;
  const defaultAutomatic = (saved: ReturnType<typeof savedSettings>) => !usesCloud(saved);
  /**
   * When the switch was turned on for each service. One saved before these were kept holds from
   * when the User allowed tagging or Organize to send there.
   */
  const sinceOf = (saved: ReturnType<typeof savedSettings>): Record<string, string> =>
    saved.automaticSince ??
    Object.fromEntries(
      options.sendsTo(saved).flatMap((service) => {
        const at = options.consentedAt(service);
        return at === null ? [] : [[service.id, at]];
      }),
    );
  /**
   * Whether the switch the User turned on holds where tagging sends now: turned on for one
   * service, it is off for another until they turn it on there (#2308).
   */
  const turnedOnHere = (saved: ReturnType<typeof savedSettings>) => {
    const since = sinceOf(saved);
    return options.sendsTo(saved).every((service) => since[service.id] !== undefined);
  };
  /** The place of the User's turn-on for this service in the database's order; null if none. */
  const turnedOnSeq = (service: ExternalService): number | null =>
    savedSettings().automaticSinceSeq?.[service.id] ?? null;
  const sinceSeqOf = (saved: ReturnType<typeof savedSettings>): Record<string, number> =>
    saved.automaticSinceSeq ?? {};
  const shownSettings = (saved: ReturnType<typeof savedSettings>): LibrarySettings => {
    const {
      automaticSince: _automaticSince,
      automaticSinceSeq: _automaticSinceSeq,
      ...shown
    } = saved;
    return {
      ...shown,
      automatic:
        saved.automatic === null ? defaultAutomatic(saved) : saved.automatic && turnedOnHere(saved),
    };
  };
  let lent: TaggingClassifier | null = null;
  const getSettings = (): LibrarySettings => {
    const saved = savedSettings();
    return shownSettings(lent && !saved.organizeWith ? { ...saved, organizeWith: lent } : saved);
  };
  /** What the User chose: the same as `settings`, without a model lent to a run (#2252). */
  const chosenSettings = (): LibrarySettings => shownSettings(savedSettings());
  const noticeIsOpen = (marker: unknown) => marker === "pending" || marker === true;
  const reviewMoved = (): number => {
    const count = settings.readDeviceValue(REVIEW_MOVED_NOTICE);
    return typeof count === "number" && count > 0 ? count : 0;
  };
  const automaticOffNotice = (): boolean => {
    const marker = settings.readDeviceValue(AUTOMATIC_OFF_NOTICE);
    if (!noticeIsOpen(marker)) return false;
    const off = !getSettings().automatic;
    if (marker === "pending" || !off) settings.writeDeviceValue(AUTOMATIC_OFF_NOTICE, off);
    return off;
  };
  const placeOf = (id: string): string | null =>
    db.get<{ group_id: string }>(
      "SELECT a.group_id FROM document_groups a JOIN library_groups g ON g.id = a.group_id WHERE a.document_id = ? AND a.deleted_at IS NULL AND g.deleted_at IS NULL",
      [id],
    )?.group_id ?? null;
  /** A Document filed inside a Folder that keeps its work inside it: nothing of it goes to a cloud service by itself (#2308). */
  const inWall = (id: string) => {
    const place = placeOf(id);
    return place !== null && wallOf(place) !== null;
  };
  const taggingStoppedFor = (id: string) => {
    const { taggingStopped } = getSettings();
    return taggingStopped.length > 0 && taggingStopped.includes(placeOf(id));
  };
  /** What the User asked of a Document: it lives until that request finishes (#2308). */
  interface AskedRequest {
    /** The service a billing continuation was authorized for; null for the User's own request. */
    service: string | null;
    /** The failure the continuation leaves in place if Organize's destination no longer matches. */
    failure: { status: "failed" | "waiting"; error: ProviderError | null } | null;
    /** Who started the run, as its proposals say. */
    run: OrganizeReviewRun;
  }
  /** A new request's own object: an attempt may act only while `asked` still holds it. */
  const ownRequest = (run: OrganizeReviewRun): AskedRequest => ({
    service: null,
    failure: null,
    run,
  });
  const BACKGROUND: OrganizeReviewRun = { origin: "background" };
  /**
   * The Folders Organize may choose: the live ones, then those proposed by name that wait for the
   * User, which a run outside a wall may choose too (#1569).
   */
  const choicesOf = (allowed?: ReadonlySet<string>, newFolders = true): FolderChoice[] => [
    ...groups().filter((group) => !allowed || allowed.has(group.id)),
    ...(newFolders
      ? options.review
          .offeredFolders()
          .filter((folder) => !allowed || folder.parentId === null || allowed.has(folder.parentId))
      : []),
  ];
  const nothingToChoose = () =>
    groups().length === 0 && options.review.offeredFolders().length === 0;
  /** A Document the User asked about that Organize can't read waits in Suggestions as left out. */
  const leaveOut = (
    doc: DocumentRow,
    request: AskedRequest | undefined,
    leftOut: Extract<OrganizeReviewProposal["placement"], { kind: "leftOut" }>["leftOut"],
  ) => {
    if (!request || request.run.origin === "background") return;
    options.review.propose(request.run, [
      {
        documentId: doc.id,
        contentHash: doc.content_hash,
        placement: { kind: "leftOut", leftOut },
        tags: [],
      },
    ]);
  };
  const asked = new Map<string, AskedRequest>();
  const checkClassifier = (selected: Record<string, unknown>) => {
    if (selected.kind === "chat") {
      if (
        !isChatModelChoice(selected.choice) ||
        !options.providerExists(selected.choice.providerId)
      )
        throw new InvalidInputError({ key: "error.library.classifierModel" });
    } else if (selected.kind === "auto") {
      if (typeof selected.baseUrl !== "string")
        throw new InvalidInputError("Enter the local Ollama server.");
      selected.baseUrl = normalizeBaseUrl(selected.baseUrl);
      if (serviceForUrl(selected.baseUrl as string))
        throw new InvalidInputError({ key: "error.library.autoNotLocal" });
    } else if (selected.kind === "ollama") {
      if (
        typeof selected.baseUrl !== "string" ||
        typeof selected.modelId !== "string" ||
        !selected.modelId.trim() ||
        selected.modelId.length > 200
      )
        throw new InvalidInputError({ key: "error.library.localModelMissing" });
      if (selected.usePageImages !== undefined && typeof selected.usePageImages !== "boolean")
        throw new InvalidInputError("Choose whether to include PDF page images.");
      selected.modelId = selected.modelId.trim();
      if (selected.usePageImages === true && !supportsLibraryImages(selected.modelId as string))
        throw new InvalidInputError("PDF page images currently require local Clef-Flash.");
      selected.baseUrl = normalizeBaseUrl(selected.baseUrl);
      if (serviceForUrl(selected.baseUrl as string))
        throw new InvalidInputError({ key: "error.library.ollamaNotLocal" });
    } else if (selected.kind === "decision") {
      if (!isDecisionHost(selected.host) || !isDecisionModelId(selected.modelId))
        throw new InvalidInputError({ key: "error.library.classifierModel" });
    } else if (selected.kind !== "jev")
      throw new InvalidInputError("Choose a supported classifier.");
  };
  const groups = () =>
    db
      .all<GroupRow>(
        `SELECT ${GROUP_COLUMNS} FROM library_groups WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE, id`,
      )
      .map(toGroup);
  const group = (id: unknown) => {
    if (typeof id !== "string") throw new InvalidInputError("A group id must be text.");
    const value = groups().find((item) => item.id === id);
    if (!value) throw new NotFoundError({ key: "error.folder.notFound" });
    return value;
  };
  /** A live Folder and every live Folder inside it, at any depth. */
  const subtree = (folderId: string): string[] =>
    db.all<{ id: string }>(SUBTREE, [folderId]).map((row) => row.id);
  /** A live Folder and the live Folders inside it up to the next wall, that Folder's own excluded. */
  const tree = (folderId: string): string[] =>
    db.all<{ id: string }>(TREE, [folderId]).map((row) => row.id);
  /** A deleted Folder and the Folders deleted with it, at any depth. */
  const deletedWith = (folderId: string, at: string): string[] =>
    db.all<{ id: string }>(DELETED_SUBTREE, [folderId, at, at]).map((row) => row.id);
  /**
   * Every live Folder's nearest walled Folder, or null, in one pass: kept until the Library
   * changes, so a search or a move over many Folders reads them once, not once per Folder.
   */
  let wallsCache: { revision: number; walls: Map<string, string | null> } | null = null;
  const wallsOf = (): ReadonlyMap<string, string | null> => {
    if (wallsCache?.revision === revision) return wallsCache.walls;
    const folders = groups();
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const walls = new Map<string, string | null>();
    const nearest = (id: string): string | null => {
      const known = walls.get(id);
      if (known !== undefined) return known;
      const chain: string[] = [];
      const seen = new Set<string>();
      let at: string | null = id;
      let wall: string | null = null;
      while (at !== null && !seen.has(at)) {
        const cached = walls.get(at);
        if (cached !== undefined) {
          wall = cached;
          break;
        }
        seen.add(at);
        const folder = byId.get(at);
        if (!folder) break;
        if (folder.keepInside) {
          wall = folder.id;
          break;
        }
        chain.push(at);
        at = folder.parentId;
      }
      for (const each of chain) walls.set(each, wall);
      walls.set(id, wall);
      return wall;
    };
    for (const folder of folders) nearest(folder.id);
    wallsCache = { revision, walls };
    return walls;
  };
  /**
   * The id of the Folder keeping its work inside it that a Folder is in, or is; null outside
   * every wall. `deleted`: a Folder in Recently deleted reads the walls around it as they were,
   * deleted Folders included.
   */
  const wallOf = (folderId: string, deleted = false): string | null => {
    if (!deleted) return wallsOf().get(folderId) ?? null;
    const byId = new Map(
      db
        .all<GroupRow>(`SELECT ${GROUP_COLUMNS} FROM library_groups`)
        .map((row) => [row.id, toGroup(row)]),
    );
    const seen = new Set<string>();
    let at: string | null = folderId;
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      const folder = byId.get(at);
      if (!folder) return null;
      if (folder.keepInside) return folder.id;
      at = folder.parentId;
    }
    return null;
  };
  /**
   * The Transcripts of the Meetings whose Notes are in this Folder: a Transcript has no Folder of
   * its own, it is where its Note is (#2528).
   */
  const transcriptIdsIn = (folderId: string): string[] =>
    db
      .all<{ id: string }>(
        `SELECT d.id FROM documents d JOIN minds n ON n.id = d.meeting_mind_id
         JOIN library_groups g ON g.id = n.folder_id
         WHERE g.id = ? AND g.deleted_at IS NULL AND n.deleted_at IS NULL AND d.deleted_at IS NULL`,
        [folderId],
      )
      .map((row) => row.id);
  /** The Documents filed in this Folder (a suggestion too, unless the Folder keeps its work inside it). */
  const filedDocumentIdsOf = (folderId: string): string[] => {
    const walled = wallOf(folderId) !== null;
    return [
      ...db
        .all<{ document_id: string }>(
          `SELECT a.document_id FROM document_groups a JOIN library_groups g ON g.id = a.group_id JOIN documents d ON d.id = a.document_id WHERE g.id = ? AND g.deleted_at IS NULL AND a.deleted_at IS NULL AND d.deleted_at IS NULL${walled ? " AND a.source = 'user'" : ""}`,
          [folderId],
        )
        .map((row) => row.document_id),
      ...transcriptIdsIn(folderId),
    ];
  };
  const everyFiledDocumentIdsOf = (folderId: string): string[] => [
    ...db
      .all<{ document_id: string }>(
        "SELECT a.document_id FROM document_groups a JOIN library_groups g ON g.id = a.group_id JOIN documents d ON d.id = a.document_id WHERE g.id = ? AND g.deleted_at IS NULL AND a.deleted_at IS NULL AND d.deleted_at IS NULL",
        [folderId],
      )
      .map((row) => row.document_id),
    ...transcriptIdsIn(folderId),
  ];
  const document = (id: unknown) => {
    if (typeof id !== "string") throw new InvalidInputError("A Document id must be text.");
    const value = db.get<DocumentRow>(
      "SELECT id, name, kind, page_count, content_hash, status FROM documents WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!value) throw new NotFoundError({ key: "error.document.gone" });
    return value;
  };
  const isTranscriptOfNote = (id: string): boolean =>
    db.get("SELECT 1 FROM documents WHERE id = ? AND meeting_mind_id IS NOT NULL", [id]) !==
    undefined;
  /** A Document the User or Organize may file; a Meeting's Transcript is never filed alone (#2528). */
  const fileable = (id: unknown) => {
    const doc = document(id);
    if (isTranscriptOfNote(doc.id)) {
      throw new InvalidInputError({ key: "error.transcript.withNote" });
    }
    return doc;
  };
  /** What Organize leaves where it is: the examples' Documents (#1942) and Meetings' Transcripts (#2528). */
  const leftAlone = (id: string): boolean =>
    options.isExampleDocument?.(id) === true || isTranscriptOfNote(id);
  const assignment = (id: string) =>
    db.get<AssignmentRow>(
      "SELECT * FROM document_groups WHERE document_id = ? AND deleted_at IS NULL",
      [id],
    );
  /**
   * Organize took this version up before and let it go: an Undo took its filing back, or it was
   * held back for the User. Reading the rest of it, or reading it again, doesn't file it (#2308).
   */
  const filedBefore = (doc: DocumentRow) =>
    !!db.get(
      "SELECT 1 FROM document_groups WHERE document_id = ? AND content_hash IS ? AND deleted_at IS NOT NULL LIMIT 1",
      [doc.id, doc.content_hash],
    );
  /**
   * Announces these Documents' assignments, as the snapshot lists them (those
   * of Documents still there), so a client changes only these.
   */
  const announce = (ids: readonly string[]) => {
    const changed = db
      .all<AssignmentRow & TaggingColumns>(
        "SELECT g.*, d.tagging_status AS tagging_status, d.tagging_error_kind AS tagging_error_kind, d.tagging_error_message AS tagging_error_message, d.tagging_error_resets_at AS tagging_error_resets_at, d.updated_at AS tagging_row_updated_at FROM document_groups g JOIN documents d ON d.id = g.document_id WHERE g.deleted_at IS NULL AND d.deleted_at IS NULL AND g.document_id IN (SELECT value FROM json_each(?))",
        [JSON.stringify(ids)],
      )
      .map((row) => assignmentOf(row, taggingOf(row) ?? undefined));
    if (changed.length > 0) options.assigned(changed);
  };
  const hasContent = (doc: DocumentRow) => {
    const classifier = doc.kind === "pdf" ? organizeModelOf(getSettings()) : null;
    const canReadPages = !!classifier && options.readsPages(classifier);
    return (
      (canReadPages && doc.status === "no-text") ||
      (["ready", "waiting-for-model", "embedding"].includes(doc.status) &&
        !!db.get("SELECT 1 FROM passages WHERE document_id = ? AND deleted_at IS NULL LIMIT 1", [
          doc.id,
        ])) ||
      !!options.head?.(doc.id)
    );
  };
  const scanWaits = (doc: DocumentRow): ProviderError | undefined => {
    if (doc.kind !== "pdf" || doc.status !== "no-text") return undefined;
    const classifier = organizeModelOf(getSettings());
    const service = classifier && options.pagesWaitFor(classifier);
    return service
      ? {
          kind: "consent-declined",
          message: `Page images of scans aren't sent to ${service.name}.`,
          wording: { key: "error.library.scanImagesOff", values: { service: service.name } },
        }
      : undefined;
  };
  /** What Organize reads of the indexed version (see ./excerpt), or of its first pages. */
  const source = (doc: DocumentRow, withPassages = true): OrganizeSource => {
    const head = options.head?.(doc.id);
    if (head)
      return {
        name: doc.name,
        kind: doc.kind,
        pageCount: head.pageCount,
        passages: withPassages ? head.passages : [],
        units: head.units,
      };
    return indexedSource(doc, withPassages);
  };
  const indexedSource = (doc: DocumentRow, withPassages: boolean): OrganizeSource => ({
    name: doc.name,
    kind: doc.kind,
    pageCount: doc.page_count,
    passages: withPassages
      ? db
          .all<{ text: string }>(
            "SELECT text FROM passages WHERE document_id = ? AND deleted_at IS NULL ORDER BY position LIMIT ?",
            [doc.id, BigInt(ORGANIZE_PASSAGES)],
          )
          .map((row) => row.text)
      : [],
    units: db
      .all<{ page: number; kind: OrganizeUnit["kind"]; label: string | null; text: string }>(
        "SELECT page, kind, label, CASE WHEN page <= ? THEN substr(text, 1, ?) ELSE '' END AS text FROM document_pages WHERE document_id = ? AND content_hash = ? AND deleted_at IS NULL ORDER BY page LIMIT 400",
        [BigInt(ROUTING_PAGES), BigInt(ROUTING_PAGE_CHARACTERS), doc.id, doc.content_hash],
      )
      .map((row) => ({ ...row, label: row.label ? JSON.parse(row.label) : null })),
  });
  const needsPageImages = (doc: DocumentRow) =>
    doc.kind === "pdf" && organizeNeedsPageImages(source(doc, false));
  const tagState = (id: string, status: ClassificationStatus, error?: ProviderError) => {
    const tagging = {
      pending: "pending",
      classifying: "tagging",
      classified: "tagged",
      waiting: "waiting-for-provider",
      failed: "failed",
    }[status];
    db.run(
      "UPDATE documents SET tagging_status = ?, tagging_error_kind = ?, tagging_error_message = ?, tagging_error_resets_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [tagging, error?.kind ?? null, error?.message ?? null, error?.resetsAt ?? null, now(), id],
    );
  };
  const taggingSnapshot = (id: string): DocumentTagging | null => {
    const row = db.get<TaggingColumns>(
      "SELECT tagging_status, tagging_error_kind, tagging_error_message, tagging_error_resets_at, updated_at AS tagging_row_updated_at FROM documents WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    return row ? taggingOf(row) : null;
  };
  const state = (id: string, status: ClassificationStatus, error?: ProviderError) => {
    db.run(
      "UPDATE document_groups SET status = ?, error_kind = ?, error_message = ?, error_wording = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
      [
        status,
        error?.kind ?? null,
        error?.message ?? null,
        error?.wording ? JSON.stringify(error.wording) : null,
        now(),
        id,
      ],
    );
    tagState(id, status, error);
    options.tagged([id]);
    announce([id]);
  };
  const stopped = (id: string) => {
    db.run(
      "UPDATE document_groups SET status = 'classified', updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
      [now(), id],
    );
    db.run(
      "UPDATE documents SET tagging_status = 'stopped', tagging_error_kind = NULL, tagging_error_message = NULL, tagging_error_resets_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [now(), id],
    );
    // Its Folder before the Document itself, as for any Document filed while it is added (#1741).
    announce([id]);
    options.tagged([id]);
  };
  const write = (
    doc: DocumentRow,
    groupId: string | null,
    source: "automatic" | "user",
    status: ClassificationStatus,
    model: ClassificationModel | null = null,
  ) => {
    const at = now();
    const existing = assignment(doc.id);
    if (existing) {
      db.run(
        "UPDATE document_groups SET filed_at = CASE WHEN group_id IS ? THEN filed_at ELSE ? END, group_id = ?, source = ?, status = ?, content_hash = ?, request_id = ?, error_kind = NULL, error_message = NULL, error_wording = NULL, updated_at = ?, classification_model = ? WHERE document_id = ? AND deleted_at IS NULL",
        [
          groupId,
          at,
          groupId,
          source,
          status,
          doc.content_hash,
          randomUUID(),
          at,
          model ? JSON.stringify(model) : null,
          doc.id,
        ],
      );
    } else {
      db.run(
        "INSERT INTO document_groups (id, document_id, group_id, source, status, content_hash, request_id, created_at, updated_at, filed_at, classification_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          randomUUID(),
          doc.id,
          groupId,
          source,
          status,
          doc.content_hash,
          randomUUID(),
          at,
          at,
          at,
          model ? JSON.stringify(model) : null,
        ],
      );
    }
  };

  /** Puts a Document's assignment back as a change found it, or removes it when it had none. */
  const restoreAssignmentRow = (
    doc: DocumentRow,
    target: Omit<DocumentGroupAssignment, "documentId"> | null,
  ) => {
    if (!target) {
      const at = now();
      db.run(
        "UPDATE document_groups SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
        [at, at, doc.id],
      );
      return;
    }
    // The move cancelled its classification: it waits its turn again.
    const status = target.status === "classifying" ? "pending" : target.status;
    write(doc, target.groupId, target.source, status, target.model);
    if (target.filedAt !== undefined)
      db.run(
        "UPDATE document_groups SET filed_at = ? WHERE document_id = ? AND deleted_at IS NULL",
        [target.filedAt, doc.id],
      );
    if (target.error)
      db.run(
        "UPDATE document_groups SET error_kind = ?, error_message = ?, error_wording = ? WHERE document_id = ? AND deleted_at IS NULL",
        [
          target.error.kind,
          target.error.message,
          target.error.wording ? JSON.stringify(target.error.wording) : null,
          doc.id,
        ],
      );
  };
  const restoreTaggingRow = (id: string, tagging: DocumentTagging) => {
    db.run(
      "UPDATE documents SET tagging_status = ?, tagging_error_kind = ?, tagging_error_message = ?, tagging_error_resets_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [
        tagging.status,
        tagging.error?.kind ?? null,
        tagging.error?.message ?? null,
        tagging.error?.resetsAt ?? null,
        now(),
        id,
      ],
    );
  };

  function enqueue(id: string): void {
    if (lifetime.signal.aborted || queued.has(id)) return;
    if (nothingToChoose()) {
      if (assignment(id)?.status === "pending") state(id, "waiting");
      return;
    }
    // Until Organize has a model, automatic tagging tags this Document: its state is the tagger's.
    if (!organizeModelOf(getSettings())) {
      if (assignment(id)?.status === "pending") {
        db.run(
          "UPDATE document_groups SET status = 'waiting', updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
          [now(), id],
        );
        announce([id]);
      }
      return;
    }
    let doc: DocumentRow;
    try {
      doc = document(id);
    } catch {
      return;
    }
    const current = assignment(id);
    if (!current) return;
    if (!hasContent(doc)) {
      const waits = scanWaits(doc);
      const saidSo = current.error_wording?.includes("error.library.scanImagesOff") === true;
      if (current.status !== "classified" && !!waits !== saidSo) state(id, "waiting", waits);
      if (NO_TEXT.has(doc.status)) leaveOut(doc, asked.get(id), { reason: "noText" });
      return;
    }
    queued.add(id);
    background.add({
      kind: "classification",
      async run(call) {
        const requestAtStart = asked.get(id);
        try {
          await classifyOne(id, { signal: call.signal, runsLocally: () => call.runsLocally() });
        } finally {
          if (!lifetime.signal.aborted) {
            if (assignment(id)?.status === "classifying") state(id, "pending");
            if (!call.gaveWay) {
              queued.delete(id);
              const status = assignment(id)?.status;
              // Waiting to be allowed, it is still the User's request when it goes.
              if (status === "pending") enqueue(id);
              else if (status !== "waiting" && asked.get(id) === requestAtStart) asked.delete(id);
            }
          }
        }
      },
    });
  }

  async function classifyOne(
    id: string,
    call: {
      /** Stops the work when the turn or the app does. */
      signal: AbortSignal;
      /** The model is on this computer: an Answer that starts makes the queue's job give way. */
      runsLocally(): void;
      /** What stopped it, once the Document's state says why. */
      failed?(error: unknown): void;
      /** The links automatic tagging changed, before and after (#2252). */
      applied?(id: string, links: readonly TagLinkChange[]): void;
      /** The Folders it may choose, when a wall keeps it to some (#1934); none: all of them. */
      allowedGroups?: ReadonlySet<string>;
      /** Whether it may choose a Folder proposed by name, which a walled run may not. */
      newFolders?: boolean;
      /** The one service this run's Allow covers, without storing consent (#2252). */
      permit?: CloudReadPermit;
    },
  ): Promise<void> {
    const initial = assignment(id);
    const request = asked.get(id);
    const abandoned = () => asked.get(id) !== request;
    const binding = request?.service ?? null;
    const destinationChanged = () =>
      binding !== null && options.organizeService(getSettings())?.id !== binding;
    const stopForDestination = () => {
      if (binding === null || abandoned()) return;
      asked.delete(id);
      state(id, request?.failure?.status ?? "failed", request?.failure?.error ?? undefined);
    };
    const version = revision;
    const stale = () =>
      lifetime.signal.aborted ||
      call.signal.aborted ||
      version !== revision ||
      assignment(id)?.request_id !== initial?.request_id;
    try {
      if (!initial || initial.status === "classified") return;
      const current = document(id);
      if (!hasContent(current)) {
        state(id, "waiting", scanWaits(current));
        if (NO_TEXT.has(current.status)) leaveOut(current, request, { reason: "noText" });
        return;
      }
      const definitions = choicesOf(call.allowedGroups, call.newFolders);
      const tagDefinitions = options.tags.list();
      if (definitions.length === 0) {
        state(id, "waiting");
        return;
      }
      if (taggingStoppedFor(id) && !asked.has(id)) {
        stopped(id);
        return;
      }
      const limitedUntil = options.rateLimit.pausedUntil();
      if (limitedUntil !== null) {
        state(id, "waiting", rateLimitError(limitedUntil));
        return;
      }
      const refusal = options.rateLimit.refusal();
      if (refusal !== null) {
        state(id, "waiting", refusal);
        return;
      }
      if (abandoned()) return;
      if (destinationChanged()) {
        stopForDestination();
        return;
      }
      state(id, "classifying");
      const settingsNow = getSettings();
      const classifier = await options.prepare(settingsNow, call.permit);
      if (classifier.local) call.runsLocally();
      if (stale()) return;
      if (abandoned()) return;
      // Checked on where this request goes, as prepared; the User's own Organize goes.
      const service = options.organizeService(settingsNow);
      if (destinationChanged()) {
        stopForDestination();
        return;
      }
      const services = service ? [service] : [];
      if (
        !asked.has(id) &&
        (!mayBackgroundSend(db, id, services, turnedOnSeq) || (services.length > 0 && inWall(id)))
      ) {
        holdBack(id, initial);
        return;
      }
      const read = source(current);
      const signal = AbortSignal.any([lifetime.signal, call.signal]);
      const images = organizeReadsPages(classifier.pageImages, read)
        ? await options.pageImages(id, current.content_hash ?? "", signal)
        : [];
      if (stale()) return;
      if (abandoned()) return;
      if (destinationChanged()) {
        stopForDestination();
        return;
      }
      const result = await classifier.organize(
        definitions,
        tagDefinitions,
        organizeExcerpt(read),
        signal,
        images,
      );
      if (stale()) return;
      if (abandoned()) return;
      options.rateLimit.succeeded();
      const latest = document(id);
      if (!hasContent(latest) || latest.content_hash !== current.content_hash) {
        state(id, "pending");
        return;
      }
      // Definition changes make the complete result stale, including tags.
      if (JSON.stringify(tagDefinitions) !== JSON.stringify(options.tags.list())) {
        state(id, "pending");
        return;
      }
      const { groupId } = result;
      const choice = groupId === null ? null : definitions.find((item) => item.id === groupId);
      if (choice === undefined) throw new Error("The classifier returned an unknown group.");
      if (result.fallback) console.info(fallbackLine(id));
      const proposedFolder =
        choice && !groups().some((group) => group.id === choice.id)
          ? options.review.offeredFolders().find((folder) => folder.id === choice.id)
          : undefined;
      const placement: OrganizeReviewProposal["placement"] =
        choice === null
          ? { kind: "leftOut", leftOut: { reason: "doesntFit" } }
          : proposedFolder
            ? {
                kind: "newFolder",
                name: proposedFolder.name,
                description: proposedFolder.description,
                parentId: proposedFolder.parentId,
              }
            : { kind: "folder", folderId: choice.id };
      const { made, links } = db.transaction(() => {
        // The Document stays where it is: its place waits in Suggestions for the User (#1569).
        write(
          latest,
          initial.group_id,
          initial.source,
          "classified",
          classifier.model
            ? { ...classifier.model, images: images.length > 0 && classifier.model.images }
            : null,
        );
        options.review.propose(request?.run ?? BACKGROUND, [
          { documentId: id, contentHash: latest.content_hash, placement, tags: [] },
        ]);
        const applied = options.tags.applyAutomatic(id, result.tags, result.newTags);
        tagState(id, "classified");
        const current = asked.get(id);
        // A clearance goes only to the service this attempt's own request was authorized for.
        if (
          current !== undefined &&
          current === request &&
          (current.service === null || services.some((each) => each.id === current.service))
        ) {
          clearForService(db, id, services, now());
        }
        return applied;
      });
      if (made > 0) options.tagsMade?.();
      if (links.length > 0) call.applied?.(id, links);
      options.tagged([id]);
      announce([id]);
    } catch (error) {
      if (!stale()) {
        if (error instanceof NotFoundError) return;
        const limitedUntil = options.rateLimit.pause(error);
        const refused = limitedUntil === null ? options.rateLimit.refuse(error) : null;
        // The plan's limit: it waits for the plan to reset (see ./planPace).
        const waiting =
          limitedUntil !== null ||
          refused !== null ||
          error instanceof ChatNotReadyError ||
          error instanceof ConsentDeclinedError ||
          error instanceof ConsentNeededError ||
          gateStop(error) !== null ||
          error instanceof TaggingNotReadyError ||
          reachedPlanLimit(error);
        const said =
          limitedUntil === null
            ? (refused ?? classifyProviderError(error))
            : rateLimitError(limitedUntil, error);
        state(id, waiting ? "waiting" : "failed", said);
        const service = options.organizeService(getSettings());
        if (!waiting && service && (said.kind === "network" || said.kind === "provider")) {
          const doc = db.get<DocumentRow>(
            "SELECT id, name, kind, page_count, content_hash, status FROM documents WHERE id = ? AND deleted_at IS NULL",
            [id],
          );
          if (doc) leaveOut(doc, request, { reason: "unreachable", service: service.name });
        }
        // The app log's scrubber takes a UUID for a key: dotted, the id stays findable.
        console.error(
          `Organize failed on Document ${id.replaceAll("-", ".")}: ${said.kind}${said.status === undefined ? "" : ` (${said.status})`}. ${redactMessage(said.message)}`,
        );
        call.failed?.(error);
      }
    }
  }

  const queueClassification = (
    ids: readonly string[],
    run: OrganizeReviewRun,
    forService?: string,
  ) => {
    const service = options.organizeService(getSettings());
    // A continuation goes only where its press was authorized: nothing is queued or cleared otherwise.
    if (forService !== undefined && service?.id !== forService) return;
    const docs = ids.map(document);
    for (const doc of docs) {
      if (forService === undefined) {
        // A new request of the User's own replaces a continuation it supersedes for these Documents.
        asked.set(doc.id, ownRequest(run));
      } else {
        const existing = assignment(doc.id);
        asked.set(doc.id, {
          run,
          service: forService,
          failure: {
            status: existing?.status === "failed" ? "failed" : "waiting",
            error: existing ? assignmentFields(existing).error : null,
          },
        });
      }
    }
    // The request goes to this service, after a quit too: kept, not only in memory. A
    // continuation's binding lives in memory only, but its clearance names its own service alone.
    if (service) for (const doc of docs) clearForService(db, doc.id, [service], now());
    db.transaction(() => {
      for (const doc of docs) {
        const existing = assignment(doc.id);
        write(
          doc,
          existing?.group_id ?? null,
          existing?.source ?? "automatic",
          hasContent(doc) ? "pending" : "waiting",
        );
        tagState(doc.id, hasContent(doc) ? "pending" : "waiting");
      }
    });
    options.tagged(docs.map((doc) => doc.id));
    announce(docs.map((doc) => doc.id));
  };

  function resume(): void {
    if (lifetime.signal.aborted) return;
    const waiting = db
      .all<{ document_id: string }>(
        "SELECT g.document_id FROM document_groups g JOIN documents d ON d.id = g.document_id WHERE g.deleted_at IS NULL AND d.deleted_at IS NULL AND g.status IN ('pending', 'waiting')",
      )
      // An assignment an earlier version made for an example's Document or a Meeting's Transcript
      // isn't worked on again.
      .filter((row) => !leftAlone(row.document_id));
    // Existing batches run text first, then PDFs needing images, avoiding model churn.
    const ordered =
      organizeModelOf(getSettings())?.kind === "auto"
        ? waiting
            .map((row) => ({ ...row, visual: needsPageImages(document(row.document_id)) }))
            .sort((a, b) => Number(a.visual) - Number(b.visual))
        : waiting;
    for (const row of ordered) enqueue(row.document_id);
  }

  /** A Folder's stored citation style; one this version doesn't know reads as none. */
  function citationStyleOf(id: string): CitationStyleId | null {
    const value = db.get<{ citation_style: string | null }>(
      "SELECT citation_style FROM library_groups WHERE id = ?",
      [id],
    )?.citation_style;
    return isCitationStyleId(value) ? value : null;
  }

  function create(input: unknown): LibraryGroup {
    const value = parseGroup(input);
    const at = now();
    const id = randomUUID();
    db.run(
      `INSERT INTO library_groups (id, name, description, parent_id, counts_own_files, keep_inside, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.name,
        value.description,
        value.parentId ?? null,
        value.countsOwnFiles ? 1 : 0,
        value.keepInside ? 1 : 0,
        at,
        at,
      ],
    );
    revision++;
    changed();
    resume();
    return group(id);
  }

  function parseGroup(input: unknown, exceptId?: string) {
    if (!isRecord(input) || typeof input.name !== "string" || typeof input.description !== "string")
      throw new InvalidInputError({ key: "error.folder.nameAndDescription" });
    const name = input.name.trim();
    const description = input.description.trim();
    if (!name || name.length > 100 || description.length > 500)
      throw new InvalidInputError({ key: "error.folder.lengths" });
    if (groups().some((item) => item.id !== exceptId && sameName(item.name, name)))
      throw new InvalidInputError({ key: "error.folder.nameTaken" });
    if (!exceptId && groups().length >= 100)
      throw new InvalidInputError({ key: "error.folder.limit" });
    const { countsOwnFiles, keepInside, parentId } = input;
    if (countsOwnFiles !== undefined && typeof countsOwnFiles !== "boolean")
      throw new InvalidInputError("countsOwnFiles must be true or false.");
    if (keepInside !== undefined && typeof keepInside !== "boolean")
      throw new InvalidInputError({ key: "error.folder.keepInside" });
    if (parentId !== undefined && parentId !== null && typeof parentId !== "string")
      throw new InvalidInputError({ key: "error.folder.parentId" });
    const inside = parentId === undefined ? undefined : parentId;
    if (inside !== undefined && inside !== null) {
      group(inside);
      if (exceptId !== undefined && (inside === exceptId || subtree(exceptId).includes(inside)))
        throw new InvalidInputError({ key: "error.folder.insideItself" });
    }
    return { name, description, countsOwnFiles, keepInside, parentId: inside };
  }

  const documentIdsOf = (input: unknown): string[] => {
    if (!Array.isArray(input) || !input.every((id) => typeof id === "string" && id !== ""))
      throw new InvalidInputError("Choose valid Documents.");
    return [...new Set(input as string[])];
  };

  /**
   * What a proposal reads: the first `SAMPLED` Documents with the start of their text, the rest
   * up to `NAMED` by name and type only, so a Linked folder of thousands stays one request.
   */
  const samplesOf = (docs: readonly DocumentRow[]): FolderSample[] =>
    docs.slice(0, SAMPLED + NAMED).map((doc, at) => {
      const excerpt = organizeExcerpt(source(doc, at < SAMPLED));
      return {
        name: doc.name,
        type: documentType(excerpt),
        text: at < SAMPLED ? excerptFromPassages([excerpt.text], SAMPLE_TOKENS) : "",
      };
    });

  /**
   * A Document Organize may not send by itself (`mayBackgroundSend`) waits for the User, "off":
   * one it hadn't filed has no assignment, as if it was never sorted; one it had stays filed.
   */
  function holdBack(id: string, row: { source: string; group_id: string | null }): void {
    const at = now();
    db.transaction(() => {
      if (row.source === "automatic" && row.group_id === null) {
        db.run(
          "UPDATE document_groups SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL",
          [at, at, id],
        );
      } else {
        state(id, "classified");
      }
      db.run(
        "UPDATE documents SET tagging_status = 'off', tagging_error_kind = NULL, tagging_error_message = NULL, tagging_error_resets_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        [at, id],
      );
    });
    options.tagged([id]);
    announce([id]);
  }

  /**
   * The cloud service new Documents wait to be allowed on (`LibrarySnapshot.sortWaitsFor`). None
   * when turning sorting on would turn it on for another service too (tagging's, say a Jev key's):
   * the row's Allow names one service, and is the consent for that one only.
   */
  function sortWaitsFor(): ExternalService | null {
    const now = getSettings();
    if (now.automatic || options.localOnly?.() || groups().length === 0) return null;
    const service = options.organizeService(now);
    if (!service || options.sendsTo(now).some((each) => each.id !== service.id)) return null;
    return service;
  }

  // Organize holds a Document's Tags while its assignment isn't finished (queued, running,
  // waiting or failed), or while Organize files new Documents by itself.
  const isOrganizing = (id: string): boolean => {
    const held = assignment(id);
    return !!held && (getSettings().automatic || held.status !== "classified");
  };

  return {
    settings: getSettings,
    chosenSettings,
    /**
     * Organize uses this model, as if the User had chosen it, until the returned function is
     * called; nothing is stored, so a quit leaves no trace (#2252). One the User chose wins.
     */
    lendOrganizeModel(classifier: TaggingClassifier): () => void {
      lent = classifier;
      return () => {
        lent = null;
      };
    },
    turnedOnSeq,
    taggingStoppedFor,
    isOrganizing,
    taggingPlaces(): (string | null)[] {
      const ids = db
        .all<{ id: string }>(
          `SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND (
             (d.status = 'ready' AND d.tagging_status IN ('pending', 'tagging'))
             OR EXISTS (SELECT 1 FROM document_groups g WHERE g.document_id = d.id
               AND g.deleted_at IS NULL AND g.status IN ('pending', 'classifying')))`,
        )
        .map((row) => row.id);
      return [...new Set(ids.map(placeOf))];
    },
    /**
     * Stops automatic Tagging with AI in these places, or turns it back on.
     * Turned back on while Organize tags new Documents, their stopped Documents
     * are organized; otherwise automatic tagging picks them up.
     */
    setTaggingStopped(places: readonly (string | null)[], stop: boolean): void {
      if (stop) for (const place of places) if (place !== null) group(place);
      const before = getSettings();
      const taggingStopped = stop
        ? [...new Set([...before.taggingStopped, ...places])]
        : before.taggingStopped.filter((each) => !places.includes(each));
      settings.writeDeviceValue("library", { ...savedSettings(), taggingStopped });
      changed();
      if (stop || !before.automatic || !organizeModelOf(before) || groups().length === 0) return;
      const ids = db
        .all<{ id: string }>(
          "SELECT id FROM documents WHERE deleted_at IS NULL AND tagging_status = 'stopped'",
        )
        .map((row) => row.id)
        .filter((id) => places.includes(placeOf(id)));
      for (const id of ids) asked.set(id, ownRequest(BACKGROUND));
      db.transaction(() => {
        for (const id of ids) {
          const existing = assignment(id);
          write(
            document(id),
            existing?.group_id ?? null,
            existing?.source ?? "automatic",
            "pending",
          );
          tagState(id, "pending");
        }
      });
      options.tagged(ids);
      announce(ids);
      resume();
    },
    documentIds: filedDocumentIdsOf,
    allDocumentIds: everyFiledDocumentIdsOf,
    subtree,
    deletedWith,
    wallOf,
    wallsOf,
    treeDocumentIds(folderId: string): string[] {
      return [...new Set(tree(folderId).flatMap((id) => filedDocumentIdsOf(id)))];
    },
    allTreeDocumentIds(folderId: string): string[] {
      return [...new Set(tree(folderId).flatMap((id) => everyFiledDocumentIdsOf(id)))];
    },
    /**
     * The live Documents in no live Folder now, the Library's "Not in a Folder": a Linked
     * folder's Documents are in none until they are filed, and a Meeting's Transcript is where
     * its Note is (#2528).
     */
    unfiledDocumentIds(): string[] {
      return db
        .all<{ id: string }>(
          `SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM document_groups a JOIN library_groups g ON g.id = a.group_id
             WHERE a.document_id = d.id AND a.deleted_at IS NULL AND g.deleted_at IS NULL)
           AND (d.meeting_mind_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM minds n JOIN library_groups g ON g.id = n.folder_id
             WHERE n.id = d.meeting_mind_id AND g.deleted_at IS NULL))`,
        )
        .map((row) => row.id);
    },
    snapshot(): LibrarySnapshot {
      const assignments = db
        .all<AssignmentRow & TaggingColumns>(
          "SELECT g.*, d.tagging_status AS tagging_status, d.tagging_error_kind AS tagging_error_kind, d.tagging_error_message AS tagging_error_message, d.tagging_error_resets_at AS tagging_error_resets_at, d.updated_at AS tagging_row_updated_at FROM document_groups g JOIN documents d ON d.id = g.document_id WHERE g.deleted_at IS NULL AND d.deleted_at IS NULL",
        )
        .map((row) => assignmentOf(row, taggingOf(row) ?? undefined));
      const deletedGroups = db
        .all<GroupRow>(
          `SELECT ${GROUP_COLUMNS} FROM library_groups WHERE deleted_at IS NOT NULL ORDER BY name COLLATE NOCASE, id`,
        )
        .map(toGroup);
      const saved = savedSettings();
      const waiting = sortWaitsFor();
      return {
        groups: groups(),
        deletedGroups,
        assignments,
        settings: shownSettings(saved),
        automaticDefault: defaultAutomatic(saved),
        automaticOffNotice: automaticOffNotice(),
        ...(waiting && { sortWaitsFor: waiting }),
        reviewCount: options.reviewCount(),
        ...(reviewMoved() > 0 && { reviewMoved: reviewMoved() }),
      };
    },
    /**
     * The plan has finished with these Documents (#1569): each is done, in the Folder it is in,
     * so none still waits to be allowed or counts as failed, and a job of the queue still running
     * on it stops.
     */
    settle(ids: readonly string[]): void {
      const done = db.transaction(() =>
        ids.flatMap((id) => {
          const row = assignment(id);
          const doc = db.get<DocumentRow>(
            "SELECT id, name, kind, page_count, content_hash, status FROM documents WHERE id = ? AND deleted_at IS NULL",
            [id],
          );
          if (!doc || row?.status === "classified") return [];
          asked.delete(id);
          write(doc, row?.group_id ?? null, row?.source ?? "automatic", "classified");
          return [id];
        }),
      );
      if (done.length > 0) announce(done);
    },
    dismissReviewMoved(): void {
      if (reviewMoved() === 0) return;
      settings.writeDeviceValue(REVIEW_MOVED_NOTICE, 0);
      changed();
    },
    dismissAutomaticOffNotice(): void {
      if (settings.readDeviceValue(AUTOMATIC_OFF_NOTICE) !== true) return;
      settings.writeDeviceValue(AUTOMATIC_OFF_NOTICE, false);
      changed();
    },
    inWall,
    /** A live Folder, or NotFoundError. */
    folder: group,
    /** The live Folders, by name. */
    folders: groups,
    /**
     * Puts these Documents in a Folder (or in none) as the User's choice, as
     * `assign` does for one, all or none, and returns where each was. It says
     * nothing yet: the caller calls `moved` once what it is part of is saved.
     */
    move(ids: readonly string[], groupId: string | null): MovedDocument[] {
      if (groupId !== null) group(groupId);
      const docs = ids.map(fileable);
      const moved = db.transaction(() =>
        docs.map((doc) => {
          const before = assignment(doc.id);
          const taggingBefore = taggingSnapshot(doc.id);
          write(doc, groupId, "user", "classified");
          // A manual choice cancels an in-flight suggestion, including its busy indicator.
          db.run(
            "UPDATE documents SET tagging_status = 'waiting-for-provider' WHERE id = ? AND tagging_status IN ('pending', 'tagging')",
            [doc.id],
          );
          const after = assignment(doc.id);
          const taggingAfter = taggingSnapshot(doc.id);
          const taggingMoved = taggingKey(taggingBefore) !== taggingKey(taggingAfter);
          return {
            id: doc.id,
            from: before?.group_id ?? null,
            change: {
              documentId: doc.id,
              before: {
                assignment: before ? assignmentFields(before) : null,
                tagging: taggingMoved ? taggingBefore : null,
              },
              after: {
                assignment: after ? assignmentFields(after) : null,
                tagging: taggingMoved ? taggingAfter : null,
              },
            },
          };
        }),
      );
      return moved;
    },
    /** Says that these Documents moved (`move`): one "library.assignments", and their tagging. */
    moved(ids: readonly string[]) {
      if (ids.length === 0) return;
      options.tagged([...ids]);
      announce(ids);
    },
    create,
    update(id: unknown, input: unknown) {
      const existing = group(id);
      const value = parseGroup(input, existing.id);
      const counts = value.countsOwnFiles ?? existing.countsOwnFiles;
      const keepInside = value.keepInside ?? existing.keepInside;
      const parentId = value.parentId === undefined ? existing.parentId : value.parentId;
      db.run(
        `UPDATE library_groups SET name = ?, description = ?, parent_id = ?, counts_own_files = ?, keep_inside = ?, updated_at = ?
         WHERE id = ?`,
        [
          value.name,
          value.description,
          parentId,
          counts ? 1 : 0,
          keepInside ? 1 : 0,
          now(),
          existing.id,
        ],
      );
      revision++;
      changed();
      return group(existing.id);
    },
    /**
     * Moves Folders in one step: each to its new parent (null: the top level). A Folder moved
     * with one of its own Folders stays where it is, so the tree keeps its shape; one already
     * there, or gone since, is left. Nothing changes when any move is refused.
     */
    moveGroups(moves: readonly { id: string; parentId: string | null }[]): string[] {
      const wanted = [...new Map(moves.map((move) => [move.id, move])).values()];
      if (wanted.length === 0) return [];
      const live = new Map(groups().map((folder) => [folder.id, folder]));
      const changing = wanted.filter((move) => {
        const folder = live.get(move.id);
        return folder !== undefined && folder.parentId !== move.parentId;
      });
      // A Folder moving with one of its own Folders goes with it; one listed beside a Folder that
      // stays where it is moves as it asks.
      const moving = changing.filter(
        (move) =>
          !changing.some((other) => other.id !== move.id && subtree(other.id).includes(move.id)),
      );
      for (const move of moving) if (move.parentId !== null) group(move.parentId);
      // The Folders as they will be, to catch a loop formed by the moves together: X into Y while
      // Y comes into X leaves both in no tree at all.
      const parentAfter = new Map([...live].map(([id, folder]) => [id, folder.parentId]));
      for (const move of moving) parentAfter.set(move.id, move.parentId);
      for (const id of parentAfter.keys()) {
        const seen = new Set<string>();
        let at: string | null | undefined = id;
        while (at !== null && at !== undefined && !seen.has(at)) {
          seen.add(at);
          at = parentAfter.get(at) ?? null;
        }
        if (at !== null && at !== undefined)
          throw new InvalidInputError({ key: "error.folder.insideItself" });
      }
      const changes = moving;
      if (changes.length === 0) return [];
      db.transaction(() => {
        const at = now();
        for (const change of changes)
          db.run(
            "UPDATE library_groups SET parent_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            [change.parentId, at, change.id],
          );
      });
      revision++;
      changed();
      return changes.map((change) => change.id);
    },
    /** The citation style new Minds in a live Folder start in (#289); null if none was chosen. */
    citationStyle(id: string): CitationStyleId | null {
      return citationStyleOf(group(id).id);
    },
    /** Sets the style new Minds in a live Folder start in; null: none, so they are Numbered. */
    setCitationStyle(id: string, style: CitationStyleId | null): void {
      const existing = group(id);
      if (citationStyleOf(existing.id) === style) return;
      db.run("UPDATE library_groups SET citation_style = ?, updated_at = ? WHERE id = ?", [
        style,
        now(),
        existing.id,
      ]);
      revision++;
      changed();
    },
    /**
     * Deletes a Folder and the Folders inside it: their Documents go to Not in a Folder, as the
     * Minds and conversations the caller took out of them did, and all are recorded folder by
     * folder so that restoring it puts them back. `at`: when Undo of a Restore deletes it again.
     */
    delete(
      id: unknown,
      taken: {
        minds?: Readonly<Record<string, readonly string[]>>;
        conversations?: Readonly<Record<string, readonly string[]>>;
      } = {},
      at: string = now(),
    ): Pick<FolderDeletion, "assignments"> {
      const existing = group(id);
      const folders = subtree(existing.id);
      // The record is dated when it is written, not at `at`: Undo of a Restore deletes a Folder
      // at its old time after an item was deleted at the Undo's own, and the item still reads the
      // Folder it was in (#2274).
      const written = now();
      const record = (
        folderId: string,
        kind: "document" | "mind" | "conversation",
        itemId: string,
      ) =>
        db.run(
          `INSERT INTO deleted_folder_items
             (id, folder_id, item_kind, item_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [randomUUID(), folderId, kind, itemId, written, written],
        );
      const assignments = db.transaction(() => {
        const rows = db.all<AssignmentRow & { live: number }>(
          `SELECT g.*, d.deleted_at IS NULL AS live FROM document_groups g
           JOIN documents d ON d.id = g.document_id
           WHERE g.group_id IN (SELECT value FROM json_each(?)) AND g.deleted_at IS NULL
           ORDER BY g.rowid`,
          [JSON.stringify(folders)],
        );
        db.run(
          "UPDATE library_groups SET deleted_at = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
          [at, at, JSON.stringify(folders)],
        );
        for (const row of rows) {
          if (row.group_id !== null) record(row.group_id, "document", row.document_id);
        }
        for (const [folderId, ids] of Object.entries(taken.minds ?? {})) {
          for (const mindId of ids) record(folderId, "mind", mindId);
        }
        for (const [folderId, ids] of Object.entries(taken.conversations ?? {})) {
          for (const conversationId of ids) record(folderId, "conversation", conversationId);
        }
        db.run(
          "UPDATE document_groups SET group_id = NULL, updated_at = ? WHERE group_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
          [at, JSON.stringify(folders)],
        );
        return rows.filter((row) => row.live).map((row) => assignmentOf(row));
      });
      revision++;
      changed();
      return { assignments };
    },
    /**
     * Brings back a deleted Folder, the Folders deleted with it and the Documents its deletion
     * took out that are in no Folder now. Returns each restored Folder's Minds and conversations,
     * for the caller to put back. Throws if a name is taken or the Library is full. Run in the
     * caller's transaction, then `restored`.
     */
    restore(id: string): {
      folders: string[];
      minds: { folderId: string; ids: string[] }[];
      conversations: { folderId: string; ids: string[] }[];
      /** Folders put at the top level, the Folder they were in still deleted. */
      toTopLevel: string[];
    } {
      const row = db.get<{ name: string; deleted_at: string | null }>(
        "SELECT name, deleted_at FROM library_groups WHERE id = ?",
        [id],
      );
      if (!row) throw new NotFoundError({ key: "error.folder.notFound" });
      const folders = row.deleted_at === null ? [id] : deletedWith(id, row.deleted_at);
      const live = groups();
      const takenNames = new Set(live.map((folder) => folder.name.toLowerCase()));
      for (const folder of db.all<{ name: string }>(
        "SELECT name FROM library_groups WHERE id IN (SELECT value FROM json_each(?))",
        [JSON.stringify(folders)],
      )) {
        if (takenNames.has(folder.name.toLowerCase()))
          throw new InvalidInputError({
            key: "error.restore.folderNameTaken",
            values: { name: folder.name },
          });
      }
      if (live.length + folders.length > 100)
        throw new InvalidInputError({ key: "error.restore.folderLimit" });
      const at = now();
      const list = JSON.stringify(folders);
      db.run(
        "UPDATE library_groups SET deleted_at = NULL, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))",
        [at, list],
      );
      // A Folder restored without the Folder it was in (still deleted) goes to the top level,
      // rather than point at a Folder that isn't there and come back inside it later.
      const orphaned = `id IN (SELECT value FROM json_each(?))
           AND parent_id IS NOT NULL
           AND parent_id NOT IN (SELECT id FROM library_groups WHERE deleted_at IS NULL)`;
      const toTopLevel = db
        .all<{ id: string }>(`SELECT id FROM library_groups WHERE ${orphaned}`, [list])
        .map((folder) => folder.id);
      db.run(`UPDATE library_groups SET parent_id = NULL, updated_at = ? WHERE ${orphaned}`, [
        at,
        list,
      ]);
      db.run(
        `UPDATE document_groups SET group_id = item.folder_id, updated_at = ?
         FROM deleted_folder_items item
         WHERE item.folder_id IN (SELECT value FROM json_each(?))
           AND item.item_kind = 'document' AND item.deleted_at IS NULL AND item.suggested = 0
           AND item.item_id = document_groups.document_id
           AND document_groups.deleted_at IS NULL AND document_groups.group_id IS NULL`,
        [at, list],
      );
      // One that waited in it as a suggestion, from before Suggestions, waits there again (#1569).
      const waited = db.all<{
        document_id: string;
        folder_id: string;
        content_hash: string | null;
      }>(
        `SELECT g.document_id, item.folder_id, d.content_hash FROM deleted_folder_items item
         JOIN document_groups g ON g.document_id = item.item_id AND g.deleted_at IS NULL
           AND g.group_id IS NULL
         JOIN documents d ON d.id = item.item_id
         WHERE item.folder_id IN (SELECT value FROM json_each(?))
           AND item.item_kind = 'document' AND item.deleted_at IS NULL AND item.suggested = 1`,
        [list],
      );
      options.review.propose(
        { origin: "migrated" },
        waited.map((row) => ({
          documentId: row.document_id,
          contentHash: row.content_hash,
          placement: { kind: "folder", folderId: row.folder_id },
          tags: [],
        })),
      );
      const taken = (kind: "mind" | "conversation") => {
        const byFolder = new Map<string, string[]>();
        for (const row of db.all<{ folder_id: string; item_id: string }>(
          "SELECT folder_id, item_id FROM deleted_folder_items WHERE folder_id IN (SELECT value FROM json_each(?)) AND item_kind = ? AND deleted_at IS NULL",
          [list, kind],
        )) {
          byFolder.set(row.folder_id, [...(byFolder.get(row.folder_id) ?? []), row.item_id]);
        }
        return [...byFolder].map(([folderId, ids]) => ({ folderId, ids }));
      };
      const items = {
        folders,
        minds: taken("mind"),
        conversations: taken("conversation"),
        toTopLevel,
      };
      db.run(
        "UPDATE deleted_folder_items SET deleted_at = ?, updated_at = ? WHERE folder_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL",
        [at, at, list],
      );
      return items;
    },
    /** Folders came back (`restore`): the Library is read again, and Organize may go on. */
    restored() {
      revision++;
      changed();
      resume();
    },
    /** Says these Documents' assignments changed, e.g. once they are restored. */
    announce,
    addStarters(input: unknown) {
      if (!Array.isArray(input) || !input.every((key) => libraryPresetKeys.includes(key)))
        throw new InvalidInputError("Choose valid starter groups.");
      const language = settings.get().language;
      // Validate the complete input before changing anything; repeated selections are harmless.
      db.transaction(() => {
        for (const key of new Set(input as (typeof libraryPresetKeys)[number][])) {
          const name = translate(language, `library.preset.${key}`);
          if (!groups().some((item) => sameName(item.name, name)))
            create({ name, description: translate(language, `library.preset.${key}.description`) });
        }
      });
    },
    /**
     * Forgets the choice, and Organize's kept model, where `reached` says they name what can't run
     * any more: a removed key's host (#1907). They go back to Automatic and to none as saved, with
     * no check of what they named, which may be gone too, and nothing else changes: the switch,
     * its turn-ons and a model lent to a run stay as they are. False when neither named it.
     */
    forgetModel(reached: (classifier: TaggingClassifier) => boolean): boolean {
      const stored = settings.readDeviceValue("library");
      const saved = isRecord(stored) ? stored : {};
      const classifier = taggingClassifierOf(saved.classifier);
      const organizeWith = taggingClassifierOf(saved.organizeWith);
      const dropsChoice = classifier !== null && reached(classifier);
      const dropsKept = organizeWith !== null && reached(organizeWith);
      if (!dropsChoice && !dropsKept) return false;
      settings.writeDeviceValue("library", {
        ...saved,
        ...(dropsChoice && { classifier: AUTOMATIC }),
        ...(dropsKept && { organizeWith: null }),
      });
      revision++;
      changed();
      return true;
    },
    saveSettings(input: unknown) {
      if (!isRecord(input) || typeof input.automatic !== "boolean")
        throw new InvalidInputError("Choose classification settings.");
      // Null was "Organize manually" before there was Automatic: it is Automatic now.
      const chosen = input.classifier ?? AUTOMATIC;
      const automaticChosen = isRecord(chosen) && chosen.kind === "automatic";
      const organizeWith =
        input.organizeWith === undefined ? savedSettings().organizeWith : input.organizeWith;
      const toCheck: unknown[] = automaticChosen ? [] : [chosen];
      if (organizeWith !== null) toCheck.push(organizeWith);
      for (const each of toCheck) {
        if (!isRecord(each)) throw new InvalidInputError("Choose a classifier.");
        checkClassifier(each);
      }
      const before = savedSettings();
      const next = {
        classifier: automaticChosen ? AUTOMATIC : (taggingClassifierOf(chosen) ?? AUTOMATIC),
        organizeWith: taggingClassifierOf(organizeWith),
      };
      // Only `turnOn`, sent where the line says what goes, turns it on, and records when and
      // where in the database's order, for each service it sends to (ADR-0022, #2370). Any other
      // save may only turn it off: a save sends the switch as shown, which can be a window's
      // older view (#2308).
      const turnOn = input.turnOn === true;
      const showing = shownSettings(before).automatic;
      const automatic = turnOn
        ? true
        : input.automatic === false && showing
          ? false
          : before.automatic;
      const at = now();
      // Turned on again where it is on, and still allowed, as a new key's Use this does, it keeps
      // its place: what came in while it was on stays new. Where the User took the consent back,
      // turning it on is a new consent.
      const onFor = new Set(
        showing
          ? options
              .sendsTo(before)
              .filter((service) => options.taggingAllowed(service))
              .map((service) => service.id)
          : [],
      );
      const freshOn = turnOn
        ? options.sendsTo(next).filter((service) => !onFor.has(service.id))
        : [];
      const automaticSince = turnOn
        ? { ...sinceOf(before), ...Object.fromEntries(freshOn.map((service) => [service.id, at])) }
        : sinceOf(before);
      const automaticSinceSeq = turnOn
        ? {
            ...sinceSeqOf(before),
            ...Object.fromEntries(freshOn.map((service) => [service.id, nextSequence(db, at)])),
          }
        : sinceSeqOf(before);
      if (automatic !== null && noticeIsOpen(settings.readDeviceValue(AUTOMATIC_OFF_NOTICE))) {
        settings.writeDeviceValue(AUTOMATIC_OFF_NOTICE, false);
      }
      settings.writeDeviceValue("library", {
        classifier: automaticChosen ? AUTOMATIC : chosen,
        ...(automatic !== null && { automatic }),
        organizeWith,
        automaticSince,
        automaticSinceSeq,
        taggingStopped: before.taggingStopped,
      });
      revision++;
      changed();
      resume();
    },
    /**
     * Proposes Folders for these Documents (the User's own, live ones with text), names them in
     * `language` and makes them; Organize then sorts the Documents into them (`classify`).
     * Returns the Folders made. Throws InvalidInputError when Organize's model can't name Folders.
     */
    async propose(
      input: unknown,
      language: Language,
      permit?: CloudReadPermit,
      forService?: string,
    ): Promise<OrganizeReviewFolder[]> {
      const settings = getSettings();
      if (!organizeModelOf(settings))
        throw new InvalidInputError({ key: "error.library.noClassifier" });
      // A continuation proposes only to the service its press was authorized for (#2308).
      if (forService !== undefined && options.organizeService(settings)?.id !== forService)
        return [];
      const docs = documentIdsOf(input)
        .filter((id) => !leftAlone(id))
        .map(document)
        .filter(hasContent);
      if (docs.length === 0) return [];
      const classifier = await options.prepare(settings, permit);
      if (!classifier.proposeFolders)
        throw new InvalidInputError({ key: "error.library.cantPropose" });
      const existing = choicesOf().map((each) => each.name);
      const proposed = await classifier.proposeFolders(
        samplesOf(docs),
        existing,
        language,
        lifetime.signal,
      );
      return options.review.proposeFolders(proposed.slice(0, Math.max(0, 100 - groups().length)));
    },
    classify(input: unknown, forService?: string, run: OrganizeReviewRun = { origin: "library" }) {
      if (!organizeModelOf(getSettings()))
        throw new InvalidInputError({ key: "error.library.noClassifier" });
      if (nothingToChoose()) throw new InvalidInputError({ key: "error.library.noFolders" });
      // A continuation's authorized service, checked before anything is queued or cleared (#2308).
      if (forService !== undefined && options.organizeService(getSettings())?.id !== forService)
        return;
      const ids = (
        input === undefined
          ? db
              .all<{ id: string }>("SELECT id FROM documents WHERE deleted_at IS NULL")
              .map((row) => row.id)
          : documentIdsOf(input)
      ).filter((id) => !leftAlone(id));
      queueClassification(ids, run, forService);
      resume();
    },
    /**
     * Organize these Documents and wait for the model, inside the turn that asked (#2252): the
     * queue never starts while an Answer is written, so a request that files them before its reply
     * sorts here, as the Library does. It stops at the first failure and puts every Document it
     * hadn't reached back as it was, so none is left working with no job to finish it.
     */
    async organizeAtOnce(
      input: unknown,
      signal: AbortSignal,
      allowedGroups?: ReadonlySet<string>,
      permit?: CloudReadPermit,
      run: OrganizeReviewRun & { newFolders?: boolean } = { origin: "assistant" },
    ): Promise<{ failed: unknown | null; untouched: number; tagChanges: TagLinkChange[] }> {
      if (!organizeModelOf(getSettings()))
        throw new InvalidInputError({ key: "error.library.noClassifier" });
      if (nothingToChoose()) throw new InvalidInputError({ key: "error.library.noFolders" });
      const ids = documentIdsOf(input).filter((id) => !leftAlone(id));
      const before = new Map(
        ids.map((id) => {
          const row = assignment(id);
          return [
            id,
            { assignment: row ? assignmentFields(row) : null, tagging: taggingSnapshot(id) },
          ];
        }),
      );
      const { newFolders, ...proposing } = run;
      queueClassification(ids, proposing);
      let failure: unknown | null = null;
      const reached = new Set<string>();
      const tagChanges: TagLinkChange[] = [];
      for (const id of ids) {
        if (signal.aborted) break;
        let stopped: unknown = null;
        await classifyOne(id, {
          signal,
          runsLocally: () => undefined,
          failed: (error) => {
            stopped = error;
          },
          applied: (_id, links) => tagChanges.push(...links),
          allowedGroups,
          newFolders,
          permit,
        });
        // Stopped during this one: it goes back as it was, like the ones after it.
        if (signal.aborted && !lifetime.signal.aborted) break;
        reached.add(id);
        if (stopped) {
          failure = stopped;
          break;
        }
      }
      const untouched = ids.filter((id) => !reached.has(id));
      for (const id of untouched) {
        const prior = before.get(id);
        if (!prior) continue;
        try {
          restoreAssignmentRow(document(id), prior.assignment);
          if (prior.tagging) restoreTaggingRow(id, prior.tagging);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
        if (prior.assignment?.status === "pending" || prior.assignment?.status === "waiting") {
          enqueue(id);
        }
      }
      return { failed: failure, untouched: untouched.length, tagChanges };
    },
    assign(id: unknown, groupId: unknown): AssignmentChange {
      const doc = fileable(id);
      if (groupId !== null) group(groupId);
      const before = assignment(doc.id);
      const taggingBefore = taggingSnapshot(doc.id);
      write(doc, groupId as string | null, "user", "classified");
      // A manual correction cancels an in-flight suggestion, including its busy indicator.
      db.run(
        "UPDATE documents SET tagging_status = 'waiting-for-provider' WHERE id = ? AND tagging_status IN ('pending', 'tagging')",
        [doc.id],
      );
      const after = assignment(doc.id);
      const taggingAfter = taggingSnapshot(doc.id);
      const taggingMoved = taggingKey(taggingBefore) !== taggingKey(taggingAfter);
      options.tagged([doc.id]);
      announce([doc.id]);
      return {
        documentId: doc.id,
        before: {
          assignment: before ? assignmentFields(before) : null,
          tagging: taggingMoved ? taggingBefore : null,
        },
        after: {
          assignment: after ? assignmentFields(after) : null,
          tagging: taggingMoved ? taggingAfter : null,
        },
      };
    },
    /** See `CoreApi.restoreAssignment`. */
    restoreAssignment(id: unknown, beforeInput: unknown, afterInput: unknown) {
      const target = parseAssignmentState(beforeInput);
      const after = parseAssignmentState(afterInput);
      let doc: DocumentRow;
      try {
        doc = fileable(id);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        throw new NotFoundError({ key: "error.restore.documentGone" });
      }
      if (target.assignment?.groupId) {
        const name = db.get<{ name: string }>(
          "SELECT name FROM library_groups WHERE id = ? AND deleted_at IS NOT NULL",
          [target.assignment.groupId],
        )?.name;
        if (name !== undefined)
          throw new NotFoundError({ key: "error.restore.folderGone", values: { name } });
        group(target.assignment.groupId);
      }
      const current = assignment(doc.id);
      const currentAssignment = current ? assignmentFields(current) : null;
      const currentTagging = taggingSnapshot(doc.id);
      // Each row goes back only while it is still as the change left it: a move, a run or a re-tag
      // since is later work, and it wins (#1928).
      const assignmentFits = sameAssignment(currentAssignment, after.assignment);
      const restoreTagging =
        target.tagging !== null &&
        after.tagging !== null &&
        taggingKey(currentTagging) === taggingKey(after.tagging);
      if (!assignmentFits && !restoreTagging) return null;
      db.transaction(() => {
        if (assignmentFits) restoreAssignmentRow(doc, target.assignment);
        if (restoreTagging && target.tagging) restoreTaggingRow(doc.id, target.tagging);
      });
      const restored = assignment(doc.id);
      const restoredAssignment = restored ? assignmentFields(restored) : null;
      const restoredTagging = restoreTagging ? taggingSnapshot(doc.id) : null;
      const assignmentMoved = !sameAssignment(currentAssignment, restoredAssignment);
      const taggingMoved =
        restoreTagging && taggingKey(currentTagging) !== taggingKey(restoredTagging);
      if (!assignmentMoved && !taggingMoved) return null;
      // A Document that had no assignment goes back to none: no event can say so, the snapshot does.
      if (!restoredAssignment) {
        revision++;
        options.changed();
      }
      options.tagged([doc.id]);
      announce([doc.id]);
      // A Document put back as waiting waits as it did: resuming now would organize it again at once (#1391).
      if (target.assignment?.status === "pending" || target.assignment?.status === "classifying")
        resume();
      return {
        documentId: doc.id,
        before: {
          assignment: currentAssignment,
          tagging: taggingMoved ? currentTagging : null,
        },
        after: {
          assignment: restoredAssignment,
          tagging: taggingMoved ? restoredTagging : null,
        },
      };
    },
    target(input: unknown): string | null {
      if (input === undefined || input === null) return null;
      if (!isRecord(input)) throw new InvalidInputError("Choose where to add the Documents.");
      return input.groupId === undefined || input.groupId === null ? null : group(input.groupId).id;
    },
    file(id: string, groupId: string) {
      if (!groups().some((item) => item.id === groupId)) return;
      const { automatic, taggingStopped } = getSettings();
      write(fileable(id), groupId, "user", automatic ? "pending" : "classified");
      if (taggingStopped.includes(groupId)) stopped(id);
      else announce([id]);
    },
    documentChanged(id: string) {
      if (lifetime.signal.aborted) return;
      if (leftAlone(id)) return;
      const doc = document(id);
      const existing = assignment(id);
      if (!hasContent(doc)) {
        // Read, with nothing Organize can read: a Document the User filed has no Tags to wait for.
        if (
          existing?.source === "user" &&
          existing.status === "pending" &&
          (doc.status === "no-text" || doc.status === "failed")
        )
          state(id, "classified");
        // A scan whose page images may not go yet is left unsorted, with the reason.
        const waits = scanWaits(doc);
        if (
          waits &&
          existing?.source !== "user" &&
          getSettings().automatic &&
          groups().length > 0 &&
          !taggingStoppedFor(id) &&
          (!existing || existing.content_hash !== doc.content_hash)
        ) {
          write(doc, existing?.group_id ?? null, existing?.source ?? "automatic", "waiting");
          state(id, "waiting", waits);
        }
        return;
      }
      if (
        getSettings().automatic &&
        groups().length > 0 &&
        (existing ? existing.content_hash !== doc.content_hash : !filedBefore(doc))
      ) {
        if (taggingStoppedFor(id)) {
          stopped(id);
          return;
        }
        write(doc, existing?.group_id ?? null, existing?.source ?? "automatic", "pending");
        announce([id]);
      }
      const status = assignment(id)?.status;
      if (status === "pending" || status === "waiting") enqueue(id);
    },
    resume,
    start() {
      db.run(
        "UPDATE document_groups SET status = 'pending' WHERE status = 'classifying' AND deleted_at IS NULL",
      );
      resume();
    },
    close() {
      lifetime.abort();
    },
  };
}
