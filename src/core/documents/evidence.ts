/**
 * What checks may use as evidence (#80). A check Run (check against
 * Documents, #96; verify, #97, #110) and a comparison table's cells
 * (#98) search the User's Documents as an Answer does, with the search Tool,
 * but leave out:
 * - IncarnaMind's own files (`Document.ownFile`): an export or a source pack
 *   would otherwise let a note support itself. Unless the User counts the
 *   Document ("Count it"), its Folder counts them, or Settings does.
 * - The User's own workings (`Document.notCited`): read to understand a
 *   Question, never evidence. Always, until the User cites them again.
 * - The document being checked, its earlier versions, and copies of either:
 *   any Document with one of its content fingerprints, at any path. Always.
 *
 * Transcripts and saved web pages are sources and count. Ordinary Answers
 * search as they always did: nothing here is in their way.
 *
 * Left out is never hidden: a search also says which of the Documents left
 * out matched, and where, so a result can name them, with Count it.
 */
import type {
  CheckedDocument,
  EvidenceExclusion,
  ExcludedEvidence,
  PassageSearchResult,
} from "../api";
import { InvalidInputError, isRecord } from "../errors";
import type { Database } from "../storage";
import type { WindowedPassage } from "./search";
import type { SearchToolOptions, SearchToolParameters } from "./searchTool";

/**
 * How much a search looks at the Documents left out, to say where they
 * matched: as many Documents as the evidence can come from, each at its best
 * Passage, so it costs the reranker little.
 */
const EXCLUDED_PARAMETERS: Partial<SearchToolParameters> = {
  candidates: 12,
  rerankPerList: 6,
  keywordRerankCandidates: 12,
  maxDocuments: 4,
  maxWindowsPerDocument: 1,
  maxPassages: 4,
};

interface PassageRow {
  passage_id: string;
  document_id: string;
  document_name: string;
  page_from: number | null;
  page_to: number | null;
  position: number;
  text: string;
}

/** What a check searches, resolved once when it starts: the same for each of its searches. */
export interface EvidenceScope {
  /** The Documents its searches look at: its Search scope without those left out. Null: every Document. */
  documentIds: string[] | null;
  /** The Documents in its Search scope that are left out, and why. */
  excluded: ReadonlyMap<string, EvidenceExclusion>;
}

/** What one of a check's searches found. */
export interface EvidenceSearch {
  /** The evidence, as the search Tool gives it to the model. */
  passages: WindowedPassage[];
  /** The Documents left out that matched too, the best first. */
  excluded: ExcludedEvidence[];
}

export interface EvidenceDependencies {
  db: Database;
  /** Settings leaves IncarnaMind's own files out (`UserSettings.leaveOutOwnFiles`). */
  leaveOutOwnFiles(): boolean;
  /** The search Tool, reranked as Answers are (see ./searchTool). */
  search(
    query: string,
    options: Pick<SearchToolOptions, "documentIds" | "parameters" | "signal">,
  ): Promise<WindowedPassage[]>;
}

export type Evidence = ReturnType<typeof createEvidence>;

/** A Passage as the core's interface gives it: without the search Tool's own fields. */
export const passageResult = (passage: WindowedPassage): PassageSearchResult => ({
  passageId: passage.passageId,
  documentId: passage.documentId,
  documentName: passage.documentName,
  pageFrom: passage.pageFrom,
  pageTo: passage.pageTo,
  position: passage.position,
  text: passage.text,
});

const inList = (column: string) => `${column} IN (SELECT value FROM json_each(?))`;

function parseList(value: unknown, what: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((each) => typeof each === "string" && each !== "")) {
    throw new InvalidInputError(`${what} must be a list of non-empty strings.`);
  }
  return [...new Set(value as string[])];
}

/** The document being checked, from input: none when it isn't given. */
export function parseCheckedDocument(input: unknown): CheckedDocument {
  if (input === undefined || input === null) return {};
  if (!isRecord(input))
    throw new InvalidInputError("The document being checked must be an object.");
  const documentIds = parseList(input.documentIds, "The checked Documents");
  const contentHashes = parseList(input.contentHashes, "The checked fingerprints");
  return {
    ...(documentIds && { documentIds }),
    ...(contentHashes && { contentHashes }),
  };
}

