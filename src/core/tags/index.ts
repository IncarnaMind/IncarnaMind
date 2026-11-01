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
import { isTagColour, nextTagColour, type TagColour } from "../../shared/tagColours";
import type { DocumentTag, Tag, TagLinkState, TagSource } from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import type { Language } from "../language";
import type { Database } from "../storage";
import type { TagDecision } from "./classify";
import { PRESET_TAGS } from "./presets";
import { NEW_TAG_LIMIT, type NewTag, tagKey } from "./suggest";

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

interface TagRow {
  id: string;
  name: string;
  description: string;
  preset: string | null;
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

const COLUMNS = "id, name, description, preset, colour, created_at, updated_at";

const toTag = (row: TagRow): Tag => ({
  id: row.id,
  name: row.name,
  description: row.description,
  preset: row.preset !== null,
  colour: row.colour,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** How names are compared: two names that differ only in case are the same Tag. */
export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
 * The live Tags on a Document, in Tag name order. Links to a Tag that is
 * deleted don't count, whatever their own state.
 */
export function tagsOfDocument(db: Database, documentId: string): DocumentTag[] {
  return db
    .all<{ tag_id: string; source: TagSource; confidence: number | null; needs_review: number }>(
      `SELECT l.tag_id, l.source, l.confidence, l.needs_review
       FROM document_tags l JOIN tags t ON t.id = l.tag_id
       WHERE l.document_id = ? AND l.deleted_at IS NULL AND t.deleted_at IS NULL
       ORDER BY t.name COLLATE NOCASE, t.created_at, t.rowid`,
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

export function createTags(db: Database, now: () => string) {
  const get = (tagId: unknown): Tag => {
    const row = db.get<TagRow>(`SELECT ${COLUMNS} FROM tags WHERE id = ? AND deleted_at IS NULL`, [
      parseTagId(tagId),
    ]);
    if (!row) throw new NotFoundError({ key: "error.tag.notFound" });
    return toTag(row);
  };

  const list = (): Tag[] =>
    db
      .all<TagRow>(
        `SELECT ${COLUMNS} FROM tags WHERE deleted_at IS NULL
         ORDER BY name COLLATE NOCASE, created_at, rowid`,
      )
      .map(toTag);

  /** Refuses a name another live Tag has, ignoring case. */
  const checkUnique = (name: string, exceptId?: string) => {
    const taken = list().find((tag) => tag.id !== exceptId && sameName(tag.name, name));
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
    decision: Pick<TagDecision, "confidence" | "needsReview"> = {
      confidence: null,
      needsReview: false,
    },
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
        decision.needsReview ? 1 : 0,
        at,
        at,
        deletedAt,
      ],
    );

  const insertTag = (name: string, description: string, colour: TagColour, at: string) => {
    const id = randomUUID();
    db.run(
      `INSERT INTO tags (id, name, description, preset, colour, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      [id, name, description, colour, at, at],
    );
    return id;
  };

  /**
   * The ids of the Tags these new ones are: a live Tag of the same name (see `tagKey`), or one
   * made for it. None is made under the name of a Tag the User deleted, nor past `NEW_TAG_LIMIT`.
   */
  const tagsNamed = (newTags: readonly NewTag[], at: string) => {
    const live = list();
    const deleted = new Set(
      db
        .all<{ name: string }>("SELECT name FROM tags WHERE deleted_at IS NOT NULL")
        .map((row) => tagKey(row.name)),
    );
    const ids: string[] = [];
    let made = 0;
    for (const tag of newTags) {
      const key = tagKey(tag.name);
      const same = live.find((each) => tagKey(each.name) === key);
      if (same) {
        ids.push(same.id);
        continue;
      }
      if (deleted.has(key) || live.length >= NEW_TAG_LIMIT) continue;
      const colour = nextTagColour(live.map((each) => each.colour));
      const id = insertTag(tag.name, tag.description, colour, at);
      live.push({
        id,
        name: tag.name,
        description: tag.description,
        preset: false,
        colour,
        createdAt: at,
        updatedAt: at,
      });
      ids.push(id);
      made++;
    }
    return { ids, made };
  };

  return {
    get,
    list,

    /**
     * Creates the preset Tags if no Tag has ever existed here (deleted ones
     * count, so deleting every preset doesn't bring them back). Returns
     * whether it did.
     */
    seedPresets(language: Language): boolean {
      return db.transaction(() => {
        if (db.get("SELECT 1 FROM tags LIMIT 1")) return false;
        const at = now();
        for (const preset of PRESET_TAGS) {
          const { name, description } = preset.text[language];
          db.run(
            `INSERT INTO tags (id, name, description, preset, colour, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), name, description, preset.key, preset.colour, at, at],
          );
        }
        return true;
      });
    },

