import type { CheckWorking } from "../../../core/api";
import { listsRow } from "../../../shared/libraryFacts";
import { useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import "./calculatedFigure.css";

/**
 * How a check worked a sentence out in code, folded: the rows of a data file it read, or the
 * Library's own lists it counted (#2525), and its code.
 */
export function CheckWorkingView({ working }: { working: CheckWorking }) {
  const t = useT();
  const language = useLanguage();
  return (
    <details className="calculated-figure-code" data-testid="claim-working">
      <summary>{t("claim.working.show")}</summary>
      {working.rows.map(({ citation, range, count }) => (
        <p key={`${citation.documentId}:${range}`}>
          {t(count === 1 ? "claim.working.rows.one" : "claim.working.rows.other", {
            name: citation.documentName,
            count: formatCount(count, language),
            range,
          })}
        </p>
      ))}
      {working.library && (
        <p>{t("claim.working.library", { lists: listsRow(working.library, t, language) })}</p>
      )}
      <pre>
        <code>{working.code}</code>
      </pre>
    </details>
  );
}
