import type { PassageSearchResult } from "../../../../core/api";
import { citationLocation, formatLocation } from "../../../../shared/locations";
import { useT } from "../../i18n";
import { useIsExampleDocument } from "../../ownDocuments";
import { useAppStore } from "../../store";

/**
 * The passages a search on this computer found for a Question no model has answered (#763):
 * the Documents' own words and where each is from, never read or checked by a model. Each opens
 * at its Passage, as a Citation does.
 */
export function FoundPassages({
  passages,
  failed = false,
  emptyNote = false,
}: {
  passages: readonly PassageSearchResult[];
  /** The search couldn't run: saying nothing matched would be wrong. */
  failed?: boolean;
  /** Say that nothing matched, where the line around it promised what the Documents say. */
  emptyNote?: boolean;
}) {
  const t = useT();
  const openDocument = useAppStore((state) => state.openDocument);
  const isExample = useIsExampleDocument();
  if (failed) return null;
  if (passages.length === 0 && !emptyNote) return null;
  return (
    <div data-testid="found-passages" className="flex flex-col gap-1.5">
      <p className="m-0 text-[12px] leading-[18px] font-semibold text-ink-secondary">
        {t("answer.found")}
      </p>
      {passages.length === 0 ? (
        <p
          data-testid="found-passages-none"
          className="m-0 text-[12px] leading-[18px] text-ink-meta"
        >
          {t("answer.offline.none")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {passages.map((passage) => {
            const location = citationLocation({
              pageFrom: passage.pageFrom,
              pageTo: passage.pageTo,
            });
            const where = location === null ? null : formatLocation(location, t);
            return (
              <li key={passage.passageId} data-testid="found-passage" className="min-w-0">
                <button
                  type="button"
                  onClick={() =>
                    openDocument(
                      {
                        documentId: passage.documentId,
                        ...(passage.pageFrom !== null && { pageFrom: passage.pageFrom }),
                        ...(passage.pageTo !== null && { pageTo: passage.pageTo }),
                        quote: passage.text,
                      },
                      { as: "citation" },
                    )
                  }
                  className="block w-full min-w-0 text-left"
                >
                  <span
                    data-testid="found-passage-document"
                    className="block truncate text-[11px] leading-4 text-ink-meta"
                  >
                    {passage.documentName}
                    {where && <span data-testid="found-passage-where"> · {where}</span>}
                    {isExample(passage.documentId) && (
                      <span data-testid="found-passage-example"> · {t("examples.chip")}</span>
                    )}
                  </span>
                  <span
                    data-testid="found-passage-text"
                    className="line-clamp-2 text-[12px] leading-[18px] text-ink-secondary"
                  >
                    {passage.text.replace(/\s+/g, " ").trim()}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
