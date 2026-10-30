import { type ReactNode, useContext } from "react";
import type { UnsupportedReason } from "../../../core/api";
import { MetaLine } from "../components/MetaLine";
import { LineAction } from "../components/ProblemLine";
import { useT } from "../i18n";
import { openCitedFollowing, quoteSaysSo } from "../openCited";
import type { NumberedCitation } from "./citationNumbers";
import { MindIdContext } from "./mindContext";

/**
 * What a cited sentence's Unsupported card says in place of where the check
 * looked: what its Citations support and what they don't, or
 * the reason the check gave, or that it gave none; then each Citation's quote,
 * which opens at its place.
 */
export function UnsupportedCited({
  cited,
  why,
  onCheckAgain,
  onOpen,
}: {
  cited: readonly NumberedCitation[];
  why: UnsupportedReason | null;
  onCheckAgain(): void;
  onOpen(): void;
}) {
  const t = useT();
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
      {cited.map((citation) => (
        <OpenCitation key={citation.key} citation={citation} onOpen={onOpen}>
          {citation.attributes.quote && (
            <span data-testid="claim-cited-quote" className="line-clamp-2 min-w-0">
              “{citation.attributes.quote}”
            </span>
          )}
          <CitationChip citation={citation} testId="claim-cited-chip" />
        </OpenCitation>
      ))}
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
  const t = useT();
  const mindId = useContext(MindIdContext);
  const { documentId, quote } = attributes;
  return documentId ? (
    <button
      type="button"
      data-testid="claim-cited"
      className="claim-card-cited"
      title={quote ?? undefined}
      aria-label={label ?? t("claim.openCitation", { number })}
      onClick={() => {
        void openCitedFollowing(
          { ...attributes, documentId },
          { check: attributes.check, withQuote: quoteSaysSo(attributes.check), number },
          mindId,
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
