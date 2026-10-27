import { DOCKS, dockCommandId } from "../../commands/assistant";
import { commands, labelOf } from "../../commands/registry";
import { useConversations } from "../../conversations";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  CheckLineIcon,
  ChevronRightLineIcon,
  DockBottomLineIcon,
  DockLeftLineIcon,
  DockRightLineIcon,
  FloatLineIcon,
  MoreLineIcon,
} from "../lineIcons";
import { menuClass, menuItemClass, menuItemUnavailableClass, menuRuleClass } from "../ui";
import { usePopoverMenu, useSubmenu } from "../usePopoverMenu";

const ICONS = {
  right: DockRightLineIcon,
  left: DockLeftLineIcon,
  bottom: DockBottomLineIcon,
  float: FloatLineIcon,
} as const;

/**
 * The assistant's ⋯: "Move assistant ▸", whose submenu has where it sits (the
 * User's choice is checked, even while a narrow window shows a side dock at the
 * bottom); `withFold`, Fold (on Windows docked right, where the header has no
 * room for it); then what acts on its conversation. Each is a command, as in ⌘K.
 */
export function AssistantMenu({ withFold = false }: { withFold?: boolean }) {
  const t = useT();
  const menu = usePopoverMenu();
  const submenu = useSubmenu();
  const chosen = useAppStore((state) => state.layout?.assistant.dock);
  const run = (id: Parameters<typeof commands.run>[0]) => {
    menu.close();
    // The item that had the focus is gone with the menu, and the page body would get it.
    menu.buttonProps.ref.current?.focus();
    commands.run(id).catch(useAppStore.getState().reportError);
  };
  const HereIcon = ICONS[chosen ?? "right"];
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="assistant-more"
        data-open={menu.open || undefined}
        aria-label={t("assistant.more")}
        title={t("assistant.more")}
        className="assistant-button"
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("assistant.more")}
        data-testid="assistant-menu"
        className={menuClass}
      >
        {menu.open && (
          <>
            <button
              {...submenu.itemProps}
              type="button"
              data-testid="assistant-menu-move"
              className={`${menuItemClass} pl-2 aria-expanded:bg-hover`}
            >
              <HereIcon className="size-4 shrink-0 text-ink-meta" />
              <span className="flex-1">{t("assistant.moveMenu")}</span>
              <ChevronRightLineIcon className="size-3.5 text-ink-meta" />
            </button>
            {withFold && (
              <button
                type="button"
                role="menuitem"
                data-testid="assistant-menu-fold"
                onClick={() => run("assistant.fold")}
                className={`${menuItemClass} pl-8`}
              >
                {t("assistant.fold")}
              </button>
            )}
            <div className={menuRuleClass} />
            <ConversationItem
              id="assistant.writeNote"
              testId="assistant-menu-write-note"
              onRun={run}
            />
            <ConversationItem id="assistant.clear" testId="assistant-menu-clear" onRun={run} />
          </>
        )}
      </div>
      <div
        {...submenu.menuProps}
        role="menu"
        aria-label={t("assistant.moveMenu")}
        data-testid="assistant-menu-docks"
        className={menuClass}
      >
        {DOCKS.map(({ dock, label }) => {
          const Icon = ICONS[dock];
          return (
            <button
              key={dock}
              type="button"
              role="menuitemradio"
              aria-checked={chosen === dock}
              data-testid={`assistant-menu-${dock}`}
              onClick={() => run(dockCommandId(dock))}
              className={`${menuItemClass} pl-2`}
            >
              <Icon className="size-4 shrink-0 text-ink-meta" />
              <span className="flex-1">{t(label)}</span>
              {chosen === dock && <CheckLineIcon className="size-4 shrink-0 text-ink-meta" />}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * An item that acts on the conversation, as its command does; while it can't,
 * it stays in the arrow keys' reach, greyed, saying why.
 */
function ConversationItem({
  id,
  testId,
  onRun,
}: {
  id: "assistant.writeNote" | "assistant.clear";
  testId: string;
  onRun(id: "assistant.writeNote" | "assistant.clear"): void;
}) {
  const t = useT();
  // The conversation's messages decide whether it can be used.
  useConversations((state) => state.messages);
  const command = commands.get(id);
  if (!command) return null;
  const ctx = { selection: [], focus: null, surface: "mind" } as const;
  const enabled = command.enabled?.(ctx) ?? true;
  const label = labelOf(command, ctx, t);
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={enabled === true ? undefined : true}
      data-testid={testId}
      title={enabled === true ? undefined : t(enabled.reason)}
      onClick={() => {
        if (enabled === true) onRun(id);
      }}
      className={`${menuItemClass} ${enabled === true ? "" : menuItemUnavailableClass} pl-8`}
    >
      {label}
    </button>
  );
}
