/**
 * A chart's layout at the width it is drawn at, so its labels stay 12 px
 * (#436). The editor draws it as React elements and an export as an SVG
 * string (./chartSvg), so colours are roles (`ChartInk`), never values: the
 * editor maps them to the theme's tokens, an export to the light theme's.
 */
import {
  CATEGORY_COUNT,
  type ChartAttributes,
  type ChartKind,
  type ChartValue,
  chartPoints,
  drawnSeries,
} from "./charts";

export const CHART_FONT_SIZE = 12;

/**
 * A colour's role: a series in greys, the earlier light and the later in the
 * secondary ink (one series alone in the secondary ink), and categories (a
 * pie's slices, or three series or more) in the Tag hues teal, purple, orange
 * and yellow, then their darker inks, then grey. Never green, red or blue,
 * which mean found, contradicted and "you can act here".
 */
export type ChartInk = "prior" | "now" | `category${number}`;

export type ChartMark =
  | { shape: "bar"; x: number; y: number; width: number; height: number }
  | { shape: "dot"; cx: number; cy: number; r: number }
  | { shape: "slice"; path: string; cx: number; cy: number };

export interface LaidOutPoint {
  row: number;
  series: number;
  value: ChartValue & { value: number };
  ink: ChartInk;
  mark: ChartMark;
  share: number | null;
}

export interface ChartText {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
  role: "axis" | "label";
}

export interface ChartLine {
  series: number;
  ink: ChartInk;
  /** A missing value breaks the line into runs. */
  runs: [number, number][][];
}

export interface ChartLegendItem {
  /** A series (bar and line) or a row (pie). */
  index: number;
  ink: ChartInk;
  name: string;
}

export interface ChartLayout {
  kind: ChartKind;
  width: number;
  height: number;
  grid: { y: number; base: boolean; x1: number; x2: number }[];
  texts: ChartText[];
  lines: ChartLine[];
  points: LaidOutPoint[];
  legend: ChartLegendItem[];
  /** Drawn inside the picture: a pie's key always, others' only for an export (the editor lists it under the chart). */
  legendMarks: { x: number; y: number; ink: ChartInk; text: ChartText }[];
}

export interface LayoutOptions {
  width: number;
  language: string;
  seriesName(index: number): string;
  measure?: (text: string) => number;
  legendInside?: boolean;
  /** Draw only these series, by their place in the data: one chart of a stack (#1392). */
  series?: readonly number[];
  /** At least this left margin, so charts stacked on one x axis line up. */
  left?: number;
}

/** Wide characters (Chinese, Japanese, Korean, full-width forms) take a whole em; others about 0.6. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/** For the core, which has no font to measure with. */
export function estimateWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? CHART_FONT_SIZE : CHART_FONT_SIZE * 0.6;
  return width;
}

export function fitText(text: string, width: number, measure: (text: string) => number): string {
  if (measure(text) <= width) return text;
  const chars = [...text];
  while (chars.length > 0 && measure(`${chars.join("")}…`) > width) chars.pop();
  return chars.length > 0 ? `${chars.join("")}…` : "";
}

export function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const power = 10 ** Math.floor(Math.log10(x));
  const m = x / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * power;
}

function niceDomain(
  values: readonly number[],
  ticks: number,
  zero: boolean,
): [number, number, number] {
  let low = Math.min(...values, ...(zero ? [0] : []));
  let high = Math.max(...values, ...(zero ? [0] : []));
  if (low === high) {
    // One value, or all the same: room above and below it.
    const pad = low === 0 ? 1 : Math.abs(low) / 2;
    if (!zero || low < 0) low -= pad;
    if (!zero || high > 0) high += pad;
  }
  const step = niceStep((high - low) / ticks);
  return [Math.floor(low / step + 1e-9) * step, Math.ceil(high / step - 1e-9) * step, step];
}

function ticksOf(low: number, high: number, step: number): number[] {
  const ticks: number[] = [];
  for (let at = 0; low + at * step <= high + step * 1e-6; at++) {
    // Rounded to the step's decimals, so 0.1 + 0.2 reads 0.3.
    ticks.push(Number((low + at * step).toPrecision(12)));
  }
  return ticks;
}

/**
 * A number on an axis: a percent as a percent when every value is one, a
 * large number in short form (1.5B, 1.5亿), others with as many decimals as
 * the step needs.
 */
