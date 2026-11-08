import type { ReactNode } from "react";
import type { CalendarService } from "../../../../core/api";
import { useCalendars } from "../../calendars";
import { SENDS_LINES, SERVICE_NAMES } from "../../calendarWords";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { CalendarLineIcon } from "../lineIcons";
import { menuFrameClass, menuTitleClass, tallMenuItemClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

/**
 * "Connect a calendar" where Coming up is empty, as the prototype's menu: each service this copy
 * offers, Google's and Microsoft's with the line that says what their sign-in sends, read before
 * the choice, which is the consent (ADR-0022).
 */
export function ConnectCalendarMenu({
  services,
  children,
  className,
  shownAt,
}: {
  services: readonly CalendarService[];
  children: ReactNode;
  className: string;
  shownAt?: string;
}) {
  const t = useT();
  const menu = usePopoverMenu({ focus: "first" });
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const offered = services.filter((service) => service === "mac" || !localOnly);
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="calendar-connect-menu"
        className={className}
      >
        {children}
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("calendars.connectMenu")}
        data-testid="calendar-connect-choices"
        className={`${menuFrameClass} w-[300px] max-w-[calc(100vw-16px)]`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("calendars.connectMenu")}</p>
            {offered.map((service) => {
              const sends = SENDS_LINES[service];
              return (
                <button
                  key={service}
                  type="button"
                  role="menuitem"
                  data-testid="calendar-connect-choice"
                  data-service={service}
                  onClick={() => {
                    menu.close();
                    void useCalendars.getState().connect(service, shownAt);
                  }}
                  className={`${tallMenuItemClass} items-start pl-2`}
                >
                  <CalendarLineIcon className="mt-0.5 size-4 shrink-0 text-ink-secondary" />
                  <span className="min-w-0 flex-1">
                    <span className="block">{t(SERVICE_NAMES[service])}</span>
                    {sends && (
                      <span className="block text-[12px] leading-[18px] text-ink-meta">
                        {t(sends)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
