/**
 * A Document's highlights and notes (#327): the words the User marked, the
 * note under them, where in the Document they are (ADR-0011) and their check,
 * so Add to note and Collect into a Mind can cite them. A new version of the
 * Document re-anchors each by its quote; one whose words are gone stays, saying
 * so. A PDF's own highlights and notes, read when it is added, are stored the
 * same way with `source: "file"`.
 *
 * Everything here is ready to sync: UUID ids, ISO 8601 UTC times, soft deletes.
 * The words of every annotation are in the keyword index (see `search`), which
 * Search, ⌘K and the assistant read.
 */
import { randomUUID } from "node:crypto";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { translate } from "../../shared/i18n";
import { formatLocation, parseCitedArea, parseLocation } from "../../shared/locations";
import type {
  Annotation,
  AnnotationAnchor,
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
import { keywordQuery, keywordText } from "../documents/keywords";
import type { FileAnnotation } from "../documents/pdfAnnotations";
import { InvalidInputError, NotFoundError } from "../errors";
import type { Language } from "../language";
import type { Database } from "../storage";
import { excerptOf, searchTerms } from "../wordSearch";

/** Where re-anchoring reads a Document's current version (see `citeSelection`). */
export interface AnnotationCiter {
  /** The current version of a live Document; null if it was deleted. */
  currentVersion(documentId: string): string | null;
  /** The selection, area or words, as the Document's current version has it. */
  cite(documentId: string, anchor: AnnotationAnchor): { quote: string } & CitationRecheckLike;
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
  file_note: string | null;
  file_colour: AnnotationColour | null;
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
  a.quote, a.note, a.file_note, a.file_colour, a.page_from, a.page_to, a.location, a.check_state,
  a.check_reason, a.anchor, a.author, a.missing, a.created_at, a.updated_at`;

const FROM = "FROM document_annotations a LEFT JOIN documents d ON d.id = a.document_id";

const MAX_NOTE_LENGTH = 20_000;

/** A PDF file's own highlight keeps any of the five colours, not only the three offered (#327). */
const COLOURS: readonly AnnotationColour[] = ["yellow", "green", "blue", "pink", "purple"];

const isColour = (value: unknown): value is AnnotationColour =>
  typeof value === "string" && (COLOURS as readonly string[]).includes(value);

const colourOf = (value: unknown): AnnotationColour => {
  if (!isColour(value)) throw new InvalidInputError({ key: "error.annotation.colour" });
  return value;
};

const noteOf = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new InvalidInputError({ key: "error.annotation.note.text" });
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new InvalidInputError({
      key: "error.annotation.note.tooLong",
      values: { count: MAX_NOTE_LENGTH },
    });
  }
  return note === "" ? null : note;
};

const partsOf = (value: unknown): SelectedPart[] =>
  Array.isArray(value)
    ? value.filter(
        (part): part is SelectedPart =>
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof part.text === "string" &&
          "unit" in part &&
          (part.unit === null || typeof part.unit === "number"),
      )
    : [];

const aroundOf = (value: unknown): { before?: string; after?: string } | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { before, after } = value as Record<string, unknown>;
  if (typeof before !== "string" && typeof after !== "string") return undefined;
  return {
    ...(typeof before === "string" && { before }),
    ...(typeof after === "string" && { after }),
  };
};

function parseAnchor(json: string | null, id: string): AnnotationAnchor | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`The highlight ${id}'s anchor isn't a selection.`);
      return null;
    }
    const anchor = parsed as Record<string, unknown>;
    const parts = partsOf(anchor.parts);
    const area = parseCitedArea(anchor.area);
    const unit = typeof anchor.unit === "number" ? anchor.unit : null;
    const around = aroundOf(anchor.around);
    if (parts.length === 0 && !area) return null;
    return {
      parts,
      ...(area && { area }),
      ...(unit !== null && { unit }),
      ...(around && { around }),
    };
  } catch (error) {
    console.error(`The highlight ${id}'s anchor couldn't be read.`, error);
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
  location: parseLocation(row.location === null ? null : safeJson(row.location, row.id)),
  check: row.check_state,
  checkReason: row.check_reason,
  anchor: parseAnchor(row.anchor, row.id),
  author: row.author,
  missing: row.missing !== 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function safeJson(json: string, id: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    console.error(`The highlight ${id}'s Location couldn't be read.`, error);
    return null;
  }
}

/** Whether a check puts the words where they are: found, or a scan's word that asks for a look. */
const located = (check: CitationCheck, reason: CitationCheckReason | null) =>
  check === "found" || (check === "cant-check" && reason === "unsure-word");

/** The words as a key: a file's read may break a line where the stored quote has a space. */
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

const wordsOf = (quote: string, note: string | null) =>
  keywordText(note === null || note === "" ? quote : `${quote}\n${note}`);

export function createAnnotations(db: Database, now: () => string, citer: AnnotationCiter) {
  const index = (seq: number, quote: string, note: string | null) => {
    db.run("DELETE FROM annotation_text_fts WHERE rowid = ?", [BigInt(seq)]);
    const words = wordsOf(quote, note);
    if (words !== "")
      db.run("INSERT INTO annotation_text_fts (rowid, text) VALUES (?, ?)", [BigInt(seq), words]);
  };
  const reindex = (id: string, quote: string, note: string | null) => {
    const seq = db.get<{ seq: number }>("SELECT seq FROM document_annotations WHERE id = ?", [
      id,
    ])?.seq;
    if (seq !== undefined) index(seq, quote, note);
  };

  const stored = (id: string): AnnotationRow => {
    const row = db.get<AnnotationRow>(
      `SELECT ${COLUMNS} ${FROM} WHERE a.id = ? AND a.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw new NotFoundError({ key: "error.annotation.notFound" });
    return row;
  };

  const insert = (
    annotation: Annotation,
    at: string,
    fileNote: string | null = null,
    fileColour: AnnotationColour | null = null,
  ): Annotation => {
    const result = db.get<{ seq: number }>(
      `INSERT INTO document_annotations
         (id, document_id, content_hash, passage_id, source, colour, quote, note, file_note,
          file_colour, page_from, page_to, location, check_state, check_reason, anchor, author,
          missing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        fileNote,
        fileColour,
        annotation.pageFrom === null ? null : BigInt(annotation.pageFrom),
        annotation.pageTo === null ? null : BigInt(annotation.pageTo),
        annotation.location ? JSON.stringify(annotation.location) : null,
        annotation.check,
        annotation.checkReason,
        annotation.anchor ? JSON.stringify(annotation.anchor) : null,
        annotation.author,
        annotation.missing ? 1 : 0,
        at,
        at,
      ],
    );
    if (!result) throw new InvalidInputError({ key: "error.annotation.notSaved" });
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
        const anchor = parseAnchor(row.anchor, row.id);
        if (!anchor) {
          db.run(
            `UPDATE document_annotations
               SET content_hash = ?, passage_id = NULL, missing = 1, updated_at = ?
             WHERE id = ?`,
            [current, at, row.id],
          );
          continue;
        }
        const cited = citer.cite(documentId, anchor);
        const found = located(cited.check, cited.checkReason);
        // A region stays where it was drawn; only its words can be lost.
        const follow = found || anchor.area !== undefined;
        const quote = follow && cited.quote !== "" ? cited.quote : row.quote;
        db.run(
          `UPDATE document_annotations
             SET content_hash = ?, passage_id = ?, quote = ?, page_from = ?, page_to = ?,
               location = ?, check_state = ?, check_reason = ?, missing = ?, updated_at = ?
           WHERE id = ?`,
          [
            current,
            found ? cited.passageId : null,
            quote,
            follow
              ? cited.pageFrom === null
                ? null
                : BigInt(cited.pageFrom)
              : row.page_from === null
                ? null
                : BigInt(row.page_from),
            follow
              ? cited.pageTo === null
                ? null
                : BigInt(cited.pageTo)
              : row.page_to === null
                ? null
                : BigInt(row.page_to),
            follow
              ? cited.location
                ? JSON.stringify({ ...cited.location })
                : row.location
              : row.location,
            follow ? cited.check : "not-found",
            follow ? cited.checkReason : "quote-not-on-pages",
            found ||
            (anchor.area !== undefined &&
              cited.checkReason === "picture" &&
              cited.location !== null)
              ? 0
              : 1,
            at,
            row.id,
          ],
        );
        if (quote !== row.quote) {
          const seq = db.get<{ seq: number }>("SELECT seq FROM document_annotations WHERE id = ?", [
            row.id,
          ])?.seq;
          if (seq !== undefined) index(seq, quote, row.note);
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
        anchor: {
          parts: input.parts,
          ...(input.area && { area: input.area }),
          ...(input.unit !== undefined && input.unit !== null && { unit: input.unit }),
          ...(input.around && { around: input.around }),
        },
        author: null,
        // A region is its place only while its words are found, or a picture's Location still is.
        missing: !(
          located(input.check, input.checkReason) ||
          (input.area !== undefined && input.checkReason === "picture" && input.location !== null)
        ),
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
          throw new InvalidInputError({ key: "error.annotation.collect" });
        }
        where.push("a.document_id = ?");
        params.push(input.documentId);
      }
      if (input.folderId !== undefined) {
        if (typeof input.folderId !== "string" || input.folderId === "") {
          throw new InvalidInputError({ key: "error.annotation.collect" });
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
      for (const each of db.all<{ document_id: string }>(
        `SELECT DISTINCT a.document_id ${FROM} WHERE ${where.join(" AND ")}`,
        params,
      )) {
        reanchor(each.document_id);
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
      if (!row) throw new NotFoundError({ key: "error.annotation.notFound" });
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
      const find = () =>
        db.all<AnnotationRow & { score: number }>(
          `SELECT ${COLUMNS}, bm25(annotation_text_fts) AS score
           FROM annotation_text_fts
           JOIN document_annotations a ON a.seq = annotation_text_fts.rowid
           LEFT JOIN documents d ON d.id = a.document_id
           WHERE annotation_text_fts MATCH ? AND a.deleted_at IS NULL AND d.deleted_at IS NULL
           ORDER BY score, a.created_at DESC LIMIT ?`,
          [match, BigInt(limit)],
        );
      let rows = find();
      // A Document at a new version re-anchors first: its rows are read as it says now.
      for (const id of new Set(rows.map((row) => row.document_id))) reanchor(id);
      rows = find();
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

    /** A Document's annotations as Markdown: each quote, its note and its Location (#327), in `language`. */
    markdown(documentId: string, language: Language): { name: string; text: string } {
      const name =
        db.get<{ name: string }>("SELECT name FROM documents WHERE id = ?", [documentId])?.name ??
        "";
      const annotations = list(documentId);
      const t = (key: MessageKey, params?: MessageParams) => translate(language, key, params);
      const lines = [`# ${name}: ${t("annotations.export.title")}`, ""];
      for (const annotation of annotations) {
        const where = annotation.location ? formatLocation(annotation.location, t) : "";
        lines.push(`## ${where}`);
        for (const line of annotation.quote.split("\n")) lines.push(`> ${line}`);
        lines.push("");
        if (annotation.note) lines.push(annotation.note, "");
        if (annotation.missing) lines.push(t("annotations.missing"), "");
        if (annotation.source === "file") {
          lines.push(
            annotation.author
              ? t("annotations.export.fromFileBy", { author: annotation.author })
              : t("annotations.export.fromFile"),
            "",
          );
        }
      }
      return {
        name: `${t("annotations.export.prefix")} – ${name}.md`,
        text: `${lines.join("\n")}\n`,
      };
    },

    /**
     * Stores a PDF's own highlights and notes for a version. Rows and the new read
     * are grouped by their words with whitespace aside, a sticky note by the file's
     * own words: a group pairs in page order only when both sides have the same
     * count and every pair moves by one shift, else only a row of the same version
     * on the same page is carried. A matched row keeps its id, the User's note,
     * colour and delete; the file's own note and colour follow the file until the
     * User edits them. A row the version lacks stays, with the current version, no
     * Passage and a not-found check. A re-read that changes nothing writes nothing.
     * The User's own annotations are untouched.
     */
    replaceFileAnnotations(
      documentId: string,
      contentHash: string,
      found: readonly FileAnnotation[],
    ): void {
      const existing = db.all<AnnotationRow & { deleted_at: string | null }>(
        `SELECT ${COLUMNS}, a.deleted_at ${FROM} WHERE a.document_id = ? AND a.source = 'file'`,
        [documentId],
      );
      const at = now();
      // Cited against the pages just stored, as the User's own are: the words' own check.
      const marks = found.map((annotation) => {
        const cited =
          annotation.kind === "highlight" && annotation.quote.trim() !== ""
            ? citer.cite(documentId, {
                parts: [{ unit: annotation.page, text: annotation.quote }],
              })
            : null;
        const there = cited !== null && located(cited.check, cited.checkReason);
        const quote = there && cited && cited.quote !== "" ? cited.quote : annotation.quote;
        return { annotation, cited, there, quote };
      });
      type Row = (typeof existing)[number];
      type Mark = (typeof marks)[number];
      db.transaction(() => {
        const taken = new Set<string>();
        const matched = new Set<Mark>();
        const pairs: { mark: Mark; row: Row }[] = [];
        const pair = (mark: Mark, row: Row) => {
          taken.add(row.id);
          matched.add(mark);
          pairs.push({ mark, row });
        };
        const pageOf = (mark: Mark) =>
          mark.there && mark.cited?.pageFrom != null ? mark.cited.pageFrom : mark.annotation.page;
        /** Groups pair in page order for one count and one shift, else only the same version on the same page. */
        const pairGroups = (
          rowsByKey: Map<string, Row[]>,
          marksByKey: Map<string, Mark[]>,
          rowPage: (row: Row) => number,
          markPage: (mark: Mark) => number,
        ) => {
          for (const [key, group] of marksByKey) {
            const all = (rowsByKey.get(key) ?? []).filter((row) => !taken.has(row.id));
            // Rows a read already left missing are not this group's place any more.
            const live = all.filter((row) => !row.missing);
            const rows = live.length > 0 ? live : all;
            const byPageRows = [...rows].sort(
              (a, b) =>
                rowPage(a) - rowPage(b) ||
                a.created_at.localeCompare(b.created_at) ||
                a.id.localeCompare(b.id),
            );
            const byPageMarks = [...group].sort((a, b) => markPage(a) - markPage(b));
            const shifts = byPageMarks.map(
              (mark, index) =>
                markPage(mark) - (byPageRows[index] ? rowPage(byPageRows[index]) : 0),
            );
            if (
              byPageRows.length === byPageMarks.length &&
              byPageRows.length > 0 &&
              shifts.every((shift) => shift === shifts[0])
            ) {
              for (const [index, mark] of byPageMarks.entries()) {
                const row = byPageRows[index];
                if (row) pair(mark, row);
              }
              continue;
            }
            for (const mark of byPageMarks) {
              const row = rows.find(
                (each) =>
                  !taken.has(each.id) &&
                  each.content_hash === contentHash &&
                  rowPage(each) === markPage(mark),
              );
              if (row) pair(mark, row);
            }
          }
        };

        const noteRows = existing.filter((row) => row.quote === "");
        const noteMarks = marks.filter((mark) => mark.annotation.kind === "note");
        const noteRowsByText = new Map<string, Row[]>();
        for (const row of noteRows) {
          const key = collapsed(row.file_note ?? "");
          noteRowsByText.set(key, [...(noteRowsByText.get(key) ?? []), row]);
        }
        const noteMarksByText = new Map<string, Mark[]>();
        for (const mark of noteMarks) {
          const key = collapsed(mark.annotation.note ?? "");
          noteMarksByText.set(key, [...(noteMarksByText.get(key) ?? []), mark]);
        }
        pairGroups(
          noteRowsByText,
          noteMarksByText,
          (row) => row.page_from ?? 0,
          (mark) => mark.annotation.page,
        );
        // A page's only other note takes a leftover only when the User hasn't rewritten it.
        const freeRowsByPage = new Map<number, Row[]>();
        for (const row of noteRows) {
          if (taken.has(row.id) || row.note !== row.file_note) continue;
          const page = row.page_from ?? 0;
          freeRowsByPage.set(page, [...(freeRowsByPage.get(page) ?? []), row]);
        }
        const freeMarksByPage = new Map<number, Mark[]>();
        for (const mark of noteMarks) {
          if (matched.has(mark)) continue;
          const page = mark.annotation.page;
          freeMarksByPage.set(page, [...(freeMarksByPage.get(page) ?? []), mark]);
        }
        for (const [page, rows] of freeRowsByPage) {
          const marksOn = freeMarksByPage.get(page) ?? [];
          const [row] = rows;
          const [mark] = marksOn;
          if (rows.length === 1 && marksOn.length === 1 && row && mark) pair(mark, row);
        }

        const rowGroups = new Map<string, Row[]>();
        for (const row of existing) {
          if (row.quote === "") continue;
          const key = collapsed(row.quote);
          rowGroups.set(key, [...(rowGroups.get(key) ?? []), row]);
        }
        const markGroups = new Map<string, Mark[]>();
        for (const mark of marks) {
          if (mark.annotation.kind !== "highlight") continue;
          const key = collapsed(mark.quote);
          markGroups.set(key, [...(markGroups.get(key) ?? []), mark]);
        }
        pairGroups(rowGroups, markGroups, (row) => row.page_from ?? 0, pageOf);

        for (const { mark, row } of pairs) {
          const { annotation, cited, there, quote } = mark;
          const passageId = there && cited ? cited.passageId : null;
          const pageFrom = there && cited?.pageFrom != null ? cited.pageFrom : annotation.page;
          const pageTo = there && cited?.pageTo != null ? cited.pageTo : pageFrom;
          const location =
            there && cited?.location
              ? cited.location
              : { kind: "page" as const, from: annotation.page, to: annotation.page };
          const note = row.note === row.file_note ? annotation.note : row.note;
          const colour = row.colour === row.file_colour ? annotation.colour : row.colour;
          const check = annotation.kind === "note" ? "cant-check" : there ? "found" : "not-found";
          const checkReason =
            annotation.kind === "note"
              ? "no-text"
              : there
                ? (cited?.checkReason ?? null)
                : "quote-not-on-pages";
          const missing = annotation.kind === "highlight" && !there;
          const locationText = JSON.stringify(location);
          const unchanged =
            row.content_hash === contentHash &&
            row.passage_id === passageId &&
            row.quote === quote &&
            row.note === note &&
            row.file_note === annotation.note &&
            row.colour === colour &&
            row.file_colour === annotation.colour &&
            row.page_from === pageFrom &&
            row.page_to === pageTo &&
            row.location === locationText &&
            row.check_state === check &&
            row.check_reason === checkReason &&
            row.missing === (missing ? 1 : 0) &&
            row.author === annotation.author;
          if (unchanged) continue;
          db.run(
            `UPDATE document_annotations
               SET content_hash = ?, passage_id = ?, quote = ?, note = ?, file_note = ?,
                 colour = ?, file_colour = ?, page_from = ?, page_to = ?, location = ?,
                 check_state = ?, check_reason = ?, missing = ?, author = ?, updated_at = ?
             WHERE id = ?`,
            [
              contentHash,
              passageId,
              quote,
              note,
              annotation.note,
              colour,
              annotation.colour,
              pageFrom,
              pageTo,
              locationText,
              check,
              checkReason,
              missing ? 1 : 0,
              annotation.author,
              at,
              row.id,
            ],
          );
          if (row.deleted_at === null && (quote !== row.quote || note !== row.note)) {
            reindex(row.id, quote, note);
          }
        }

        for (const mark of marks) {
          if (matched.has(mark)) continue;
          const { annotation, cited, there, quote } = mark;
          insert(
            {
              id: randomUUID(),
              documentId,
              documentName: "",
              contentHash,
              passageId: there && cited ? cited.passageId : null,
              source: "file",
              colour: annotation.colour,
              quote,
              note: annotation.note,
              pageFrom: there && cited?.pageFrom != null ? cited.pageFrom : annotation.page,
              pageTo: there && cited?.pageTo != null ? cited.pageTo : annotation.page,
              location:
                there && cited?.location
                  ? cited.location
                  : { kind: "page", from: annotation.page, to: annotation.page },
              check: annotation.kind === "note" ? "cant-check" : there ? "found" : "not-found",
              checkReason:
                annotation.kind === "note"
                  ? "no-text"
                  : there
                    ? (cited?.checkReason ?? null)
                    : "quote-not-on-pages",
              anchor: null,
              author: annotation.author,
              missing: annotation.kind === "highlight" && !there,
              createdAt: at,
              updatedAt: at,
            },
            at,
            annotation.note,
            annotation.colour,
          );
        }

        for (const row of existing) {
          if (taken.has(row.id) || row.deleted_at !== null) continue;
          const current =
            row.content_hash === contentHash &&
            row.passage_id === null &&
            row.check_state === "not-found" &&
            row.check_reason === "quote-not-on-pages" &&
            row.missing === 1;
          if (current) continue;
          db.run(
            `UPDATE document_annotations
               SET content_hash = ?, passage_id = NULL, check_state = 'not-found',
                 check_reason = 'quote-not-on-pages', missing = 1, updated_at = ?
             WHERE id = ?`,
            [contentHash, at, row.id],
          );
        }
      });
    },
  };
}

export type Annotations = ReturnType<typeof createAnnotations>;
