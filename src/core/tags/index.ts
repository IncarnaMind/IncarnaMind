/**
 * Tags and the Tags on each Document (CONTEXT.md: a Tag is a label with a
 * short description; a Document can have many). This module only stores
 * them: automatic tagging lives in ./tagger.
 *
 * The rule that matters: a Tag the User added to or removed from a Document
 * is the User's from then on. Their removal is kept as a deleted link with
 * source "user" (see migration 12), and automatic tagging skips every
 * Document and Tag that has one.
 */
import { randomUUID } from "node:crypto";
import { sameName } from "../../shared/names";
import { isTagColour, nextTagColour, type TagColour } from "../../shared/tagColours";
import type {
  DocumentTag,
  Tag,
  TagAsShown,
  TagLinkState,
  TagSource,
  TagSourceRevert,
} from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import { LANGUAGES, type Language } from "../language";
import type { Database } from "../storage";
import type { TagDecision } from "./classify";
import {
  isTagKind,
  KIND_COLOURS,
  kindDescription,
  kindName,
  TAG_KINDS,
  type TagKind,
} from "./kinds";

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

interface TagRow {
  id: string;
  /** Empty for a kind's Tag the User hasn't renamed: it shows the kind's name. */
  name: string;
  description: string;
  preset: string | null;
  kind: string | null;
  /** 1 when the User made it or changed its name, colour or description; automatic tagging's are 0. */
  made_by_user: number;
  colour: TagColour;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  id: string;
  tag_id: string;
  source: TagSource;
  confidence: number | null;
  needs_review: number;
}

const COLUMNS = "id, name, description, preset, kind, made_by_user, colour, created_at, updated_at";

const kindOf = (row: Pick<TagRow, "kind">): TagKind | null =>
  isTagKind(row.kind) ? row.kind : null;

/** A Tag's name as shown: a kind's in the interface's language, unless the User renamed it (#2339). */
export const shownName = (row: Pick<TagRow, "kind" | "name">, language: Language): string => {
  const kind = kindOf(row);
  return kind && row.name === "" ? kindName(kind, language) : row.name;
};

export const shownDescription = (row: Pick<TagRow, "kind" | "description">, language: Language) => {
  const kind = kindOf(row);
  return kind && row.description === "" ? kindDescription(kind, language) : row.description;
};

const toTag = (row: TagRow, language: Language): Tag => ({
  id: row.id,
  name: shownName(row, language),
  description: shownDescription(row, language),
  preset: row.preset !== null,
  kind: kindOf(row),
  madeByUser: row.made_by_user !== 0,
  colour: row.colour,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const byName = (a: Tag, b: Tag) => {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

function parseShown(value: unknown): TagAsShown {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !isTagColour(value.colour)
  ) {
    throw new InvalidInputError(
      "The Undo of a Tag needs whether it was the User's and what it showed.",
    );
  }
  return { name: value.name, description: value.description, colour: value.colour };
}

function parseSourceRevert(source: unknown): TagSourceRevert | undefined {
  if (source === undefined) return undefined;
  if (!isRecord(source) || typeof source.madeByUser !== "boolean") {
    throw new InvalidInputError(
      "The Undo of a Tag edit needs whether it was the User's and what it showed.",
    );
  }
  return { madeByUser: source.madeByUser, expected: parseShown(source.expected) };
}

function parseTagId(id: unknown): string {
  if (typeof id !== "string" || id === "") {
    throw new InvalidInputError("A Tag id must be a non-empty string.");
  }
  return id;
}

function parseName(name: unknown): string {
  if (typeof name !== "string") throw new InvalidInputError("A Tag's name must be text.");
  const trimmed = name.trim();
  if (!trimmed) throw new InvalidInputError({ key: "error.tag.nameEmpty" });
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new InvalidInputError({ key: "error.tag.nameTooLong", values: { max: MAX_NAME_LENGTH } });
  }
  return trimmed;
}

function parseColour(colour: unknown): TagColour {
  if (!isTagColour(colour)) throw new InvalidInputError("Choose one of the Tag colours.");
  return colour;
}

function parseDescription(description: unknown): string {
  if (typeof description !== "string") {
    throw new InvalidInputError("A Tag's description must be text.");
  }
  const trimmed = description.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvalidInputError({
      key: "error.tag.descriptionTooLong",
      values: { max: MAX_DESCRIPTION_LENGTH },
    });
  }
  return trimmed;
}

