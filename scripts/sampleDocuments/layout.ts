/**
 * Lays the sample Documents in `data/` out as PDF pages: wrapped Helvetica
 * text, tables and bar charts, through the PDF writer the tests use. Each
 * spec is one page, and a spec that doesn't fit is an error, not a page the
 * reader loses the end of.
 */
import { type PdfDrawing, type PdfPage, widthOf } from "../../tests/helpers/pdf";

const LEFT = 72;
const RIGHT = 540;
const TOP = 748;

/** A pool's text at an index, wrapped: a pool is never empty. */
export function at(pool: readonly string[], index: number): string {
  const text = pool[index % pool.length];
  if (text === undefined) throw new Error("A paragraph pool is empty.");
  return text;
}

/** A paragraph as lines that each fit the width, broken between words. */
export function wrap(text: string, size: number, width = RIGHT - LEFT): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (widthOf(next, size) <= width || line === "") {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  for (const line of lines) {
    if (widthOf(line, size) > width) throw new Error(`Too wide for the page: ${line}`);
  }
  return lines;
}

export interface SampleTable {
  caption?: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
  /** How many parts of the width each column takes; equal by default. */
  weights?: readonly number[];
  /** The rows a shaded band covers, from 0, as a table in a report repeats them. */
  bands?: readonly number[];
}

export interface SampleChart {
  bars: readonly { label: string; value: number }[];
  /** What the bars count, written under the axis. */
  note?: string;
  /** The value the tallest bar is drawn at; the largest value by default. */
  max?: number;
}

export interface SamplePage {
  /** The large lines of a cover, or of a paper's first page. */
  title?: readonly string[];
  titleSize?: number;
  subtitle?: readonly string[];
  /** A running head at the top of a report's page. */
  running?: string;
  heading?: string;
  paragraphs?: readonly string[];
  table?: SampleTable;
  chart?: SampleChart;
  /** Small print at the foot of a cover or a statement page. */
  small?: readonly string[];
  /** Text the tests and evals expect on this page, as the app stores it. */
  anchors?: readonly string[];
}

const LINE = 15;
const BODY = 11;

interface Laid {
  lines: string[];
  drawn: PdfDrawing[];
  placed: { text: string; x: number; y: number }[];
  printed: { text: string; size: number }[];
}

function layTable(table: SampleTable, y: number, laid: Laid): number {
  const weights = table.weights ?? table.columns.map(() => 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const columns: number[] = [];
  const widths: number[] = [];
  let x = LEFT;
  for (const weight of weights) {
    const width = ((RIGHT - LEFT) * weight) / total;
    columns.push(x);
    widths.push(width - 8);
    x += width;
  }
  if (table.caption) {
    for (const line of wrap(table.caption, 9.5)) {
      laid.placed.push({ text: line, x: LEFT, y });
      y -= 12;
    }
    y -= 4;
  }
  const header = y;
  let headerHeight = 0;
  for (const [index, column] of table.columns.entries()) {
    const lines = wrap(column, 9.5, widths[index] ?? RIGHT - LEFT);
    headerHeight = Math.max(headerHeight, lines.length);
    lines.forEach((line, row) => {
      laid.placed.push({ text: line, x: columns[index] ?? LEFT, y: y - row * 12 });
    });
  }
  y -= Math.max(13, headerHeight * 12 + 3);
  laid.drawn.push({ rule: [LEFT, y + 5, RIGHT, y + 5], gray: 0.3 });
  table.rows.forEach((row, rowIndex) => {
    let height = 0;
    const wrapped = row.map((cell, index) => {
      const lines = wrap(cell, 9.5, widths[index] ?? RIGHT - LEFT);
      height = Math.max(height, lines.length);
      return lines;
    });
    if (table.bands?.includes(rowIndex)) {
      laid.drawn.push({
        rectangle: [LEFT - 4, y - height * 12 + 3, RIGHT - LEFT + 8, height * 12],
        gray: 0.92,
      });
    }
    wrapped.forEach((lines, index) => {
      lines.forEach((line, row) => {
        laid.placed.push({ text: line, x: columns[index] ?? LEFT, y: y - row * 12 });
      });
    });
    y -= height * 12 + 3;
  });
  laid.drawn.push({ rule: [LEFT, y + 2, RIGHT, y + 2], gray: 0.3 });
  laid.drawn.push({ rule: [LEFT, header + 5, RIGHT, header + 5], gray: 0.3 });
  for (const row of table.rows) {
    if (row.length !== table.columns.length) throw new Error(`A table row has ${row.length} cells.`);
  }
  return y;
}

function layChart(chart: SampleChart, y: number, laid: Laid): number {
  const height = 130;
  const width = 360;
  const max = chart.max ?? Math.max(...chart.bars.map((bar) => bar.value));
  const step = width / chart.bars.length;
  const baseline = y - height;
  laid.drawn.push({ rule: [LEFT, baseline, LEFT + width, baseline], gray: 0.3 });
  chart.bars.forEach((bar, index) => {
    const barHeight = Math.max(2, Math.round((bar.value / max) * (height - 20)));
    const x = LEFT + index * step + step * 0.2;
    laid.drawn.push({
      rectangle: [x, baseline + 1, step * 0.6, barHeight],
      gray: 0.55,
    });
    laid.placed.push({
      text: bar.label,
      x: x - 2,
      y: baseline - 12,
    });
    laid.placed.push({
      text: String(bar.value),
      x: x,
      y: baseline + barHeight + 4,
    });
  });
  y = baseline - 26;
  if (chart.note) {
    for (const line of wrap(chart.note, 9.5)) {
      laid.placed.push({ text: line, x: LEFT, y });
      y -= 12;
    }
  }
  return y - 4;
}

/** One page as the PDF writer takes it. */
export function layOut(spec: SamplePage, page: number): PdfPage {
  const laid: Laid = { lines: [], drawn: [], placed: [], printed: [] };
  let y = TOP;
  if (spec.running) {
    laid.placed.push({ text: spec.running, x: LEFT, y: TOP + 32 });
  }
  for (const text of spec.title ?? []) {
    for (const line of wrap(text, spec.titleSize ?? 22)) {
      laid.printed.push({ text: line, size: spec.titleSize ?? 22 });
      y -= Math.round((spec.titleSize ?? 22) * 1.45);
    }
  }
  for (const text of spec.subtitle ?? []) {
    for (const line of wrap(text, 12)) {
      laid.printed.push({ text: line, size: 12 });
      y -= 20;
    }
  }
  y -= 8;
  if (spec.heading) {
    for (const line of wrap(spec.heading, 14)) {
      laid.printed.push({ text: line, size: 14 });
      y -= 20;
    }
    y -= 4;
  }
  for (const paragraph of spec.paragraphs ?? []) {
    for (const line of wrap(paragraph, BODY)) {
      laid.lines.push(line);
      y -= LINE;
    }
    y -= 5;
  }
  if (spec.table) y = layTable(spec.table, y, laid);
  if (spec.chart) y = layChart(spec.chart, y, laid);
  for (const text of spec.small ?? []) {
    for (const line of wrap(text, 9)) {
      laid.placed.push({ text: line, x: LEFT, y });
      y -= 12;
    }
  }
  if (y < 56) throw new Error(`Page ${page} runs past its foot: ${JSON.stringify(spec.heading)}`);
  laid.placed.push({ text: String(page), x: 297, y: 36 });
  return {
    printed: laid.printed,
    lines: laid.lines,
    placed: laid.placed,
    drawn: laid.drawn.length > 0 ? laid.drawn : undefined,
  };
}
