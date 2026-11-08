import { calendarsOffered, useCalendars } from "../calendars";
import { COMING_UP_SHOWN, comingUpRows, rowTime } from "../calendarWords";
import { takeNotes, useComingUp } from "../comingUp";
import { languageNow } from "../i18n";
import { useAppStore } from "../store";
import type { Command } from "./registry";

const shown = () => comingUpRows(useComingUp.getState().meetings, new Date());

/** Take notes for the Meeting at `slot` in Home's Coming up, named for it in ⌘K. */
const takeNotesAt = (slot: number): Command => ({
  id: `comingUp.takeNotes${slot + 1}`,
  label: (_ctx, t) => {
    const meeting = shown()[slot];
    return meeting
      ? t("comingUp.command.takeNotes", {
          title: meeting.title,
          time: rowTime(meeting, new Date(), languageNow(), t),
        })
      : t("comingUp.takeNotes");
  },
  keywords: ["comingUp.command.keywords"],
  group: "main",
  // A Note made, which Delete takes back, as every way of making one (interaction rule 4).
  reversible: true,
  when: () => shown()[slot] !== undefined,
  run: async () => {
    const meeting = shown()[slot];
    if (meeting) await takeNotes(meeting);
  },
});

const openCalendars = () => useAppStore.getState().openSettings("meetings", "calendars");

export const calendarCommands: readonly Command[] = [
  ...Array.from({ length: COMING_UP_SHOWN }, (_, slot) => takeNotesAt(slot)),
  {
    id: "calendars.connect",
    // Connecting signs in and allows what goes to the service: the User's own (D290).
    assistant: { never: "privacy" },
    label: "comingUp.command.connect",
    keywords: ["comingUp.command.calendarKeywords", "settings.pages.meetings"],
    group: "open",
    reversible: true,
    when: () => {
      const calendars = useCalendars.getState().calendars;
      return (
        !!calendars &&
        calendars.services.some((service) =>
          calendars.accounts.every((account) => account.service !== service),
        )
      );
    },
    run: openCalendars,
  },
  {
    id: "calendars.choose",
    label: "comingUp.command.choose",
    keywords: ["comingUp.command.calendarKeywords", "settings.pages.meetings"],
    group: "open",
    reversible: true,
    when: () => {
      const calendars = useCalendars.getState().calendars;
      return calendarsOffered(calendars) && (calendars?.accounts.length ?? 0) > 0;
    },
    run: openCalendars,
  },
];
