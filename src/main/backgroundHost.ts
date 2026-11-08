/**
 * IncarnaMind in the background (#189) and its offers to take notes (#208), as the host shows
 * them: the tray icon while "Keep running in the menu bar" is on, and a system notification for
 * each offer and each call's end, whose buttons do what the tray's items do. Nothing here starts a
 * recording: Take notes asks the core, which records only an offer it still holds.
 */
import { Notification } from "electron";
import type { Core } from "../core";
import type { CallEnding, CallOffer, Meeting, MeetingOffers, Settings } from "../core/api";
import type { Language } from "../core/language";
import { translate } from "../shared/i18n";
import type { MessageKey, MessageParams } from "../shared/i18n/types";
import { meetingAppName } from "../shared/meetingApps";
import { mindName } from "../shared/naming";
import { keepRunningCopy } from "./background";
import type { FileLogger } from "./log";
import { type AppTray, createAppTray } from "./tray";
import { type TrayActions, type TrayState, trayMenu } from "./trayMenu";

export interface BackgroundHostOptions {
  core: Core;
  dataDir: string;
  /** Whether it kept running in the background as the last run left it, until the core's settings say. */
  keepRunning: boolean;
  log: FileLogger;
  /** Brings the app's window to the front, making one if none is open. */
  showWindow(): void;
  /** Shows the window with this Meeting's Note. */
  showMeeting(mindId: string): void;
  showSettings(): void;
  quit(): void;
  /** A test build: the tray's menu and the notifications are reached through `globalThis`. */
  testHooks: boolean;
}

export interface BackgroundHost {
  /** Whether IncarnaMind keeps running with its window closed. */
  keepsRunning(): boolean;
}

/** What a smoke test reads and clicks: the tray's menu as it would open, and each notification shown. */
export interface BackgroundTestHooks {
  tray(): { shown: boolean; items: { id?: string; label?: string; enabled?: boolean }[] };
  clickTray(id: string): void;
  notifications(): { kind: "offer" | "ending"; title: string; body: string; actions: string[] }[];
  /** Clicks a notification's body (`action` absent) or its button. */
  clickNotification(kind: "offer" | "ending", action?: number): void;
}

const isLive = (meeting: Meeting) => meeting.status === "recording" || meeting.status === "paused";