export function tickFormat(
  language: string,
  step: number,
  largest: number,
  percent: boolean,
): (value: number) => string {
  const decimals = (unit: number) => Math.min(6, Math.max(0, -Math.floor(Math.log10(unit) + 1e-9)));
  let format: Intl.NumberFormat;
  const make = (options: Intl.NumberFormatOptions) => {
    try {
      return new Intl.NumberFormat(language, options);
    } catch {
      return new Intl.NumberFormat("en", options);
    }
  };
  if (percent) {
    format = make({ style: "percent", maximumFractionDigits: decimals(step * 100) });
  } else if (Math.abs(largest) >= 10_000) {
    format = make({ notation: "compact", maximumFractionDigits: 2 });
  } else {
    const places = decimals(step);
    format = make({ minimumFractionDigits: places, maximumFractionDigits: places });
  }
  return (value) => format.format(Object.is(value, -0) ? 0 : value);
}

const isPercent = (value: ChartValue) => value.unit?.kind === "percent";

function seriesInks(count: number): ChartInk[] {
  if (count === 1) return ["now"];
  if (count === 2) return ["prior", "now"];
  return Array.from({ length: count }, (_, index) => `category${index % CATEGORY_COUNT}` as const);
}

/** A pie's key is drawn beside it, and a scatter chart's one series needs none. */
export function chartLegend(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
  seriesName: (index: number) => string,
): ChartLegendItem[] {
  if (chart.kind !== "bar" && chart.kind !== "line") return [];
  const drawn = drawnSeries(chart);
  const inks = seriesInks(drawn.length);
  return drawn.map((series, place) => ({
    index: series,
    ink: inks[place] ?? "now",
    name: seriesName(series),
  }));
}

const PLOT_TOP = 10;
const PLOT_RIGHT = 10;
const AXIS_BOTTOM = 28;
const CHART_HEIGHT = 240;
const LEGEND_ROW = 22;

export function layoutChart(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
  options: LayoutOptions,
): ChartLayout {
  const measure = options.measure ?? estimateWidth;
  const width = Math.max(160, Math.round(options.width));
  if (chart.kind === "pie") return layoutPie(chart, { ...options, width, measure });
  const layout =
    chart.kind === "scatter"
      ? layoutScatter(chart, { ...options, width, measure })
      : layoutBarsOrLines(chart, { ...options, width, measure });
  if (options.legendInside && layout.legend.length > 1) addLegendRow(layout, measure);
  return layout;
}

type Measured = LayoutOptions & { measure: (text: string) => number };

function emptyLayout(kind: ChartKind, width: number, height = CHART_HEIGHT): ChartLayout {
  return {
    kind,
    width,
    height,
    grid: [],
    texts: [],
    lines: [],
    points: [],
    legend: [],
    legendMarks: [],
  };
}

