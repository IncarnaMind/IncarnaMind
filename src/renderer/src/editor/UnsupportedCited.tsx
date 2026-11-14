import type { ReactNode } from "react";
import type { UnsupportedReason } from "../../../core/api";
import { MetaLine } from "../components/MetaLine";
import { LineAction } from "../components/ProblemLine";
import { useT } from "../i18n";
import { openCited, quoteSaysSo } from "../openCited";
import type { NumberedCitation } from "./citationNumbers";
import { useCitedOrigin } from "./mindContext";
import { MoreQuotes } from "./QuoteLink";

/**
 * What a cited sentence's Unsupported card says in place of where the check
 * looked: what its Citations support and what they don't, or
 * the reason the check gave, or that it gave none; then the first Citation's quote,
 * which opens at its place, and a count that opens the others (#2869).
 */
export function UnsupportedCited({
  cited,
  why,
  allCited,
  onMore,
  onCheckAgain,
  onOpen,
}: {
  cited: readonly NumberedCitation[];
  why: UnsupportedReason | null;
  /** Every Citation's quote shows, not only the first. */
  allCited: boolean;
  onMore(): void;
  onCheckAgain(): void;
  onOpen(): void;
}) {
  const t = useT();
  const shown = allCited ? cited : cited.slice(0, 1);
  return (
    <>
      {why?.covered && why.uncovered ? (
        <p data-testid="claim-covers" className="claim-card-says">
          {t(
            cited.length === 1 ? "claim.unsupported.covers.one" : "claim.unsupported.covers.other",
            {
              covered: why.covered,
              uncovered: why.uncovered,
            },
          )}
        </p>
      ) : why?.reason ? (
        <p data-testid="claim-why" className="claim-card-says">
          {why.reason}
        </p>
      ) : (
        <div className="citation-card-note">
          <MetaLine
            data-testid="claim-no-reason"
            parts={[
              t("claim.unsupported.noReason"),
              <LineAction
                key="again"
                action={{
                  label: t("claim.checkAgain"),
                  testId: "claim-no-reason-check",
                  onClick: onCheckAgain,
                }}
              />,
            ]}
          />
        </div>
      )}
      {shown.map((citation) => (
        <OpenCitation key={citation.key} citation={citation} onOpen={onOpen}>
          {citation.attributes.quote && (
            <span data-testid="claim-cited-quote" className="line-clamp-2 min-w-0">
              “{citation.attributes.quote}”
            </span>
          )}
          <CitationChip citation={citation} testId="claim-cited-chip" />
        </OpenCitation>
      ))}
      {cited.length > 1 && (
        <p className="claim-quote-where">
          <MoreQuotes
            more={{ count: cited.length - 1, open: allCited, onToggle: onMore }}
            testId="claim-cited-more"
          />
        </p>
      )}
    </>
  );
}

export function CitationChip({
  citation: { number, attributes },
  testId,
}: {
  citation: NumberedCitation;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      data-check={attributes.check}
      className="citation-marker claim-card-cited-chip"
    >
      {number}
    </span>
  );
}

export function OpenCitation({
  citation: { number, attributes },
  label,
  onOpen,
  children,
}: {
  citation: NumberedCitation;
  label?: string;
  onOpen(): void;
  children: ReactNode;
}) {
  const origin = useCitedOrigin();
  const t = useT();
  const { documentId, quote } = attributes;
  return documentId ? (
    <button
      type="button"
      data-testid="claim-cited"
      className="claim-card-cited"
      title={quote ?? undefined}
      aria-label={label ?? t("claim.openCitation", { number })}
      onClick={() => {
        void openCited(
          { ...attributes, documentId },
          { origin, check: attributes.check, withQuote: quoteSaysSo(attributes.check), number },
        );
        onOpen();
      }}
    >
      {children}
    </button>
  ) : (
    <div data-testid="claim-cited" className="claim-card-cited">
      {children}
    </div>
  );
}
