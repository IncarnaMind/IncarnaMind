import { sameName } from "../../shared/names";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Database } from "../storage";
import { tagKey } from "../tags/suggest";
import type {
  OrganizeReview,
  OrganizeReviewChange,
  OrganizeReviewEdit,
  OrganizeReviewFolder,
  OrganizeReviewItem,
  OrganizeReviewLeftOut,
  OrganizeReviewOrigin,
  OrganizeReviewPlacement,
  OrganizeReviewRow,
  OrganizeReviewTag,
  OrganizeReviewTarget,
} from "./types";

/** How long what the User unticked or took off isn't proposed again (#1569). */
export const DECLINE_DAYS = 30;

const FOLDER_NAME_MAX = 100;
const FOLDER_DESCRIPTION_MAX = 500;
const TAG_NAME_MAX = 100;
const TAG_DESCRIPTION_MAX = 500;

type Value = string | number | null;
type Values = Record<string, Value>;
type Table = OrganizeReviewRow["table"];
type Column = "text" | "text?" | "int";

const TABLES: Record<Table, string> = {
  items: "organize_review_items",
  folders: "organize_review_folders",
  tags: "organize_review_tags",
  declines: "organize_review_declines",
};

/** The mark on a row set aside because the User filed its Document by hand (#1569). */
const FILED_BY_HAND = "filed-by-hand";

/** Each table's columns but `id` and `updated_at`, as `OrganizeReviewRow.values` carries them. */
const COLUMNS: Record<Table, Record<string, Column>> = {
  items: {
    document_id: "text",
    placement: "text",
    group_id: "text?",
    folder_id: "text?",
    left_out: "text?",
    left_out_detail: "text?",
    ticked: "int",
    origin: "text",
    run_id: "text?",
    edited: "int",
    content_hash: "text?",
    state: "text",
    confirmation_id: "text?",
    discard_id: "text?",
    filed: "text?",
    created_at: "text",
    deleted_at: "text?",
  },
  folders: {
    name: "text",
    description: "text",
    parent_id: "text?",
    group_id: "text?",
    made: "int",
    created_at: "text",
    deleted_at: "text?",
  },
  tags: {
    item_id: "text",
    tag_id: "text?",
    name: "text",
    description: "text",
    added_by_user: "int",
    made: "int",
    link_before: "text?",
    created_at: "text",
    deleted_at: "text?",
  },
  declines: {
    document_id: "text",
    kind: "text",
    target_id: "text?",
    name: "text",
    until: "text",
    created_at: "text",
    deleted_at: "text?",
  },
};

export interface ItemRow {
  id: string;
  document_id: string;
  placement: "folder" | "newFolder" | "leftOut" | "unchanged";
  group_id: string | null;
  folder_id: string | null;
  left_out: string | null;
  left_out_detail: string | null;
  ticked: number;
  origin: OrganizeReviewOrigin;
  run_id: string | null;
  edited: number;
  content_hash: string | null;
  state: "open" | "confirmed" | "discarded";
  confirmation_id: string | null;
  discard_id: string | null;
  filed: string | null;
  created_at: string;
}

export interface FolderRow {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  group_id: string | null;
  made: number;
}

export interface TagRow {
  id: string;
  item_id: string;
  tag_id: string | null;
  name: string;
  description: string;
  added_by_user: number;
  made: number;
  link_before: string | null;
}

/** Who asked for a run, and on what. */
export interface OrganizeReviewRun {
  origin: OrganizeReviewOrigin;
  /** The run, so taking it back takes its rows out; null when nothing will. */
  runId?: string | null;
  /** For a run the User started on a Folder: only it may propose moving that Folder's Documents the User filed. */
  folderId?: string | null;
}

export type ProposedTag = { tagId: string } | { name: string; description: string };

export interface OrganizeReviewProposal {
  documentId: string;
  /** The version the run read. */
  contentHash: string | null;
  placement:
    | { kind: "folder"; folderId: string }
    | {
        kind: "newFolder";
        name: string;
        description: string;
        /** The Library's Folder it, or the proposed Folder it goes in, would be made in. */
        parentId?: string | null;
        /** A proposed Folder it would be made in. */
        parent?: { name: string; description: string } | null;
      }
    | { kind: "leftOut"; leftOut: OrganizeReviewLeftOut }
    | { kind: "unchanged" };
  tags: ProposedTag[];
}

interface NewFolder {
  name: string;
  description: string;
  parentId: string | null;
  parent?: { name: string; description: string } | null;
}

export interface TagsProposal {
  documentId: string;
  contentHash: string | null;
  tags: ProposedTag[];
}

/** A run the User started may replace what waits; one in the background or a migration only adds. */
const userStarted = (run: OrganizeReviewRun) =>
  run.origin !== "background" && run.origin !== "migrated";

const OPEN = "state = 'open' AND deleted_at IS NULL";

/**
 * An open row the Review shows: its Document is live, and the Folder it would go into is too. A
 * row for a Folder deleted since waits, and shows again when the Folder is restored.
 */
const VISIBLE = `i.state = 'open' AND i.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = i.document_id AND d.deleted_at IS NULL)
  AND (i.placement <> 'folder' OR EXISTS (
    SELECT 1 FROM library_groups g WHERE g.id = i.group_id AND g.deleted_at IS NULL))
  AND (i.placement <> 'newFolder' OR EXISTS (
    SELECT 1 FROM organize_review_folders f WHERE f.id = i.folder_id AND f.deleted_at IS NULL))`;

/** A proposed Tag the Review shows: the Library's, or a new one (one Confirm made and its Undo deleted included). */
const TAG_SHOWN = `t.deleted_at IS NULL AND (t.tag_id IS NULL OR t.made = 1
  OR EXISTS (SELECT 1 FROM tags x WHERE x.id = t.tag_id AND x.deleted_at IS NULL))`;

