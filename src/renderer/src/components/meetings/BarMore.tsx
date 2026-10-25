import { menuKeysLabel } from "../../commands/keymap";
import { type CommandContext, commands, isEnabled, labelOf } from "../../commands/registry";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { MoreLineIcon } from "../lineIcons";
import { menuClass, menuItemClass, menuItemUnavailableClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

const FOLDING = [
  { fold: "mark", id: "meeting.mark" },
  { fold: "help", id: "meeting.panel" },
  { fold: "transcript", id: "meeting.transcript" },
  { fold: "details", id: "meeting.details" },
] as const;

const CONTEXT: CommandContext = { selection: [], focus: null, surface: "mind" };

/**
 * The recording bar's ⋯, shown only once a button has folded into it (styles.css, the bar's
 * container queries). Its menu holds the buttons that are hidden when it opens, each its
 * command, as ⌘K has it.
 */
export function BarMore() {
  const t = useT();
  const menu = usePopoverMenu();
  const bar = menu.buttonProps.ref.current?.closest(".meeting-bar");
  const hidden = menu.open
    ? FOLDING.filter(({ fold }) => {
        const button = bar?.querySelector<HTMLElement>(`[data-fold="${fold}"]`);
        return button !== null && button !== undefined && button.offsetParent === null;
      })
    : [];
  const run = (id: (typeof FOLDING)[number]["id"]) => {
    menu.close();
    commands.run(id).catch(useAppStore.getState().reportError);
  };

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="meeting-more"
        data-open={menu.open || undefined}
        aria-label={t("meetings.bar.more")}
        title={t("meetings.bar.more")}
        className="meeting-button meeting-button--icon meeting-more"
      >
        <MoreLineIcon className="size-4" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("meetings.bar.more")}
        data-testid="meeting-more-menu"
        className={menuClass}
      >
        {hidden.map(({ id }) => {
          const command = commands.get(id);
          if (!command) return null;
          const enabled = isEnabled(command, CONTEXT);
          const keys = menuKeysLabel(command);
          return (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-testid={`meeting-more-${id.replace("meeting.", "")}`}
              aria-disabled={enabled ? undefined : true}
              onClick={() => {
                if (enabled) run(id);
              }}
              className={`${menuItemClass} ${menuItemUnavailableClass} pl-2`}
            >
              <span className="flex-1">{labelOf(command, CONTEXT, t)}</span>
              {keys && <span className="pl-4 text-[13px] text-ink-meta">{keys}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
