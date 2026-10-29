import type { FigureScheduleRow } from "../../../core/api";
import { lineRef, toCheckAgain, toKeep, toSignOff } from "../../../shared/figureSchedule";
import { figureScheduleHandle } from "../components/figures/figureScheduleHandle";
import { figureHandle } from "../editor/figureHandle";
import { type Command, type CommandContext, needsHere } from "./registry";

function current(ctx: CommandContext) {
  const handle = figureHandle.current;
  return handle && (!ctx.focus || (ctx.focus.kind === "check" && ctx.focus.id === handle.id))
    ? handle
    : null;
}

/** "Checked by me" on a calculated figure (#1933), as a toggle: off, then on. */
const figureSignOffCommands: Command[] = (["signOff", "signOffRemove"] as const).map((action) => {
  const id = `figure.${action}` as const;
  return {
    id,
    label: "signOff.action",
    keywords: ["signOff.keywords"],
    group: "edit",
    reversible: true,
    checked: () => action === "signOffRemove",
    ...needsHere(id),
  };
});

export const figureCommands: readonly Command[] = [
  ...(
    [
      ["open", "figures.inline.open", "open"],
      ["copyFormula", "figures.inline.copyFormula", "edit"],
      ["convertToText", "figures.inline.convert", "edit"],
      ["remove", "figures.inline.delete", "danger"],
    ] as const
  ).map(([action, label, group]): Command => {
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
  }),
  ...figureSignOffCommands,
];

/** The schedule's figures ⌘K acts on: those selected in it. */
function chosenFigures(ctx: CommandContext): FigureScheduleRow[] {
  const held = figureScheduleHandle.current;
  if (!held) return [];
  const chosen = new Set(ctx.selection.flatMap((ref) => (ref.kind === "check" ? [ref.id] : [])));
  const { mindId, rows } = held.schedule;
  return rows.filter((row) => chosen.has(lineRef(mindId, { id: row.id, parent: row }).id));
}

/** What a row's menu does to the figures chosen in the schedule, from ⌘K too, on the same rows. */
export const figureScheduleCommands: readonly Command[] = [
  {
    id: "figures.checkChosen",
    label: (ctx, t) => {
      const count = toCheckAgain(chosenFigures(ctx)).length;
      return count > 1 ? t("figures.checkCount", { count }) : t("claim.checkAgain");
    },
    group: "main",
    reversible: true,
    appliesTo: ["check"],
    when: (ctx) => toCheckAgain(chosenFigures(ctx)).length > 0,
    run: (ctx) =>
      figureScheduleHandle.current?.checkAgain(
        toCheckAgain(chosenFigures(ctx)).map((row) => row.id),
      ),
  },
  {
    id: "figures.keepChosen",
    label: (ctx, t) => {
      const count = toKeep(chosenFigures(ctx)).length;
      return count > 1 ? t("figures.keepCount", { count }) : t("claim.keepAsView");
    },
    group: "edit",
    reversible: true,
    appliesTo: ["check"],
    when: (ctx) => toKeep(chosenFigures(ctx)).length > 0,
    run: (ctx) =>
      figureScheduleHandle.current?.keep(toKeep(chosenFigures(ctx)).map((row) => row.id)),
  },
  {
    id: "figures.signOffChosen",
    label: (ctx, t) => {
      const { rows, off } = toSignOff(chosenFigures(ctx));
      return rows.length > 1
        ? t(off ? "signOff.unmarkCount" : "signOff.markCount", { count: rows.length })
        : t("signOff.action");
    },
    keywords: ["signOff.keywords"],
    group: "edit",
    reversible: true,
    appliesTo: ["check"],
    when: (ctx) => chosenFigures(ctx).length > 0,
    checked: (ctx) => {
      const { rows, off } = toSignOff(chosenFigures(ctx));
      return rows.length === 1 && off;
    },
    run: (ctx) => {
      const { rows, off } = toSignOff(chosenFigures(ctx));
      figureScheduleHandle.current?.signOff(
        rows.map((row) => row.id),
        off,
      );
    },
  },
];
