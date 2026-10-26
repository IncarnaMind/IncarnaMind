import {
  CHART_KINDS,
  type ChartAttributes,
  type ChartKind,
  drawnSeries,
} from "../../../shared/charts";
import { CheckLineIcon } from "../components/lineIcons";
import {
  menuClass,
  menuItemClass,
  menuItemUnavailableClass,
  menuRuleClass,
  menuTitleClass,
} from "../components/ui";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { useT } from "../i18n";
import { ChevronDownSmallIcon } from "./icons";

/** The kinds, then the columns drawn, turned on and off in place (#436). */
export function ChartKindMenu({
  chart,
  seriesName,
  fits,
  onKind,
  onSwitch,
  switchWhy,
  onSeries,
}: {
  chart: ChartAttributes;
  seriesName(index: number): string;
  fits(kind: ChartKind): boolean;
  onKind(kind: ChartKind): void;
  onSwitch: (() => void) | null;
  switchWhy: string | null;
  onSeries(series: number): void;
}) {
  const t = useT();
  const menu = usePopoverMenu();
  const label = t("chart.kindMenu");
  const drawn = drawnSeries(chart);
  const chosen = chart.drawn ?? chart.data.series.map((_, index) => index);
  const choose = (run: () => void) => {
    menu.close();
    run();
  };
  const axisOf = (series: number) => {
    if (chart.kind !== "scatter") return "";
    const place = drawn.indexOf(series);
    return place === 0 ? t("chart.scatter.across") : place === 1 ? t("chart.scatter.up") : "";
  };
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="chart-kind"
        title={label}
        aria-label={`${label}: ${t(`chart.kind.${chart.kind}`)}`}
        className="chart-head-button"
      >
        <span>{t(`chart.kind.${chart.kind}`)}</span>
        <ChevronDownSmallIcon className="size-3" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={label}
        data-testid="chart-kind-menu"
        className={menuClass}
      >
        {menu.open && (
          <>
            {CHART_KINDS.map((kind) => {
              const why = fits(kind) ? null : t("chart.scatter.needsTwo");
              return (
                <button
                  key={kind}
                  type="button"
                  role="menuitemradio"
                  aria-checked={chart.kind === kind}
                  aria-disabled={why !== null || undefined}
                  title={why ?? undefined}
                  data-testid={`chart-kind-${kind}`}
                  onClick={() => {
                    if (why === null) choose(() => onKind(kind));
                  }}
                  className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
                >
                  <CheckLineIcon
                    className={`size-3.5 shrink-0 ${chart.kind === kind ? "text-ink" : "invisible"}`}
                  />
                  <span className="flex-1">{t(`chart.kind.${kind}`)}</span>
                </button>
              );
            })}
            {chart.data.series.length > 1 && (
              <>
                <div className={menuRuleClass} />
                <p className={menuTitleClass}>
                  {t(
                    chart.source.kind === "table" && chart.source.switched
                      ? "chart.rows"
                      : "chart.columns",
                  )}
                </p>
                {chart.data.series.map((_, series) => {
                  const on =
                    chart.kind === "pie" ? drawn.includes(series) : chosen.includes(series);
                  const axis = axisOf(series);
                  const content = (
                    <>
                      <CheckLineIcon
                        className={`size-3.5 shrink-0 ${on ? "text-ink" : "invisible"}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{seriesName(series)}</span>
                      {axis && <span className="pl-4 text-[13px] text-ink-meta">{axis}</span>}
                    </>
                  );
                  const props = {
                    type: "button" as const,
                    "data-testid": "chart-series",
                    onClick: () => choose(() => onSeries(series)),
                    className: `${menuItemClass} pl-2`,
                  };
                  return chart.kind === "pie" ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a column is its place in the table.
                    <button key={series} role="menuitemradio" aria-checked={on} {...props}>
                      {content}
                    </button>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a column is its place in the table.
                    <button key={series} role="menuitemcheckbox" aria-checked={on} {...props}>
                      {content}
                    </button>
                  );
                })}
              </>
            )}
            {(onSwitch || switchWhy) && (
              <>
                <div className={menuRuleClass} />
                <button
                  type="button"
                  role="menuitem"
                  data-testid="chart-switch"
                  aria-disabled={switchWhy !== null || undefined}
                  title={switchWhy ?? undefined}
                  onClick={() => {
                    if (onSwitch) choose(onSwitch);
                  }}
                  className={`${menuItemClass} ${switchWhy ? menuItemUnavailableClass : ""} pl-2`}
                >
                  <CheckLineIcon className="invisible size-3.5 shrink-0" />
                  <span className="flex-1">{t("chart.switch")}</span>
                </button>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