function layoutBarsOrLines(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
  options: Measured,
): ChartLayout {
  const { width, measure } = options;
  const layout = emptyLayout(chart.kind, width);
  const drawn = drawnSeries(chart);
  const shown = options.series ?? drawn;
  const inks = seriesInks(drawn.length);
  const points = chartPoints(chart).filter((point) => shown.includes(point.series));
  layout.legend = chartLegend(chart, options.seriesName);
  const { rows } = chart.data;
  if (rows.length === 0) return layout;

  const values = points.map((point) => point.value.value);
  const [low, high, step] = niceDomain(values.length > 0 ? values : [0, 1], 5, true);
  const format = tickFormat(
    options.language,
    step,
    Math.max(Math.abs(low), Math.abs(high)),
    points.length > 0 && points.every((point) => isPercent(point.value)),
  );
  const ticks = ticksOf(low, high, step);
  const tickLabels = ticks.map(format);
  const left = Math.max(Math.ceil(Math.max(...tickLabels.map(measure)) + 16), options.left ?? 0);
  const right = width - PLOT_RIGHT;
  const bottom = CHART_HEIGHT - AXIS_BOTTOM;
  const y = (value: number) => PLOT_TOP + ((high - value) / (high - low)) * (bottom - PLOT_TOP);
  ticks.forEach((tick, index) => {
    layout.grid.push({ y: y(tick), base: tick === 0, x1: left, x2: right });
    layout.texts.push({
      x: left - 8,
      y: y(tick) + 4,
      text: tickLabels[index] ?? "",
      anchor: "end",
      role: "axis",
    });
  });

  // Labels that would touch are thinned to every k-th.
  const slot = (right - left) / rows.length;
  const centre = (row: number) => left + slot * (row + 0.5);
  const widest = Math.max(...rows.map((row) => measure(row.label)));
  const every = Math.max(1, Math.ceil((Math.min(widest, 120) + 8) / slot));
  rows.forEach((row, index) => {
    if (index % every !== 0) return;
    layout.texts.push({
      x: centre(index),
      y: CHART_HEIGHT - 8,
      text: fitText(row.label, slot * every - 8, measure),
      anchor: "middle",
      role: "axis",
    });
  });

  const placeOf = new Map(drawn.map((series, place) => [series, place]));
  if (chart.kind === "line") {
    const r = rows.length > 40 ? 3 : 4.5;
    for (const series of shown) {
      const runs: [number, number][][] = [];
      let run: [number, number][] = [];
      rows.forEach((row, index) => {
        const value = row.values[series]?.value;
        if (value == null) {
          if (run.length > 0) runs.push(run);
          run = [];
          return;
        }
        run.push([centre(index), y(value)]);
      });
      if (run.length > 0) runs.push(run);
      layout.lines.push({ series, ink: inks[placeOf.get(series) ?? 0] ?? "now", runs });
    }
    layout.points = points.map((point) => ({
      ...point,
      ink: inks[placeOf.get(point.series) ?? 0] ?? "now",
      mark: { shape: "dot", cx: centre(point.row), cy: y(point.value.value), r },
      share: null,
    }));
    return layout;
  }

  const count = Math.max(1, shown.length);
  const gap = count > 1 ? Math.min(4, slot * 0.04) : 0;
  const bar = Math.max(1, Math.min(30, (slot * 0.7 - gap * (count - 1)) / count));
  const group = bar * count + gap * (count - 1);
  const zero = y(0);
  const barPlace = new Map(shown.map((series, place) => [series, place]));
  layout.points = points.map((point) => {
    const place = barPlace.get(point.series) ?? 0;
    const x = centre(point.row) - group / 2 + place * (bar + gap);
    const top = Math.min(y(point.value.value), zero);
    return {
      ...point,
      ink: inks[placeOf.get(point.series) ?? 0] ?? "now",
      mark: {
        shape: "bar",
        x,
        y: top,
        width: bar,
        height: Math.max(1, Math.abs(zero - y(point.value.value))),
      },
      share: null,
    };
  });
  return layout;
}

function layoutScatter(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
  options: Measured,
): ChartLayout {
  const { width, measure } = options;
  const layout = emptyLayout("scatter", width);
  const [across, up] = drawnSeries(chart);
  const points = chartPoints(chart);
  if (across === undefined || up === undefined || points.length === 0) return layout;
  const { rows } = chart.data;
  const xs = points.map((point) => rows[point.row]?.values[across]?.value ?? 0);
  const ys = points.map((point) => point.value.value);
  const [x0, x1, xStep] = niceDomain(xs, 4, false);
  const [y0, y1, yStep] = niceDomain(ys, 4, false);
  const percentAcross = points.every((point) => {
    const value = rows[point.row]?.values[across];
    return value ? isPercent(value) : false;
  });
  const percentUp = points.every((point) => isPercent(point.value));
  const formatX = tickFormat(
    options.language,
    xStep,
    Math.max(Math.abs(x0), Math.abs(x1)),
    percentAcross,
  );
  const formatY = tickFormat(
    options.language,
    yStep,
    Math.max(Math.abs(y0), Math.abs(y1)),
    percentUp,
  );
  const yTicks = ticksOf(y0, y1, yStep);
  const left = Math.ceil(Math.max(...yTicks.map(formatY).map(measure)) + 16);
  const right = width - PLOT_RIGHT - 8;
  const bottom = CHART_HEIGHT - AXIS_BOTTOM;
  const X = (value: number) => left + ((value - x0) / (x1 - x0)) * (right - left);
  const Y = (value: number) => PLOT_TOP + ((y1 - value) / (y1 - y0)) * (bottom - PLOT_TOP);
  for (const tick of yTicks) {
    layout.grid.push({ y: Y(tick), base: false, x1: left, x2: right });
    layout.texts.push({
      x: left - 8,
      y: Y(tick) + 4,
      text: formatY(tick),
      anchor: "end",
      role: "axis",
    });
  }
  for (const tick of ticksOf(x0, x1, xStep)) {
    layout.texts.push({
      x: X(tick),
      y: CHART_HEIGHT - 8,
      text: formatX(tick),
      anchor: "middle",
      role: "axis",
    });
  }
  const acrossName = options.seriesName(across);
  const upName = options.seriesName(up);
  layout.texts.push({
    x: right,
    y: bottom - 6,
    text: fitText(`${acrossName} →`, (right - left) / 2, measure),
    anchor: "end",
    role: "axis",
  });
  layout.texts.push({
    x: left + 6,
    y: PLOT_TOP + 12,
    text: fitText(`↑ ${upName}`, (right - left) / 2, measure),
    anchor: "start",
    role: "axis",
  });
  const labelled = points.length <= 30;
  layout.points = points.map((point, index) => {
    const cx = X(xs[index] ?? 0);
    const cy = Y(point.value.value);
    if (labelled) {
      layout.texts.push({
        x: cx + 9,
        y: cy + 4,
        text: fitText(rows[point.row]?.label ?? "", 96, measure),
        anchor: "start",
        role: "label",
      });
    }
    return { ...point, ink: "now", mark: { shape: "dot", cx, cy, r: 5 }, share: null };
  });
  return layout;
}

