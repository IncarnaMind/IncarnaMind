import type { DeletedItem } from "../../../core/api";
import { LIBRARY_DELETED } from "../deletedItems";
import { countNow } from "../i18n";
import { restoreItems, useDeleted } from "../recentlyDeleted";
import { useRequests } from "../requests";
import { useAppStore } from "../store";
import type { Command, CommandContext } from "./registry";
import { idsOf } from "./targets";

/** The items in Recently deleted a menu or selection names. */
const itemsOf = (ctx: CommandContext): readonly DeletedItem[] => {
  const ids = idsOf(ctx, "deleted");
  return (useDeleted.getState().items ?? []).filter((item) => ids.includes(item.id));
};

const countLabel = (one: "deleted.restore" | "deleted.deletePermanently") =>
  ((ctx, t) => {
    const count = itemsOf(ctx).length;
    return count > 1 ? t(`${one}.count`, { count: countNow(count) }) : t(one);
  }) satisfies Command["label"];

export const deletedCommands: readonly Command[] = [
  {
    id: "deleted.show",
    label: "deleted.command",
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openLibrary(LIBRARY_DELETED),
  },
  {
    id: "deleted.restore",
    label: countLabel("deleted.restore"),
    group: "main",
    appliesTo: ["deleted"],
    reversible: true,
    run: (ctx) => restoreItems(itemsOf(ctx)),
  },
  {
    id: "deleted.deletePermanently",
    assistant: { never: "permanent" },
    label: countLabel("deleted.deletePermanently"),
    group: "danger",
    destructive: true,
    appliesTo: ["deleted"],
    reversible: { confirm: "deleted.confirm.foot" },
    run(ctx) {
      useRequests.getState().ask({ deletePermanently: { items: itemsOf(ctx), empty: false } });
    },
  },
  {
    id: "deleted.empty",
    assistant: { never: "permanent" },
    label: "deleted.emptyAction",
    group: "danger",
    destructive: true,
    reversible: { confirm: "deleted.confirm.foot" },
    async run() {
      await useDeleted.getState().refresh();
      const items = useDeleted.getState().items ?? [];
      if (items.length === 0) useAppStore.getState().openLibrary(LIBRARY_DELETED);
      else useRequests.getState().ask({ deletePermanently: { items, empty: true } });
    },
  },
];
