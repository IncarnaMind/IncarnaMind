/**
 * A Document's highlights and notes (#327): the words the User marked, the
 * note under them, where in the Document they are (ADR-0011) and their check,
 * so Add to note and Collect into a Mind can cite them. A new version of the
 * Document re-anchors each by its quote; one whose words are gone stays, saying
 * so. A PDF's own highlights and notes, read when it is added, are stored the
 * same way with `source: "file"`.
 *
 * Everything here is ready to sync: UUID ids, ISO 8601 UTC times, soft deletes.
 * The words of every annotation are in the keyword index (./searching), which
 * Search, ⌘K and the assistant read.
 */
import { randomUUID } from "node:crypto";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { translate } from "../../shared/i18n";
import { formatLocation, parseLocation } from "../../shared/locations";
import type {
  Annotation,
  AnnotationColour,
  AnnotationEdit,
  AnnotationGroup,
  AnnotationMatch,
  AnnotationSource,
  AnnotationsIn,
  CitationCheck,
  CitationCheckReason,
  CitationLocation,
  CreateAnnotationInput,
  SelectedPart,
} from "../api";
import { ANNOTATION_COLOURS } from "../api";
import { keywordQuery, keywordText } from "../documents/keywords";
import type { FileAnnotation } from "../documents/pdfAnnotations";
import { InvalidInputError, NotFoundError } from "../errors";
import type { Database } from "../storage";
import { excerptOf, searchTerms } from "../wordSearch";

/** Where re-anchoring reads a Document's current version (see `citeSelection`). */
export interface AnnotationCiter {
  /** The current version of a live Document; null if it was deleted. */
  currentVersion(documentId: string): string | null;
  /** The selection as the Document's current version has it. */
  cite(documentId: string, parts: readonly SelectedPart[]): { quote: string } & CitationRecheckLike;
}

/** What a Citation's check is: the fields an annotation keeps. */
export interface CitationRecheckLike {
  check: CitationCheck;
  checkReason: CitationCheckReason | null;
  contentHash: string | null;
  passageId: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  location: CitationLocation | null;
}

interface AnnotationRow {
  id: string;
  document_id: string;
  document_name: string | null;
  content_hash: string | null;
  passage_id: string | null;
  source: AnnotationSource;
  colour: AnnotationColour;
  quote: string;
  note: string | null;
  page_from: number | null;
  page_to: number | null;
  location: string | null;
  check_state: CitationCheck;
  check_reason: CitationCheckReason | null;
  anchor: string | null;
  author: string | null;
  missing: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `a.id, a.document_id, d.name AS document_name, a.content_hash, a.passage_id,
  a.source, a.colour,
  a.quote, a.note, a.page_from, a.page_to, a.location, a.check_state, a.check_reason, a.anchor, a.author,
  a.missing, a.created_at, a.updated_at`;

const FROM = "FROM document_annotations a LEFT JOIN documents d ON d.id = a.document_id";

const MAX_NOTE_LENGTH = 20_000;

const isColour = (value: unknown): value is AnnotationColour =>
  typeof value === "string" && (ANNOTATION_COLOURS as readonly string[]).includes(value);

const colourOf = (value: unknown): AnnotationColour => {
  if (!isColour(value)) throw new InvalidInputError("That isn't one of the highlight colours.");
  return value;
};

const noteOf = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new InvalidInputError("A note is text.");
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new InvalidInputError(`A note holds at most ${MAX_NOTE_LENGTH} characters.`);
  }
  return note === "" ? null : note;
};

function parseAnchor(json: string | null): SelectedPart[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const parts = parsed.filter(
      (part): part is SelectedPart =>
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string" &&
        "unit" in part &&
        (part.unit === null || typeof part.unit === "number"),
    );
    return parts.length === 0 ? null : parts;
  } catch {
    return null;
  }
}