/**
 * How many ticked Documents wait with a Folder or a Tag to confirm, as Confirm would count them
 * (`LibrarySnapshot.reviewCount`).
 */
export function organizeReviewCount(db: Database): number {
  return (
    db.get<{ count: number }>(
      `SELECT count(*) AS count FROM organize_review_items i
       WHERE ${VISIBLE} AND i.ticked <> 0 AND (i.placement IN ('folder', 'newFolder') OR EXISTS (
         SELECT 1 FROM organize_review_tags t WHERE t.item_id = i.id AND ${TAG_SHOWN}))`,
    )?.count ?? 0
  );
}

const leftOutOf = (
  row: Pick<ItemRow, "left_out" | "left_out_detail">,
): OrganizeReviewLeftOut | null => {
  const { left_out: reason, left_out_detail: detail } = row;
  if (reason === "doesntFit" || reason === "staysInFolder" || reason === "noText")
    return { reason };
  if (reason === "unreachable" && detail !== null) return { reason, service: detail };
  if (reason === "walled" && detail !== null) return { reason, folderId: detail };
  return null;
};

const leftOutColumns = (leftOut: OrganizeReviewLeftOut | null) => ({
  left_out: leftOut?.reason ?? null,
  left_out_detail:
    leftOut?.reason === "unreachable"
      ? leftOut.service
      : leftOut?.reason === "walled"
        ? leftOut.folderId
        : null,
});

function parseLeftOut(input: unknown): OrganizeReviewLeftOut {
  const invalid = new InvalidInputError({ key: "error.organizeReview.invalid" });
  if (!isRecord(input)) throw invalid;
  const { reason } = input;
  if (reason === "doesntFit" || reason === "staysInFolder" || reason === "noText")
    return { reason };
  if (reason === "unreachable" && typeof input.service === "string" && input.service !== "")
    return { reason, service: input.service };
  if (reason === "walled" && typeof input.folderId === "string" && input.folderId !== "")
    return { reason, folderId: input.folderId };
  throw invalid;
}

export function parseIds(input: unknown): string[] {
  if (!Array.isArray(input) || !input.every((id) => typeof id === "string" && id !== ""))
    throw new InvalidInputError({ key: "error.organizeReview.invalid" });
  return [...new Set(input as string[])];
}

export function parseId(input: unknown): string {
  if (typeof input !== "string" || input === "")
    throw new InvalidInputError({ key: "error.organizeReview.invalid" });
  return input;
}

function parseFolderName(input: unknown): string {
  if (typeof input !== "string") throw new InvalidInputError({ key: "error.folder.lengths" });
  const name = input.trim();
  if (!name || name.length > FOLDER_NAME_MAX)
    throw new InvalidInputError({ key: "error.folder.lengths" });
  return name;
}

function parseFolderDescription(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input !== "string") throw new InvalidInputError({ key: "error.folder.lengths" });
  const description = input.trim();
  if (description.length > FOLDER_DESCRIPTION_MAX)
    throw new InvalidInputError({ key: "error.folder.lengths" });
  return description;
}

function parseTagName(input: unknown): string {
  if (typeof input !== "string") throw new InvalidInputError({ key: "error.tag.nameEmpty" });
  const name = input.trim();
  if (!name) throw new InvalidInputError({ key: "error.tag.nameEmpty" });
  if (name.length > TAG_NAME_MAX)
    throw new InvalidInputError({ key: "error.tag.nameTooLong", values: { max: TAG_NAME_MAX } });
  return name;
}

function parseTagDescription(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input !== "string")
    throw new InvalidInputError({ key: "error.organizeReview.invalid" });
  const description = input.trim();
  if (description.length > TAG_DESCRIPTION_MAX)
    throw new InvalidInputError({
      key: "error.tag.descriptionTooLong",
      values: { max: TAG_DESCRIPTION_MAX },
    });
  return description;
}

function parseTarget(input: unknown): OrganizeReviewTarget {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.organizeReview.invalid" });
  if (input.kind === "folder") return { kind: "folder", folderId: parseId(input.folderId) };
  if (input.kind === "newFolder")
    return { kind: "newFolder", newFolderId: parseId(input.newFolderId) };
  if (input.kind === "leftOut") return { kind: "leftOut" };
  throw new InvalidInputError({ key: "error.organizeReview.invalid" });
}

function parseEdit(input: unknown): OrganizeReviewEdit {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.organizeReview.invalid" });
  switch (input.kind) {
    case "tick":
      if (typeof input.ticked !== "boolean")
        throw new InvalidInputError({ key: "error.organizeReview.invalid" });
      return { kind: "tick", itemIds: parseIds(input.itemIds), ticked: input.ticked };
    case "move":
      return {
        kind: "move",
        itemIds: parseIds(input.itemIds),
        to: parseTarget(input.to),
      };
    case "addTag": {
      const { tag } = input;
      if (!isRecord(tag)) throw new InvalidInputError({ key: "error.organizeReview.invalid" });
      return {
        kind: "addTag",
        itemId: parseId(input.itemId),
        tag:
          tag.tagId !== undefined
            ? { tagId: parseId(tag.tagId) }
            : { name: parseTagName(tag.name), description: parseTagDescription(tag.description) },
      };
    }
    case "removeTag":
      return {
        kind: "removeTag",
        itemId: parseId(input.itemId),
        tagRowId: parseId(input.tagRowId),
      };
    case "renameFolder":
      return {
        kind: "renameFolder",
        newFolderId: parseId(input.newFolderId),
        name: parseFolderName(input.name),
      };
    case "mergeFolder": {
      const into = parseTarget(input.into);
      if (into.kind === "leftOut")
        throw new InvalidInputError({ key: "error.organizeReview.invalid" });
      return { kind: "mergeFolder", newFolderId: parseId(input.newFolderId), into };
    }
    default:
      throw new InvalidInputError({ key: "error.organizeReview.invalid" });
  }
}

