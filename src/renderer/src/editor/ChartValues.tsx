import { type KeyboardEvent, useRef, useState } from "react";
import type { CitationCheck } from "../../../core/api";
import {
  type ChartAttributes,
  type ChartValue,
  chosenSeries,
  listedRows,
  unitlessRows,
} from "../../../shared/charts";
import { useT } from "../i18n";
import { ChartCheck } from "./ChartCheck";
import { type PointEvents, type PointRef, pressOnPoint, samePoint } from "./ChartPlot";

/** "Show as table": the way to read every value and its source without a pointer, one Tab stop as the chart's points are. */
export function ChartValues({
  chart,
  seriesName,
  labelHeading,
  active,
  events,
  checkOf,
}: {
  chart: ChartAttributes;
  seriesName(index: number): string;
  labelHeading: string;
  active: PointRef | null;
  events: PointEvents;
  /** Null: it has no Citation. */
  checkOf(value: ChartValue): { check: CitationCheck | null; label: string };
}) {
  const t = useT();
  const drawn = chosenSeries(chart);
  const unitless = new Map(drawn.map((series) => [series, unitlessRows(chart.data, series)]));
  // A cut chart lists every row, those it doesn't draw too (#503).
  const rows = listedRows(chart.data);
  const cells: PointRef[] = [];
  rows.forEach((row, index) => {
    for (const series of drawn) if (row.values[series]) cells.push({ row: index, series });
  });
  const [current, setCurrent] = useState(0);
  const at = Math.min(current, Math.max(0, cells.length - 1));
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, point: PointRef) => {
    const index = cells.findIndex((cell) => samePoint(cell, point));
    let next: number | null = null;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = cells.length - 1;
    else if (event.key === "ArrowRight") next = Math.min(cells.length - 1, index + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      const found = cells.findIndex(
        (cell) => cell.series === point.series && cell.row === point.row + step,
      );
      next = found >= 0 ? found : index;
    } else if (pressOnPoint(event, point, events)) return;
    if (next === null) return;
    event.preventDefault();
    // At once, not after the next render: a second key pressed before it goes from here.
    const target = cells[next];
    if (target) buttons.current.get(`${target.row}:${target.series}`)?.focus();
    setCurrent(next);
  };

  return (
    <div className="chart-values" data-chart-ui="">
      <table data-testid="chart-table">
        <thead>
          <tr>
            <th scope="col">{labelHeading}</th>
            {drawn.map((series) => (
              <th key={series} scope="col">
                {seriesName(series)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place.
            <tr key={index}>
              <th scope="row">{row.label}</th>
              {drawn.map((series) => {
                const value = row.values[series];
                if (!value) return <td key={series} />;
                const point = { row: index, series };
                const key = `${index}:${series}`;
                const mark = checkOf(value);
                const position = cells.findIndex((cell) => samePoint(cell, point));
                const noUnit = unitless.get(series)?.has(index) ?? false;
                return (
                  <td key={series}>
                    <button
                      type="button"
                      ref={(element) => {
                        if (element) buttons.current.set(key, element);
                        else buttons.current.delete(key);
                      }}
                      className="chart-value"
                      data-testid="chart-value"
                      data-point={key}
                      data-active={samePoint(point, active) || undefined}
                      data-unitless={noUnit || undefined}
                      tabIndex={position === at ? 0 : -1}
                      aria-label={events.label(point)}
                      aria-haspopup="dialog"
                      aria-keyshortcuts={events.control(point) ? "Space" : undefined}
                      onPointerEnter={(event) =>
                        events.peek(point, event.currentTarget, "pointer", true)
                      }
                      onPointerLeave={(event) =>
                        events.peek(point, event.currentTarget, "pointer", false)
                      }
                      onFocus={(event) => {
                        setCurrent(position);
                        events.peek(point, event.currentTarget, "focus", true);
                      }}
                      onBlur={(event) => events.peek(point, event.currentTarget, "focus", false)}
                      onClick={(event) => events.activate(point, event.currentTarget)}
                      onKeyDown={(event) => onKeyDown(event, point)}
                    >
                      <span>{value.shown}</span>
                      <ChartCheck check={mark.check} label={mark.label} size="sm" />
                      {noUnit && (
                        <span className="chart-value-note" data-testid="chart-value-no-unit">
                          {t("chart.value.noUnit")}
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
