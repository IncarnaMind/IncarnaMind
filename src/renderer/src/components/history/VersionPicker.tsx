import { Fragment, useState } from "react";
import type { Checkpoint } from "../../../../core/api";
import { beforeAiChange, byDay, reasonLabel, timeLabel, versionLabel } from "../../historyLabels";
import { useLanguage, useT } from "../../i18n";
import { CheckLineIcon, ChevronDownLineIcon, ChevronUpLineIcon, SparkLineIcon } from "../lineIcons";
import { menuClass, menuItemClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

/** How many versions the picker lists before "Older versions". */
const FIRST_SHOWN = 12;

/**
 * The version on one side of History: a button that names it, and its menu
 * of the Mind's Checkpoints, newest first in groups by day, those saved
 * before an AI change marked with the spark. The right side's starts with
 * the Mind as it is now (`chosen` null).
 */
export function VersionPicker({
  side,
  checkpoints,
  chosen,
  onChoose,
  onRename,
  disabled = false,
}: {
  side: "left" | "right";
  checkpoints: readonly Checkpoint[];
  chosen: string | null;
  onChoose(id: string | null): void;
  /** F2 on the button names the chosen version, as F2 renames a row. */
  onRename?: () => void;
  /** Nothing to choose from: the Mind has no versions yet. */
  disabled?: boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const menu = usePopoverMenu();
  const [older, setOlder] = useState(false);
  const now = new Date();
  const picked = checkpoints.find((each) => each.id === chosen) ?? null;
  const name = picked ? versionLabel(picked, now, language, t) : t("history.now");
  const reason = picked ? reasonLabel(picked, t) : null;
  const shown = older ? checkpoints : checkpoints.slice(0, FIRST_SHOWN);
  const choose = (id: string | null) => {
    onChoose(id);
    menu.close();
    menu.buttonProps.ref.current?.focus();
  };
  const Chevron = menu.open ? ChevronUpLineIcon : ChevronDownLineIcon;

  return (
    <>
      <button
        type="button"
        {...menu.buttonProps}
        data-testid={`history-picker-${side}`}
        disabled={disabled}
        aria-label={t(side === "left" ? "history.picker.left" : "history.picker.right", {
          version: reason ? `${name}, ${reason}` : name,
        })}
        className="history-picker"
        data-side={side}
        onKeyDown={(event) => {
          if (event.key !== "F2" || !onRename) return;
          event.preventDefault();
          onRename();
        }}
      >
        {picked && beforeAiChange(picked) && <SparkLineIcon className="history-icon" />}
        <span className="min-w-0 truncate">
          {name}
          {reason && <span className="history-meta"> · {reason}</span>}
        </span>
        <Chevron className="history-icon" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("history.versions")}
        data-testid={`history-versions-${side}`}
        className={`${menuClass} history-menu`}
      >
        {menu.open && (
          <>
            {side === "right" && (
              <Option
                checked={chosen === null}
                onClick={() => choose(null)}
                label={t("history.now")}
              />
            )}
            {byDay(shown, now, language).map((group) => (
              <Fragment key={group.day}>
                <div role="presentation" className={menuTitleClass}>
                  {group.day}
                </div>
                {group.checkpoints.map((checkpoint) => {
                  const why = reasonLabel(checkpoint, t);
                  const version = versionLabel(checkpoint, now, language, t);
                  return (
                    <Option
                      key={checkpoint.id}
                      checked={checkpoint.id === chosen}
                      ai={beforeAiChange(checkpoint)}
                      label={timeLabel(checkpoint.createdAt, language)}
                      reason={why}
                      spoken={why ? `${version}, ${why}` : version}
                      onClick={() => choose(checkpoint.id)}
                    />
                  );
                })}
              </Fragment>
            ))}
            {!older && checkpoints.length > FIRST_SHOWN && (
              <button
                type="button"
                role="menuitem"
                data-testid="history-older"
                onClick={() => setOlder(true)}
                className={`${menuItemClass} pl-2 text-ink-secondary`}
              >
                <ChevronDownLineIcon className="history-icon" />
                {t("history.older")}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** A version in the menu; screen readers hear its day too (`spoken`), as its group's heading isn't read. */
function Option({
  checked,
  ai = false,
  label,
  reason = null,
  spoken,
  onClick,
}: {
  checked: boolean;
  ai?: boolean;
  label: string;
  reason?: string | null;
  spoken?: string;
  onClick(): void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-label={spoken && (ai ? `${spoken}, ${t("history.ai")}` : spoken)}
      data-testid="history-version"
      onClick={onClick}
      className={`${menuItemClass} history-option pl-2`}
    >
      <span className="history-icon">{ai && <SparkLineIcon className="size-full" />}</span>
      <span className="history-time">{label}</span>
      {reason && <span className="history-meta min-w-0 flex-1 truncate">· {reason}</span>}
      {!reason && <span className="flex-1" />}
      {checked && <CheckLineIcon className="history-icon" />}
    </button>
  );
}
