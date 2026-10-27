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
