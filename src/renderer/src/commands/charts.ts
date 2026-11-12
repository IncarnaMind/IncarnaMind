import type { Editor } from "@tiptap/core";
import { isInTable } from "@tiptap/pm/tables";
import { CHART_KINDS, type ChartKind } from "../../../shared/charts";
import type { MessageKey } from "../../../shared/i18n";
import { chartOfSelection, chartOfTable, insertChart, tableAround } from "../editor/chartCommands";
import { chartHandles } from "../editor/chartHandles";
import { noteHolding } from "../editor/noteKeymap";
import { languageNow } from "../i18n";
import type { Command, CommandContext } from "./registry";

function noteOf(ctx: CommandContext): Editor | null {
  const editor = ctx.focus?.kind === "block" ? noteHolding(ctx.focus.id) : null;
  return editor && !editor.isDestroyed && editor.isEditable ? editor : null;
}

const chartOf = (ctx: CommandContext) =>
  ctx.focus && (ctx.focus.kind === "chart" || ctx.focus.kind === "block")
    ? (chartHandles.get(ctx.focus.id) ?? null)
    : null;

const KIND_COMMANDS: Record<ChartKind, MessageKey> = {
  bar: "chart.command.bar",
  line: "chart.command.line",
  pie: "chart.command.pie",
  scatter: "chart.command.scatter",
};

export const chartCommands: readonly Command[] = [
  {
    id: "chart.fromTable",
    label: "chart.fromTable",
    group: "main",
    appliesTo: ["block"],
    reversible: true,
    when: (ctx) => {
      const editor = noteOf(ctx);
      return (
        editor !== null &&
        isInTable(editor.state) &&
        chartOfTable(editor.state, languageNow()) !== null
      );
    },
    run(ctx) {
      const editor = noteOf(ctx);
      const chart = editor && chartOfTable(editor.state, languageNow());
      if (editor && chart) insertChart(editor, chart);
    },
  },
  {
    id: "chart.fromFigures",
    label: "chart.fromFigures",
    group: "main",
    appliesTo: ["block"],
    appliesToText: true,
    reversible: true,
    when: (ctx) => {
      const editor = noteOf(ctx);
      return editor !== null && !editor.state.selection.empty && !tableAround(editor.state);
    },
    enabled(ctx) {
      const editor = noteOf(ctx);
      return editor && chartOfSelection(editor.state, languageNow())
        ? true
        : { reason: "chart.fromFigures.none" };
    },
    run(ctx) {
      const editor = noteOf(ctx);
      const chart = editor && chartOfSelection(editor.state, languageNow());
      if (editor && chart) insertChart(editor, chart);
    },
  },
  {
    id: "chart.table",
    label: (ctx, t) => t(chartOf(ctx)?.asTable() ? "chart.showAsChart" : "chart.showAsTable"),
    group: "main",
    appliesTo: ["chart", "block"],
    // A way of looking at it: the same command puts it back.
    reversible: true,
    when: (ctx) => chartOf(ctx) !== null,
    run: (ctx) => chartOf(ctx)?.toggleTable(),
  },
  ...CHART_KINDS.map(
    (kind): Command => ({
      id: `chart.kind.${kind}`,
      label: KIND_COMMANDS[kind],
      group: "main",
      appliesTo: ["chart", "block"],
      reversible: true,
      // The kind it is already isn't offered.
      when: (ctx) => {
        const chart = chartOf(ctx);
        return chart !== null && chart.kind() !== kind;
      },
      enabled: (ctx) => (chartOf(ctx)?.fits(kind) ? true : { reason: "chart.scatter.needsTwo" }),
      run: (ctx) => chartOf(ctx)?.setKind(kind),
    }),
  ),
  {
    id: "chart.switch",
    label: "chart.switch",
    group: "main",
    appliesTo: ["chart", "block"],
    reversible: true,
    when: (ctx) => chartOf(ctx)?.canSwitch() ?? false,
    run: (ctx) => chartOf(ctx)?.switchRowsAndColumns(),
  },
  {
    id: "chart.update",
    label: "chart.update.command",
    group: "main",
    appliesTo: ["chart", "block"],
    reversible: true,
    when: (ctx) => chartOf(ctx)?.canUpdate() ?? false,
    run: (ctx) => chartOf(ctx)?.update(),
  },
  {
    id: "chart.rename",
    label: "chart.rename",
    rowKeys: "F2",
    group: "edit",
    appliesTo: ["chart", "block"],
    reversible: true,
    when: (ctx) => chartOf(ctx) !== null,
    run: (ctx) => chartOf(ctx)?.rename(),
  },
];