export function parseTagLinkStates(input: unknown): TagLinkState[] {
  if (!Array.isArray(input)) throw new InvalidInputError("Expected a list of Tag links.");
  return input.map((each): TagLinkState => {
    if (!isRecord(each) || typeof each.documentId !== "string" || typeof each.tagId !== "string")
      throw new InvalidInputError("A Tag link names a Document and a Tag.");
    const { documentId, tagId, link, removedByUser } = each;
    if (removedByUser !== undefined && typeof removedByUser !== "boolean")
      throw new InvalidInputError("removedByUser must be true or false.");
    if (link === null)
      return { documentId, tagId, link, ...(removedByUser !== undefined && { removedByUser }) };
    const invalid = new InvalidInputError("A Tag link says who chose it, or is null.");
    if (!isRecord(link)) throw invalid;
    const { source, confidence, needsReview } = link;
    if ((source !== "automatic" && source !== "user") || typeof needsReview !== "boolean")
      throw invalid;
    if (
      confidence !== null &&
      (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))
    )
      throw invalid;
    return { documentId, tagId, link: { source, confidence, needsReview } };
  });
}

/**
 * The live Tags on a Document, in Tag name order, a kind's Tag the User hasn't renamed by its
 * kind. Links to a Tag that is deleted don't count, whatever their own state.
 */
export function tagsOfDocument(db: Database, documentId: string): DocumentTag[] {
  return db
    .all<{ tag_id: string; source: TagSource; confidence: number | null; needs_review: number }>(
      `SELECT l.tag_id, l.source, l.confidence, l.needs_review
       FROM document_tags l JOIN tags t ON t.id = l.tag_id
       WHERE l.document_id = ? AND l.deleted_at IS NULL AND t.deleted_at IS NULL
       ORDER BY CASE WHEN t.kind IS NOT NULL AND t.name = '' THEN t.kind ELSE t.name END
         COLLATE NOCASE, t.created_at, t.rowid`,
      [documentId],
    )
    .map((row) => ({
      tagId: row.tag_id,
      source: row.source,
      confidence: row.confidence,
      needsReview: row.needs_review !== 0,
    }));
}

export type TagsStore = ReturnType<typeof createTags>;

/**
 * `language`: the interface's, which a kind's Tag shows its name in; a change of language renames
 * them all, as the next read finds.
 */