function layoutPie(
  chart: Pick<ChartAttributes, "kind" | "drawn" | "data">,
  options: Measured,
): ChartLayout {
  const { width, measure } = options;
  const points = chartPoints(chart);
  const small = width < 520;
  const radius = small ? 76 : 96;
  const cx = (small ? 8 : 16) + radius;
  const keyX = cx + radius + (small ? 20 : 48);
  const row = points.length > 6 ? 24 : 32;
  const keyTop = Math.max(20, 108 - (points.length * row) / 2);
  const height = Math.max(216, Math.ceil(keyTop + points.length * row + 8));
  const cy = height / 2;
  const layout = emptyLayout("pie", width, height);
  const total = points.reduce((sum, point) => sum + point.value.value, 0);
  if (total <= 0) return layout;
  const share = (value: number) => value / total;
  const percent = new Intl.NumberFormat(safeLanguage(options.language), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  let angle = -Math.PI / 2;
  const at = (a: number, r = radius) =>
    `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  layout.points = points.map((point, index) => {
    const part = share(point.value.value);
    const end = angle + part * Math.PI * 2;
    const ink: ChartInk = `category${index % CATEGORY_COUNT}`;
    // A whole circle can't be one arc: two halves.
    const path =
      part >= 0.9999
        ? `M${at(angle)} A${radius} ${radius} 0 1 1 ${at(angle + Math.PI)} A${radius} ${radius} 0 1 1 ${at(angle)} Z`
        : `M${cx} ${cy} L${at(angle)} A${radius} ${radius} 0 ${end - angle > Math.PI ? 1 : 0} 1 ${at(end)} Z`;
    const middle = (angle + end) / 2;
    const mx = cx + radius * 0.6 * Math.cos(middle);
    const my = cy + radius * 0.6 * Math.sin(middle);
    angle = end;
    const y = keyTop + index * row;
    const name = rowsLabel(chart, point.row);
    const text = `${name} · ${percent.format(part)}`;
    layout.legendMarks.push({
      x: keyX,
      y,
      ink,
      text: {
        x: keyX + 20,
        y: y + 10,
        text: fitText(text, width - keyX - 24, measure),
        anchor: "start",
        role: "label",
      },
    });
    layout.legend.push({ index: point.row, ink, name });
    return {
      ...point,
      ink,
      mark: { shape: "slice", path, cx: mx, cy: my },
      share: part,
    };
  });
  return layout;
}

const rowsLabel = (chart: Pick<ChartAttributes, "data">, row: number) =>
  chart.data.rows[row]?.label ?? "";

function safeLanguage(language: string): string {
  try {
    return new Intl.NumberFormat(language).resolvedOptions().locale;
  } catch {
    return "en";
  }
}

function addLegendRow(layout: ChartLayout, measure: (text: string) => number): void {
  const start = layout.grid[0]?.x1 ?? 16;
  let x = start;
  let y = layout.height + 4;
  for (const item of layout.legend) {
    const text = fitText(item.name, 160, measure);
    const needed = 16 + measure(text) + 16;
    if (x > start && x + needed > layout.width) {
      x = start;
      y += LEGEND_ROW;
    }
    layout.legendMarks.push({
      x,
      y,
      ink: item.ink,
      text: { x: x + 16, y: y + 10, text, anchor: "start", role: "label" },
    });
    x += needed;
  }
  layout.height = y + LEGEND_ROW;
}
