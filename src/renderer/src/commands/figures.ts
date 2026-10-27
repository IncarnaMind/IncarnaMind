import type { FigureScheduleRow } from "../../../core/api";
import { lineRef } from "../../../shared/figureSchedule";
import { figureScheduleHandle } from "../components/figures/figureScheduleHandle";
import { figureHandle } from "../editor/figureHandle";
import type { Command, CommandContext } from "./registry";

function current(ctx: CommandContext) {
  const handle = figureHandle.current;
  return handle && (!ctx.focus || (ctx.focus.kind === "check" && ctx.focus.id === handle.id))
    ? handle
    : null;
}

export const figureCommands: readonly Command[] = (
  [
    ["open", "figures.inline.open", "open"],
    ["copyFormula", "figures.inline.copyFormula", "edit"],
    ["convertToText", "figures.inline.convert", "edit"],
    ["remove", "figures.inline.delete", "danger"],
  ] as const
).map(([action, label, group]) => {
  const id = `figure.${action}` as const;
  const edits = action === "convertToText" || action === "remove";
  return {
    id,
    label,
    group,
    reversible: true,
    ...(action === "remove" ? { destructive: true as const } : {}),
    when: (ctx: CommandContext) =>
      ctx.here?.[id] !== undefined ||
      (current(ctx) !== null && (!edits || current(ctx)?.editable() === true)),
    run: (ctx: CommandContext) => {
      if (ctx.here?.[id]) ctx.here[id]?.();
      else current(ctx)?.[action]();
    },
  };
});

/** The schedule's figures ⌘K acts on: those selected in it. */
function chosenFigures(ctx: CommandContext): FigureScheduleRow[] {
  const held = figureScheduleHandle.current;
  if (!held) return [];
  const chosen = new Set(ctx.selection.flatMap((ref) => (ref.kind === "check" ? [ref.id] : [])));
  const { mindId, rows } = held.schedule;
  return rows.filter((row) => chosen.has(lineRef(mindId, { id: row.id, parent: row }).id));
}

const ids = (ctx: CommandContext) => chosenFigures(ctx).map((row) => row.id);

/** What a row's menu does to the figures chosen in the schedule, from ⌘K too. */
export const figureScheduleCommands: readonly Command[] = [
  {
    id: "figures.checkChosen",
    label: (ctx, t) => {
      const count = chosenFigures(ctx).length;
      return count > 1 ? t("figures.checkCount", { count }) : t("claim.checkAgain");
    },
    group: "main",
    reversible: true,
    appliesTo: ["check"],
    when: (ctx) =>
      chosenFigures(ctx).some(
        (row) =>
          row.shown.state === "not-checked" ||
          row.shown.state === "needs-recheck" ||
          row.shown.state === "kept",
      ),
    run: (ctx) => figureScheduleHandle.current?.checkAgain(ids(ctx)),
  },
  {
    id: "figures.keepChosen",
    label: (ctx, t) => {
      const count = chosenFigures(ctx).length;
      return count > 1 ? t("figures.keepCount", { count }) : t("claim.keepAsView");
    },
    group: "edit",
    reversible: true,
    appliesTo: ["check"],
    when: (ctx) => chosenFigures(ctx).some((row) => row.shown.state !== "kept"),
    run: (ctx) => figureScheduleHandle.current?.keep(ids(ctx)),
  },
];
