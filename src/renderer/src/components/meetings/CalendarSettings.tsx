import type { CalendarAccount, CalendarInfo, CalendarService } from "../../../../core/api";
import { CALENDARS_UNDO_PLACE, calendarsOffered, useCalendars } from "../../calendars";
import {
  accountDetail,
  CONNECT_LABELS,
  type ProblemFix,
  problemOf,
  SENDS_LINES,
  SERVICE_NAMES,
} from "../../calendarWords";
import { useLanguage, useT } from "../../i18n";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { DetailsLine } from "../DetailsLine";
import { CalendarLineIcon, CheckLineIcon } from "../lineIcons";
import { LineAction, ProblemMark } from "../ProblemLine";
import { SettingsGroup, SettingsRow, SettingsSection } from "../settings/SettingsGroup";
import { UndoLineAt } from "../UndoLine";
import { buttonStyle, menuFrameClass, menuItemClass, menuRuleClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

const TARGET = ["calendars"] as const;

const icon = <CalendarLineIcon className="size-5 text-ink-secondary" />;

/**
 * Settings › Meetings › Calendars (#190), as the board draws it: a row for each calendar
 * connected on this device, with Choose calendars… and Disconnect, then one for each service this
 * copy offers, whose line says what its sign-in sends before Connect… (ADR-0022). A calendar that
 * can't be read says why in its row, with the one action that fixes it.
 */
export function CalendarSettings() {
  const t = useT();
  const calendars = useCalendars((state) => state.calendars);
  const section = useSettingsTarget<HTMLElement>(TARGET, calendars !== null);
  if (!calendarsOffered(calendars) || !calendars) return null;
  const unconnected = calendars.services.filter((service) =>
    calendars.accounts.every((account) => account.service !== service),
  );
  return (
    <SettingsSection ref={section} title={t("calendars.title")} testId="calendar-settings">
      <SettingsGroup>
        {calendars.accounts.map((account) => (
          <AccountRow key={account.id} account={account} />
        ))}
        {unconnected.map((service) => (
          <ConnectRow key={service} service={service} signingIn={calendars.signingIn === service} />
        ))}
      </SettingsGroup>
      <UndoLineAt place={CALENDARS_UNDO_PLACE} className="mt-2 px-4" />
    </SettingsSection>
  );
}

function AccountRow({ account }: { account: CalendarAccount }) {
  const t = useT();
  const language = useLanguage();
  const { disconnect } = useCalendars.getState();
  const problem = account.problem && problemOf(account, account.problem, language, t);
  return (
    <SettingsRow
      data-testid="calendar-account"
      data-service={account.service}
      leading={icon}
      label={t(SERVICE_NAMES[account.service])}
      detail={
        problem ? (
          <span role="alert" data-testid="calendar-problem" data-problem={account.problem}>
            <ProblemMark />
            {problem.words}
            <FixAction account={account} fix={problem.fix} />
          </span>
        ) : (
          <span data-testid="calendar-account-detail">{accountDetail(account, t)}</span>
        )
      }
      control={
        <>
          {account.calendars.length > 0 && <ChooseCalendars account={account} />}
          <button
            type="button"
            data-testid="calendar-disconnect"
            onClick={() => void disconnect(account)}
            className={buttonStyle("secondary", "sm")}
          >
            {t("calendars.disconnect")}
          </button>
        </>
      }
    />
  );
}

function FixAction({ account, fix }: { account: CalendarAccount; fix: ProblemFix }) {
  const t = useT();
  const store = useCalendars.getState();
  if (fix === null) return null;
  const action = {
    sync: { label: t("calendars.tryAgain"), onClick: () => void store.sync() },
    "sign-in": {
      label: t("calendars.signInAgain"),
      onClick: () => void store.connect(account.service, CALENDARS_UNDO_PLACE),
    },
    allow: { label: t("calendars.allow"), onClick: () => void store.allow(account) },
    "system-settings": {
      label: t("calendars.openSystemSettings"),
      onClick: () => void store.openSystemSettings(),
    },
  }[fix];
  return (
    <>
      <span aria-hidden="true"> · </span>
      <LineAction action={{ ...action, testId: "calendar-fix" }} />
    </>
  );
}

function ConnectRow({ service, signingIn }: { service: CalendarService; signingIn: boolean }) {
  const t = useT();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const problem = useCalendars((state) => state.problems[service]);
  const { connect, cancelSignIn } = useCalendars.getState();
  const sends = SENDS_LINES[service];
  const paused = localOnly && sends !== undefined;
  const detail = signingIn ? (
    <span role="status" data-testid="calendar-signing-in">
      {t("calendars.signingIn")}
      <span aria-hidden="true"> · </span>
      <LineAction
        action={{
          label: t("calendars.cancel"),
          testId: "calendar-sign-in-cancel",
          onClick: () => void cancelSignIn(),
        }}
      />
    </span>
  ) : paused ? (
    <span data-testid="calendar-paused">{t("meetings.route.paused")}</span>
  ) : (
    <>
      {sends ? (
        <DetailsLine testId="calendar-sends" details={<p>{t("calendars.sends.details")}</p>}>
          {t(sends)}
        </DetailsLine>
      ) : (
        <span>{t("calendars.mac.about")}</span>
      )}
      {problem && (
        <span role="alert" data-testid="calendar-connect-problem" className="block text-ink">
          <ProblemMark />
          {problem}
        </span>
      )}
    </>
  );
  return (
    <SettingsRow
      data-testid="calendar-connect-row"
      data-service={service}
      leading={icon}
      label={t(SERVICE_NAMES[service])}
      detail={detail}
      control={
        paused ? undefined : (
          <button
            type="button"
            data-testid="calendar-connect"
            aria-label={t(CONNECT_LABELS[service])}
            disabled={signingIn}
            onClick={() => void connect(service, CALENDARS_UNDO_PLACE)}
            className={buttonStyle("secondary", "sm")}
          >
            {t("calendars.connect")}
          </button>
        )
      }
    />
  );
}

/** Choose calendars…: a box for each calendar of the account, ticked when it counts, each change at once with Undo. */
function ChooseCalendars({ account }: { account: CalendarAccount }) {
  const t = useT();
  const menu = usePopoverMenu({ align: "end" });
  const groups = groupsOf(account.calendars);
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="calendar-choose"
        className={buttonStyle("secondary", "sm")}
      >
        {t("calendars.choose")}
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("calendars.choose.title")}
        data-testid="calendar-choices"
        className={`${menuFrameClass} w-[280px] max-w-[calc(100vw-16px)]`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("calendars.choose.title")}</p>
            {groups.map(({ group, calendars }, at) => (
              <div key={group ?? ""}>
                {at > 0 && <hr className={menuRuleClass} />}
                {group !== null && groups.length > 1 && <p className={menuTitleClass}>{group}</p>}
                {calendars.map((calendar) => (
                  <CalendarChoice key={calendar.id} calendar={calendar} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function CalendarChoice({ calendar }: { calendar: CalendarInfo }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={calendar.counted}
      data-testid="calendar-choice"
      data-counted={calendar.counted}
      title={calendar.name}
      onClick={() => void useCalendars.getState().setCounted(calendar, !calendar.counted)}
      className={`${menuItemClass} pl-2`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {calendar.counted && <CheckLineIcon className="size-3.5 text-accent" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
    </button>
  );
}

/** The Mac's calendars by the account they are in there, in the order they come; others in one group. */
function groupsOf(
  calendars: readonly CalendarInfo[],
): { group: string | null; calendars: CalendarInfo[] }[] {
  const groups: { group: string | null; calendars: CalendarInfo[] }[] = [];
  for (const calendar of calendars) {
    const found = groups.find((each) => each.group === calendar.group);
    if (found) found.calendars.push(calendar);
    else groups.push({ group: calendar.group, calendars: [calendar] });
  }
  return groups;
}
