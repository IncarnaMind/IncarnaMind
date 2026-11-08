import { create } from "zustand";
import type {
  CalendarAccount,
  CalendarInfo,
  CalendarService,
  CalendarsState,
} from "../../core/api";
import { SERVICE_NAMES } from "./calendarWords";
import { core } from "./core";
import { errorMessage } from "./errors";
import { translateNow } from "./i18n";
import type { Translate } from "./objects";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

/** Where a change made in Settings › Meetings › Calendars says so, with Undo. */
export const CALENDARS_UNDO_PLACE = "settings:meetings:calendars";

interface CalendarsStore {
  /** As the core has them; null until read. */
  calendars: CalendarsState | null;
  /** Why connecting a service failed, said where it was asked for, until the next try. */
  problems: Partial<Record<CalendarService, string>>;
  load(): Promise<void>;
  /** Connects a service, with an Undo line that disconnects it; at `shownAt` when given. */
  connect(service: CalendarService, shownAt?: string): Promise<void>;
  cancelSignIn(): Promise<void>;
  /**
   * Disconnects at once. The Mac's calendar connects again with Undo; a sign-in can't be put
   * back without the browser, so its line offers to connect again instead.
   */
  disconnect(account: CalendarAccount): Promise<void>;
  setCounted(calendar: CalendarInfo, counted: boolean): Promise<void>;
  sync(): Promise<void>;
  /** Allows the calendars flow again for an account the User turned off in Settings › Privacy. */
  allow(account: CalendarAccount): Promise<void>;
  openSystemSettings(): Promise<void>;
}

const report = (error: unknown) => useAppStore.getState().reportError(error);
const serviceName = (service: CalendarService) => (t: Translate) => t(SERVICE_NAMES[service]);

const accountOf = (service: CalendarService) =>
  useCalendars.getState().calendars?.accounts.find((each) => each.service === service) ?? null;

export const useCalendars = create<CalendarsStore>()((set, get) => {
  const keepProblem = (service: CalendarService, error: unknown) =>
    set((state) => ({
      problems: { ...state.problems, [service]: errorMessage(error, translateNow) },
    }));
  const clearProblem = (service: CalendarService) =>
    set((state) => {
      const { [service]: _gone, ...rest } = state.problems;
      return { problems: rest };
    });

  return {
    calendars: null,
    problems: {},

    async load() {
      try {
        set({ calendars: await core.getCalendars() });
      } catch (error) {
        report(error);
      }
    },

    async connect(service, shownAt) {
      clearProblem(service);
      let account: CalendarAccount | null;
      try {
        account = await core.connectCalendar(service);
      } catch (error) {
        keepProblem(service, error);
        return;
      }
      // Cancelled, or the Mac's access refused: its row says how to allow it.
      if (!account || account.problem === "denied") return;
      const connected = account;
      useUndo.getState().push({
        said: (t) => t("calendars.connected", { service: serviceName(service)(t) }),
        undo: async () => {
          await core.disconnectCalendar(accountOf(service)?.id ?? connected.id);
        },
        ...(service === "mac" && {
          redo: async () => {
            await core.connectCalendar("mac");
          },
        }),
        ...(shownAt && { shownAt }),
      });
    },

    async cancelSignIn() {
      try {
        await core.cancelCalendarSignIn();
      } catch (error) {
        report(error);
      }
    },

    async disconnect(account) {
      try {
        set({ calendars: await core.disconnectCalendar(account.id) });
      } catch (error) {
        report(error);
        return;
      }
      const words = serviceName(account.service);
      if (account.service === "mac") {
        useUndo.getState().push({
          said: (t) => t("calendars.disconnected", { service: words(t) }),
          undo: async () => {
            await core.connectCalendar("mac");
          },
          redo: async () => {
            const now = accountOf("mac");
            if (now) await core.disconnectCalendar(now.id);
          },
          shownAt: CALENDARS_UNDO_PLACE,
        });
        return;
      }
      useUndo.getState().tell({
        says: (t) => t("calendars.disconnected", { service: words(t) }),
        action: {
          label: (t) => t("calendars.connectAgain"),
          testId: "calendar-connect-again",
          run: () => void get().connect(account.service),
        },
      });
    },

    async setCounted(calendar, counted) {
      const save = async (value: boolean) => {
        set({
          calendars: await core.setCalendarCounted({ calendarId: calendar.id, counted: value }),
        });
      };
      try {
        await save(counted);
      } catch (error) {
        report(error);
        return;
      }
      useUndo.getState().push({
        said: (t, cut) =>
          t(counted ? "calendars.countedOn" : "calendars.countedOff", {
            calendar: cut(calendar.name),
          }),
        undo: () => save(!counted),
        redo: () => save(counted),
        shownAt: CALENDARS_UNDO_PLACE,
      });
    },

    async sync() {
      try {
        set({ calendars: await core.syncCalendars() });
      } catch (error) {
        report(error);
      }
    },

    async allow(account) {
      try {
        if (!account.consentServiceId) {
          useAppStore.getState().openSettings("privacy");
          return;
        }
        await core.allowDataFlow("calendars", account.consentServiceId);
        await get().sync();
      } catch (error) {
        report(error);
      }
    },

    async openSystemSettings() {
      try {
        await core.openCalendarSettings();
      } catch (error) {
        report(error);
      }
    },
  };
});

core.on("calendars.changed", (calendars) => useCalendars.setState({ calendars }));

/** Whether this copy can connect a calendar, or has one connected. */
export const calendarsOffered = (calendars: CalendarsState | null): boolean =>
  !!calendars && (calendars.services.length > 0 || calendars.accounts.length > 0);