export function serveBackground(options: BackgroundHostOptions): BackgroundHost {
  const { core, log } = options;
  let language: Language = "en";
  let keepRunning = options.keepRunning;
  let offers: MeetingOffers = { offer: null, ending: null, problem: null };
  let recording: TrayState["recording"] = null;
  let tray: AppTray | null = null;

  const failed = (what: string) => (error: unknown) =>
    log.exception(`background.${what}Failed`, error);

  const actions: TrayActions = {
    open: options.showWindow,
    openRecording: () => {
      if (recording) options.showMeeting(recording.meeting.mindId);
    },
    stopRecording: (meetingId) => void core.stopMeeting(meetingId).catch(failed("stop")),
    takeOffer: (offerId) => {
      options.showWindow();
      core.takeMeetingOffer(offerId).catch(failed("takeOffer"));
    },
    declineOffer: (offerId, always) =>
      void core.declineMeetingOffer({ offerId, always }).catch(failed("declineOffer")),
    keepRecording: (meetingId) =>
      void core.keepRecordingAfterCall(meetingId).catch(failed("keepRecording")),
    settings: options.showSettings,
    quit: options.quit,
  };

  const state = (): TrayState => ({
    language,
    recording,
    offer: offers.offer,
    ending: offers.ending,
  });

  const showTray = () => {
    if (keepRunning && !tray) {
      try {
        tray = createAppTray(actions, state());
      } catch (error) {
        log.exception("background.trayFailed", error);
      }
    } else if (!keepRunning && tray) {
      tray.destroy();
      tray = null;
    }
    tray?.update(state());
  };

  const t = (key: MessageKey, values?: MessageParams) => translate(language, key, values);

  type Said = ReturnType<BackgroundTestHooks["notifications"]>[number];
  interface Shown {
    id: string;
    notification: Notification | null;
    said: Said;
    click(): void;
    act(index: number): void;
  }
  const shown = new Map<"offer" | "ending", Shown>();

  const notify = (
    kind: "offer" | "ending",
    id: string,
    said: Said,
    click: () => void,
    act: (index: number) => void,
  ) => {
    let notification: Notification | null = null;
    if (Notification.isSupported()) {
      notification = new Notification({
        title: said.title,
        body: said.body,
        actions: said.actions.map((text) => ({ type: "button" as const, text })),
        ...(kind === "offer" && { closeButtonText: t("offers.notNow") }),
      });
      notification.on("click", click);
      notification.on("action", (_event, index) => act(index));
      notification.show();
    }
    shown.set(kind, { id, notification, said, click, act });
  };

  const close = (kind: "offer" | "ending") => {
    shown.get(kind)?.notification?.close();
    shown.delete(kind);
  };

  const offerShown = (offer: CallOffer) => {
    const app = meetingAppName(offer.app, language);
    notify(
      "offer",
      offer.id,
      {
        kind: "offer",
        title: t("offers.call.title"),
        body: t("offers.call.body", { app }),
        actions: [t("offers.take"), t("offers.dontAsk", { app })],
      },
      () => actions.takeOffer(offer.id),
      (index) => (index === 0 ? actions.takeOffer(offer.id) : actions.declineOffer(offer.id, true)),
    );
  };

  const endingShown = (ending: CallEnding) => {
    const seconds = Math.max(0, Math.round((Date.parse(ending.stopsAt) - Date.now()) / 1000));
    notify(
      "ending",
      ending.meetingId,
      {
        kind: "ending",
        title: t("offers.end.title"),
        body: t("offers.end.body", { seconds }),
        actions: [t("offers.end.stopNow"), t("offers.end.keep")],
      },
      () => actions.openRecording(ending.meetingId),
      (index) =>
        index === 0
          ? actions.stopRecording(ending.meetingId)
          : actions.keepRecording(ending.meetingId),
    );
  };

  const offersChanged = (next: MeetingOffers) => {
    offers = next;
    if (shown.get("offer")?.id !== next.offer?.id) {
      close("offer");
      if (next.offer) offerShown(next.offer);
    }
    if (shown.get("ending")?.id !== next.ending?.meetingId) {
      close("ending");
      if (next.ending) endingShown(next.ending);
    }
    showTray();
  };

  const meetingsChanged = async (meetings: Meeting[]) => {
    const live = meetings.find(isLive) ?? null;
    if (!live) {
      recording = null;
    } else if (recording?.meeting.mindId === live.mindId) {
      recording = { ...recording, meeting: live };
    } else {
      const mind = (await core.listMinds()).find((each) => each.id === live.mindId);
      recording = { meeting: live, note: mind ? mindName(mind) : "" };
    }
    showTray();
  };

  const settingsChanged = (settings: Settings) => {
    language = settings.language;
    if (settings.device.keepRunning !== keepRunning) {
      keepRunning = settings.device.keepRunning;
      try {
        keepRunningCopy(options.dataDir, keepRunning);
      } catch (error) {
        log.exception("background.copyFailed", error);
      }
    }
    showTray();
  };

  core.onAnyEvent((name, payload) => {
    if (name === "settings.changed") settingsChanged(payload as Settings);
    else if (name === "meetings.offers") offersChanged(payload as MeetingOffers);
    else if (name === "meetings.changed")
      meetingsChanged(payload as Meeting[]).catch(failed("meetings"));
  });
  Promise.all([core.getSettings(), core.getMeetingOffers(), core.listMeetings()])
    .then(async ([settings, given, meetings]) => {
      settingsChanged(settings);
      offersChanged(given);
      await meetingsChanged(meetings);
    })
    .catch(failed("start"));

  if (options.testHooks) {
    const hooks: BackgroundTestHooks = {
      tray: () => ({
        shown: tray !== null,
        items: trayMenu(state(), actions, Date.now(), process.platform).map((item) => ({
          ...(item.id !== undefined && { id: item.id }),
          ...(item.label !== undefined && { label: item.label }),
          ...(item.enabled !== undefined && { enabled: item.enabled }),
        })),
      }),
      clickTray: (id) => {
        const item = trayMenu(state(), actions, Date.now(), process.platform).find(
          (each) => each.id === id,
        );
        if (!item?.click) throw new Error(`No tray item ${id}.`);
        (item.click as () => void)();
      },
      notifications: () => [...shown.values()].map((each) => each.said),
      clickNotification: (kind, action) => {
        const each = shown.get(kind);
        if (!each) throw new Error(`No ${kind} notification is shown.`);
        if (action === undefined) each.click();
        else each.act(action);
      },
    };
    (globalThis as { incarnamindBackground?: BackgroundTestHooks }).incarnamindBackground = hooks;
  }

  return { keepsRunning: () => keepRunning };
}