export function createTags(db: Database, now: () => string, language: () => Language = () => "en") {
  const shown = (row: TagRow) => toTag(row, language());
  const rowOf = (tagId: unknown): TagRow => {
    const row = db.get<TagRow>(`SELECT ${COLUMNS} FROM tags WHERE id = ? AND deleted_at IS NULL`, [
      parseTagId(tagId),
    ]);
    if (!row) throw new NotFoundError({ key: "error.tag.notFound" });
    return row;
  };
  const get = (tagId: unknown): Tag => shown(rowOf(tagId));

  const list = (): Tag[] =>
    db
      .all<TagRow>(
        `SELECT ${COLUMNS} FROM tags WHERE deleted_at IS NULL ORDER BY created_at, rowid`,
      )
      .map(shown)
      .sort(byName);

  /** The Tags the User decided on for a Document, added or removed: automatic tagging leaves them alone. */
  const owned = (documentId: string): string[] =>
    db
      .all<{ tag_id: string }>(
        "SELECT DISTINCT tag_id FROM document_tags WHERE document_id = ? AND source = 'user'",
        [documentId],
      )
      .map((row) => row.tag_id);

  /**
   * The live Tag that has `name`, ignoring case; a kind's Tag the User hasn't renamed has its name
   * in every language.
   */
  const holderOf = (name: string, exceptId?: string) => {
    const kindNamed = (tag: Tag) =>
      tag.kind !== null &&
      tag.name === kindName(tag.kind, language()) &&
      LANGUAGES.some((each) => tag.kind !== null && sameName(kindName(tag.kind, each), name));
    return list().find(
      (tag) => tag.id !== exceptId && (sameName(tag.name, name) || kindNamed(tag)),
    );
  };

  const checkUnique = (name: string, exceptId?: string) => {
    const taken = holderOf(name, exceptId);
    if (taken)
      throw new InvalidInputError({ key: "error.tag.nameTaken", values: { name: taken.name } });
  };

  const liveLink = (documentId: string, tagId: string) =>
    db.get<LinkRow>(
      `SELECT id, tag_id, source, confidence, needs_review FROM document_tags
       WHERE document_id = ? AND tag_id = ? AND deleted_at IS NULL`,
      [documentId, tagId],
    );

  const insertLink = (
    documentId: string,
    tagId: string,
    source: TagSource,
    at: string,
    deletedAt: string | null = null,
    decision: Pick<TagDecision, "confidence"> & { needsReview?: boolean } = { confidence: null },
  ) =>
    db.run(
      `INSERT INTO document_tags
         (id, document_id, tag_id, source, confidence, needs_review, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        documentId,
        tagId,
        source,
        decision.confidence,
        decision.needsReview === true ? 1 : 0,
        at,
        at,
        deletedAt,
      ],
    );

  const insertTag = (
    name: string,
    description: string,
    colour: TagColour,
    at: string,
    madeByUser: boolean,
    kind: TagKind | null = null,
  ) => {
    const id = randomUUID();
    db.run(
      `INSERT INTO tags (id, name, description, preset, kind, made_by_user, colour, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      [id, name, description, kind, madeByUser ? 1 : 0, colour, at, at],
    );
    return id;
  };

  return {
    get,
    list,
    owned,

    /**
     * Creates a Tag for each kind if no Tag has ever existed here (deleted ones
     * count, so deleting every kind doesn't bring them back), shown in the
     * interface's language. Returns whether it did.
     */
    seedPresets(): boolean {
      return db.transaction(() => {
        if (db.get("SELECT 1 FROM tags LIMIT 1")) return false;
        const at = now();
        for (const kind of TAG_KINDS) {
          db.run(
            `INSERT INTO tags (id, name, description, preset, kind, colour, created_at, updated_at)
             VALUES (?, '', '', ?, ?, ?, ?, ?)`,
            [randomUUID(), kind, kind, KIND_COLOURS[kind], at, at],
          );
        }
        return true;
      });
    },

    /**
     * A kind's Tag: the live one, or one made for it, as Confirm adds a kind (#2339). `made`: it
     * was made now.
     */
    kindTag(kind: TagKind): { tag: Tag; made: boolean } {
      return db.transaction(() => {
        const live = db.get<TagRow>(
          `SELECT ${COLUMNS} FROM tags WHERE kind = ? AND deleted_at IS NULL
           ORDER BY created_at, rowid LIMIT 1`,
          [kind],
        );
        if (live) return { tag: shown(live), made: false };
        const id = insertTag("", "", KIND_COLOURS[kind], now(), false, kind);
        return { tag: get(id), made: true };
      });
    },

    /** Makes a Tag; one the User did not make (Research's) leaves madeByUser false. */
    create(input: unknown, madeByUser = true): Tag {
      if (!isRecord(input)) throw new InvalidInputError("createTag expects an object.");
      const name = parseName(input.name);
      const description =
        input.description === undefined ? "" : parseDescription(input.description);
      const chosen = input.colour === undefined ? null : parseColour(input.colour);
      return db.transaction(() => {
        checkUnique(name);
        const at = now();
        const colour = chosen ?? nextTagColour(list().map((tag) => tag.colour));
        const id = insertTag(name, description, colour, at, madeByUser);
        return {
          id,
          name,
          description,
          preset: false,
          kind: null,
          madeByUser,
          colour,
          createdAt: at,
          updatedAt: at,
        };
      });
    },

    /**
     * Changes a Tag's name, description or colour. With `source`, the Undo of an edit, it also
     * puts back whether the Tag was the User's, if it still shows what the edit left.
     */
    update(tagId: unknown, patch: unknown, source?: unknown): Tag {
      if (!isRecord(patch)) throw new InvalidInputError("updateTag expects an object.");
      for (const key of Object.keys(patch)) {
        if (key !== "name" && key !== "description" && key !== "colour") {
          throw new InvalidInputError(`A Tag has no field "${key}".`);
        }
      }
      const revert = parseSourceRevert(source);
      return db.transaction(() => {
        const row = rowOf(tagId);
        const tag = shown(row);
        const name = patch.name === undefined ? tag.name : parseName(patch.name);
        const description =
          patch.description === undefined ? tag.description : parseDescription(patch.description);
        const colour = patch.colour === undefined ? tag.colour : parseColour(patch.colour);
        const putsBack =
          revert !== undefined &&
          tag.name === revert.expected.name &&
          tag.description === revert.expected.description &&
          tag.colour === revert.expected.colour;
        if (name === tag.name && description === tag.description && colour === tag.colour)
          return tag;
        checkUnique(name, tag.id);
        const at = now();
        const madeByUser = putsBack ? revert.madeByUser : true;
        // A kind's Tag keeps showing the kind's own words until the User changes them.
        db.run(
          `UPDATE tags SET name = ?, description = ?, colour = ?, made_by_user = ?,
             updated_at = ? WHERE id = ?`,
          [
            name === tag.name ? row.name : name,
            description === tag.description ? row.description : description,
            colour,
            madeByUser ? 1 : 0,
            at,
            tag.id,
          ],
        );
        return { ...tag, name, description, madeByUser, colour, updatedAt: at };
      });
    },

    /**
     * Puts back whether a Tag was the User's, if it still shows `expected`: the Undo of a merge.
     * A Tag changed since, or deleted since, keeps its source. Returns whether it changed.
     */
    setSource(tagId: unknown, madeByUser: unknown, expected: unknown): boolean {
      if (typeof madeByUser !== "boolean") {
        throw new InvalidInputError(
          "Putting back a Tag's source needs whether it was the User's and what it showed.",
        );
      }
      const shown = parseShown(expected);
      return db.transaction(() => {
        const id = parseTagId(tagId);
        const row = db.get<TagRow>(
          `SELECT ${COLUMNS} FROM tags WHERE id = ? AND deleted_at IS NULL`,
          [id],
        );
        const showing = row && toTag(row, language());
        if (
          !row ||
          !showing ||
          showing.name !== shown.name ||
          showing.description !== shown.description ||
          showing.colour !== shown.colour
        )
          return false;
        if ((row.made_by_user !== 0) === madeByUser) return false;
        db.run("UPDATE tags SET made_by_user = ?, updated_at = ? WHERE id = ?", [
          madeByUser ? 1 : 0,
          now(),
          id,
        ]);
        return true;
      });
    },

    /**
     * Marks a Tag deleted at `at`, and takes it off every Document. Returns the
     * ids of the Documents that carried it.
     */
    delete(tagId: unknown, at: string): string[] {
      return db.transaction(() => {
        const tag = get(tagId);
        const documentIds = db
          .all<{ document_id: string }>(
            `SELECT document_id FROM document_tags WHERE tag_id = ? AND deleted_at IS NULL
             ORDER BY created_at, rowid`,
            [tag.id],
          )
          .map((row) => row.document_id);
        db.run("UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, tag.id]);
        db.run(
          `UPDATE document_tags SET deleted_at = ?, updated_at = ?
           WHERE tag_id = ? AND deleted_at IS NULL`,
          [at, at, tag.id],
        );
        return documentIds;
      });
    },

    /**
     * The User puts a Tag on a Document (the caller checks the Document).
     * An automatic link becomes theirs: that is how the User confirms a Tag
     * marked "needs review". Returns whether anything changed.
     */
    addToDocument(documentId: string, tagIdInput: unknown): boolean {
      return db.transaction(() => {
        const tag = get(tagIdInput);
        const at = now();
        const link = liveLink(documentId, tag.id);
        if (link?.source === "user") return false;
        if (link) {
          db.run(
            `UPDATE document_tags SET source = 'user', confidence = NULL, needs_review = 0,
               updated_at = ?
             WHERE id = ?`,
            [at, link.id],
          );
        } else {
          insertLink(documentId, tag.id, "user", at);
        }
        return true;
      });
    },

    /**
     * The User takes a Tag off a Document (the caller checks the Document).
     * The link is marked deleted as theirs, so automatic tagging leaves it off;
     * if the Tag wasn't on the Document, that decision is still recorded.
     * Returns whether the Document's Tags changed.
     */
    removeFromDocument(documentId: string, tagIdInput: unknown): boolean {
      return db.transaction(() => {
        const tag = get(tagIdInput);
        const at = now();
        const link = liveLink(documentId, tag.id);
        if (link) {
          db.run(
            `UPDATE document_tags SET source = 'user', deleted_at = ?, updated_at = ? WHERE id = ?`,
            [at, at, link.id],
          );
          return true;
        }
        const decided = db.get(
          `SELECT 1 FROM document_tags WHERE document_id = ? AND tag_id = ? AND source = 'user'`,
          [documentId, tag.id],
        );
        if (!decided) insertLink(documentId, tag.id, "user", at, at);
        return false;
      });
    },

    /**
     * Merges Tag `fromInput` into Tag `intoInput` at `at`: each Document's
     * link moves over, keeping who chose it (the User's wins where a Document
     * has both, and an automatic link keeps its confidence), and a removal the
     * User made carries over where they haven't decided on the other Tag. The
     * merged Tag is then deleted. Returns the ids of the Documents whose Tags
     * changed (those that carried the merged Tag), and the other Tag's links
     * as they were where it changed them.
     */
    merge(
      fromInput: unknown,
      intoInput: unknown,
      at: string,
    ): { documentIds: string[]; links: TagLinkState[] } {
      return db.transaction(() => {
        const from = get(fromInput);
        const into = get(intoInput);
        if (from.id === into.id) throw new InvalidInputError({ key: "error.tag.mergeIntoItself" });
        // A deleted Document's links are left as they were, for restoring it.
        const rows = db.all<LinkRow & { document_id: string; deleted: number }>(
          `SELECT l.id, l.document_id, l.tag_id, l.source, l.confidence, l.needs_review,
             l.deleted_at IS NOT NULL AS deleted
           FROM document_tags l JOIN documents d ON d.id = l.document_id
           WHERE l.tag_id = ? AND d.deleted_at IS NULL
             AND (l.deleted_at IS NULL OR l.source = 'user')
           ORDER BY l.created_at, l.rowid`,
          [from.id],
        );
        const changed: string[] = [];
        const links = new Map<string, TagLinkState>();
        const before = (documentId: string, state: Omit<TagLinkState, "documentId" | "tagId">) => {
          if (!links.has(documentId))
            links.set(documentId, { documentId, tagId: into.id, ...state });
        };
        for (const row of rows) {
          const target = liveLink(row.document_id, into.id);
          const decided = !!db.get(
            "SELECT 1 FROM document_tags WHERE document_id = ? AND tag_id = ? AND source = 'user'",
            [row.document_id, into.id],
          );
          if (row.deleted) {
            // The User's removal: the other Tag stays off too, unless they decided on it.
            if (!target && !decided) {
              before(row.document_id, { link: null, removedByUser: false });
              insertLink(row.document_id, into.id, "user", at, at);
            }
            continue;
          }
          changed.push(row.document_id);
          if (target) {
            if (row.source === "user" && target.source !== "user") {
              before(row.document_id, {
                link: {
                  source: target.source,
                  confidence: target.confidence,
                  needsReview: target.needs_review !== 0,
                },
              });
              db.run(
                `UPDATE document_tags SET source = 'user', confidence = NULL, needs_review = 0,
                   updated_at = ? WHERE id = ?`,
                [at, target.id],
              );
            }
          } else if (row.source === "user" || !decided) {
            before(row.document_id, { link: null, removedByUser: decided });
            // An automatic link doesn't come back where the User took the other Tag off.
            insertLink(row.document_id, into.id, row.source, at, null, {
              confidence: row.confidence,
              needsReview: row.needs_review !== 0,
            });
          }
        }
        db.run("UPDATE tags SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, from.id]);
        // The Tag kept is the User's from now on, so its row stays at 0 in the sidebar.
        db.run("UPDATE tags SET made_by_user = 1, updated_at = ? WHERE id = ?", [at, into.id]);
        db.run(
          `UPDATE document_tags SET deleted_at = ?, updated_at = ?
           WHERE tag_id = ? AND deleted_at IS NULL`,
          [at, at, from.id],
        );
        return { documentIds: [...new Set(changed)], links: [...links.values()] };
      });
    },

    /** A Tag's name as the interface shows it, deleted or not: a kind's in its language. */
    nameShown: (row: Pick<TagRow, "kind" | "name">) => shownName(row, language()),

    /**
     * The live Tag a deleted one would share its name with, restored: a kind's Tag that shows its
     * kind's name has that name in every language.
     */
    holderOnRestore(row: Pick<TagRow, "kind" | "name">): Tag | undefined {
      const kind = kindOf(row);
      const names =
        kind && row.name === "" ? LANGUAGES.map((each) => kindName(kind, each)) : [row.name];
      for (const name of names) {
        const taken = holderOf(name);
        if (taken) return taken;
      }
      return undefined;
    },

    /**
     * Brings back a deleted Tag (the caller checks it may) and the links deleted with it, but on a
     * meeting's Transcript, which has no Tags of its own (#2528). Returns the Documents that carry
     * it again.
     */
    restore(tagId: string, deletedAt: string): string[] {
      return db.transaction(() => {
        const at = now();
        db.run("UPDATE tags SET deleted_at = NULL, updated_at = ? WHERE id = ?", [at, tagId]);
        return db
          .all<{ document_id: string }>(
            `UPDATE document_tags SET deleted_at = NULL, updated_at = ?
             WHERE tag_id = ? AND deleted_at = ?
               AND NOT EXISTS (SELECT 1 FROM document_tags live
                               WHERE live.document_id = document_tags.document_id
                                 AND live.tag_id = document_tags.tag_id AND live.deleted_at IS NULL)
               AND NOT EXISTS (SELECT 1 FROM documents d
                               WHERE d.id = document_tags.document_id
                                 AND d.meeting_mind_id IS NOT NULL)
             RETURNING document_id`,
            [at, tagId, deletedAt],
          )
          .map((row) => row.document_id);
      });
    },

    /**
     * Puts links back as they were (see `CoreApi.revertDocumentTags`); the caller checks
     * the Documents and Tags. A link taken off is marked automatic, so it records no
     * removal. Returns the Documents whose Tags changed.
     */
    revert(states: readonly TagLinkState[]): string[] {
      return db.transaction(() => {
        const at = now();
        const changed = new Set<string>();
        for (const { documentId, tagId, link, removedByUser } of states) {
          const live = liveLink(documentId, tagId);
          if (link) {
            const needsReview = link.needsReview ? 1 : 0;
            if (
              live?.source === link.source &&
              live.confidence === link.confidence &&
              live.needs_review === needsReview
            )
              continue;
            // The link a removal marked deleted comes back, so the removal goes with it.
            const row =
              live ??
              db.get<{ id: string }>(
                `SELECT id FROM document_tags WHERE document_id = ? AND tag_id = ?
                 ORDER BY deleted_at DESC, rowid DESC LIMIT 1`,
                [documentId, tagId],
              );
            if (row)
              db.run(
                `UPDATE document_tags SET source = ?, confidence = ?, needs_review = ?,
                   deleted_at = NULL, updated_at = ? WHERE id = ?`,
                [link.source, link.confidence, needsReview, at, row.id],
              );
            else insertLink(documentId, tagId, link.source, at, null, link);
            changed.add(documentId);
            continue;
          }
          if (live) {
            db.run(
              `UPDATE document_tags SET source = 'automatic', deleted_at = ?, updated_at = ?
               WHERE id = ?`,
              [at, at, live.id],
            );
            changed.add(documentId);
          }
          if (removedByUser === false)
            db.run(
              `UPDATE document_tags SET source = 'automatic', updated_at = ?
               WHERE document_id = ? AND tag_id = ? AND source = 'user'`,
              [at, documentId, tagId],
            );
        }
        return [...changed];
      });
    },

    /**
     * Puts these Tags on a Document as Research's own, where neither the User nor anything else
     * has: a Tag the User added or took off there, and a deleted Tag, are left alone. Returns
     * whether its Tags changed. Run it in the caller's transaction.
     */
    addAutomatic(documentId: string, tagIds: readonly string[]): boolean {
      return db.transaction(() => {
        const at = now();
        const decided = new Set(owned(documentId));
        const live = new Set(list().map((tag) => tag.id));
        let changed = false;
        for (const tagId of new Set(tagIds)) {
          if (!live.has(tagId) || decided.has(tagId) || liveLink(documentId, tagId)) continue;
          insertLink(documentId, tagId, "automatic", at);
          changed = true;
        }
        return changed;
      });
    },
  };
}
