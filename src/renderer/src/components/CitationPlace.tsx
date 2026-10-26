import { useId } from "react";
import { CITATION_PLACES, type CitationPlace } from "../../../core/api";
import { type CitedCount, citedCountText } from "../../../shared/exportOptions";
import { answerCitationPlace } from "../exports";
import { useT } from "../i18n";
import { buttonStyle, hintClass, segmentClass, segmentedClass } from "./ui";

const PLACE_LABELS = {
  footnotes: "export.citationPlace.footnotes",
  list: "export.citationPlace.list",
} as const;

const choiceButtonClass = buttonStyle("secondary", "sm");

/** The Citations' place in the Saved line's Change, as one click each: the file is written again as picked (#1945). */
export function CitationPlaceLine({
  mindId,
  format,
  count,
}: {
  mindId: string;
  format: "docx" | "pdf";
  count: CitedCount;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      <p
        id={`${id}-question`}
        data-testid="export-place-question"
        title={t("export.citationPlace.hint")}
        className="min-w-0 text-[14px] leading-5 text-ink-secondary"
      >
        {t("export.citationPlace")}{" "}
        {count.citations > 0 && (
          <span data-testid="export-place-count" className="text-ink-meta">
            {citedCountText(t, count)}
          </span>
        )}
      </p>
      <span className="flex shrink-0 gap-2">
        {CITATION_PLACES.map((each) => (
          <button
            key={each}
            type="button"
            data-testid={`export-place-ask-${each}`}
            aria-describedby={`${id}-question`}
            onClick={() => void answerCitationPlace(mindId, format, each)}
            className={choiceButtonClass}
          >
            {t(PLACE_LABELS[each])}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * The same choice in Export options, showing where Citations go now: the saved choice, or
 * footnotes, which a first export writes until the User picks otherwise (#1945). In a citation
 * style that isn't Numbered the style decides, and the row only says so.
 */
export function CitationPlaceRow({
  value,
  byStyle,
  onChange,
}: {
  value: CitationPlace | undefined;
  byStyle: boolean;
  onChange(next: CitationPlace): void;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-col">
        <span id={`${id}-label`} className="text-ui text-ink">
          {t("export.citationPlace")}
        </span>
        {!byStyle && (
          <span id={`${id}-hint`} className={hintClass}>
            {t("export.citationPlace.hint")}
          </span>
        )}
      </div>
      {byStyle ? (
        <span
          data-testid="export-citation-place-style"
          className="text-[13px] leading-5 text-ink-meta"
        >
          {t("export.citationPlace.byStyle")}
        </span>
      ) : (
        <span
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          data-testid="export-citation-place"
          data-answer={value ?? "footnotes"}
          className={segmentedClass}
        >
          {CITATION_PLACES.map((each) => (
            <label key={each} className={segmentClass}>
              <input
                type="radio"
                name={`${id}-answer`}
                value={each}
                data-testid={`export-citation-place-${each}`}
                checked={(value ?? "footnotes") === each}
                onChange={() => onChange(each)}
                className="sr-only"
              />
              {t(PLACE_LABELS[each])}
            </label>
          ))}
        </span>
      )}
    </div>
  );
}