function parseRows(input: unknown): OrganizeReviewRow[] {
  const invalid = new InvalidInputError({ key: "error.organizeReview.invalid" });
  if (!Array.isArray(input)) throw invalid;
  return input.map((each): OrganizeReviewRow => {
    if (!isRecord(each) || typeof each.id !== "string" || !isRecord(each.values)) throw invalid;
    const table = each.table;
    if (table !== "items" && table !== "folders" && table !== "tags" && table !== "declines")
      throw invalid;
    const columns = COLUMNS[table];
    const values: Values = {};
    for (const [column, kind] of Object.entries(columns)) {
      const value = each.values[column];
      const fits =
        kind === "int"
          ? Number.isInteger(value)
          : typeof value === "string" || (kind === "text?" && value === null);
      if (!fits) throw invalid;
      values[column] = value as Value;
    }
    if (Object.keys(each.values).length !== Object.keys(columns).length) throw invalid;
    return { table, id: each.id, values };
  });
}

const sameValues = (a: Values, b: Values) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([column, value]) => b[column] === value);

/**
 * The stored Suggestions: what runs propose, what the User changes before Confirm, and what
 * Discard sets aside. Only the database; Confirm is ./index's.
 */
export function createOrganizeReviewStore(db: Database, now: () => string) {
  /** The rows the edit under way touched, as each was before it. */
  let recording: Map<string, { table: Table; id: string; before: Values | undefined }> | null =
    null;

  const read = (table: Table, id: string): Values | undefined => {
    const row = db.get<Record<string, unknown>>(`SELECT * FROM ${TABLES[table]} WHERE id = ?`, [
      id,
    ]);
    if (!row) return undefined;
    const values: Values = {};
    for (const column of Object.keys(COLUMNS[table])) values[column] = row[column] as Value;
    return values;
  };

  const touch = (table: Table, id: string) => {
    const key = `${table}:${id}`;
    if (recording && !recording.has(key))
      recording.set(key, { table, id, before: read(table, id) });
  };

  const insert = (table: Table, values: Values): string => {
    const id = crypto.randomUUID();
    touch(table, id);
    const at = now();
    const row: Values = { ...values, created_at: at, deleted_at: null };
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO ${TABLES[table]} (id, ${columns.join(", ")}, updated_at)
       VALUES (?, ${columns.map(() => "?").join(", ")}, ?)`,
      [id, ...columns.map((column) => row[column] ?? null), at],
    );
    return id;
  };

  const update = (table: Table, id: string, patch: Values) => {
    touch(table, id);
    const columns = Object.keys(patch);
    db.run(
      `UPDATE ${TABLES[table]} SET ${columns.map((column) => `${column} = ?`).join(", ")},
         updated_at = ? WHERE id = ?`,
      [...columns.map((column) => patch[column] ?? null), now(), id],
    );
  };

  const remove = (table: Table, id: string) => update(table, id, { deleted_at: now() });

  /** Runs `apply` as one change, and returns the rows it touched before and after. */
  const change = (apply: () => void): OrganizeReviewChange =>
    db.transaction(() => {
      recording = new Map();
      try {
        apply();
        const before: OrganizeReviewRow[] = [];
        const after: OrganizeReviewRow[] = [];
        for (const { table, id, before: was } of recording.values()) {
          const values = read(table, id);
          if (!values) continue;
          // A row the change made was, before it, the same row deleted when it was made.
          const prior = was ?? { ...values, deleted_at: values.created_at ?? null };
          if (sameValues(prior, values)) continue;
          before.push({ table, id, values: prior });
          after.push({ table, id, values });
        }
        return { before, after };
      } finally {
        recording = null;
      }
    });

  const openItem = (documentId: string) =>
    db.get<ItemRow>(`SELECT * FROM organize_review_items WHERE document_id = ? AND ${OPEN}`, [
      documentId,
    ]);
  const openItemById = (id: string) =>
    db.get<ItemRow>(`SELECT * FROM organize_review_items WHERE id = ? AND ${OPEN}`, [id]);
  const tagRowsOf = (itemId: string) =>
    db.all<TagRow>(
      "SELECT * FROM organize_review_tags WHERE item_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid",
      [itemId],
    );
  const folderRow = (id: string) =>
    db.get<FolderRow>("SELECT * FROM organize_review_folders WHERE id = ? AND deleted_at IS NULL", [
      id,
    ]);
  /** A proposed Folder still waiting: not made yet, or with a row that still waits for it. */
  const openFolders = () =>
    db.all<FolderRow>(
      `SELECT f.* FROM organize_review_folders f WHERE f.deleted_at IS NULL AND (f.group_id IS NULL
         OR EXISTS (SELECT 1 FROM organize_review_items i
                    WHERE i.folder_id = f.id AND i.placement = 'newFolder'
                      AND i.state = 'open' AND i.deleted_at IS NULL))
       ORDER BY f.created_at, f.rowid`,
    );
  /**
   * The proposed Folders a run may choose: one with a row waiting in it, or one proposed and not
   * used yet. One whose rows were all discarded or confirmed isn't offered again.
   */
  const offeredFolders = () => {
    const live = liveGroups();
    return db
      .all<FolderRow>(
        `SELECT f.* FROM organize_review_folders f WHERE f.deleted_at IS NULL AND (
           EXISTS (SELECT 1 FROM organize_review_items i
                   WHERE i.folder_id = f.id AND i.placement = 'newFolder'
                     AND i.state = 'open' AND i.deleted_at IS NULL)
           OR NOT EXISTS (SELECT 1 FROM organize_review_items i
                          WHERE i.folder_id = f.id AND i.deleted_at IS NULL))
         ORDER BY f.created_at, f.rowid`,
      )
      .filter((folder) => !live.some((group) => sameName(group.name, folder.name)));
  };
  const folderOf = (folder: FolderRow): OrganizeReviewFolder => ({
    id: folder.id,
    name: folder.name,
    description: folder.description,
    ...parentOf(folder),
  });
  const openFolder = (id: string) => {
    const folder = openFolders().find((each) => each.id === id);
    if (!folder) throw new NotFoundError({ key: "error.folder.notFound" });
    return folder;
  };
  const liveGroups = () =>
    db.all<{ id: string; name: string; parent_id: string | null }>(
      "SELECT id, name, parent_id FROM library_groups WHERE deleted_at IS NULL",
    );
  /** The live Folder of this name in this place: a name is unique among siblings only (#2425). */
  const siblingNamed = (parentId: string | null, name: string) =>
    liveGroups().find((each) => each.parent_id === parentId && sameName(each.name, name));
  const liveGroup = (id: string) => liveGroups().find((group) => group.id === id);
  const liveTags = () =>
    db.all<{ id: string; name: string; description: string }>(
      "SELECT id, name, description FROM tags WHERE deleted_at IS NULL",
    );

  const declineUntil = () =>
    new Date(Date.parse(now()) + DECLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const matches = (kind: "folder" | "tag", a: string, b: string) =>
    kind === "folder" ? sameName(a, b) : tagKey(a) === tagKey(b);
  const liveDeclines = (
    documentId: string,
    kind: "folder" | "tag",
    targetId: string | null,
    name: string,
  ) =>
    db
      .all<{ id: string; target_id: string | null; name: string; until: string }>(
        "SELECT id, target_id, name, until FROM organize_review_declines WHERE document_id = ? AND kind = ? AND deleted_at IS NULL",
        [documentId, kind],
      )
      .filter(
        (row) => (targetId !== null && row.target_id === targetId) || matches(kind, row.name, name),
      );
  const declined = (
    documentId: string,
    kind: "folder" | "tag",
    targetId: string | null,
    name: string,
  ) => {
    const at = now();
    return liveDeclines(documentId, kind, targetId, name).some((row) => row.until > at);
  };

  /** What the Document stands for in the Review: its Folder, and each proposed Tag. */
  const targetsOf = (item: ItemRow) => {
    const targets: { kind: "folder" | "tag"; targetId: string | null; name: string }[] = [];
    if (item.placement === "folder" && item.group_id) {
      const group = liveGroup(item.group_id);
      if (group) targets.push({ kind: "folder", targetId: group.id, name: group.name });
    }
    if (item.placement === "newFolder" && item.folder_id) {
      const folder = folderRow(item.folder_id);
      if (folder) targets.push({ kind: "folder", targetId: null, name: folder.name });
    }
    for (const tag of tagRowsOf(item.id)) {
      if (tag.added_by_user === 0)
        targets.push({ kind: "tag", targetId: tag.made === 1 ? null : tag.tag_id, name: tag.name });
    }
    return targets;
  };
  const decline = (documentId: string, target: ReturnType<typeof targetsOf>[number]) => {
    insert("declines", {
      document_id: documentId,
      kind: target.kind,
      target_id: target.targetId,
      name: target.name,
      until: declineUntil(),
    });
  };
  const undecline = (documentId: string, target: ReturnType<typeof targetsOf>[number]) => {
    for (const row of liveDeclines(documentId, target.kind, target.targetId, target.name))
      remove("declines", row.id);
  };

  const inTree = (folderId: string, groupId: string) =>
    !!db.get(
      `WITH RECURSIVE tree (id) AS (
         SELECT id FROM library_groups WHERE id = ? AND deleted_at IS NULL
         UNION SELECT g.id FROM library_groups g JOIN tree ON g.parent_id = tree.id
         WHERE g.deleted_at IS NULL)
       SELECT 1 FROM tree WHERE id = ?`,
      [folderId, groupId],
    );

  /** The Document a run may propose for: live, and not a Meeting's Transcript, which goes with its Note (#2528). */
  const proposable = (documentId: string) =>
    !!db.get(
      "SELECT 1 FROM documents WHERE id = ? AND deleted_at IS NULL AND meeting_mind_id IS NULL",
      [documentId],
    );

  type StoredPlacement = Pick<
    ItemRow,
    "placement" | "group_id" | "folder_id" | "left_out" | "left_out_detail"
  >;
  const UNCHANGED: StoredPlacement = {
    placement: "unchanged",
    group_id: null,
    folder_id: null,
    left_out: null,
    left_out_detail: null,
  };

  /** Where a run may propose the Document goes, by the User's choices and declines. */
  const placementFor = (
    run: OrganizeReviewRun,
    documentId: string,
    placement: OrganizeReviewProposal["placement"],
  ): StoredPlacement | { newFolder: NewFolder } => {
    if (placement.kind === "unchanged") return UNCHANGED;
    const assignment = db.get<{ group_id: string | null; source: string }>(
      "SELECT group_id, source FROM document_groups WHERE document_id = ? AND deleted_at IS NULL",
      [documentId],
    );
    // Left out says where a Document in no Folder stays; one in a Folder stays there unsaid, but
    // for Organize This Folder, whose Review says what stays at the Folder's top level.
    if (placement.kind === "leftOut") {
      const leftOut = parseLeftOut(placement.leftOut);
      return assignment?.group_id && leftOut.reason !== "staysInFolder"
        ? UNCHANGED
        : { ...UNCHANGED, placement: "leftOut", ...leftOutColumns(leftOut) };
    }
    // The User's own filing stands, but for a run the User started on the Folder it is in.
    if (
      assignment?.source === "user" &&
      !(
        run.origin === "folder" &&
        run.folderId &&
        assignment.group_id !== null &&
        inTree(run.folderId, assignment.group_id)
      )
    )
      return UNCHANGED;
    const name =
      placement.kind === "folder"
        ? liveGroup(placement.folderId)?.name
        : parseFolderName(placement.name);
    if (name === undefined) return UNCHANGED;
    const parentId =
      placement.kind === "newFolder" && placement.parentId && liveGroup(placement.parentId)
        ? placement.parentId
        : null;
    const parentName =
      placement.kind === "newFolder" && placement.parent
        ? parseFolderName(placement.parent.name)
        : null;
    // A proposed parent the Library has by now is that Folder, in the same place.
    const parentGroup = parentName === null ? undefined : siblingNamed(parentId, parentName);
    const group =
      placement.kind === "folder"
        ? liveGroup(placement.folderId)
        : parentName !== null && !parentGroup
          ? undefined
          : siblingNamed(parentGroup?.id ?? parentId, name);
    if (group && assignment?.group_id === group.id) return UNCHANGED;
    if (declined(documentId, "folder", group?.id ?? null, name)) return UNCHANGED;
    if (group) return { ...UNCHANGED, placement: "folder", group_id: group.id };
    if (placement.kind !== "newFolder") return UNCHANGED;
    return {
      newFolder: {
        name,
        description: parseFolderDescription(placement.description),
        parentId: parentGroup?.id ?? parentId,
        parent:
          parentName === null || parentGroup
            ? null
            : {
                name: parentName,
                description: parseFolderDescription(placement.parent?.description),
              },
      },
    };
  };

  /** The Tags a run may propose for the Document: none the User decided on, applied already, or declined. */
  const tagsFor = (documentId: string, proposed: readonly ProposedTag[]) => {
    const live = liveTags();
    const deleted = new Set(
      db
        .all<{ name: string }>("SELECT name FROM tags WHERE deleted_at IS NOT NULL")
        .map((row) => tagKey(row.name)),
    );
    const owned = new Set(
      db
        .all<{ tag_id: string }>(
          "SELECT DISTINCT tag_id FROM document_tags WHERE document_id = ? AND source = 'user'",
          [documentId],
        )
        .map((row) => row.tag_id),
    );
    // An uncertain Tag waits for the User like a new one; any other already applies.
    const applied = new Set(
      db
        .all<{ tag_id: string }>(
          "SELECT tag_id FROM document_tags WHERE document_id = ? AND deleted_at IS NULL AND needs_review = 0",
          [documentId],
        )
        .map((row) => row.tag_id),
    );
    const out: { tag_id: string | null; name: string; description: string }[] = [];
    const seen = new Set<string>();
    for (const each of proposed) {
      let tag: { tag_id: string | null; name: string; description: string };
      if ("tagId" in each) {
        const existing = live.find((one) => one.id === each.tagId);
        if (!existing) continue;
        tag = { tag_id: existing.id, name: existing.name, description: existing.description };
      } else {
        const name = parseTagName(each.name);
        const existing = live.find((one) => tagKey(one.name) === tagKey(name));
        if (existing)
          tag = { tag_id: existing.id, name: existing.name, description: existing.description };
        else if (deleted.has(tagKey(name))) continue;
        else tag = { tag_id: null, name, description: parseTagDescription(each.description) };
      }
      const key = tag.tag_id ?? `new:${tagKey(tag.name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (tag.tag_id !== null && (owned.has(tag.tag_id) || applied.has(tag.tag_id))) continue;
      if (declined(documentId, "tag", tag.tag_id, tag.name)) continue;
      out.push(tag);
    }
    return out;
  };

  /** The proposed Folder of this name that still waits, or a new one, in its proposed parent if any. */
  const proposedFolder = (folder: NewFolder): string => {
    const parent =
      folder.parent &&
      proposedFolder({ ...folder.parent, parentId: folder.parentId, parent: null });
    const parentId = parent ?? folder.parentId ?? null;
    return (
      openFolders().find(
        (each) => (each.parent_id ?? null) === parentId && sameName(each.name, folder.name),
      )?.id ??
      insert("folders", {
        name: folder.name,
        description: folder.description,
        parent_id: parentId,
        group_id: null,
        made: 0,
      })
    );
  };

  /**
   * Where a proposed Folder would be made: in a Folder of the Library, or in another proposed
   * Folder still waiting. A proposed parent Confirm made since is the Library's Folder now.
   */
  const parentOf = (
    folder: FolderRow,
  ): Pick<OrganizeReviewFolder, "parentId" | "parentNewFolderId"> => {
    const none = { parentId: null, parentNewFolderId: null };
    if (folder.parent_id === null) return none;
    if (liveGroup(folder.parent_id)) return { parentId: folder.parent_id, parentNewFolderId: null };
    const parent = folderRow(folder.parent_id);
    if (!parent) return none;
    if (parent.group_id !== null && liveGroup(parent.group_id))
      return { parentId: parent.group_id, parentNewFolderId: null };
    return { parentId: null, parentNewFolderId: parent.id };
  };

  const addTags = (itemId: string, tags: ReturnType<typeof tagsFor>) => {
    const there = tagRowsOf(itemId);
    for (const tag of tags) {
      const already = there.some((row) =>
        tag.tag_id !== null ? row.tag_id === tag.tag_id : tagKey(row.name) === tagKey(tag.name),
      );
      if (already) continue;
      insert("tags", {
        item_id: itemId,
        tag_id: tag.tag_id,
        name: tag.name,
        description: tag.description,
        added_by_user: 0,
        made: 0,
        link_before: null,
      });
    }
  };

  const dropItem = (item: ItemRow) => {
    for (const tag of tagRowsOf(item.id)) remove("tags", tag.id);
    remove("items", item.id);
  };

  const insertItem = (
    run: OrganizeReviewRun,
    documentId: string,
    contentHash: string | null,
    placement: StoredPlacement,
  ) =>
    insert("items", {
      document_id: documentId,
      ...placement,
      ticked: 1,
      origin: run.origin,
      run_id: run.runId ?? null,
      edited: 0,
      content_hash: contentHash,
      state: "open",
      confirmation_id: null,
      discard_id: null,
      filed: null,
    });

  /**
   * Whether a run may write over the row waiting for this Document: never one the User edited;
   * a run the User started replaces the rest, and one in the background only a row its Document
   * changed since.
   */
  const replaceable = (run: OrganizeReviewRun, item: ItemRow, contentHash: string | null) =>
    item.edited === 0 && (userStarted(run) || item.content_hash !== contentHash);

  return {
    read,
    update,
    insert,
    change,
    openItem,
    openItemById,
    tagRowsOf,
    folderRow,
    liveGroup,
    liveTags,

    count: () => organizeReviewCount(db),

    offeredFolders: () => offeredFolders().map(folderOf),

    /**
     * Keeps these Folders, proposed by name, for runs to choose and the User to confirm: none is
     * made. A live Folder's name, or one already proposed, isn't proposed again.
     */
    proposeFolders(
      folders: readonly { name: string; description: string; parentId?: string | null }[],
    ): OrganizeReviewFolder[] {
      return db.transaction(() => {
        const ids: string[] = [];
        for (const folder of folders) {
          const name = parseFolderName(folder.name);
          const parentId = folder.parentId && liveGroup(folder.parentId) ? folder.parentId : null;
          if (siblingNamed(parentId, name)) continue;
          const id = proposedFolder({
            name,
            description: parseFolderDescription(folder.description),
            parentId,
          });
          if (!ids.includes(id)) ids.push(id);
        }
        return ids.flatMap((id) => {
          const row = folderRow(id);
          return row ? [folderOf(row)] : [];
        });
      });
    },

    /**
     * Takes a run's rows out, but those the User edited, and the Folders it proposed that nothing
     * waits in any more, and brings back the rows it replaced: the assistant's Undo. Restoring the
     * change puts them back.
     */
    withdraw(runId: string | null, folderIds: readonly string[]): OrganizeReviewChange {
      return change(() => {
        for (const item of db.all<ItemRow>(
          `SELECT * FROM organize_review_items WHERE run_id = ? AND edited = 0 AND ${OPEN}`,
          [runId],
        ))
          dropItem(item);
        if (runId !== null)
          for (const item of db.all<ItemRow>(
            "SELECT * FROM organize_review_items WHERE discard_id = ? AND state = 'discarded' AND deleted_at IS NULL",
            [runId],
          ))
            if (!openItem(item.document_id)) update("items", item.id, { state: "open" });
        for (const id of folderIds) {
          const waits = db.get(
            `SELECT 1 FROM organize_review_items WHERE folder_id = ? AND placement = 'newFolder' AND ${OPEN}`,
            [id],
          );
          if (!waits && folderRow(id)) remove("folders", id);
        }
      });
    },

    /**
     * Writes what an Organize run proposes for each Document, by the rules the User's choices
     * set (#1569). Returns how many rows it wrote.
     */
    propose(run: OrganizeReviewRun, proposals: readonly OrganizeReviewProposal[]): number {
      return db.transaction(() => {
        let written = 0;
        for (const proposal of proposals) {
          if (!proposable(proposal.documentId)) continue;
          const existing = openItem(proposal.documentId);
          if (existing && !replaceable(run, existing, proposal.contentHash)) continue;
          const resolved = placementFor(run, proposal.documentId, proposal.placement);
          const tags = tagsFor(proposal.documentId, proposal.tags);
          const placement =
            "newFolder" in resolved
              ? {
                  ...UNCHANGED,
                  placement: "newFolder" as const,
                  folder_id: proposedFolder(resolved.newFolder),
                }
              : resolved;
          // A run with an Undo sets the row it replaces aside, for that Undo to bring back.
          if (existing && run.runId)
            update("items", existing.id, { state: "discarded", discard_id: run.runId });
          else if (existing) dropItem(existing);
          if (placement.placement === "unchanged" && tags.length === 0) continue;
          const id = insertItem(run, proposal.documentId, proposal.contentHash, placement);
          addTags(id, tags);
          written++;
        }
        return written;
      });
    },

    /**
     * Writes the Tags a tagging run proposes, beside any Folder already proposed. A run the User
     * started replaces the Tags proposed before on a row they haven't edited; one in the
     * background adds. Returns how many rows it wrote to.
     */
    proposeTags(run: OrganizeReviewRun, proposals: readonly TagsProposal[]): number {
      return db.transaction(() => {
        let written = 0;
        for (const proposal of proposals) {
          if (!proposable(proposal.documentId)) continue;
          const tags = tagsFor(proposal.documentId, proposal.tags);
          const existing = openItem(proposal.documentId);
          if (!existing) {
            if (tags.length === 0) continue;
            addTags(insertItem(run, proposal.documentId, proposal.contentHash, UNCHANGED), tags);
            written++;
            continue;
          }
          if (existing.edited !== 0) continue;
          if (userStarted(run)) {
            for (const tag of tagRowsOf(existing.id)) remove("tags", tag.id);
          }
          addTags(existing.id, tags);
          written++;
        }
        return written;
      });
    },

    view(): OrganizeReview {
      const rows = db.all<ItemRow>(
        `SELECT i.* FROM organize_review_items i WHERE ${VISIBLE} ORDER BY i.created_at, i.rowid`,
      );
      const tags = new Map(liveTags().map((tag) => [tag.id, tag]));
      const items = rows.map((row): OrganizeReviewItem => {
        const placement: OrganizeReviewPlacement =
          row.placement === "folder" && row.group_id
            ? { kind: "folder", folderId: row.group_id }
            : row.placement === "newFolder" && row.folder_id
              ? { kind: "newFolder", newFolderId: row.folder_id }
              : row.placement === "leftOut"
                ? { kind: "leftOut", leftOut: leftOutOf(row) }
                : { kind: "unchanged" };
        return {
          id: row.id,
          documentId: row.document_id,
          placement,
          ticked: row.ticked !== 0,
          origin: row.origin,
          edited: row.edited !== 0,
          tags: tagRowsOf(row.id).flatMap((tag): OrganizeReviewTag[] => {
            const live = tag.tag_id === null ? undefined : tags.get(tag.tag_id);
            if (tag.tag_id !== null && !live && tag.made === 0) return [];
            return [
              {
                id: tag.id,
                tagId: live?.id ?? null,
                name: live?.name ?? tag.name,
                description: live?.description ?? tag.description,
                addedByUser: tag.added_by_user !== 0,
              },
            ];
          }),
        };
      });
      const shown = new Set(
        rows.flatMap((row) =>
          row.placement === "newFolder" && row.folder_id ? [row.folder_id] : [],
        ),
      );
      // A proposed parent shows with its subfolders, though its Documents are all in them.
      for (const id of [...shown]) {
        let folder = folderRow(id);
        while (folder) {
          const parent = parentOf(folder).parentNewFolderId;
          if (parent === null || shown.has(parent)) break;
          shown.add(parent);
          folder = folderRow(parent);
        }
      }
      const folders = db
        .all<FolderRow>(
          `SELECT * FROM organize_review_folders WHERE deleted_at IS NULL
             AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
          [JSON.stringify([...shown])],
        )
        .map(folderOf);
      return { items, folders, count: organizeReviewCount(db) };
    },

    edit(input: unknown): OrganizeReviewChange {
      const edit = parseEdit(input);
      return change(() => {
        switch (edit.kind) {
          case "tick":
            for (const id of edit.itemIds) {
              const item = openItemById(id);
              if (!item || (item.ticked !== 0) === edit.ticked) continue;
              for (const target of targetsOf(item)) {
                if (edit.ticked) undecline(item.document_id, target);
                else decline(item.document_id, target);
              }
              update("items", item.id, { ticked: edit.ticked ? 1 : 0, edited: 1 });
            }
            return;
          case "move": {
            const to = edit.to;
            if (to.kind === "folder" && !liveGroup(to.folderId))
              throw new NotFoundError({ key: "error.folder.notFound" });
            if (to.kind === "newFolder") openFolder(to.newFolderId);
            for (const id of edit.itemIds) {
              const item = openItemById(id);
              if (!item) continue;
              update("items", item.id, {
                placement: to.kind,
                group_id: to.kind === "folder" ? to.folderId : null,
                folder_id: to.kind === "newFolder" ? to.newFolderId : null,
                left_out: null,
                left_out_detail: null,
                ticked: to.kind === "leftOut" ? item.ticked : 1,
                edited: 1,
              });
            }
            return;
          }
          case "addTag": {
            const item = openItemById(edit.itemId);
            if (!item) return;
            const wanted = edit.tag;
            const live = liveTags();
            let tag: { tag_id: string | null; name: string; description: string };
            if ("tagId" in wanted) {
              const chosen = live.find((one) => one.id === wanted.tagId);
              if (!chosen) throw new NotFoundError({ key: "error.tag.notFound" });
              tag = { tag_id: chosen.id, name: chosen.name, description: chosen.description };
            } else {
              const chosen = live.find((one) => tagKey(one.name) === tagKey(wanted.name));
              tag = chosen
                ? { tag_id: chosen.id, name: chosen.name, description: chosen.description }
                : { tag_id: null, name: wanted.name, description: wanted.description ?? "" };
            }
            const there = tagRowsOf(item.id).some((row) =>
              tag.tag_id !== null
                ? row.tag_id === tag.tag_id
                : tagKey(row.name) === tagKey(tag.name),
            );
            if (there) return;
            insert("tags", {
              item_id: item.id,
              tag_id: tag.tag_id,
              name: tag.name,
              description: tag.description,
              added_by_user: 1,
              made: 0,
              link_before: null,
            });
            undecline(item.document_id, { kind: "tag", targetId: tag.tag_id, name: tag.name });
            update("items", item.id, { edited: 1 });
            return;
          }
          case "removeTag": {
            const item = openItemById(edit.itemId);
            const tag = item && tagRowsOf(item.id).find((row) => row.id === edit.tagRowId);
            if (!item || !tag) return;
            remove("tags", tag.id);
            if (tag.added_by_user === 0)
              decline(item.document_id, {
                kind: "tag",
                targetId: tag.made === 1 ? null : tag.tag_id,
                name: tag.name,
              });
            update("items", item.id, { edited: 1 });
            return;
          }
          case "renameFolder": {
            const folder = openFolder(edit.newFolderId);
            if (folder.name === edit.name) return;
            const taken =
              openFolders().some(
                (each) => each.id !== folder.id && sameName(each.name, edit.name),
              ) || liveGroups().some((group) => sameName(group.name, edit.name));
            if (taken) throw new InvalidInputError({ key: "error.folder.nameTaken" });
            update("folders", folder.id, { name: edit.name });
            for (const item of db.all<{ id: string }>(
              `SELECT id FROM organize_review_items WHERE folder_id = ? AND placement = 'newFolder' AND ${OPEN}`,
              [folder.id],
            ))
              update("items", item.id, { edited: 1 });
            return;
          }
          case "mergeFolder": {
            const folder = openFolder(edit.newFolderId);
            const into = edit.into;
            if (into.kind === "folder" && !liveGroup(into.folderId))
              throw new NotFoundError({ key: "error.folder.notFound" });
            if (into.kind === "newFolder" && openFolder(into.newFolderId).id === folder.id)
              throw new InvalidInputError({ key: "error.organizeReview.mergeIntoItself" });
            for (const item of db.all<{ id: string }>(
              `SELECT id FROM organize_review_items WHERE folder_id = ? AND placement = 'newFolder' AND ${OPEN}`,
              [folder.id],
            ))
              update("items", item.id, {
                placement: into.kind,
                group_id: into.kind === "folder" ? into.folderId : null,
                folder_id: into.kind === "newFolder" ? into.newFolderId : null,
                edited: 1,
              });
            for (const child of db.all<{ id: string }>(
              "SELECT id FROM organize_review_folders WHERE parent_id = ? AND deleted_at IS NULL",
              [folder.id],
            ))
              update("folders", child.id, {
                parent_id: into.kind === "folder" ? into.folderId : into.newFolderId,
              });
            remove("folders", folder.id);
            return;
          }
        }
      });
    },

    /**
     * Puts each row back as `before` has it, while it is still as `after` left it: a later run or
     * edit wins, and that row is left alone, with its Tags and declines. Returns the change it
     * made, or null for none.
     */
    restore(beforeInput: unknown, afterInput: unknown): OrganizeReviewChange | null {
      const before = parseRows(beforeInput);
      const after = parseRows(afterInput);
      if (
        before.length !== after.length ||
        before.some((row, at) => row.table !== after[at]?.table || row.id !== after[at]?.id)
      )
        throw new InvalidInputError({ key: "error.organizeReview.invalid" });
      const fits = (row: OrganizeReviewRow) => {
        const values = read(row.table, row.id);
        return values !== undefined && sameValues(values, row.values);
      };
      const changedSince = after.filter((row) => row.table === "items" && !fits(row));
      const heldItems = new Set(changedSince.map((row) => row.id));
      const heldDocuments = new Set(changedSince.map((row) => row.values.document_id));
      const restored = change(() => {
        before.forEach((target, at) => {
          const left = after[at];
          if (!left || !fits(left)) return;
          if (target.table === "tags" && heldItems.has(String(target.values.item_id))) return;
          if (target.table === "declines" && heldDocuments.has(target.values.document_id ?? null))
            return;
          const reopens =
            target.table === "items" &&
            target.values.state === "open" &&
            target.values.deleted_at === null;
          const documentId = target.values.document_id;
          if (reopens && typeof documentId === "string") {
            const open = openItem(documentId);
            if (open && open.id !== target.id) return;
          }
          update(target.table, target.id, target.values);
        });
      });
      return restored.after.length === 0 ? null : restored;
    },

    /** Sets aside the open rows of Documents filed by hand; true when there was one. */
    setAsideFiled(documentIds: readonly string[]): boolean {
      return db.transaction(() => {
        let any = false;
        for (const documentId of documentIds) {
          const item = openItem(documentId);
          if (!item) continue;
          update("items", item.id, { state: "discarded", discard_id: FILED_BY_HAND });
          any = true;
        }
        return any;
      });
    },

    /**
     * Opens again the row set aside when each of these Documents was filed by hand, now that it is
     * in no Folder, as the Undo of that filing leaves it; but not when a later row was made for it.
     */
    bringBackUnfiled(documentIds: readonly string[]): boolean {
      return db.transaction(() => {
        let any = false;
        for (const documentId of documentIds) {
          const latest = db.get<ItemRow>(
            "SELECT * FROM organize_review_items WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [documentId],
          );
          if (latest?.state !== "discarded" || latest.discard_id !== FILED_BY_HAND) continue;
          update("items", latest.id, { state: "open", discard_id: null });
          any = true;
        }
        return any;
      });
    },

    /** Sets these open rows aside with one id, which `restoreDiscarded` brings back. Null when none was open. */
    discard(itemIdsInput: unknown): string | null {
      const ids = parseIds(itemIdsInput);
      return db.transaction(() => {
        const id = crypto.randomUUID();
        let any = false;
        for (const itemId of ids) {
          if (!openItemById(itemId)) continue;
          update("items", itemId, { state: "discarded", discard_id: id });
          any = true;
        }
        return any ? id : null;
      });
    },

    /** Brings back what a Discard set aside, but for a Document a later run proposed for since. */
    restoreDiscarded(discardId: unknown): void {
      const id = parseId(discardId);
      db.transaction(() => {
        for (const item of db.all<ItemRow>(
          "SELECT * FROM organize_review_items WHERE discard_id = ? AND state = 'discarded' AND deleted_at IS NULL",
          [id],
        )) {
          if (openItem(item.document_id)) continue;
          update("items", item.id, { state: "open" });
        }
      });
    },

    visibleOpen(ids: readonly string[]): ItemRow[] {
      return db.all<ItemRow>(
        `SELECT i.* FROM organize_review_items i
         WHERE i.id IN (SELECT value FROM json_each(?)) AND ${VISIBLE}
         ORDER BY i.created_at, i.rowid`,
        [JSON.stringify(ids)],
      );
    },
  };
}

export type OrganizeReviewStore = ReturnType<typeof createOrganizeReviewStore>;
