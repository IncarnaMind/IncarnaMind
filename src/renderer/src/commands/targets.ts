import type { Document, Mind } from "../../../core/api";
import { currentTabOf } from "../layoutSlice";
import type { ObjectKind, ObjectRef } from "../objects";
import { useAppStore } from "../store";
import { findTab } from "../tabs";
import type { CommandContext } from "./registry";

export const targetsOf = (ctx: CommandContext): readonly ObjectRef[] =>
  ctx.selection.length > 0 ? ctx.selection : ctx.focus ? [ctx.focus] : [];

/** Only while one thing is selected or focused: what opens, renames or exports one. */
export const onlyOne = (ctx: CommandContext): boolean => targetsOf(ctx).length <= 1;

export const idsOf = (ctx: CommandContext, kind: ObjectKind): string[] =>
  targetsOf(ctx).flatMap((ref) => (ref.kind === kind ? [ref.id] : []));

export function documentsOf(ctx: CommandContext): Document[] {
  const ids = new Set(idsOf(ctx, "document"));
  return ids.size > 0 ? useAppStore.getState().documents.filter((each) => ids.has(each.id)) : [];
}

/** Only while every target is a Document that passes `test`. */
export function everyDocument(ctx: CommandContext, test: (document: Document) => boolean): boolean {
  const count = targetsOf(ctx).length;
  const documents = documentsOf(ctx);
  return count > 0 && documents.length === count && documents.every(test);
}

/**
 * The one Mind a command acts on: the Mind's row or the tab its menu was opened on, else the Mind
 * in the tab the User is in (⇧⌘E, ⌘K). None for several selected.
 */
export function mindOf(ctx: CommandContext): string | null {
  const targets = targetsOf(ctx);
  if (targets.length > 1) return null;
  const [target] = targets;
  if (target?.kind === "mind") return target.id;
  const { layout } = useAppStore.getState();
  const tab =
    target === undefined
      ? currentTabOf(layout)
      : target.kind === "tab"
        ? findTab(layout, target.id)
        : undefined;
  return tab?.item.kind === "mind" ? tab.item.mindId : null;
}

/** The Minds a menu or ⌘K acts on, in the store's order: a tab shows its Mind. */
export function mindsOf(ctx: CommandContext): Mind[] {
  const ids = new Set(idsOf(ctx, "mind"));
  for (const tabId of idsOf(ctx, "tab")) {
    const item = findTab(useAppStore.getState().layout, tabId)?.item;
    if (item?.kind === "mind") ids.add(item.mindId);
  }
  return useAppStore.getState().minds.filter((mind) => ids.has(mind.id));
}

/** Only while every target is a Mind that passes `test`. */
export function everyMind(ctx: CommandContext, test: (mindId: string) => boolean): boolean {
  const count = targetsOf(ctx).length;
  const minds = mindsOf(ctx);
  return count > 0 && minds.length === count && minds.every((mind) => test(mind.id));
}

/** The Mind in the tab the User is in, if that tab holds one. */
export function mindInFront(): string | null {
  const item = currentTabOf(useAppStore.getState().layout)?.item;
  return item?.kind === "mind" ? item.mindId : null;
}

/** The Mind a menu or the keyboard names: the Mind's row, the Mind a tab shows, else the one in front. */
export function mindShown(ctx: CommandContext): string | null {
  const target = ctx.selection[0] ?? ctx.focus;
  if (target?.kind === "mind") return target.id;
  if (target?.kind === "tab") {
    const item = findTab(useAppStore.getState().layout, target.id)?.item;
    return item?.kind === "mind" ? item.mindId : null;
  }
  return mindInFront();
}
