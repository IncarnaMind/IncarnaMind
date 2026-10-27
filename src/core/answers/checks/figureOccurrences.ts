import * as Y from "yjs";
import { readCalculatedFigureAttributes } from "../../../shared/calculatedFigures";
import {
  chartCells,
  chartPoints,
  drawnSeries,
  gridOfTable,
  readChart,
  type SourceGrid,
} from "../../../shared/charts";
import { readFigures } from "../../../shared/figures";
import { sentenceSpans } from "../../../shared/sentences";
import { CALCULATED_FIGURE_NODE, CHART_NODE, type CheckFigure, type TextStretch } from "../../api";
import { plainText } from "../../mindText";
import { layout, textBlocks } from "../../proposals/write";
import { nodeOf } from "../blocks";
import { documentFigureContext } from "../calculations";
import { type SelectedSentence, textOf } from "./sentences";

export interface FigureOccurrence extends CheckFigure {
  sentence: TextStretch | null;
  context: string;
  label?: string;
  table?: {
    blockId: string;
    row: number;
    column: number;
    rowLabel: string;
    columnLabel: string;
    header: boolean;
  };
}

function tableContext(element: Y.XmlElement, grids: Map<Y.XmlElement, SourceGrid>) {
  let cell: unknown = element.parent;
  while (
    cell instanceof Y.XmlElement &&
    cell.nodeName !== "tableCell" &&
    cell.nodeName !== "tableHeader"
  )
    cell = cell.parent;
  if (!(cell instanceof Y.XmlElement)) return null;
  const row = cell.parent;
  const table = row instanceof Y.XmlElement ? row.parent : null;
  if (!(row instanceof Y.XmlElement && table instanceof Y.XmlElement) || table.nodeName !== "table")
    return null;
  const blockId = table.getAttribute("id");
  if (typeof blockId !== "string") return null;
  const rows = table.toArray().filter((each): each is Y.XmlElement => each instanceof Y.XmlElement);
  const rowIndex = rows.indexOf(row);
  const cellIndex = row
    .toArray()
    .filter((each) => each instanceof Y.XmlElement)
    .indexOf(cell);
  const grid = grids.get(table) ?? gridOfTable(nodeOf(table));
  grids.set(table, grid);
  const anchors = (grid[rowIndex] ?? []).flatMap((slot, column) =>
    slot && !slot.continued ? [column] : [],
  );
  const column = anchors[cellIndex];
  if (column === undefined) return null;
  const columnLabel = [
    ...new Set(
      grid.slice(0, rowIndex).flatMap((slots) => {
        const slot = slots[column];
        return slot?.header && slot.text ? [slot.text] : [];
      }),
    ),
  ].join("\n");
  const rowLabel = grid[rowIndex]?.[0]?.text ?? "";
  const rowText = (grid[rowIndex] ?? []).map((slot) => slot?.text ?? "").join(" | ");
  const before = table.prevSibling;
  const caption =
    before instanceof Y.XmlElement && before.nodeName !== "table" ? plainText(before) : "";
  return {
    place: {
      blockId,
      row: rowIndex,
      column,
      rowLabel,
      columnLabel,
      header: cell.nodeName === "tableHeader",
    },
    header: [columnLabel, rowText, caption].filter(Boolean).join("\n"),
  };
}

