import { Fragment, type ReactNode, type RefObject } from "react";
import type { CitationCheck } from "../../../core/api";
import type { ChartInk } from "../../../shared/chartLayout";
import { type ChartSources, MAX_CHART_VALUES } from "../../../shared/charts";
import { citationSource, withShownName } from "../../../shared/citations";
import { useT } from "../i18n";
import { useAppStore } from "../store";
import { ChartCheck } from "./ChartCheck";
import { calculatedFrom } from "./chartCalculated";

export function ChartFoot({
  legend,
  sources,
  check,
  notFound,
  rows,
  cutFrom,
  onUpdate,
  onFindUncited,
  findRef,
}: {
  legend: { ink: ChartInk; name: string }[];
  sources: ChartSources;
  /** The worst of the values' checks; null when none is cited. */
  check: CitationCheck | null;
  notFound: number;
  rows: number;
  cutFrom: number | null;
  /** Null when its table hasn't changed, or can't be charted now. */
  onUpdate: (() => void) | null;
  /** Puts the next value with no Citation in focus, with its card (#503). */
  onFindUncited(): void;
  findRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  const cited = sources.values - sources.uncited - sources.calculated;
  const documents = useAppStore((state) =>
    state.status.kind === "ready" ? state.documents : null,
  );
  const place = sources.places[0]?.citation;
  const source = place ? citationSource(withShownName(place, documents), t) : null;
  const document = source?.name ?? "";
  const plural = (count: number) => (count === 1 ? "one" : "other");

  let said: string | null = null;
  if (sources.values > 0 && cited === 0 && sources.calculated === 0) {
    said = t(`chart.source.none.${plural(sources.values)}`, { count: sources.values });
  } else if (cited > 0 && sources.places.length === 1 && source?.where) {
    said = t(`chart.source.place.${plural(cited)}`, {
      count: cited,
      document,
      location: source.where,
    });
  } else if (cited > 0 && sources.documents === 1) {
    said = t(`chart.source.document.${plural(cited)}`, { count: cited, document });
  } else if (cited > 0) {
    said = t("chart.source.documents", { count: cited, documents: sources.documents });
  }
  // Calculated values are counted apart from quoted ones, never as "each quoted" (#2307).
  const calculated =
    sources.calculated > 0
      ? calculatedFrom(sources.inputs, documents, t, sources.calculated)
      : null;
  if (calculated) said = said ? `${said} · ${calculated}` : calculated;
  const more: ReactNode[] = [
    cited + sources.calculated > 0 && sources.uncited > 0 ? (
      // A way to find them, not a warning: quiet, as the rest of the line.
      <button
        key="uncited"
        ref={findRef}
        type="button"
        data-chart-ui=""
        data-testid="chart-find-uncited"
        className="chart-find"
        onClick={onFindUncited}
      >
        {t("chart.source.uncited", { count: sources.uncited })}
      </button>
    ) : null,
    notFound > 0 ? t(`chart.source.notFound.${plural(notFound)}`, { count: notFound }) : null,
    sources.notDrawn > 0
      ? t(`chart.source.notDrawn.${plural(sources.notDrawn)}`, { count: sources.notDrawn })
      : null,
    sources.noUnit > 0
      ? t(`chart.source.noUnit.${plural(sources.noUnit)}`, { count: sources.noUnit })
      : null,
  ].filter((part) => part !== null);
  const line = (parts: ReactNode[]) =>
    parts.map((part, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line, in a fixed order.
      <Fragment key={index}>
        {index > 0 && " · "}
        {part}
      </Fragment>
    ));

  return (
    <div className="chart-foot" data-testid="chart-foot">
      {legend.length > 1 && (
        <span className="chart-legend" data-testid="chart-legend">
          {legend.map((item) => (
            <span key={`${item.ink}-${item.name}`} className="chart-legend-item">
              <i className={`chart-swatch chart-fill-${item.ink}`} aria-hidden="true" />
              {item.name}
            </span>
          ))}
        </span>
      )}
      {said && (
        <span className="chart-source" data-testid="chart-source">
          {check && <ChartCheck check={check} label={said} size="md" />}
          <span>{line([said, ...more])}</span>
        </span>
      )}
      {!said && more.length > 0 && <span className="chart-source">{line(more)}</span>}
      {cutFrom !== null && (
        <span className="chart-source" data-testid="chart-cut">
          {t("chart.cut", { rows, total: cutFrom, max: MAX_CHART_VALUES })}
        </span>
      )}
      {onUpdate && (
        <span className="chart-source" data-testid="chart-changed">
          {t("chart.tableChanged")} ·{" "}
          <button
            type="button"
            data-chart-ui=""
            data-testid="chart-update"
            className="chart-link"
            onClick={onUpdate}
          >
            {t("chart.update")}
          </button>
        </span>
      )}
    </div>
  );
}