    create(input: unknown): Tag {
      if (!isRecord(input)) throw new InvalidInputError("createTag expects an object.");
      const name = parseName(input.name);
      const description =
        input.description === undefined ? "" : parseDescription(input.description);
      const chosen = input.colour === undefined ? null : parseColour(input.colour);
      return db.transaction(() => {
        checkUnique(name);
        const at = now();
        const colour = chosen ?? nextTagColour(list().map((tag) => tag.colour));
        const id = insertTag(name, description, colour, at);
        return { id, name, description, preset: false, colour, createdAt: at, updatedAt: at };
      });
    },

    update(tagId: unknown, patch: unknown): Tag {
      if (!isRecord(patch)) throw new InvalidInputError("updateTag expects an object.");
      for (const key of Object.keys(patch)) {
        if (key !== "name" && key !== "description" && key !== "colour") {
          throw new InvalidInputError(`A Tag has no field "${key}".`);
        }
      }
      return db.transaction(() => {
        const tag = get(tagId);
        const name = patch.name === undefined ? tag.name : parseName(patch.name);
        const description =
          patch.description === undefined ? tag.description : parseDescription(patch.description);
        const colour = patch.colour === undefined ? tag.colour : parseColour(patch.colour);
        if (name === tag.name && description === tag.description && colour === tag.colour)
          return tag;
        checkUnique(name, tag.id);
        const at = now();
        db.run(
          "UPDATE tags SET name = ?, description = ?, colour = ?, updated_at = ? WHERE id = ?",
          [name, description, colour, at, tag.id],
        );
        return { ...tag, name, description, colour, updatedAt: at };
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
        db.run(
          `UPDATE document_tags SET deleted_at = ?, updated_at = ?
           WHERE tag_id = ? AND deleted_at IS NULL`,
          [at, at, from.id],
        );
        return { documentIds: [...new Set(changed)], links: [...links.values()] };
      });
    },

    /**
     * Brings back a deleted Tag (the caller checks it may) and the links deleted with it.
     * Returns the Documents that carry it again.
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
     * Sets a Document's automatic Tags to those in `decisions` and `newTags`: automatic
     * links not decided on are taken off, decided Tags not on it are added, and those kept
     * take the new confidence and review mark. A new Tag is the live Tag of its name, or is
     * made (see `tagsNamed`). Tags the User added or removed on the Document, and deleted
     * Tags, are left alone. Returns whether the Document's Tags changed and how many Tags
     * were made. Run it in the caller's transaction.
     */
    applyAutomatic(
      documentId: string,
      decisions: readonly TagDecision[],
      newTags: readonly NewTag[] = [],
    ): { changed: boolean; made: number } {
      return db.transaction(() => {
        const at = now();
        const named = tagsNamed(newTags, at);
        const owned = new Set(
          db
            .all<{ tag_id: string }>(
              "SELECT tag_id FROM document_tags WHERE document_id = ? AND source = 'user'",
              [documentId],
            )
            .map((row) => row.tag_id),
        );
        const live = new Set(list().map((tag) => tag.id));
        const wanted = new Map(
          [
            ...decisions,
            ...named.ids.map((tagId) => ({ tagId, confidence: null, needsReview: false })),
          ]
            .filter((decision) => live.has(decision.tagId) && !owned.has(decision.tagId))
            .map((decision) => [decision.tagId, decision]),
        );
        const links = db.all<LinkRow>(
          `SELECT id, tag_id, source, confidence, needs_review FROM document_tags
           WHERE document_id = ? AND deleted_at IS NULL AND source = 'automatic'`,
          [documentId],
        );
        let changed = false;
        for (const link of links) {
          const decision = wanted.get(link.tag_id);
          wanted.delete(link.tag_id);
          if (!decision) {
            db.run("UPDATE document_tags SET deleted_at = ?, updated_at = ? WHERE id = ?", [
              at,
              at,
              link.id,
            ]);
            changed = true;
          } else if (
            link.confidence !== decision.confidence ||
            (link.needs_review !== 0) !== decision.needsReview
          ) {
            // Still applies, decided afresh: e.g. Jev's probability moved on a re-tag.
            db.run(
              `UPDATE document_tags SET confidence = ?, needs_review = ?, updated_at = ?
               WHERE id = ?`,
              [decision.confidence, decision.needsReview ? 1 : 0, at, link.id],
            );
            changed = true;
          }
        }
        for (const [tagId, decision] of wanted) {
          insertLink(documentId, tagId, "automatic", at, null, decision);
          changed = true;
        }
        return { changed, made: named.made };
      });
    },
  };
}
