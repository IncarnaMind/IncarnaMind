import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection } from "@tiptap/pm/state";
import { BLOCK_ID_ATTRIBUTE, CHART_NODE } from "../../../core/api";
import {
  type ChartAttributes,
  type ChartData,
  type ChartKind,
  canSwitch,
  chartFromFigures,
  chartFromTable,
  drawnSeries,
  gridOfTable,
  readChart,
  type SourceGrid,
  type SourceLine,
  sameChartData,
  sourceLineOf,
  switchedChart,
} from "../../../shared/charts";
import { asOwnUndoStep } from "./selectionCommands";

const readText = (node: ProseMirrorNode): SourceLine => sourceLineOf(node.toJSON());

export const tableGrid = (table: ProseMirrorNode): SourceGrid => gridOfTable(table.toJSON());

export function tableAround(state: EditorState): { node: ProseMirrorNode; pos: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "table") return { node, pos: $from.before(depth) };
  }
  return null;
}

function headingAbove(doc: ProseMirrorNode, topLevel: number): string {
  let title = "";
  doc.forEach((node, _offset, index) => {
    if (index < topLevel && node.type.name === "heading") title = node.textContent;
  });
  return title;
}

export function chartOfTable(state: EditorState, language: string): ChartAttributes | null {
  const table = tableAround(state);
  if (!table) return null;
  const id = table.node.attrs[BLOCK_ID_ATTRIBUTE];
  return chartFromTable(tableGrid(table.node), {
    blockId: typeof id === "string" ? id : null,
    title: headingAbove(state.doc, state.doc.resolve(table.pos).index(0)),
    language,
  });
}

function selectedLines(state: EditorState): SourceLine[] {
  const { from, to } = state.selection;
  const lines: SourceLine[] = [];
  state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name === "table" || node.type.name === CHART_NODE) return false;
    if (!node.isTextblock) return true;
    lines.push(readText(node));
    return false;
  });
  return lines;
}

export function chartOfSelection(state: EditorState, language: string): ChartAttributes | null {
  const { selection } = state;
  if (selection.empty || tableAround(state)) return null;
  const lines = selectedLines(state);
  return chartFromFigures(lines, {
    title: headingAbove(state.doc, state.doc.resolve(selection.from).index(0)),
    language,
  });
}

const attributesOf = (chart: ChartAttributes) => ({
  kind: chart.kind,
  title: chart.title,
  drawn: chart.drawn,
  data: chart.data,
  source: chart.source,
});

/** After the top-level Block: a table in an Answer gets its chart after the Answer, not inside it. */
export function insertChart(editor: Editor, chart: ChartAttributes): boolean {
  if (editor.view.composing) return false;
  const { state } = editor;
  const $end = state.selection.$to;
  const after = $end.depth > 0 ? $end.after(1) : $end.pos;
  const type = state.schema.nodes[CHART_NODE];
  if (!type) return false;
  return asOwnUndoStep(editor, () => {
    const node = type.create(attributesOf(chart));
    const tr = state.tr.insert(after, node);
    tr.setSelection(NodeSelection.create(tr.doc, after)).scrollIntoView();
    editor.view.dispatch(tr);
    editor.commands.focus();
    return true;
  });
}

export function changeChart(
  editor: Editor,
  pos: number,
  change: Partial<Pick<ChartAttributes, "kind" | "title" | "drawn" | "data" | "source">>,
): boolean {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== CHART_NODE || !editor.isEditable) return false;
  return asOwnUndoStep(editor, () => {
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...change }),
    );
    return true;
  });
}

/** A pie draws only the one chosen, a scatter chart two at most: the first kept, with the one chosen. */
export function toggledSeries(chart: ChartAttributes, series: number): number[] {
  const all = chart.data.series.map((_, index) => index);
  if (chart.kind === "pie") return [series];
  const drawn = chart.drawn ?? all;
  if (drawn.includes(series)) return drawn.filter((each) => each !== series);
  const kept = chart.kind === "scatter" ? drawnSeries(chart).slice(0, 1) : drawn;
  return all.filter((each) => each === series || kept.includes(each));
}

export function withKind(
  chart: ChartAttributes,
  kind: ChartKind,
): Pick<ChartAttributes, "kind" | "drawn"> {
  const all = chart.data.series.map((_, index) => index);
  const drawn = chart.drawn ?? all;
  if (kind === "scatter" && drawn.length < 2) {
    return { kind, drawn: [...new Set([...drawn, ...all])].slice(0, 2).sort((a, b) => a - b) };
  }
  return { kind, drawn: chart.drawn };
}

export function chartTable(
  doc: ProseMirrorNode,
  chart: Pick<ChartAttributes, "source">,
): ProseMirrorNode | null {
  const { source } = chart;
  if (source.kind !== "table" || !source.blockId) return null;
  let found: ProseMirrorNode | null = null;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "table" && node.attrs[BLOCK_ID_ATTRIBUTE] === source.blockId) {
      found = node;
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  return found;
}

/** Null when the table is gone, unchanged, or no longer has a column of numbers. */
export function tableUpdate(
  doc: ProseMirrorNode,
  attributes: Readonly<Record<string, unknown>>,
  language: string,
): ChartData | null {
  const chart = readChart(attributes);
  const table = chartTable(doc, chart);
  if (!table) return null;
  const fresh = chartFromTable(tableGrid(table), {
    blockId: chart.source.kind === "table" ? chart.source.blockId : null,
    title: chart.title,
    language,
    switched: chart.source.kind === "table" && chart.source.switched === true,
  });
  if (!fresh) return null;
  return sameChartData(fresh.data, chart.data) ? null : fresh.data;
}

/**
 * While the chart draws what its table holds, the table is read again the other way round: a
 * row with no number, left out one way, comes back the other, and the table isn't taken to
 * have changed.
 */
export function switchedChartIn(
  doc: ProseMirrorNode,
  attributes: Readonly<Record<string, unknown>>,
  language: string,
): ReturnType<typeof switchedChart> {
  const chart = readChart(attributes);
  const table =
    canSwitch(chart) && tableUpdate(doc, attributes, language) === null
      ? chartTable(doc, chart)
      : null;
  const fresh =
    table &&
    chart.source.kind === "table" &&
    chartFromTable(tableGrid(table), {
      blockId: chart.source.blockId,
      title: chart.title,
      language,
      switched: chart.source.switched !== true,
    });
  return switchedChart(chart, fresh ? fresh.data : null);
}
