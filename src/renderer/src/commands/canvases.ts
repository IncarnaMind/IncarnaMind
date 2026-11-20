import { useAppStore } from "../store";
import { findTab } from "../tabs";
import type { Command, CommandContext } from "./registry";
import { targetsOf } from "./targets";

const store = () => useAppStore.getState();

/** The one Canvas a command acts on (#3406): its row's, or the one its tab shows. */
function canvasIdIn(ctx: CommandContext): string | null {
  const targets = targetsOf(ctx);
  const [target] = targets;
  if (targets.length !== 1 || !target) return null;
  if (target.kind === "canvas") return target.id;
  const shown = target.kind === "tab" ? findTab(store().layout, target.id)?.item : undefined;
  return shown?.kind === "canvas" ? shown.canvasId : null;
}

const ofCanvas = (ctx: CommandContext) => canvasIdIn(ctx) !== null;

/** Where it is open, else in a new tab; or always in a new tab, as a Note's Open in new tab. */
const openCanvas = (canvasId: string, newTab: boolean) =>
  store().changeLayout({
    type: "open",
    item: { kind: "canvas", canvasId },
    where: newTab ? { in: "group" } : { in: "place" },
  });

/** Open and Delete, from a Canvas's row, its tab and ⌘K. The User can't edit a Canvas. */
export const canvasCommands: readonly Command[] = [
  {
    id: "canvas.open",
    label: "mind.open",
    group: "open",
    appliesTo: ["canvas"],
    when: ofCanvas,
    reversible: true,
    async run(ctx) {
      const id = canvasIdIn(ctx);
      if (id) await openCanvas(id, false);
    },
  },
  {
    id: "canvas.openTab",
    label: "mind.openTab",
    group: "open",
    appliesTo: ["canvas"],
    when: ofCanvas,
    reversible: true,
    async run(ctx) {
      const id = canvasIdIn(ctx);
      if (id) await openCanvas(id, true);
    },
  },
  {
    id: "canvas.delete",
    label: "mind.deleteAction",
    group: "danger",
    destructive: true,
    appliesTo: ["canvas", "tab"],
    when: ofCanvas,
    reversible: true,
    async run(ctx) {
      const id = canvasIdIn(ctx);
      if (id) await store().deleteCanvas(id);
    },
  },
];
