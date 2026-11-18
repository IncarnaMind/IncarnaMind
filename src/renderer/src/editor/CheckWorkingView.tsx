import type { CheckWorking } from "../../../core/api";
import { useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import "./calculatedFigure.css";

/** How a check worked a sentence's figure out again over a data file's rows: the rows it read and its code, folded. */
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
      <pre>
        <code>{working.code}</code>
      </pre>
    </details>
  );
}
