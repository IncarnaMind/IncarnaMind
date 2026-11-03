import type { ReactNode } from "react";
import { MAX_TAB_GROUPS } from "../../../../core/api";
import type { CommandId } from "../../../../shared/commands";
import { shortcutLabel } from "../../commands/keymap";
import { type CommandContext, commands, isEnabled, offered } from "../../commands/registry";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { MoreLineIcon } from "../lineIcons";
import { menuClass, menuItemClass, menuRuleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

/** One item of a tab's or group's menu, which runs a command, or a rule between them. */
type Item =
  | {
      /** Its test ID, after "tab-menu-". */
      id: string;
      command: CommandId;
      /** Shorter than the command's label: the menu says what it acts on. */
      label: string;
      disabled?: boolean;
    }
  | "rule";

const onTab = (tabId: string | undefined): CommandContext => ({
  selection: [],
  focus: tabId ? { kind: "tab", id: tabId } : null,
  surface: "mind",
});

function MenuItems({
  items,
  ctx,
  close,
}: {
  items: (Item | false)[];
  ctx: CommandContext;
  close(): void;
}) {
  return items.map((item, index) => {
    if (item === false) return null;
    if (item === "rule") {
      // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity but their place.
      return <div key={`rule-${index}`} className={menuRuleClass} />;
    }
    const command = commands.get(item.command);
    const usable = command !== undefined && offered(command, ctx) && isEnabled(command, ctx);
    return (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        data-testid={`tab-menu-${item.id}`}
        disabled={item.disabled || !usable}
        onClick={() => {
          close();
          commands.run(item.command, ctx).catch(useAppStore.getState().reportError);
        }}
        className={`${menuItemClass} pl-2`}
      >
        <span className="flex-1">{item.label}</span>
        {command?.shortcut && (
          <span className="pl-4 text-[13px] text-ink-meta">{shortcutLabel(item.command)}</span>
        )}
      </button>
    );
  });
}

/** The ⋯ at a group strip's end: what applies to the group. */
export function GroupMenu({ groupId, merged }: { groupId: string; merged: boolean }) {
  const t = useT();
  const menu = usePopoverMenu();
  const layout = useAppStore((state) => state.layout);
  const group = layout?.groups.find((each) => each.id === groupId);
  const full = (layout?.groups.length ?? 0) >= MAX_TAB_GROUPS;
  const items: (Item | false)[] =
    menu.open && group
      ? [
          {
            id: "split",
            command: "tab.split",
            label: t("tabs.menu.split"),
            disabled: merged || full,
          },
          { id: "equal", command: "group.equalize", label: t("tabs.menu.equal") },
          "rule",
          { id: "reopen", command: "tab.reopen", label: t("tabs.menu.reopen") },
          { id: "close-others", command: "tab.closeOthers", label: t("tabs.menu.closeOthers") },
          { id: "close-group", command: "group.close", label: t("tabs.menu.closeGroup") },
        ]
      : [];
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="group-menu"
        aria-label={t("tabs.groupMenu")}
        title={t("tabs.groupMenu")}
        className="tab-strip-button"
      >
        <MoreLineIcon />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("tabs.groupMenu")}
        data-testid="group-menu-items"
        className={menuClass}
      >
        <MenuItems
          items={items}
          // An empty group has no tab to act on.
          ctx={onTab(group?.activeTabId ?? undefined)}
          close={menu.close}
        />
      </div>
    </>
  );
}

/** A strip button with an icon, such as Split. */
export function StripButton({
  testId,
  label,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="tab-strip-button"
    >
      {children}
    </button>
  );
}
