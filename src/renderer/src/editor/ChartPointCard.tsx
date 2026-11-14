import type { ReactNode, Ref } from "react";
import type { CitationAttributes } from "../../../core/api";
import { badgeMessage, type CitationState, citationSource } from "../../../shared/citations";
import { useLanguage, useT } from "../i18n";
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
  citations,
  figure,
  onOpen,
  ref,
}: {
  ref?: Ref<HTMLDivElement>;
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
  /** Every Citation the value rests on, in its order; Open goes to the worst checked: an Analysis over two Documents (#2378). */
  citations?: readonly { citation: CitationAttributes; state: CitationState }[];
  /** A calculated value's figure card, in place of its value and Citation (#2307). */
  figure: ReactNode | null;
  onOpen(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const rows =
    citations && citations.length > 0 ? citations : citation && state ? [{ citation, state }] : [];
  const canOpen = rows.some(({ state }) => state.documentId !== null);
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
      <div ref={ref} className="chart-card chart-card--calculated" data-testid="chart-card-body">
        {heading}
        {notes}
        {figure}
        {cut && <p className="chart-card-cut">{cut}</p>}
      </div>
    );
  }
  return (
    <div ref={ref} className="chart-card" data-testid="chart-card-body">
      {heading}
      <p className="chart-card-value" data-testid="chart-card-value">
        {value}
      </p>
      {notes}
      {rows.length > 0 ? (
        <>
          {rows.map((row) => {
            const source = citationSource(row.citation, t, language);
            const badge = badgeMessage(row.state, row.citation, t);
            return (
              <div
                className="chart-card-source"
                data-testid="chart-card-source"
                key={JSON.stringify([
                  row.citation.documentId,
                  row.citation.passageId,
                  row.citation.location,
                ])}
              >
                <ChartCheck check={row.state.check} label={t(badge.key, badge.params)} />
                <span className="chart-card-where" title={source.text}>
                  {source.where
                    ? t("chart.point.where", { document: source.name, location: source.where })
                    : source.name}
                </span>
              </div>
            );
          })}
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
        <div className="chart-card-source" data-testid="chart-card-source">
          <ChartCheck check={null} label={t("chart.point.noCitation")} />
          <span className="chart-card-where">{t("chart.point.noCitation")}</span>
        </div>
      )}
      {rows.map((row) => (
        <ChangedSourceNotice
          attributes={row.citation}
          key={JSON.stringify([
            row.citation.documentId,
            row.citation.passageId,
            row.citation.location,
          ])}
        />
      ))}
      {cut && <p className="chart-card-cut">{cut}</p>}
    </div>
  );
}
