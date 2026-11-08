/**
 * The menu of the menu bar icon (macOS) or tray icon (Windows, Linux) of #189, as the
 * Meeting-Offer board draws it: a recording and Stop Recording, a call offered (#208) or ending,
 * then Open IncarnaMind, Settings… and Quit.
 */
import type { MenuItemConstructorOptions } from "electron";
import type { CallEnding, CallOffer, Meeting } from "../core/api";
import type { Language } from "../core/language";
import { meetingTimeAt } from "../shared/blockTimes";
import { clockTime } from "../shared/clock";
import { translate } from "../shared/i18n";
import type { MessageKey } from "../shared/i18n/types";
import { type CallKind, meetingApp, meetingAppName } from "../shared/meetingApps";

export interface TrayState {
  language: Language;
  /** The Meeting recording or paused, with its Note's name. */
  recording: { meeting: Meeting; note: string } | null;
  offer: CallOffer | null;
  ending: CallEnding | null;
}

export interface TrayActions {
  open(): void;
  openRecording(meetingId: string): void;
  stopRecording(meetingId: string): void;
  takeOffer(offerId: string): void;
  declineOffer(offerId: string, always: boolean): void;
  keepRecording(meetingId: string): void;
  settings(): void;
  quit(): void;
}

const KIND_LINE: Record<CallKind, MessageKey> = {
  meeting: "offers.kind.meeting",
  call: "offers.kind.call",
  huddle: "offers.kind.huddle",
};

/** The menu, top to bottom, as of `now`. */
export function trayMenu(
  state: TrayState,
  actions: TrayActions,
  now: number,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    translate(state.language, key, values);
  const mac = platform === "darwin";
  const items: MenuItemConstructorOptions[] = [];
  const { recording, offer, ending } = state;
  if (mac) items.push({ label: "IncarnaMind", enabled: false });
  if (recording) {
    const { meeting } = recording;
    items.push(
      {
        id: "tray.recording",
        label: `${t("tray.recording", { name: recording.note })}  ${clockTime(meetingTimeAt(meeting, now))}`,
        click: () => actions.openRecording(meeting.id),
      },
      {
        id: "tray.stopRecording",
        label: t("tray.stopRecording"),
        ...(mac && { accelerator: "CmdOrCtrl+Shift+P", registerAccelerator: false }),
        click: () => actions.stopRecording(meeting.id),
      },
    );
  }
  if (ending) {
    const seconds = Math.max(0, Math.ceil((Date.parse(ending.stopsAt) - now) / 1000));
    items.push(
      { type: "separator" },
      { label: t("offers.end.line", { seconds }), enabled: false },
      {
        id: "tray.keepRecording",
        label: t("offers.end.keep"),
        click: () => actions.keepRecording(ending.meetingId),
      },
    );
  }
  if (offer) {
    const app = meetingAppName(offer.app, state.language);
    items.push(
      ...(items.length > (mac ? 1 : 0) ? [{ type: "separator" } as const] : []),
      {
        label: t(KIND_LINE[meetingApp(offer.app)?.kind ?? "meeting"], { app }),
        enabled: false,
      },
      { id: "tray.takeNotes", label: t("offers.take"), click: () => actions.takeOffer(offer.id) },
      {
        id: "tray.dontAsk",
        label: t("offers.dontAsk", { app }),
        click: () => actions.declineOffer(offer.id, true),
      },
    );
  }
  items.push(
    { type: "separator" },
    { id: "tray.open", label: t("tray.open"), click: actions.open },
    {
      id: "tray.settings",
      label: t("tray.settings"),
      ...(mac && { accelerator: "CmdOrCtrl+,", registerAccelerator: false }),
      click: actions.settings,
    },
    { type: "separator" },
    {
      id: "tray.quit",
      label: t("tray.quit"),
      ...(mac && { accelerator: "CmdOrCtrl+Q", registerAccelerator: false }),
      click: actions.quit,
    },
  );
  return items;
}
