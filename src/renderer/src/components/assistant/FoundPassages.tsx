import type { PassageSearchResult } from "../../../../core/api";
import { useT } from "../../i18n";

/**
 * The passages a search on this computer found for a Question no model has answered (#763):
 * the Documents' own words and where each is from, never read or checked by a model.
 */
export function FoundPassages({
  passages,
  emptyNote = false,
}: {
  passages: readonly PassageSearchResult[];
  /** Say that nothing matched, where the line around it promised what the Documents say. */
  emptyNote?: boolean;
}) {
  const t = useT();
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
          {passages.map((passage) => (
            <li key={passage.passageId} data-testid="found-passage" className="min-w-0">
              <span
                data-testid="found-passage-document"
                className="block truncate text-[11px] leading-4 text-ink-meta"
              >
                {passage.documentName}
              </span>
              <span
                data-testid="found-passage-text"
                className="line-clamp-2 text-[12px] leading-[18px] text-ink-secondary"
              >
                {passage.text.replace(/\s+/g, " ").trim()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
