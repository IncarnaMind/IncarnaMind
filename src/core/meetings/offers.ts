/**
 * Offers to take notes in a call that isn't on the calendar (#208). A call app taking the
 * microphone is offered once, while the User's switches allow it and nothing records; only Take
 * notes records. When the app a Meeting was taken for lets go of the microphone, the Meeting
 * stops 30 seconds later unless the User keeps recording or the app takes it back.
 */
import type { CallWatcher, Logger } from "../adapters";
import type {
  CallEnding,
  CallOffer,
  CallWatchProblem,
  DeviceSettings,
  MeetingOffers,
} from "../api";
import { NotFoundError } from "../errors";

/** A call app that lets go of the microphone and takes it back within this is still in the same call (a device switch, a rejoin). */
export const SAME_CALL_MS = 10_000;
/** How long after the call app lets go of the microphone its Meeting stops: the line "Stopping in 30 seconds". */
export const STOP_AFTER_CALL_MS = 30_000;

/**
 * Whether an offer to take notes may show, by the User's switches in Settings › General (#189):
 * the calendar's before a calendar meeting (#207), a call's when `app` took the microphone.
 * Offers wait for Meetings to be set up: the recording notice read on this device.
 */
export function offerAllowed(
  device: Pick<
    DeviceSettings,
    "meetingNoticeAccepted" | "calendarOffers" | "callOffers" | "callOffersOff"
  >,
  offer: { kind: "calendar" } | { kind: "call"; app: string },
): boolean {
  if (!device.meetingNoticeAccepted) return false;
  if (offer.kind === "calendar") return device.calendarOffers;
  return device.callOffers && !device.callOffersOff.includes(offer.app);
}

export interface MeetingOffersOptions {
  watcher: CallWatcher | undefined;
  /** Whether call offers are wanted at all: watching stops while they aren't. */
  watching(): boolean;
  /** Whether a call in `app` may be offered now (`offerAllowed`). */
  allowed(app: string): boolean;
  /** A Meeting records or is paused: nothing is offered then. */
  busy(): boolean;
  /** Whether the Meeting records or is paused. */
  live(meetingId: string): boolean;
  /** Records the call in a new Note, opened in the main window; its Meeting's id. */
  record(app: string): string;
  stop(meetingId: string): void;
  changed(offers: MeetingOffers): void;
  newId(): string;
  now(): Date;
  log: Logger;
}

export interface MeetingOffersControl {
  get(): MeetingOffers;
  take(offerId: string): string;
  decline(offerId: string, always: boolean): void;
  keepRecording(meetingId: string): void;
  /** The switches or Meetings changed: starts or stops watching, and takes back what no longer holds. */
  refresh(): void;
  close(): void;
}

export function createMeetingOffers(options: MeetingOffersOptions): MeetingOffersControl {
  const { log } = options;
  let stopWatching: (() => void) | null = null;
  let problem: CallWatchProblem | null = null;
  let using = new Set<string>();
  let offer: CallOffer | null = null;
  let ending: (CallEnding & { timer: ReturnType<typeof setTimeout> }) | null = null;
  /** Meetings taken from an offer, by id: the call app each records. */
  const taken = new Map<string, string>();
  /** Apps that let go of the microphone, until the call is over (`SAME_CALL_MS`). */
  const letGo = new Map<string, ReturnType<typeof setTimeout>>();
  /** Apps whose call the User declined; offered again once that call is over. */
  const declined = new Set<string>();

  const state = (): MeetingOffers => ({
    offer,
    ending: ending && { meetingId: ending.meetingId, app: ending.app, stopsAt: ending.stopsAt },
    problem,
  });
  const changed = () => options.changed(state());

  const cancelEnding = () => {
    if (!ending) return;
    clearTimeout(ending.timer);
    ending = null;
  };

  const callOver = (app: string) => {
    letGo.delete(app);
    declined.delete(app);
    if (offer?.app === app) {
      offer = null;
      changed();
    }
  };

  const tookMicrophone = (app: string) => {
    const waiting = letGo.get(app);
    if (waiting) {
      clearTimeout(waiting);
      letGo.delete(app);
    }
    if (ending?.app === app) {
      cancelEnding();
      log.info("meeting.callBack");
      changed();
    }
    if (offer || declined.has(app)) return;
    if ([...taken.values()].includes(app)) return;
    if (options.busy() || !options.allowed(app)) return;
    offer = { id: options.newId(), app, at: options.now().toISOString() };
    log.info("meeting.offered");
    changed();
  };

  const letGoOfMicrophone = (app: string, exact: boolean) => {
    letGo.set(
      app,
      setTimeout(() => callOver(app), SAME_CALL_MS),
    );
    // Only a watcher that says when an app lets go may stop a recording.
    if (ending || !exact) return;
    const meetingId = [...taken].find(
      ([id, takenApp]) => takenApp === app && options.live(id),
    )?.[0];
    if (!meetingId) return;
    const stopsAt = new Date(options.now().getTime() + STOP_AFTER_CALL_MS).toISOString();
    const timer = setTimeout(() => {
      ending = null;
      taken.delete(meetingId);
      try {
        if (options.live(meetingId)) options.stop(meetingId);
        log.info("meeting.stoppedAfterCall");
      } catch (error) {
        log.error("meeting.stopAfterCallFailed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      changed();
    }, STOP_AFTER_CALL_MS);
    ending = { meetingId, app, stopsAt, timer };
    log.info("meeting.callEnded");
    changed();
  };

  const heard = (apps: readonly string[], exact: boolean) => {
    const now = new Set(apps);
    const before = using;
    using = now;
    for (const app of now) if (!before.has(app)) tookMicrophone(app);
    for (const app of before) if (!now.has(app)) letGoOfMicrophone(app, exact);
  };

  const stop = () => {
    stopWatching?.();
    stopWatching = null;
    using = new Set();
    for (const timer of letGo.values()) clearTimeout(timer);
    letGo.clear();
    declined.clear();
    offer = null;
    cancelEnding();
  };

  const refresh = () => {
    const wanted = options.watching() && options.watcher !== undefined;
    const before = JSON.stringify(state());
    if (!wanted && stopWatching) stop();
    if (!wanted) problem = null;
    if (wanted && !stopWatching && options.watcher) {
      problem = null;
      stopWatching = options.watcher.watch({
        apps: heard,
        problem: (found) => {
          log.warn("meeting.callWatchProblem", { problem: found });
          problem = found;
          changed();
        },
      });
    }
    if (offer && (options.busy() || !options.allowed(offer.app))) offer = null;
    for (const id of taken.keys()) {
      if (options.live(id)) continue;
      taken.delete(id);
      if (ending?.meetingId === id) cancelEnding();
    }
    if (JSON.stringify(state()) !== before) changed();
  };

  return {
    get: state,
    take(offerId) {
      if (!offer || offer.id !== offerId) {
        throw new NotFoundError({ key: "error.meetingOffer.gone" });
      }
      const { app } = offer;
      offer = null;
      changed();
      const meetingId = options.record(app);
      taken.set(meetingId, app);
      log.info("meeting.offerTaken");
      return meetingId;
    },
    decline(offerId, always) {
      if (!offer || offer.id !== offerId) return;
      declined.add(offer.app);
      log.info("meeting.offerDeclined", { always });
      offer = null;
      changed();
    },
    keepRecording(meetingId) {
      if (ending?.meetingId !== meetingId) return;
      cancelEnding();
      changed();
    },
    refresh,
    close: stop,
  };
}
