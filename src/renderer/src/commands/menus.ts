import type { CommandId } from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import type { ObjectKind } from "../objects";
import { COMMAND_GROUPS, type Command, type CommandContext, commands, offered } from "./registry";

export interface Registered {
  id: CommandId;
  section: number;
}

const registered = new Map<ObjectKind, Registered[]>();
const mixed: Registered[] = [];

/**
 * Adds commands to a kind's menu. Within a section they show in the order of
 * their groups (`COMMAND_GROUPS`) and, within a group, in the order given, so a
 * feature registers its own items. Sections show one after the other with a
 * rule between: a tab's menu is its Mind's section, then its own.
 */
export function registerMenu(kind: ObjectKind, ids: readonly CommandId[], section = 0): void {
  const held = registered.get(kind) ?? [];
  const fresh = ids.filter((id) => !held.some((each) => each.id === id));
  registered.set(kind, [...held, ...fresh.map((id) => ({ id, section }))]);
}

/** The menu of a selection of several kinds of object, in place of any one kind's. */
export function registerMixedMenu(ids: readonly CommandId[]): void {
  mixed.push(
    ...ids.filter((id) => !mixed.some((each) => each.id === id)).map((id) => ({ id, section: 0 })),
  );
}

export const menuKinds = (): ObjectKind[] => [...registered.keys()];

/** A kind's menu as registered: each command with its section, in the order given. */
export const menuEntries = (kind: ObjectKind): readonly Registered[] => registered.get(kind) ?? [];

export const menuIds = (kind: ObjectKind): readonly CommandId[] =>
  menuEntries(kind).map((each) => each.id);

/** An item of a menu: a command that applies here, and whether it can run now (else, why not). */
export interface MenuItem {
  command: Command;
  enabled: true | { reason: MessageKey };
  section: number;
}

export type MenuEntry = MenuItem | "rule";

/**
 * A kind's menu for this context. A command that doesn't apply is left out, as
 * is one in `without`; one that applies but can't run now stays, disabled with
 * its reason. A rule separates groups and sections that have items.
 */
export function buildMenu(
  kind: ObjectKind,
  ctx: CommandContext,
  without: readonly CommandId[] = [],
): MenuEntry[] {
  return entriesOf(registered.get(kind) ?? [], ctx, without);
}

export const buildMixedMenu = (ctx: CommandContext): MenuEntry[] => entriesOf(mixed, ctx, []);

function entriesOf(
  menu: readonly Registered[],
  ctx: CommandContext,
  without: readonly CommandId[],
): MenuEntry[] {
  const items = menu.flatMap(({ id, section }) => {
    const command = commands.get(id);
    if (!command || without.includes(id) || !offered(command, ctx)) return [];
    const item: MenuItem = { command, enabled: command.enabled?.(ctx) ?? true, section };
    return [{ group: COMMAND_GROUPS.indexOf(command.group), item }];
  });
  const sections = [...new Set(items.map((each) => each.item.section))].sort((a, b) => a - b);
  const entries: MenuEntry[] = [];
  for (const section of sections) {
    COMMAND_GROUPS.forEach((_, group) => {
      const inGroup = items.filter((each) => each.group === group && each.item.section === section);
      if (inGroup.length === 0) return;
      if (entries.length > 0) entries.push("rule");
      for (const each of inGroup) entries.push(each.item);
    });
  }
  return entries;
}
