import type { ReactNode } from "react";
import type { CitationAttributes } from "../../../core/api";
import { badgeMessage, type CitationState, citationSource } from "../../../shared/citations";
import { useT } from "../i18n";
import { ChangedSourceNotice } from "./ChangedSourceNotice";
import { ChartCheck } from "./ChartCheck";

export function ChartPointCard({
  title,
  position,
  value,
  detail,
  notDrawn,
  cut,
  citation,
  state,
  figure,
  onOpen,
}: {
  title: string;
  /** Which of the values with no Citation the foot found this is: "1 of 3"; null for one, or a value found otherwise. */
  position: string | null;
  value: string;
  detail: string | null;
  /** Why it isn't drawn: it holds no number, or no unit where its column has one; null: it is. */
  notDrawn: "number" | "unit" | null;
  cut: string | null;
  citation: CitationAttributes | null;
  state: CitationState | null;
  /** A calculated value's figure card, in place of its value and Citation (#2307). */
  figure: ReactNode | null;
  onOpen(): void;
}) {
  const t = useT();
  const source = citation ? citationSource(citation, t) : null;
  const badge = citation && state ? badgeMessage(state, citation, t) : null;
  const canOpen = state !== null && state.documentId !== null;
  const heading = (
    <p className="chart-card-title">
      <span>{title}</span>
      {position && (
        <span className="chart-card-position" data-testid="chart-card-position">
          {position}
        </span>
      )}
    </p>
  );
  const notes = (
    <>
      {detail && <p className="chart-card-detail">{detail}</p>}
      {notDrawn && (
        <p className="chart-card-detail">
          {t(notDrawn === "unit" ? "chart.point.noUnit" : "chart.point.notDrawn")}
        </p>
      )}
    </>
  );
  if (figure) {
    return (
      <div className="chart-card chart-card--calculated" data-testid="chart-card-body">
        {heading}
        {notes}
        {figure}
        {cut && <p className="chart-card-cut">{cut}</p>}
      </div>
    );
  }
  return (
    <div className="chart-card" data-testid="chart-card-body">
      {heading}
      <p className="chart-card-value" data-testid="chart-card-value">
        {value}
      </p>
      {notes}
      <div className="chart-card-source" data-testid="chart-card-source">
        {citation && state && badge ? (
          <>
            <ChartCheck check={state.check} label={t(badge.key, badge.params)} />
            <span className="chart-card-where" title={source?.text}>
              {source?.where
                ? t("chart.point.where", { document: source.name, location: source.where })
                : source?.name}
            </span>
            {canOpen && (
              <button
                type="button"
                data-testid="chart-card-open"
                className="chart-card-open"
                onClick={onOpen}
              >
                {t("chart.point.open")}
              </button>
            )}
          </>
        ) : (
          <>
            <ChartCheck check={null} label={t("chart.point.noCitation")} />
            <span className="chart-card-where">{t("chart.point.noCitation")}</span>
          </>
        )}
      </div>
      {citation && <ChangedSourceNotice attributes={citation} />}
      {cut && <p className="chart-card-cut">{cut}</p>}
    </div>
  );
}