const toAnnotation = (row: AnnotationRow): Annotation => ({
  id: row.id,
  documentId: row.document_id,
  documentName: row.document_name ?? "",
  contentHash: row.content_hash,
  passageId: row.passage_id,
  source: row.source,
  colour: row.colour,
  quote: row.quote,
  note: row.note,
  pageFrom: row.page_from,
  pageTo: row.page_to,
  location: parseLocation(row.location === null ? null : safeJson(row.location)),
  check: row.check_state,
  checkReason: row.check_reason,
  anchor: (() => {
    const parts = parseAnchor(row.anchor);
    return parts ? { parts } : null;
  })(),
  author: row.author,
  missing: row.missing !== 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Whether a check puts the words where they are: found, or a scan's word that asks for a look. */
const located = (check: CitationCheck, reason: CitationCheckReason | null) =>
  check === "found" || (check === "cant-check" && reason === "unsure-word");

const wordsOf = (quote: string, note: string | null) =>
  keywordText(note === null || note === "" ? quote : `${quote}\n${note}`);

export function createAnnotations(db: Database, now: () => string, citer: AnnotationCiter) {
  const index = (seq: number, quote: string, note: string | null) => {
    db.run("DELETE FROM annotation_text_fts WHERE rowid = ?", [BigInt(seq)]);
    const words = wordsOf(quote, note);
    if (words !== "")
      db.run("INSERT INTO annotation_text_fts (rowid, text) VALUES (?, ?)", [BigInt(seq), words]);
  };

  const stored = (id: string): AnnotationRow => {
    const row = db.get<AnnotationRow>(
      `SELECT ${COLUMNS} ${FROM} WHERE a.id = ? AND a.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw new NotFoundError("That highlight is gone.");
    return row;
  };

  const insert = (annotation: Annotation, at: string): Annotation => {
    const result = db.get<{ seq: number }>(
      `INSERT INTO document_annotations
         (id, document_id, content_hash, passage_id, source, colour, quote, note, page_from,
          page_to, location, check_state, check_reason, anchor, author, missing, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`,
      [
        annotation.id,
        annotation.documentId,
        annotation.contentHash,
        annotation.passageId,
        annotation.source,
        annotation.colour,
        annotation.quote,
        annotation.note,
        annotation.pageFrom === null ? null : BigInt(annotation.pageFrom),
        annotation.pageTo === null ? null : BigInt(annotation.pageTo),
        annotation.location ? JSON.stringify(annotation.location) : null,
        annotation.check,
        annotation.checkReason,
        annotation.anchor ? JSON.stringify(annotation.anchor.parts) : null,
        annotation.author,
        annotation.missing ? 1 : 0,
        at,
        at,
      ],
    );
    if (!result) throw new Error("The highlight wasn't saved.");
    index(result.seq, annotation.quote, annotation.note);
    return annotation;
  };

  /**
   * Finds each of a Document's annotations again in a version its quote wasn't
   * placed in, by the selection it was made from: its Location and quote follow
   * its words, and one whose words are gone says "missing".
   */
  function reanchor(documentId: string): void {
    const current = citer.currentVersion(documentId);
    if (current === null) return;
    const rows = db.all<AnnotationRow>(
      `SELECT ${COLUMNS} ${FROM}
       WHERE a.document_id = ? AND a.deleted_at IS NULL AND a.source = 'user'
         AND (a.content_hash IS NULL OR a.content_hash <> ?)`,
      [documentId, current],
    );
    if (rows.length === 0) return;
    const at = now();
    db.transaction(() => {
      for (const row of rows) {
        const parts = parseAnchor(row.anchor);
        if (!parts) {
          db.run(
            "UPDATE document_annotations SET content_hash = ?, missing = 1, updated_at = ? WHERE id = ?",
            [current, at, row.id],
          );
          continue;
        }
        const cited = citer.cite(documentId, parts);
        const found = located(cited.check, cited.checkReason);
        db.run(
          `UPDATE document_annotations
             SET content_hash = ?, quote = ?, page_from = ?, page_to = ?, location = ?,
               check_state = ?, check_reason = ?, missing = ?, updated_at = ?
           WHERE id = ?`,
          [
            current,
            found ? cited.quote : row.quote,
            found
              ? cited.pageFrom === null
                ? null
                : BigInt(cited.pageFrom)
              : row.page_from === null
                ? null
                : BigInt(row.page_from),
            found
              ? cited.pageTo === null
                ? null
                : BigInt(cited.pageTo)
              : row.page_to === null
                ? null
                : BigInt(row.page_to),
            found ? (cited.location ? JSON.stringify(cited.location) : null) : row.location,
            found ? cited.check : "not-found",
            found ? cited.checkReason : "quote-not-on-pages",
            found ? 0 : 1,
            at,
            row.id,
          ],
        );
        if (found && cited.quote !== row.quote) {
          const seq = db.get<{ seq: number }>("SELECT seq FROM document_annotations WHERE id = ?", [
            row.id,
          ])?.seq;
          if (seq !== undefined) index(seq, cited.quote, row.note);
        }
      }
    });
  }

  const list = (documentId: string): Annotation[] => {
    reanchor(documentId);
    return db
      .all<AnnotationRow>(
        `SELECT ${COLUMNS} ${FROM}
         WHERE a.document_id = ? AND a.deleted_at IS NULL
         ORDER BY a.created_at DESC, a.seq DESC`,
        [documentId],
      )
      .map(toAnnotation);
  };

  return {
    /** Highlights words the User selected, already cited by the core. */
    create(input: CreateAnnotationInput & CitationRecheckLike & { quote: string }): Annotation {
      const note = noteOf(input.note);
      const at = now();
      const annotation: Annotation = {
        id: randomUUID(),
        documentId: input.documentId,
        documentName:
          db.get<{ name: string }>("SELECT name FROM documents WHERE id = ?", [input.documentId])
            ?.name ?? "",
        contentHash: input.contentHash,
        passageId: input.passageId,
        source: "user",
        colour: colourOf(input.colour),
        quote: input.quote,
        note,
        pageFrom: input.pageFrom,
        pageTo: input.pageTo,
        location: input.location,
        check: input.check,
        checkReason: input.checkReason,
        anchor: { parts: input.parts },
        author: null,
        missing: !located(input.check, input.checkReason),
        createdAt: at,
        updatedAt: at,
      };
      const saved = db.transaction(() => insert(annotation, at));
      return toAnnotation(stored(saved.id));
    },

    list(documentId: string): Annotation[] {
      return list(documentId);
    },

    /** Annotations to collect, grouped by Document in page order. */
    in(input: AnnotationsIn): AnnotationGroup[] {
      const where = ["a.deleted_at IS NULL", "d.deleted_at IS NULL"];
      const params: string[] = [];
      if (input.documentId !== undefined) {
        if (typeof input.documentId !== "string" || input.documentId === "") {
          throw new InvalidInputError("Collect needs a Document.");
        }
        where.push("a.document_id = ?");
        params.push(input.documentId);
      }
      if (input.folderId !== undefined) {
        if (typeof input.folderId !== "string" || input.folderId === "") {
          throw new InvalidInputError("Collect needs a Folder.");
        }
        where.push(`d.id IN (
          SELECT document_id FROM document_groups WHERE deleted_at IS NULL AND group_id IN (
            WITH RECURSIVE under(id) AS (
              SELECT id FROM library_groups WHERE id = ? AND deleted_at IS NULL
              UNION ALL SELECT g.id FROM library_groups g JOIN under ON g.parent_id = under.id
            ) SELECT id FROM under))`);
        params.push(input.folderId);
      }
      if (input.colour !== undefined) {
        where.push("a.colour = ?");
        params.push(colourOf(input.colour));
      }
      const rows = db.all<AnnotationRow>(
        `SELECT ${COLUMNS} ${FROM} WHERE ${where.join(" AND ")}
         ORDER BY d.name, a.page_from, a.created_at, a.seq`,
        params,
      );
      const groups = new Map<string, AnnotationGroup>();
      for (const row of rows) {
        let group = groups.get(row.document_id);
        if (!group) {
          group = {
            documentId: row.document_id,
            documentName: row.document_name ?? "",
            annotations: [],
          };
          groups.set(row.document_id, group);
        }
        group.annotations.push(toAnnotation(row));
      }
      return [...groups.values()];
    },

    /** How many annotations each live Document with any has, by Document id. */
    counts(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const row of db.all<{ document_id: string; count: number }>(
        `SELECT a.document_id, count(*) AS count ${FROM}
         WHERE a.deleted_at IS NULL AND d.deleted_at IS NULL GROUP BY a.document_id`,
      )) {
        counts[row.document_id] = row.count;
      }
      return counts;
    },

    update(id: string, edit: AnnotationEdit): Annotation {
      const row = stored(id);
      const at = now();
      const note = edit.note === undefined ? row.note : noteOf(edit.note);
      const colour = edit.colour === undefined ? row.colour : colourOf(edit.colour);
      db.transaction(() => {
        db.run(
          "UPDATE document_annotations SET note = ?, colour = ?, updated_at = ? WHERE id = ?",
          [note, colour, at, id],
        );
        const seq = db.get<{ seq: number }>("SELECT seq FROM document_annotations WHERE id = ?", [
          id,
        ])?.seq;
        if (seq !== undefined) index(seq, row.quote, note);
      });
      return toAnnotation(stored(id));
    },

    /** Deletes it softly, so `restore` takes it back. */
    remove(id: string): Annotation {
      const row = stored(id);
      const at = now();
      db.run("UPDATE document_annotations SET deleted_at = ?, updated_at = ? WHERE id = ?", [
        at,
        at,
        id,
      ]);
      return toAnnotation(row);
    },

    restore(id: string): Annotation {
      const row = db.get<AnnotationRow>(`SELECT ${COLUMNS} ${FROM} WHERE a.id = ?`, [id]);
      if (!row) throw new NotFoundError("That highlight is gone.");
      const at = now();
      db.transaction(() => {
        db.run("UPDATE document_annotations SET deleted_at = NULL, updated_at = ? WHERE id = ?", [
          at,
          id,
        ]);
        const seq = db.get<{ seq: number }>("SELECT seq FROM document_annotations WHERE id = ?", [
          id,
        ])?.seq;
        if (seq !== undefined) index(seq, row.quote, row.note);
      });
      return toAnnotation(stored(id));
    },

    /** The annotations whose quote or note holds the words, best match first. */
    search(query: string, limit: number): AnnotationMatch[] {
      const terms = searchTerms(query);
      const match = keywordQuery(query);
      if (terms.length === 0 || match === null) return [];
      const rows = db.all<AnnotationRow & { score: number }>(
        `SELECT ${COLUMNS}, bm25(annotation_text_fts) AS score
         FROM annotation_text_fts
         JOIN document_annotations a ON a.seq = annotation_text_fts.rowid
         LEFT JOIN documents d ON d.id = a.document_id
         WHERE annotation_text_fts MATCH ? AND a.deleted_at IS NULL AND d.deleted_at IS NULL
         ORDER BY score, a.created_at DESC LIMIT ?`,
        [match, BigInt(limit)],
      );
      return rows.map((row) => {
        const annotation = toAnnotation(row);
        const text =
          annotation.note === null ? annotation.quote : `${annotation.quote}\n${annotation.note}`;
        const { excerpt, highlights } = excerptOf(text, terms);
        return {
          annotationId: annotation.id,
          documentId: annotation.documentId,
          documentName: annotation.documentName,
          colour: annotation.colour,
          source: annotation.source,
          note: annotation.note,
          excerpt,
          highlights,
          pageFrom: annotation.pageFrom,
          pageTo: annotation.pageTo,
          location: annotation.location,
          missing: annotation.missing,
        };
      });
    },

    /** A Document's annotations as Markdown: each quote, its note and its Location (#327). */
    markdown(documentId: string): { name: string; text: string } {
      const name =
        db.get<{ name: string }>("SELECT name FROM documents WHERE id = ?", [documentId])?.name ??
        "";
      const annotations = list(documentId);
      const english = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
      const lines = [`# ${name}: ${english("annotations.export.title")}`, ""];
      for (const annotation of annotations) {
        const where = annotation.location ? formatLocation(annotation.location, english) : "";
        lines.push(`## ${where}`);
        for (const line of annotation.quote.split("\n")) lines.push(`> ${line}`);
        lines.push("");
        if (annotation.note) lines.push(annotation.note, "");
        if (annotation.missing) lines.push(english("annotations.missing"), "");
        if (annotation.source === "file") {
          lines.push(
            annotation.author
              ? english("annotations.export.fromFileBy", { author: annotation.author })
              : english("annotations.export.fromFile"),
            "",
          );
        }
      }
      return {
        name: `${name}${english("annotations.export.suffix")}`,
        text: `${lines.join("\n")}\n`,
      };
    },

    /**
     * Stores a PDF's own highlights and notes for a version, in place of those
     * read from an earlier one. The User's own are untouched.
     */
    replaceFileAnnotations(
      documentId: string,
      contentHash: string,
      found: readonly FileAnnotation[],
    ): void {
      const at = now();
      db.transaction(() => {
        db.run(
          `UPDATE document_annotations SET deleted_at = ?, updated_at = ?
           WHERE document_id = ? AND source = 'file' AND deleted_at IS NULL`,
          [at, at, documentId],
        );
        for (const annotation of found) {
          insert(
            {
              id: randomUUID(),
              documentId,
              documentName: "",
              contentHash,
              passageId: null,
              source: "file",
              colour: annotation.colour,
              quote: annotation.quote,
              note: annotation.note,
              pageFrom: annotation.page,
              pageTo: annotation.page,
              location: { kind: "page", from: annotation.page, to: annotation.page },
              check:
                annotation.kind === "note"
                  ? "cant-check"
                  : annotation.found
                    ? "found"
                    : "not-found",
              checkReason:
                annotation.kind === "note"
                  ? "no-text"
                  : annotation.found
                    ? null
                    : "quote-not-on-pages",
              anchor: null,
              author: annotation.author,
              missing: false,
              createdAt: at,
              updatedAt: at,
            },
            at,
          );
        }
      });
    },
  };
}

export type Annotations = ReturnType<typeof createAnnotations>;