function inSentence(
  sentence: SelectedSentence,
  grids: Map<Y.XmlElement, SourceGrid>,
): FigureOccurrence[] {
  if (sentence.element.nodeName !== "paragraph") return [];
  const table = tableContext(sentence.element, grids);
  if (table?.place.header) return [];
  const raw = textOf(sentence.element);
  const parts = layout(sentence.element);
  const expanded = parts
    .map(({ node, start, size }) =>
      node instanceof Y.XmlElement && node.nodeName === CALCULATED_FIGURE_NODE
        ? (readCalculatedFigureAttributes(node.getAttributes())?.figure.shown ??
          raw.slice(start, start + size))
        : raw.slice(start, start + size),
    )
    .join("");
  const context = [table?.header, expanded].filter(Boolean).join("\n");
  const document = documentFigureContext([{ text: context }]);
  const range: TextStretch = {
    from: { blockId: sentence.blockId, offset: sentence.from },
    to: { blockId: sentence.blockId, offset: sentence.to },
  };
  const common = {
    sentence: range,
    context,
    ...(table && { table: table.place, label: table.place.rowLabel }),
  };
  const found: FigureOccurrence[] = readFigures(raw, { ...document, header: table?.header ?? null })
    .filter((reading) => reading.start >= sentence.from && reading.end <= sentence.to)
    .map((reading) => ({
      ...common,
      id: JSON.stringify(["text", sentence.blockId, reading.start, reading.end, reading.chars]),
      locator: {
        kind: "text",
        from: { blockId: sentence.blockId, offset: reading.start },
        to: { blockId: sentence.blockId, offset: reading.end },
      },
      reading,
      calculated: null,
    }));
  for (const { node, start } of parts) {
    if (
      !(node instanceof Y.XmlElement) ||
      node.nodeName !== CALCULATED_FIGURE_NODE ||
      start < sentence.from ||
      start + 1 > sentence.to
    )
      continue;
    const calculated = readCalculatedFigureAttributes(node.getAttributes());
    if (!calculated || typeof calculated.figure.value !== "number") continue;
    const readings = readFigures(calculated.figure.shown, {
      ...document,
      language: calculated.figure.show.language,
      header: null,
    });
    const reading = readings[0];
    if (readings.length !== 1 || !reading) continue;
    found.push({
      ...common,
      id: calculated.id,
      locator: {
        kind: "text",
        from: { blockId: sentence.blockId, offset: start },
        to: { blockId: sentence.blockId, offset: start + 1 },
      },
      reading: { ...reading, start, end: start + 1 },
      calculated,
    });
  }
  return found.sort((a, b) => a.reading.start - b.reading.start);
}

export function figuresInSentence(sentence: SelectedSentence): FigureOccurrence[] {
  return inSentence(sentence, new Map());
}

function inChart(element: Y.XmlElement): FigureOccurrence[] {
  const blockId = element.getAttribute("id");
  if (typeof blockId !== "string") return [];
  const chart = readChart(element.getAttributes());
  const points = chartPoints(chart);
  const plotted = new Set(points.map(({ row, series }) => `${row}:${series}`));
  if (chart.kind === "scatter") {
    const across = drawnSeries(chart)[0];
    if (across !== undefined) for (const point of points) plotted.add(`${point.row}:${across}`);
  }
  const document = documentFigureContext([
    {
      text: [chart.title, ...chart.data.series, ...chart.data.rows.map((row) => row.label)].join(
        "\n",
      ),
    },
  ]);
  return chartCells(chart).flatMap(({ row, series, value }): FigureOccurrence[] => {
    if (!plotted.has(`${row}:${series}`)) return [];
    const readings = readFigures(value.shown, {
      ...document,
      dates: true,
      header: chart.data.series[series] ?? null,
    });
    const reading = readings[0];
    if (readings.length !== 1 || !reading) return [];
    const label = chart.data.rows[row]?.label ?? "";
    return [
      {
        id: JSON.stringify(["chart", blockId, row, series, reading.chars]),
        locator: { kind: "chart", blockId, row, series },
        reading,
        calculated: null,
        sentence: null,
        label,
        context: [chart.title, label, chart.data.series[series] ?? ""].join("\n"),
      },
    ];
  });
}

export function figuresInMind(blocks: Y.XmlFragment): FigureOccurrence[] {
  const grids = new Map<Y.XmlElement, SourceGrid>();
  const found: FigureOccurrence[] = [];
  for (const { element, busy } of textBlocks(blocks, { charts: true })) {
    if (busy) continue;
    if (element.nodeName === CHART_NODE) found.push(...inChart(element));
    else if (element.nodeName === "paragraph") {
      const blockId = element.getAttribute("id");
      if (typeof blockId !== "string") continue;
      const text = textOf(element);
      const spans = sentenceSpans(text);
      const occurrences = inSentence(
        { element, blockId, from: 0, to: text.length, text, context: text, cited: [] },
        grids,
      );
      for (const occurrence of occurrences) {
        const span = spans.find(
          (each) => each.from <= occurrence.reading.start && each.to >= occurrence.reading.end,
        );
        found.push(
          span
            ? {
                ...occurrence,
                sentence: {
                  from: { blockId, offset: span.from },
                  to: { blockId, offset: span.to },
                },
              }
            : occurrence,
        );
      }
    }
  }
  return found;
}
