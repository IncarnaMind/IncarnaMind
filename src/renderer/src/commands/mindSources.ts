import { countNow } from "../i18n";
import { mindSourceOf, removeAsSources, saveAsSources, updateSnapshots } from "../mindSources";
import { useAppStore } from "../store";
import type { Command } from "./registry";
import { everyMind, mindsOf } from "./targets";

const sourceOf = (mindId: string) => mindSourceOf(useAppStore.getState().documents, mindId);

/** Use a Mind as a source, and its snapshot's update and removal (#335). */
export const mindSourceCommands: readonly Command[] = [
  {
    id: "mind.useAsSource",
    label: (ctx, t) => {
      const count = mindsOf(ctx).length;
      return count > 1
        ? t("mind.useAsSourceMany", { count: countNow(count) })
        : t("mind.useAsSource");
    },
    group: "main",
    appliesTo: ["mind", "tab"],
    when: (ctx) => everyMind(ctx, (mindId) => !sourceOf(mindId)),
    reversible: true,
    run: (ctx) => saveAsSources(mindsOf(ctx)),
  },
  {
    id: "mind.updateSourceSnapshot",
    label: (ctx, t) => {
      const count = mindsOf(ctx).length;
      return count > 1
        ? t("mind.updateSnapshotMany", { count: countNow(count) })
        : t("mind.updateSnapshot");
    },
    group: "main",
    appliesTo: ["mind", "tab"],
    when: (ctx) => everyMind(ctx, (mindId) => !!sourceOf(mindId)),
    reversible: true,
    run: (ctx) => updateSnapshots(mindsOf(ctx)),
  },
  {
    id: "mind.removeAsSource",
    label: (ctx, t) => {
      const count = mindsOf(ctx).length;
      return count > 1
        ? t("mind.removeAsSourceMany", { count: countNow(count) })
        : t("mind.removeAsSource");
    },
    group: "main",
    appliesTo: ["mind", "tab"],
    when: (ctx) => everyMind(ctx, (mindId) => !!sourceOf(mindId)),
    reversible: true,
    run: (ctx) => removeAsSources(mindsOf(ctx)),
  },
];