export function createEvidence(deps: EvidenceDependencies) {
  const { db } = deps;

  /**
   * Every fingerprint of the document being checked: those given, and each
   * version of its Documents that IncarnaMind has: the current one, the old
   * ones whose text or Passages are still kept, and those retained.
   */
  const fingerprintsOf = (checked: CheckedDocument): string[] => {
    const ids = JSON.stringify(checked.documentIds ?? []);
    const known = db.all<{ content_hash: string }>(
      `SELECT content_hash FROM documents WHERE ${inList("id")}
       UNION SELECT content_hash FROM document_pages
         WHERE ${inList("document_id")} AND content_hash IS NOT NULL
       UNION SELECT content_hash FROM passages
         WHERE ${inList("document_id")} AND content_hash IS NOT NULL
       UNION SELECT content_hash FROM retained_versions
         WHERE ${inList("document_id")} AND deleted_at IS NULL`,
      [ids, ids, ids, ids],
    );
    return [
      ...new Set([...(checked.contentHashes ?? []), ...known.map((row) => row.content_hash)]),
    ];
  };

  return {
    /**
     * The scope of a check: its Search scope (the Documents it resolves to,
     * or null for every Document) without the Documents left out of its
     * evidence, for the document being checked, if any.
     */
    scope(documentIds: readonly string[] | null, checked: CheckedDocument = {}): EvidenceScope {
      const excluded = new Map<string, EvidenceExclusion>();
      const scoped = documentIds === null ? "" : `AND ${inList("d.id")}`;
      const scopeParams = documentIds === null ? [] : [JSON.stringify(documentIds)];

      if (deps.leaveOutOwnFiles()) {
        const own = db.all<{ id: string }>(
          `SELECT d.id FROM documents d
           WHERE d.deleted_at IS NULL AND d.own_file IS NOT NULL AND d.counted_as_evidence = 0
             AND NOT EXISTS (
               SELECT 1 FROM document_groups a JOIN library_groups g ON g.id = a.group_id
               WHERE a.document_id = d.id AND a.deleted_at IS NULL AND g.deleted_at IS NULL
                 AND g.counts_own_files = 1
             )
             ${scoped}`,
          scopeParams,
        );
        for (const row of own) excluded.set(row.id, "own-file");
      }

      const workings = db.all<{ id: string }>(
        `SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND d.not_cited = 1 ${scoped}`,
        scopeParams,
      );
      for (const row of workings) excluded.set(row.id, "own-workings");

      const fingerprints = fingerprintsOf(checked);
      const checkedIds = checked.documentIds ?? [];
      if (fingerprints.length > 0 || checkedIds.length > 0) {
        const copies = db.all<{ id: string }>(
          `SELECT d.id FROM documents d
           WHERE d.deleted_at IS NULL AND (${inList("d.content_hash")} OR ${inList("d.id")})
             ${scoped}`,
          [JSON.stringify(fingerprints), JSON.stringify(checkedIds), ...scopeParams],
        );
        // Never evidence for this check, counted or not: the reason that can't be undone wins.
        for (const row of copies) excluded.set(row.id, "checked-document");
      }

      if (excluded.size === 0) {
        return { documentIds: documentIds === null ? null : [...documentIds], excluded };
      }
      const every =
        documentIds ??
        db
          .all<{ id: string }>("SELECT id FROM documents WHERE deleted_at IS NULL")
          .map((row) => row.id);
      return { documentIds: every.filter((id) => !excluded.has(id)), excluded };
    },

    /**
     * One of a check's searches: the search Tool over its scope, then, if
     * any Documents are left out, a small search of those, for where they matched.
     */
    async search(
      query: string,
      scope: EvidenceScope,
      signal?: AbortSignal,
    ): Promise<EvidenceSearch> {
      const passages = await deps.search(query, {
        documentIds: scope.documentIds ?? undefined,
        signal,
      });
      if (scope.excluded.size === 0) return { passages, excluded: [] };
      const matched = await deps.search(query, {
        documentIds: [...scope.excluded.keys()],
        parameters: EXCLUDED_PARAMETERS,
        signal,
      });
      // The search Tool gives its Passages by Document, the best Document first.
      const byDocument = new Map<string, ExcludedEvidence>();
      const add = (passage: PassageSearchResult) => {
        const reason = scope.excluded.get(passage.documentId);
        if (!reason) return;
        const entry = byDocument.get(passage.documentId) ?? {
          documentId: passage.documentId,
          documentName: passage.documentName,
          reason,
          passages: [],
        };
        entry.passages.push(passage);
        byDocument.set(passage.documentId, entry);
      };
      for (const passage of matched) add(passageResult(passage));
      // Search shows the Passages of identical files once (see `distinctPassages`): each copy
      // left out is named too, where the one shown matched.
      for (const found of [...byDocument.values()]) {
        for (const copy of copiesOf(found, scope.excluded)) add(copy);
      }
      return { passages, excluded: [...byDocument.values()] };
    },
  };

  /** The same Passages in the other Documents left out that hold the same file as `found`. */
  function copiesOf(
    found: ExcludedEvidence,
    excluded: ReadonlyMap<string, EvidenceExclusion>,
  ): PassageSearchResult[] {
    const others = [...excluded.keys()].filter((id) => id !== found.documentId);
    if (others.length === 0) return [];
    return db
      .all<PassageRow>(
        `SELECT p.id AS passage_id, p.document_id, d.name AS document_name, p.page_from,
           p.page_to, p.position, p.text
         FROM passages p JOIN documents d ON d.id = p.document_id
         WHERE d.deleted_at IS NULL AND p.deleted_at IS NULL AND ${inList("d.id")}
           AND d.content_hash = (SELECT content_hash FROM documents WHERE id = ?)
           AND p.content_hash = d.content_hash AND ${inList("p.position")}
         ORDER BY d.created_at, d.rowid, p.position`,
        [
          JSON.stringify(others),
          found.documentId,
          JSON.stringify(found.passages.map((passage) => passage.position)),
        ],
      )
      .map((row) => ({
        passageId: row.passage_id,
        documentId: row.document_id,
        documentName: row.document_name,
        pageFrom: row.page_from,
        pageTo: row.page_to,
        position: row.position,
        text: row.text,
      }));
  }
}
