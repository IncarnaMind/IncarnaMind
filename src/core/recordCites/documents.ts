import type { LiveDocument } from "../../shared/citations";
import type { UnitText } from "../../shared/units";
import type { EvidenceScope } from "../documents/evidence";
import type { RecordCiteDocument } from "./resolver";

export interface RecordCiteSource {
  names?(): readonly LiveDocument[];
  pageTexts(
    documentId: string,
    contentHash: string,
    from: number | null,
    to: number | null,
  ): readonly UnitText[];
  batesHolders?(prefix: string, identifier: string): ReadonlySet<string>;
}

export interface RecordCiteLibrary {
  documents: RecordCiteDocument[];
  batesHolders?(prefix: string, identifier: string): ReadonlySet<string>;
}

/**
 * The Documents a check may read record cites in, by name: a Document's pages are read only
 * once a cite names it, and only once for each check (#1709).
 */
export function recordCiteLibrary(
  source: RecordCiteSource,
  scope: EvidenceScope,
): RecordCiteLibrary {
  const allowed = scope.documentIds === null ? null : new Set(scope.documentIds);
  const documents = (source.names?.() ?? [])
    .filter(
      (document) =>
        (allowed === null || allowed.has(document.id)) && !scope.excluded.has(document.id),
    )
    .map((document): RecordCiteDocument => {
      let units: readonly UnitText[] | undefined;
      return {
        id: document.id,
        name: document.name ?? document.title ?? "",
        contentHash: document.contentHash,
        get units() {
          units ??= source.pageTexts(document.id, document.contentHash, null, null);
          return units;
        },
      };
    });
  const lookup = source.batesHolders;
  if (!lookup) return { documents };
  const holders = new Map<string, ReadonlySet<string>>();
  return {
    documents,
    batesHolders(prefix, identifier) {
      const key = `${prefix}\u0000${identifier}`;
      const known = holders.get(key) ?? lookup(prefix, identifier);
      holders.set(key, known);
      return known;
    },
  };
}
